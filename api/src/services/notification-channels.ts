import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { sendMail } from './mail.js'

/**
 * Multi-channel user notification service.
 *
 * Channels:
 *  - inapp  : nivaro_notifications row + Socket.io `notification:new` to `user:<id>` room
 *  - email  : sendMail() using the `notification` Liquid template
 *  - sms    : Twilio REST API (fetch, no SDK) — requires user.phone + Twilio config
 *  - push   : Socket.io `push` event to the user room (in-app push)
 *
 * Twilio config resolution: nivaro_settings columns (twilio_account_sid,
 * twilio_auth_token, twilio_from) when present, else env vars
 * TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM. No-op + warn when unset.
 */

interface TwilioConfig {
  accountSid: string
  authToken: string
  from: string
}

async function getTwilioConfig(): Promise<TwilioConfig | null> {
  let settings: Record<string, unknown> | null = null
  try {
    settings = (await db('nivaro_settings').where({ id: 1 }).first()) ?? null
  } catch {
    settings = null
  }

  const accountSid =
    (settings?.twilio_account_sid as string | undefined) || process.env.TWILIO_ACCOUNT_SID || ''
  const authToken =
    (settings?.twilio_auth_token as string | undefined) || process.env.TWILIO_AUTH_TOKEN || ''
  const from = (settings?.twilio_from as string | undefined) || process.env.TWILIO_FROM || ''

  if (!accountSid || !authToken || !from) return null
  return { accountSid, authToken, from }
}

/** Send an SMS via the Twilio REST API. No-op (with warning) when unconfigured. */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const cfg = await getTwilioConfig()
  if (!cfg) {
    console.warn('[notification-channels] Twilio not configured, skipping SMS to', to)
    return false
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`
    const auth = Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')
    const params = new URLSearchParams({ To: to, From: cfg.from, Body: body })

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000)
    })

    if (!res.ok) {
      console.warn('[notification-channels] Twilio SMS failed with status', res.status)
      return false
    }
    return true
  } catch (err) {
    console.warn('[notification-channels] Twilio SMS error:', err)
    return false
  }
}

/** In-app push: emits a `push` event to the user's personal Socket.io room. */
export function sendPush(
  app: FastifyInstance,
  userId: string,
  payload: Record<string, unknown>
): void {
  if (!app.io) return
  app.io.to(`user:${userId}`).emit('push', payload)
}

export interface NotifyUserOptions {
  subject: string
  message: string
  collection?: string | null
  item?: string | null
  sender?: string | null
  /** Defaults: inapp true, email false, sms false. */
  channels?: { inapp?: boolean; email?: boolean; sms?: boolean }
}

/**
 * Notify a single user across the requested channels.
 * In-app (default on) inserts a nivaro_notifications row and emits to the
 * user's Socket.io room; email and SMS are opt-in via `channels`.
 */
export async function notifyUser(
  app: FastifyInstance,
  userId: string,
  opts: NotifyUserOptions
): Promise<void> {
  const channels = { inapp: true, email: false, sms: false, ...(opts.channels ?? {}) }
  const now = new Date()

  try {
    if (channels.inapp) {
      const [notif] = await db('nivaro_notifications')
        .insert({
          recipient: userId,
          subject: opts.subject.slice(0, 255),
          status: 'inbox',
          timestamp: now,
          sender: opts.sender ?? null,
          message: opts.message.slice(0, 500),
          collection: opts.collection ?? null,
          item: opts.item ?? null
        })
        .returning('*')

      if (app.io) {
        emitNotification(app.io, userId, {
          id: (notif as { id?: number } | undefined)?.id ?? null,
          subject: opts.subject.slice(0, 255),
          message: opts.message.slice(0, 200),
          collection: opts.collection ?? null,
          item: opts.item ?? null,
          sender: opts.sender ?? null,
          timestamp: now
        })
      }
    }

    if (channels.email || channels.sms) {
      const user = (await db('nivaro_users').where({ id: userId }).first()) as
        | { email: string | null; first_name: string | null; phone?: string | null }
        | undefined

      if (channels.email && user?.email) {
        await sendMail({
          to: user.email,
          subject: opts.subject,
          template: 'notification',
          data: {
            first_name: user.first_name,
            message: opts.message,
            ...(opts.collection && opts.item
              ? {
                  action_url: `${config.ADMIN_URL}/collections/${opts.collection}/${opts.item}`,
                  action_label: 'View item'
                }
              : {})
          }
        })
      }

      if (channels.sms && user?.phone) {
        await sendSms(user.phone, `${opts.subject}\n${opts.message}`.slice(0, 1600))
      }
    }
  } catch (err) {
    // Notifications are non-critical — never break the calling flow
    console.warn('[notification-channels] notifyUser error:', err)
  }
}
