import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import { pubsub, topics } from '../graphql/pubsub.js'

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
}

const CHANNEL = 'nvr:item-events'
const NODE = randomUUID()
let pub: Redis | null = null
let sub: Redis | null = null

function deliver(ev: ItemEvent): void {
  const payload = { itemMutated: { ...ev, data: null } }
  pubsub.publish(topics.itemMutated(ev.collection, ev.item), payload)
  pubsub.publish(topics.itemMutated(ev.collection, '*'), payload)
}

export function publishItemEvent(ev: Omit<ItemEvent, 'at'>): void {
  const full: ItemEvent = { ...ev, at: new Date().toISOString() }
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
        const msg = JSON.parse(raw) as { node: string; ev: ItemEvent }
        if (msg.node === NODE) return
        deliver(msg.ev)
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
