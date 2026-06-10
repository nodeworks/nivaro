import { db } from '../db/index.js'

export type SmsProvider = 'twilio' | 'aws-sns' | 'vonage' | 'sinch' | 'messagebird'

interface SmsConfig {
  provider: SmsProvider | null
  accountSid: string | null
  authToken: string | null
  from: string | null
  region: string | null
}

async function getSmsConfig(): Promise<SmsConfig> {
  try {
    const row = (await db('nivaro_settings')
      .select('sms_provider', 'sms_account_sid', 'sms_auth_token', 'sms_from', 'sms_region')
      .orderBy('id', 'asc')
      .first()) as Record<string, unknown> | undefined

    return {
      provider: (row?.sms_provider as SmsProvider | null) ?? null,
      accountSid: (row?.sms_account_sid as string | null) ?? null,
      authToken: (row?.sms_auth_token as string | null) ?? null,
      from: (row?.sms_from as string | null) ?? null,
      region: (row?.sms_region as string | null) ?? 'us-east-1'
    }
  } catch {
    return { provider: null, accountSid: null, authToken: null, from: null, region: null }
  }
}

export async function sendSms(to: string, body: string): Promise<void> {
  const cfg = await getSmsConfig()
  if (!cfg.provider || !cfg.accountSid || !cfg.authToken) {
    console.warn('[sms] Provider not configured, skipping SMS to', to)
    return
  }

  switch (cfg.provider) {
    case 'twilio':
      await sendViaTwilio(to, body, cfg)
      break
    case 'aws-sns':
      await sendViaAwsSns(to, body, cfg)
      break
    case 'vonage':
      await sendViaVonage(to, body, cfg)
      break
    case 'sinch':
      await sendViaSinch(to, body, cfg)
      break
    case 'messagebird':
      await sendViaMessageBird(to, body, cfg)
      break
    default:
      throw new Error(`Unknown SMS provider: ${cfg.provider}`)
  }
}

async function sendViaTwilio(to: string, body: string, cfg: SmsConfig): Promise<void> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Messages.json`
  const params = new URLSearchParams({ To: to, From: cfg.from ?? '', Body: body })
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(err.message ?? `Twilio error ${res.status}`)
  }
}

async function sendViaAwsSns(to: string, body: string, cfg: SmsConfig): Promise<void> {
  const region = cfg.region ?? 'us-east-1'
  const endpoint = `https://sns.${region}.amazonaws.com/`
  const params = new URLSearchParams({
    Action: 'Publish',
    PhoneNumber: to,
    Message: body,
    Version: '2010-03-31'
  })
  const now = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStr = now.slice(0, 8)

  // AWS SigV4 signing — minimal implementation
  const canonical = `POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:sns.${region}.amazonaws.com\nx-amz-date:${now}\n\ncontent-type;host;x-amz-date\n${await sha256Hex(params.toString())}`
  const credScope = `${dateStr}/${region}/sns/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${now}\n${credScope}\n${await sha256Hex(canonical)}`
  const sigKey = await deriveSigningKey(cfg.authToken!, dateStr, region, 'sns')
  const signature = await hmacHex(sigKey, stringToSign)
  const auth = `AWS4-HMAC-SHA256 Credential=${cfg.accountSid}/${credScope}, SignedHeaders=content-type;host;x-amz-date, Signature=${signature}`

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Amz-Date': now,
      Authorization: auth
    },
    body: params.toString()
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`AWS SNS error ${res.status}: ${text.slice(0, 200)}`)
  }
}

async function sendViaVonage(to: string, body: string, cfg: SmsConfig): Promise<void> {
  const res = await fetch('https://rest.nexmo.com/sms/json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.accountSid,
      api_secret: cfg.authToken,
      to,
      from: cfg.from ?? 'Nivaro',
      text: body
    })
  })
  const json = (await res.json()) as { messages?: Array<{ status: string; error_text?: string }> }
  const msg = json.messages?.[0]
  if (msg?.status !== '0') throw new Error(msg?.error_text ?? 'Vonage error')
}

async function sendViaSinch(to: string, body: string, cfg: SmsConfig): Promise<void> {
  // cfg.accountSid = Service Plan ID, cfg.authToken = API Token
  const res = await fetch(`https://us.sms.api.sinch.com/xms/v1/${cfg.accountSid}/batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: cfg.from, to: [to], body })
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { title?: string }
    throw new Error(err.title ?? `Sinch error ${res.status}`)
  }
}

async function sendViaMessageBird(to: string, body: string, cfg: SmsConfig): Promise<void> {
  const res = await fetch('https://rest.messagebird.com/messages', {
    method: 'POST',
    headers: {
      Authorization: `AccessKey ${cfg.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ originator: cfg.from ?? 'Nivaro', recipients: [to], body })
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { errors?: Array<{ description: string }> }
    throw new Error(err.errors?.[0]?.description ?? `MessageBird error ${res.status}`)
  }
}

// ─── AWS SigV4 helpers (no external deps) ─────────────────────────────────────

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacBuf(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const rawKey = typeof key === 'string' ? new TextEncoder().encode(`AWS4${key}`) : key
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

async function deriveSigningKey(
  secret: string,
  date: string,
  region: string,
  service: string
): Promise<ArrayBuffer> {
  const kDate = await hmacBuf(secret, date)
  const kRegion = await hmacBuf(kDate, region)
  const kService = await hmacBuf(kRegion, service)
  return hmacBuf(kService, 'aws4_request')
}
