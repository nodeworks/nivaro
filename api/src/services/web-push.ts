import { createHash } from 'node:crypto'
import webpush from 'web-push'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { routePush } from './channel-test-mode.js'
import { PHONE_PREFIX, type PhonePushPayload, sendPhonePush } from './phone-push.js'
import { RELAY_PREFIX } from './push-relay.js'
import { noteChannel, noteChannelRedirect } from './traffic-taps/channels.js'

/**
 * Web Push (browser push notifications, PWA).
 *
 * VAPID key resolution: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY env vars first,
 * then nivaro_settings columns. If neither is set, a keypair is generated
 * ONCE on first use and persisted to nivaro_settings — zero-setup default.
 * Subscriptions live in nivaro_push_subscriptions (unique per endpoint hash);
 * dead endpoints (404/410 from the push service) are pruned on send.
 */

interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

let cached: VapidKeys | null = null

export async function getVapidKeys(): Promise<VapidKeys> {
  if (cached) return cached

  const envPub = process.env.VAPID_PUBLIC_KEY ?? ''
  const envPriv = process.env.VAPID_PRIVATE_KEY ?? ''
  const subject = process.env.VAPID_SUBJECT || `mailto:admin@${safeHost()}`

  if (envPub && envPriv) {
    cached = { publicKey: envPub, privateKey: envPriv, subject }
    return cached
  }

  const settings = (await db('nivaro_settings').where({ id: 1 }).first()) as
    | Record<string, unknown>
    | undefined
  const dbPub = (settings?.vapid_public_key as string | null) ?? null
  const dbPriv = (settings?.vapid_private_key as string | null) ?? null
  if (dbPub && dbPriv) {
    cached = {
      publicKey: dbPub,
      privateKey: dbPriv,
      subject: (settings?.vapid_subject as string | null) || subject
    }
    return cached
  }

  // First use: generate + persist
  const keys = webpush.generateVAPIDKeys()
  await db('nivaro_settings').where({ id: 1 }).update({
    vapid_public_key: keys.publicKey,
    vapid_private_key: keys.privateKey,
    vapid_subject: subject
  })
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey, subject }
  return cached
}

function safeHost(): string {
  try {
    return new URL(config.PUBLIC_URL).hostname
  } catch {
    return 'localhost'
  }
}

export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

export interface PushPayload {
  title: string
  body: string
  url?: string | null
  tag?: string | null
  /** Chat: the room this push is about. The service worker keeps one
   *  notification per room and counts the messages in it (#967). */
  room?: string | null
  /** Chat: one-time token that lets the notification's inline Reply post
   *  into the room as the recipient (#956). */
  reply_token?: string | null
  /** Chaos (#2861): one-time token behind the notification's Stop action, which ends every
   *  fault on the instance (`POST /api/chaos/stop-all/push`). */
  stop_token?: string | null
  /** The inbox row this push is about: the notification's Mark as read action
   *  and a click both mark it read. */
  id?: number | null
  /** Notification category — picks the icon (`/push/<key>.png`, PUSH_ICON_CATEGORIES). */
  category?: string | null
  /** Inbox lane: critical stays on screen, FYI arrives silently, needs-you
   *  and critical carry a corner dot on the icon. */
  lane?: 'critical' | 'needs_you' | 'fyi' | null
  /** When it happened (ISO); the notification shows this time, not the arrival. */
  at?: string | null
  /** The record it is about: a newer push about the same record replaces the
   *  older one instead of stacking (the inbox keeps every row). */
  collection?: string | null
  item?: string | number | null
}

/**
 * Categories with their own notification icon (scripts/push-icons.mjs draws
 * them into admin/public/push and efp-new/public/push). Anything else shows
 * the app's own mark (`default`).
 */
export const PUSH_ICON_CATEGORIES = [
  'workflow',
  'approvals',
  'tasks',
  'mentions',
  'watch',
  'alerts',
  'anomaly',
  'sla',
  'reports',
  'integrations',
  'system',
  'security',
  'chat',
  'huddle',
  'chaos'
] as const

const ICON_ALIASES: Record<string, (typeof PUSH_ICON_CATEGORIES)[number]> = {
  approval: 'approvals',
  task: 'tasks',
  mention: 'mentions',
  alert: 'alerts',
  audit: 'security',
  access: 'security',
  report: 'reports',
  integration: 'integrations'
}

