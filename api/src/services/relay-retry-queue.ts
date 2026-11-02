import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import {
  pushRelayConfig,
  RELAY_BATCH,
  type RelayMessage,
  type RelayResults,
  relaySendChecked
} from './push-relay.js'
import { captureTenant } from './tenant-capture.js'
import { currentTenantKey } from './tenant-rooms.js'
import { noteChannel } from './traffic-taps/channels.js'

/**
 * Relay messages the relay's limiter refused (429). Its limit counts MESSAGES per fixed window
 * (60 a minute on a public key), so a refused batch is not resent at once: it waits here.
 *
 *  - ONE queue per tenant (currentTenantKey()), at most RELAY_QUEUE_MAX messages; past that the
 *    oldest are dropped (logged once per backlog).
 *  - ONE timer per tenant drains it, from the background (the tenant it was queued in, the
 *    background pool) — never inside a request — at most RELAY_WINDOW_MESSAGES per window,
 *    paced by the relay's Retry-After (else one window).
 *  - While a tenant's relay is limiting ("limited until"), new sends go straight into the queue
 *    instead of calling the relay (phone-push.ts sendViaRelay).
 *
 * A batch the relay refuses for any other reason (down, 5xx) is counted and dropped, as a direct
 * send is: the in-app notification is the record, the push only a nudge.
 */

export const RELAY_QUEUE_MAX = 500
/** Messages one window may carry: the public relay key's limit. */
export const RELAY_WINDOW_MESSAGES = 60
export const RELAY_WINDOW_S = 60

export interface RelayQueueItem {
  message: RelayMessage
  /** The nivaro_push_subscriptions row the message is for (gone → deleted, ok → touched). */
  rowId: number
}

interface TenantQueue {
  items: RelayQueueItem[]
  timer: ReturnType<typeof setTimeout> | null
  draining: boolean
  limitedUntil: number
  dropLogged: boolean
  inTenant: <T>(fn: () => Promise<T>) => Promise<T>
}

const queues = new Map<string, TenantQueue>()

const clampWait = (s: number) => Math.min(RELAY_WINDOW_S, Math.max(1, Math.ceil(s || 0)))

/** How long (ms) this tenant's relay is still limiting; 0 = send directly. */
export function relayLimitedMs(): number {
  const q = queues.get(currentTenantKey())
  return q ? Math.max(0, q.limitedUntil - Date.now()) : 0
}

/** Messages waiting for this tenant. */
export function relayQueueSize(): number {
  return queues.get(currentTenantKey())?.items.length ?? 0
}

/** Test hook: forget every queue and its timer. */
export function resetRelayQueues(): void {
  for (const q of queues.values()) if (q.timer) clearTimeout(q.timer)
  queues.clear()
}

/**
 * Queue refused messages for this tenant; the relay is limiting for `retryAfterS` (clamped to
 * 1..60 s). Starts this tenant's one drain timer when none runs. Never throws.
 */
export function enqueueRelay(items: RelayQueueItem[], retryAfterS: number): void {
  if (items.length === 0) return
  const key = currentTenantKey()
  let q = queues.get(key)
  if (!q) {
    q = {
      items: [],
      timer: null,
      draining: false,
      limitedUntil: 0,
      dropLogged: false,
      inTenant: captureTenant()
    }
    queues.set(key, q)
  }
  q.items.push(...items)
  const over = q.items.length - RELAY_QUEUE_MAX
  if (over > 0) {
    q.items.splice(0, over)
    if (!q.dropLogged) {
      q.dropLogged = true
      console.warn(`[phone-push] relay queue full: dropped ${over} oldest message(s)`)
    }
  }
  q.limitedUntil = Math.max(q.limitedUntil, Date.now() + clampWait(retryAfterS) * 1000)
  schedule(key, q)
}

function schedule(key: string, q: TenantQueue): void {
  if (q.timer || q.draining) return
  const t = setTimeout(
    () => {
      q.timer = null
      void drain(key, q)
    },
    Math.max(0, q.limitedUntil - Date.now())
  )
  t.unref?.()
  q.timer = t
}

async function drain(key: string, q: TenantQueue): Promise<void> {
  q.draining = true
  try {
    await q.inTenant(() =>
      runInBackgroundPool(async () => {
        const cfg = await pushRelayConfig()
        if (!cfg.key) {
          console.warn(
            `[phone-push] relay not connected: ${q.items.length} queued message(s) dropped`
          )
          q.items = []
          return
        }
        let budget = RELAY_WINDOW_MESSAGES
        let limited = false
        const delivered: number[] = []
        const gone: number[] = []
        while (q.items.length > 0 && budget > 0) {
          const batch = q.items.slice(0, Math.min(RELAY_BATCH, budget))
          const started = Date.now()
          const res = await relaySendChecked(
            cfg,
            batch.map((i) => i.message)
          )
          if (res && 'retryAfter' in res) {
            q.limitedUntil = Date.now() + clampWait(res.retryAfter) * 1000
            limited = true
            break
          }
          q.items.splice(0, batch.length)
          budget -= batch.length
          if (!res) {
            noteChannel('push', 'failed', { ms: Date.now() - started, n: batch.length })
            continue
          }
          tally(res.results, batch, delivered, gone)
          noteChannel('push', 'sent', { ms: Date.now() - started, n: batch.length })
        }
        // A window's worth went out: the next waits for the next window.
        if (!limited && q.items.length > 0) q.limitedUntil = Date.now() + RELAY_WINDOW_S * 1000
        await applyOutcome(delivered, gone)
      })
    )
  } catch (err) {
    console.warn('[phone-push] relay queue drain failed:', (err as Error)?.message ?? err)
  } finally {
    q.draining = false
    if (q.items.length > 0) schedule(key, q)
    else if (queues.get(key) === q) queues.delete(key)
  }
}

function tally(
  results: RelayResults,
  batch: RelayQueueItem[],
  delivered: number[],
  gone: number[]
): void {
  const byDevice = new Map(batch.map((i) => [i.message.device, i.rowId]))
  for (const r of results) {
    const id = byDevice.get(r.device)
    if (id == null) continue
    if (r.status === 'ok') delivered.push(id)
    else if (r.status === 'gone') gone.push(id)
  }
}

async function applyOutcome(delivered: number[], gone: number[]): Promise<void> {
  if (gone.length > 0)
    await db('nivaro_push_subscriptions')
      .whereIn('id', gone)
      .del()
      .catch(() => {})
  if (delivered.length > 0)
    await db('nivaro_push_subscriptions')
      .whereIn('id', delivered)
      .update({ last_used_at: new Date() })
      .catch(() => {})
}
