import { createHash } from 'node:crypto'
import webpush from 'web-push'
import { config } from '../config.js'
import { db } from '../db/index.js'

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
}

/**
 * Send a web push to every registered browser of one user.
 * Fire-and-forget safe: never throws; prunes dead subscriptions.
 */
export async function sendWebPush(userId: string, payload: PushPayload): Promise<number> {
  try {
    const subs = (await db('nivaro_push_subscriptions').where({ user: userId })) as Array<{
      id: number
      endpoint: string
      keys_p256dh: string
      keys_auth: string
    }>
    if (subs.length === 0) return 0

    const vapid = await getVapidKeys()
    const body = JSON.stringify({
      title: payload.title.slice(0, 120),
      body: payload.body.slice(0, 300),
      url: payload.url ?? null,
      tag: payload.tag ?? null
    })

    let sent = 0
    for (const sub of subs) {
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
        await db('nivaro_push_subscriptions')
          .where({ id: sub.id })
          .update({ last_used_at: new Date() })
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          await db('nivaro_push_subscriptions').where({ id: sub.id }).del()
        } else {
          console.warn('[web-push] send failed:', status ?? err)
        }
      }
    }
    return sent
  } catch (err) {
    console.warn('[web-push] sendWebPush error:', err)
    return 0
  }
}
