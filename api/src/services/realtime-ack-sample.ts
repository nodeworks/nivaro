/**
 * Which journaled events ask real clients for a delivery acknowledgement (#2477). A leaf module
 * (no imports) because the journal and the stream reader read it on every emit.
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
