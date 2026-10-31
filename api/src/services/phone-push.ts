import { db } from '../db/index.js'
import { routePush } from './channel-test-mode.js'
import { noteChannel, noteChannelRedirect } from './traffic-taps/channels.js'

/**
 * Phone push: alerts on a phone app built with Expo (iOS + Android), sent
 * through the Expo push service.
 *
 * No table of its own: a phone is a `nivaro_push_subscriptions` row whose
 * endpoint is `expo:<Expo push token>` (keys_p256dh = 'expo', keys_auth =
 * '<platform>:<app id>'). Browser endpoints are always https://, so the two
 * never collide, and every count of "push devices" already includes phones.
 * `sendWebPush` skips these rows; `sendPhonePush` reads only them.
 *
 *   MOBILE_PUSH=off          no phone push at all (registration still stores the phone)
 *   EXPO_ACCESS_TOKEN=       optional: the Expo project's push access token
 *   EXPO_PUSH_URL=           optional: send endpoint (default the Expo service); tests point it at a mock
 *
 * Dead phones (Expo says DeviceNotRegistered, on the ticket or on the receipt
 * read back a little later) are removed.
 */

export const PHONE_PREFIX = 'expo:'
const DEFAULT_SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPT_DELAY_MS = 30_000

/** Expo push tokens look like `ExponentPushToken[...]` (or `ExpoPushToken[...]`). */
export function isExpoPushToken(token: unknown): token is string {
  return (
    typeof token === 'string' &&
    token.length <= 200 &&
    /^Expo(nent)?PushToken\[[A-Za-z0-9_\-:.]+\]$/.test(token)
  )
}

export function phonePushEnabled(): boolean {
  return (process.env.MOBILE_PUSH ?? '').toLowerCase() !== 'off'
}

function sendUrl(): string {
  return process.env.EXPO_PUSH_URL || DEFAULT_SEND_URL
}

function receiptsUrl(): string {
  return sendUrl().replace(/\/send$/, '/getReceipts')
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json'
  }
  const token = process.env.EXPO_ACCESS_TOKEN
  if (token) h.authorization = `Bearer ${token}`
  return h
}

export interface PhonePushPayload {
  title: string
  body: string
  /** What the app opens when the alert is tapped. Values only the recipient may see are fine:
   *  the alert goes to their own phone. */
  data?: {
    id?: number | null
    collection?: string | null
    item?: string | null
    url?: string | null
  }
}

/** The figure on the app icon: the same count as the Inbox badge (GET /notifications/unread-count). */
export async function unreadBadge(userId: string): Promise<number | null> {
  try {
    const row = (await db('nivaro_notifications')
      .where({ recipient: userId, status: 'inbox' })
      .where((qb) => qb.whereNull('snoozed_until').orWhere('snoozed_until', '<=', new Date()))
      .where((qb) => qb.whereNull('lane').orWhereIn('lane', ['critical', 'needs_you', 'fyi']))
      .count({ c: '*' })
      .first()) as { c?: number | string } | undefined
    return Number(row?.c ?? 0)
  } catch {
    return null
  }
}

type Ticket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } }

async function removePhones(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  await db('nivaro_push_subscriptions')
    .whereIn('id', ids)
    .del()
    .catch(() => {})
}

/** Read the receipts back and drop phones Expo says are gone. Best effort. */
async function checkReceipts(byTicket: Map<string, number>): Promise<void> {
  try {
    const res = await fetch(receiptsUrl(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ ids: [...byTicket.keys()] }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return
    const json = (await res.json()) as { data?: Record<string, Ticket> }
    const gone: number[] = []
    for (const [ticket, r] of Object.entries(json.data ?? {})) {
      if (r.status === 'error' && r.details?.error === 'DeviceNotRegistered') {
        const id = byTicket.get(ticket)
        if (id != null) gone.push(id)
      }
    }
    await removePhones(gone)
  } catch {
    /* receipts are a clean-up, never a failure */
  }
}

/**
 * Send a push to every phone one user signed in on. Never throws; returns how
 * many phones Expo accepted it for.
 */
export async function sendPhonePush(userId: string, payload: PhonePushPayload): Promise<number> {
  if (!phonePushEnabled()) return 0
  try {
    // Test mode (#832), as browser push: someone outside the allowlist is not pushed;
    // the test recipient's phones get it instead, titled with who it was for.
    const routed = await routePush(userId)
    if (!routed) {
      noteChannel('push', 'dropped')
      return 0
    }
    let data = payload.data ?? {}
    if (routed.userId !== userId) {
      noteChannelRedirect('push')
      userId = routed.userId
      // The notification row belongs to the intended recipient, not the test one.
      data = { ...data, id: null }
      payload = { ...payload, title: `${routed.prefix}${payload.title}` }
    }
    const phones = (await db('nivaro_push_subscriptions')
      .where({ user: userId })
      .where('endpoint', 'like', `${PHONE_PREFIX}%`)
      .select('id', 'endpoint')) as Array<{ id: number; endpoint: string }>
    if (phones.length === 0) return 0

    const badge = await unreadBadge(userId)
    let sent = 0
    const gone: number[] = []
    const byTicket = new Map<string, number>()
    // Expo takes at most 100 messages per request.
    for (let i = 0; i < phones.length; i += 100) {
      const chunk = phones.slice(i, i + 100)
      const messages = chunk.map((p) => ({
        to: p.endpoint.slice(PHONE_PREFIX.length),
        title: payload.title.slice(0, 120),
        body: payload.body.slice(0, 300),
        data,
        sound: 'default',
        priority: 'high',
        ...(badge != null ? { badge } : {})
      }))
      const started = Date.now()
      try {
        const res = await fetch(sendUrl(), {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(15_000)
        })
        const json = (await res.json().catch(() => ({}))) as { data?: Ticket[] }
        if (!res.ok || !Array.isArray(json.data)) {
          noteChannel('push', 'failed', { ms: Date.now() - started, n: chunk.length })
          console.warn('[phone-push] send failed:', res.status)
          continue
        }
        json.data.forEach((t, k) => {
          const phone = chunk[k]
          if (!phone) return
          if (t.status === 'ok') {
            sent++
            if (t.id) byTicket.set(t.id, phone.id)
          } else if (t.details?.error === 'DeviceNotRegistered') {
            gone.push(phone.id)
          }
        })
        noteChannel('push', 'sent', { ms: Date.now() - started, n: chunk.length })
      } catch (err) {
        noteChannel('push', 'failed', { ms: Date.now() - started, n: chunk.length })
        console.warn('[phone-push] send error:', (err as Error)?.message ?? err)
        const { countSwallow } = await import('./swallow-counter.js')
        countSwallow('phone-push-send', err)
      }
    }
    await removePhones(gone)
    if (sent > 0) {
      const okIds = phones.filter((p) => !gone.includes(p.id)).map((p) => p.id)
      await db('nivaro_push_subscriptions')
        .whereIn('id', okIds)
        .update({ last_used_at: new Date() })
        .catch(() => {})
    }
    if (byTicket.size > 0)
      setTimeout(() => void checkReceipts(byTicket), RECEIPT_DELAY_MS).unref?.()
    return sent
  } catch (err) {
    console.warn('[phone-push] sendPhonePush error:', err)
    return 0
  }
}
