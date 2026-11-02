import { db } from '../db/index.js'
import { tenantOrigin } from '../db/tenant-context.js'
import { routePush } from './channel-test-mode.js'
import {
  EXPO_PREFIX,
  type PushRelayConfig,
  pushRelayConfig,
  RELAY_BATCH,
  RELAY_PREFIX,
  type RelayMessage,
  type RelayResults,
  relaySendChecked,
  wherePhoneEndpoint
} from './push-relay.js'
import { enqueueRelay, type RelayQueueItem, relayLimitedMs } from './relay-retry-queue.js'
import { noteChannel, noteChannelRedirect } from './traffic-taps/channels.js'

/**
 * Phone push: alerts on a phone app built with Expo (iOS + Android), sent
 * through the Expo push service.
 *
 * No table of its own: a phone is a `nivaro_push_subscriptions` row whose
 * endpoint is `expo:<Expo push token>` (keys_p256dh = 'expo:<sha256 of the sign-out forget key>', keys_auth =
 * '<platform>:<app id>'). Browser endpoints are always https://, so the two
 * never collide, and every count of "push devices" already includes phones.
 * `sendWebPush` skips these rows; `sendPhonePush` reads only them.
 *
 *   MOBILE_PUSH=off          no phone push at all (registration still stores the phone)
 *   EXPO_ACCESS_TOKEN=       optional: the Expo project's push access token
 *   EXPO_PUSH_URL=           optional: send endpoint (default the Expo service); tests point it at a mock
 *
 * Phones of the official Nivaro app are `relay:<device id>` rows, sent through the Nivaro push
 * relay instead (services/push-relay.ts); `MOBILE_PUSH_RELAY_*` and Settings → mobile_push.
 *
 * Dead phones (Expo says DeviceNotRegistered, on the ticket or on the receipt
 * read back a little later) are removed.
 */

export const PHONE_PREFIX = EXPO_PREFIX
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