/** The icon file key for a category + lane, e.g. `sla-needs`, `default`. */
export function pushIconKey(category: string | null | undefined, lane?: string | null): string {
  const c = String(category ?? '').toLowerCase()
  const base = (PUSH_ICON_CATEGORIES as readonly string[]).includes(c)
    ? c
    : (ICON_ALIASES[c] ?? 'default')
  return lane === 'critical' ? `${base}-critical` : lane === 'needs_you' ? `${base}-needs` : base
}

/** The JSON the service workers read (admin/public/sw.js, efp-new/public/sw.js). */
export function pushBody(payload: PushPayload): string {
  const recordTag =
    payload.collection && payload.item != null && payload.item !== ''
      ? `rec-${payload.collection}-${payload.item}`
      : null
  const category = payload.category ?? (payload.room ? 'chat' : payload.stop_token ? 'chaos' : null)
  return JSON.stringify({
    title: payload.title.slice(0, 120),
    body: payload.body.slice(0, 300),
    url: payload.url ?? null,
    tag: payload.tag ?? recordTag ?? (payload.id != null ? `n-${payload.id}` : null),
    room: payload.room ?? null,
    reply_token: payload.reply_token ?? null,
    stop_token: payload.stop_token ?? null,
    id: payload.id ?? null,
    icon: pushIconKey(category, payload.lane),
    lane: payload.lane ?? null,
    at: payload.at ?? null
  })
}

/**
 * Send a web push to every registered browser of one user.
 * Fire-and-forget safe: never throws; prunes dead subscriptions.
 */
export async function sendWebPush(userId: string, payload: PushPayload): Promise<number> {
  try {
    // Test mode (#832): a person outside the allowlist is not pushed; the test
    // recipient's browsers get it instead, titled with who it was for.
    const routed = await routePush(userId)
    if (!routed) {
      noteChannel('push', 'dropped')
      return 0
    }
    if (routed.userId !== userId) {
      noteChannelRedirect('push')
      userId = routed.userId
      // A redirected push must not carry a chat reply token for someone else.
      payload = {
        ...payload,
        title: `${routed.prefix}${payload.title}`,
        reply_token: undefined,
        stop_token: undefined,
        // Not their row: Mark as read would 404 for the test recipient.
        id: undefined
      }
    }
    // Phones share the table (services/phone-push.ts) and go out through Expo or the push relay.
    const subs = (await db('nivaro_push_subscriptions')
      .where({ user: userId })
      .where('endpoint', 'not like', `${PHONE_PREFIX}%`)
      .where('endpoint', 'not like', `${RELAY_PREFIX}%`)) as Array<{
      id: number
      endpoint: string
      keys_p256dh: string
      keys_auth: string
    }>
    if (subs.length === 0) return 0

    const vapid = await getVapidKeys()
    const body = pushBody(payload)

    let sent = 0
    for (const sub of subs) {
      // #1140: each device push is a call into the Traffic Map's web-push node.
      const started = Date.now()
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth }
          },
          body,
          {
            vapidDetails: {
              subject: vapid.subject,
              publicKey: vapid.publicKey,
              privateKey: vapid.privateKey
            },
            TTL: 60 * 60 * 24
          }
        )
        sent++
        noteChannel('push', 'sent', { ms: Date.now() - started })
        await db('nivaro_push_subscriptions')
          .where({ id: sub.id })
          .update({ last_used_at: new Date() })
      } catch (err) {
        noteChannel('push', 'failed', { ms: Date.now() - started })
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await db('nivaro_push_subscriptions').where({ id: sub.id }).del()
        } else {
          console.warn('[web-push] send failed:', status ?? err)
          const { countSwallow } = await import('./swallow-counter.js')
          countSwallow('web-push-send', err)
        }
      }
    }
    return sent
  } catch (err) {
    console.warn('[web-push] sendWebPush error:', err)
    return 0
  }
}

/**
 * A notification's push: every browser (web push) and every phone (Expo) the
 * person signed in on. Returns how many devices took it. Never throws.
 */
export async function sendDevicePush(
  userId: string,
  payload: PushPayload & { phone?: PhonePushPayload['data'] }
): Promise<number> {
  const { phone, ...web } = payload
  const [browsers, phones] = await Promise.all([
    sendWebPush(userId, web),
    sendPhonePush(userId, {
      title: web.title,
      body: web.body,
      data: { url: web.url ?? null, ...phone }
    })
  ])
  return browsers + phones
}
