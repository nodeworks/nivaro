import { hostname } from 'node:os'
import type { Redis } from 'ioredis'

/**
 * Which journaled events ask real clients for a delivery acknowledgement (#2477). A leaf module
 * (no app imports) because the journal and the stream reader read it on every emit.
 */

/** 1 in N journaled events carries `_st` for clients to acknowledge (REALTIME_ACK_EVERY; 0 = off). */
export function ackEvery(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REALTIME_ACK_EVERY
  if (raw == null || raw === '') return 50
  const n = Math.floor(Number(raw))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 1_000_000) : 50
}

/** Whether the event with this sequence carries the `_st` stamp clients acknowledge. */
export function ackSampled(seq: number | null | undefined, every: number = ackEvery()): boolean {
  return every > 0 && typeof seq === 'number' && seq > 0 && seq % every === 0
}

/**
 * The time floor (REALTIME_ACK_FLOOR_S, default 30; 0 = off): a process stamps the first
 * journaled event after this long without a stamp, whatever its sequence. 1 in 50 of the
 * cluster's sequence alone left the SLO blind on a read-heavy day (staging demo 2026-10-26: a
 * 45-minute, 32-person session sent so few record events — presence heartbeats are not
 * journaled — that no sampled one reached a connected tab). Off with REALTIME_ACK_EVERY=0.
 */
export function ackFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REALTIME_ACK_FLOOR_S
  if (raw == null || raw === '') return 30_000
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(n, 86_400) * 1000 : 0
}

let lastStampAt = 0

/**
 * Should the event with this sequence carry `_st`? 1 in N by sequence, or the first one after
 * the time floor (`floor: false` for synthetic emits: the probe and drills). Records the stamp.
 */
export function shouldStamp(
  seq: number | null | undefined,
  opts: { now?: number; floor?: boolean; env?: NodeJS.ProcessEnv } = {}
): boolean {
  const env = opts.env ?? process.env
  const every = ackEvery(env)
  if (every <= 0 || typeof seq !== 'number' || !(seq > 0)) return false
  const now = opts.now ?? Date.now()
  const floorMs = opts.floor === false ? 0 : ackFloorMs(env)
  if (seq % every !== 0 && !(floorMs > 0 && now - lastStampAt >= floorMs)) return false
  lastStampAt = now
  return true
}

/** Tests only. */
export function _resetStampFloorForTests(): void {
  lastStampAt = 0
}

/** Seconds the server keeps the `_st` it stamped on a sampled event (acks after that are ignored). */
export const ACK_STAMP_TTL_S = 300

/** Redis key holding the `_st` stamped on sampled event `seq` — an ack must echo it exactly. */
export function ackStampKey(seq: number): string {
  return `nvr:rt:ack:st:${seq}`
}

/** This replica's label in the per-node delivery rows. */
export function deliveryNode(): string {
  const inst = process.env.NIVARO_INSTANCE?.trim() || process.env.NODE_ENV?.trim() || 'default'
  return `${inst} · ${hostname().slice(0, 40)}`
}

/** 5-minute buckets of stamped events written to connected sockets (`e|node`, `s|node`). */
export const SENT_KEY = 'nvr:rt:dlv:s:'
export const SENT_BUCKET_MS = 300_000
const SENT_TTL_S = 26 * 3600

/**
 * A stamped event just went to `sockets` connected sockets in this process (the room's local
 * size). What the delivery check compares the acknowledgements against: sampled events that
 * reached people but drew no ack mean the measurement is broken, not that nothing happened.
 * Fire-and-forget; never in cloud mode (the delivery histograms are not kept per tenant).
 */
export function noteStampedDelivery(
  redis: Pick<Redis, 'multi'> | null | undefined,
  room: string,
  sockets: number,
  opts: { node?: string; at?: number } = {}
): void {
  if (!redis || !(sockets > 0) || process.env.CLOUD_META_DB_URL) return
  // The probe's socket never acknowledges (it is not a person); its delivery is its own sample.
  if (/(^|:)probe:/.test(room)) return
  const node = (opts.node ?? deliveryNode()).replace(/\|/g, '/')
  const key = `${SENT_KEY}${Math.floor((opts.at ?? Date.now()) / SENT_BUCKET_MS)}`
  try {
    void Promise.resolve(
      redis
        .multi()
        .hincrby(key, `e|${node}`, 1)
        .hincrby(key, `s|${node}`, Math.floor(sockets))
        .expire(key, SENT_TTL_S)
        .exec()
    ).catch(() => {})
  } catch {
    /* a lost count never matters */
  }
}

/** How many sockets in this process sit in `room` (0 when the adapter cannot say). */
export function localRoomSize(io: unknown, room: string): number {
  type Nsp = { adapter?: { rooms?: Map<string, Set<string>> } }
  try {
    const s = io as { of?: (nsp: string) => Nsp } | null
    return s?.of?.('/')?.adapter?.rooms?.get(room)?.size ?? 0
  } catch {
    return 0
  }
}
