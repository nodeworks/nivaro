import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { pubsub, topics } from '../graphql/pubsub.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Record-change events for GraphQL subscriptions (`itemMutated`).
 *
 * The payload names WHAT changed — collection, record, action, the names of
 * the fields written — and never carries a value: a value on a shared feed
 * would reach people whose role or row filter hides it. A subscriber that
 * wants the new data reads the record, where its permissions apply.
 *
 * Events are delivered in the process that made the write at once, and to
 * every other replica over a Redis channel, so a subscription hears a write
 * whichever replica served it.
 */

export interface ItemEvent {
  collection: string
  item: string
  action: 'create' | 'update' | 'delete'
  changed_fields: string[]
  at: string
  /** Cloud: the tenant whose write this was ('' self-hosted) — topics are per tenant. */
  tenant?: string
  /** The event journal position of the matching collection:update (null when unjournaled). */
  seq?: number | null
}

// REDIS_CHANNEL_PREFIX: see plugins/socketio.ts (pub/sub ignores the db index).
const CHANNEL = `${process.env.REDIS_CHANNEL_PREFIX ?? ''}nvr:item-events`
const NODE = randomUUID()
let pub: Redis | null = null
let sub: Redis | null = null

const listeners = new Set<(ev: ItemEvent, remote: boolean) => void>()

/**
 * Hear every record event — this process's own writes and those relayed from other replicas
 * (`remote`). Listeners run synchronously and must be cheap; a throw is swallowed. Returns
 * unsubscribe. (The Traffic Map's temporary cache busts on it, #2273.)
 */
export function onItemEvent(fn: (ev: ItemEvent, remote: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const touchListeners = new Set<(collection: string, tenant: string) => void>()

/**
 * Hear "a record in this collection changed" from OTHER replicas for the broadcasts that carry no
 * action (record aspects like `$state` / `$lock`, raw bulk writes) — those are never itemMutated
 * events, so subscriptions do not see them. Returns unsubscribe. (#2273's temporary cache.)
 */
export function onCollectionTouched(fn: (collection: string, tenant: string) => void): () => void {
  touchListeners.add(fn)
  return () => {
    touchListeners.delete(fn)
  }
}

/** Tell other replicas a record in `collection` changed (no itemMutated event). */
export function publishCollectionTouched(collection: string): void {
  if (!pub) return
  const touched = { collection, tenant: currentTenantKey() }
  pub.publish(CHANNEL, JSON.stringify({ node: NODE, touched })).catch(() => {})
}

function deliver(ev: ItemEvent, remote = false): void {
  for (const fn of listeners) {
    try {
      fn(ev, remote)
    } catch {
      /* a listener never affects delivery */
    }
  }
  const { tenant = '', ...event } = ev
  const payload = {
    itemMutated: { ...event, seq: event.seq == null ? null : String(event.seq), data: null }
  }
  // Only subscribers of the same tenant hear it (they subscribe under their own tenant key).
  // A raw bulk write (#1875) arrives as item '*' — publish it once.
  if (ev.item !== '*') pubsub.publish(topics.itemMutated(ev.collection, ev.item, tenant), payload)
  pubsub.publish(topics.itemMutated(ev.collection, '*', tenant), payload)
}

export function publishItemEvent(ev: Omit<ItemEvent, 'at'>): void {
  // The tenant rides the event, so a replica relaying it over Redis keys it the same way.
  const full: ItemEvent = {
    ...ev,
    tenant: ev.tenant ?? currentTenantKey(),
    at: new Date().toISOString()
  }
  try {
    deliver(full)
  } catch {
    /* a listener must never affect the write that published */
  }
  if (pub) {
    pub.publish(CHANNEL, JSON.stringify({ node: NODE, ev: full })).catch(() => {})
  }
}

export async function initItemEvents(redis: Redis): Promise<void> {
  if (sub) return
  pub = redis
  try {
    const conn = redis.duplicate()
    conn.on('error', () => {})
    await conn.subscribe(CHANNEL)
    conn.on('message', (_channel, raw) => {
      try {
        const msg = JSON.parse(raw) as {
          node: string
          ev?: ItemEvent
          touched?: { collection?: unknown; tenant?: unknown }
        }
        if (msg.node === NODE) return
        if (msg.touched) {
          const c = msg.touched.collection
          if (typeof c !== 'string') return
          const tenant = typeof msg.touched.tenant === 'string' ? msg.touched.tenant : ''
          for (const fn of touchListeners) {
            try {
              fn(c, tenant)
            } catch {
              /* a listener never affects delivery */
            }
          }
          return
        }
        if (msg.ev) deliver(msg.ev, true)
      } catch {
        /* malformed message */
      }
    })
    sub = conn
  } catch {
    // Redis unavailable — events stay within this process.
  }
}

export async function closeItemEvents(): Promise<void> {
  const conn = sub
  sub = null
  pub = null
  if (conn) await conn.quit().catch(() => {})
}
