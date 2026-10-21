import { serverNow } from './server-clock'

/**
 * Realtime delivery acknowledgements (#2477). The server stamps a small sample of events with
 * `_st` (the server time it sent them); a client that receives one answers `rt:ack` with its
 * receive time on the server clock (#2132 offset), so the delivery SLO shows real clients' p95,
 * not only the synthetic probe's. Nothing else rides it: the sequence, the stamp, the time.
 */
export function deliveryAckFor(payload: unknown): { seq: number; st: number; rx: number } | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as { _seq?: unknown; _st?: unknown }
  if (typeof p._seq !== 'number' || typeof p._st !== 'number') return null
  return { seq: p._seq, st: p._st, rx: serverNow() }
}