/** How phone alerts leave this instance: not at all, straight to Expo, or through the relay. */
export async function phonePushMode(): Promise<'off' | 'direct' | 'relay'> {
  if (!phonePushEnabled()) return 'off'
  return (await pushRelayConfig()).key ? 'relay' : 'direct'
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
    const phones = (await wherePhoneEndpoint(
      db('nivaro_push_subscriptions').where({ user: userId })
    ).select('id', 'endpoint')) as Array<{ id: number; endpoint: string }>
    if (phones.length === 0) return 0

    const badge = await unreadBadge(userId)
    let sent = 0
    const gone: number[] = []
    const delivered: number[] = []
    const byTicket = new Map<string, number>()
    const expoPhones = phones.filter((p) => p.endpoint.startsWith(EXPO_PREFIX))
    const relayPhones = phones.filter((p) => p.endpoint.startsWith(RELAY_PREFIX))
    // Expo takes at most 100 messages per request.
    for (let i = 0; i < expoPhones.length; i += 100) {
      const chunk = expoPhones.slice(i, i + 100)
      const messages = chunk.map((p) => ({
        to: p.endpoint.slice(EXPO_PREFIX.length),
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
            delivered.push(phone.id)
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
    if (relayPhones.length > 0) {
      const cfg = await pushRelayConfig()
      const relayed = await sendViaRelay(cfg, relayPhones, payload, data, badge)
      sent += relayed.delivered.length
      delivered.push(...relayed.delivered)
      gone.push(...relayed.gone)
    }
    await removePhones(gone)
    if (delivered.length > 0) {
      await db('nivaro_push_subscriptions')
        .whereIn('id', delivered)
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

export async function instanceName(): Promise<string> {
  try {
    const row = (await db('nivaro_settings').first('project_name')) as
      | { project_name?: string | null }
      | undefined
    return String(row?.project_name ?? '').trim() || 'Nivaro'
  } catch {
    return 'Nivaro'
  }
}

/**
 * The address this instance is reached on, for the relay's `instance` field and its registration.
 * Cloud: the current tenant's origin (its host or custom domain) — never PUBLIC_URL, the shared
 * process's own address; '' when the work has no tenant host (nothing better to name).
 */
export async function instanceOrigin(): Promise<string> {
  if (process.env.CLOUD_META_DB_URL) return tenantOrigin() ?? ''
  try {
    const { adminBaseUrl } = await import('../admin-base.js')
    return adminBaseUrl() ?? ''
  } catch {
    return ''
  }
}

interface RelayChunk {
  messages: RelayMessage[]
  byDevice: Map<string, number>
}

function tallyResults(
  results: RelayResults,
  byDevice: Map<string, number>,
  out: { delivered: number[]; gone: number[] }
): void {
  for (const r of results) {
    const id = byDevice.get(r.device)
    if (id == null) continue
    if (r.status === 'ok') out.delivered.push(id)
    else if (r.status === 'gone') out.gone.push(id)
  }
}

/**
 * Send to relay phones. `content: 'minimal'` keeps the alert text and record names off the
 * relay and the push networks: the title is the instance name, the body generic, and `data`
 * ids only (the app fetches the notification itself after sign-in). A relay that is down
 * costs the push, never the in-app notification: failed batches are counted, nothing throws.
 */
async function sendViaRelay(
  cfg: PushRelayConfig,
  phones: Array<{ id: number; endpoint: string }>,
  payload: PhonePushPayload,
  data: NonNullable<PhonePushPayload['data']>,
  badge: number | null
): Promise<{ delivered: number[]; gone: number[] }> {
  const out = { delivered: [] as number[], gone: [] as number[] }
  if (!cfg.key) {
    noteChannel('push', 'failed', { ms: 0, n: phones.length })
    console.warn(`[phone-push] relay not connected: skipped ${phones.length} phone(s)`)
    return out
  }
  const instance = await instanceOrigin()
  const strs: Record<string, string> = {}
  if (data.id != null) strs.notification_id = String(data.id)
  if (instance) strs.instance = instance
  let title: string
  let body: string
  let msgData: Record<string, string>
  if (cfg.content === 'minimal') {
    title = await instanceName()
    body = 'You have a new notification'
    msgData = strs
  } else {
    title = payload.title.slice(0, 120)
    body = payload.body.slice(0, 300)
    msgData = { ...strs }
    if (data.url) msgData.url = String(data.url)
    if (data.collection) msgData.collection = String(data.collection)
    if (data.item) msgData.item = String(data.item)
  }
  const chunks: RelayChunk[] = []
  for (let i = 0; i < phones.length; i += RELAY_BATCH) {
    const chunk = phones.slice(i, i + RELAY_BATCH)
    chunks.push({
      byDevice: new Map(chunk.map((p) => [p.endpoint.slice(RELAY_PREFIX.length), p.id])),
      messages: chunk.map((p) => ({
        device: p.endpoint.slice(RELAY_PREFIX.length),
        title,
        body,
        data: msgData,
        ...(badge != null ? { badge } : {})
      }))
    })
  }
  const queued = (from: RelayChunk[]): RelayQueueItem[] =>
    from.flatMap((c) =>
      c.messages.map((message) => ({ message, rowId: c.byDevice.get(message.device) as number }))
    )
  // The relay is limiting this tenant right now: straight into the queue, no call.
  const waitMs = relayLimitedMs()
  if (waitMs > 0) {
    enqueueRelay(queued(chunks), waitMs / 1000)
    return out
  }
  for (const [k, c] of chunks.entries()) {
    const started = Date.now()
    const res = await relaySendChecked(cfg, c.messages)
    if (res && 'retryAfter' in res) {
      // The limit counts messages: anything sent now is refused too. This batch and the rest
      // wait in the tenant's queue, drained in the background (relay-retry-queue.ts).
      noteChannel('push', 'failed', { ms: Date.now() - started, n: c.messages.length })
      enqueueRelay(queued(chunks.slice(k)), res.retryAfter)
      break
    }
    if (!res) {
      noteChannel('push', 'failed', { ms: Date.now() - started, n: c.messages.length })
      continue
    }
    tallyResults(res.results, c.byDevice, out)
    noteChannel('push', 'sent', { ms: Date.now() - started, n: c.messages.length })
  }
  return out
}
