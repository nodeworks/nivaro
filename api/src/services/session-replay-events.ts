/**
 * A recording's rrweb events as stored (gzip chunks in nivaro_session_events,
 * masked at recording time), and the window cut an export (#1375) or a spec
 * (#1393) is made from.
 */
import { db } from '../db/index.js'
import { chainChunks, chainParts, ensureChainHot } from './session-recording-chain.js'
import { parsedChunks } from './session-replay-chunks.js'
import { ensureRecordingHot } from './session-replay-storage.js'

export type RrwebEvent = { type: number; timestamp: number; data?: Record<string, unknown> }

/** rrweb EventType values this file cares about. */
const FULL_SNAPSHOT = 2
const META = 4

/**
 * Every event of a recording in order; a corrupt chunk is skipped (a partial
 * replay beats none). A session that rolled over into parts is read whole
 * (./session-recording-chain).
 */
export async function loadRecordingEvents(recordingId: string): Promise<RrwebEvent[]> {
  const parts = await chainParts(recordingId)
  // #1411 — a cold recording is read back from object storage first.
  if (parts.length > 1) await ensureChainHot(parts, { wait: true }).catch(() => null)
  else await ensureRecordingHot(recordingId, { wait: true }).catch(() => null)
  const chunks =
    parts.length > 1
      ? await chainChunks(parts)
      : ((await db('nivaro_session_events')
          .where({ recording: recordingId })
          .orderBy('seq', 'asc')
          .select('events')) as Array<{ events: string }>)
  const events: RrwebEvent[] = []
  // An export or a spec is cut from the events themselves, so they are parsed — one chunk
  // at a time, inflated off the event loop, the loop free in between
  // (./session-replay-chunks). A corrupt chunk is skipped there.
  for await (const parsed of parsedChunks(chunks)) {
    if (!Array.isArray(parsed)) continue
    for (const e of parsed) {
      if (e && typeof e === 'object' && typeof (e as RrwebEvent).timestamp === 'number') {
        events.push(e as RrwebEvent)
      }
    }
  }
  return events
}

export interface ReplayWindow {
  /** The events to replay: a Meta + full snapshot at or before `from`, then on to `to`. */
  events: RrwebEvent[]
  /** Where playback starts, in ms from the first returned event. */
  startOffsetMs: number
  /** Where playback ends, in ms from the first returned event. */
  endOffsetMs: number
  /** The window as asked, in ms from the recording's first event (clamped). */
  fromMs: number
  toMs: number
}

/**
 * Cut a window out of a recording. Offsets are ms from the recording's first
 * event — the player's clock. A replay cannot start mid-stream: it needs the
 * DOM as it was, so the window opens at the latest full snapshot at or before
 * `fromMs` (with the Meta event that precedes it, which carries the viewport),
 * and playback is told to start `startOffsetMs` into that. Events after `toMs`
 * are dropped. Null when the recording has no full snapshot to start from.
 */
export function cutReplayWindow(
  all: RrwebEvent[],
  fromMs?: number | null,
  toMs?: number | null
): ReplayWindow | null {
  if (all.length === 0) return null
  const events = [...all].sort((a, b) => a.timestamp - b.timestamp)
  const t0 = events[0].timestamp
  const last = events[events.length - 1].timestamp - t0
  const from = Math.min(Math.max(0, Math.floor(fromMs ?? 0)), last)
  const to = Math.max(from, Math.min(last, toMs == null ? last : Math.floor(toMs)))
  const fromTs = t0 + from
  const toTs = t0 + to

  let snap = -1
  for (let i = 0; i < events.length && events[i].timestamp <= fromTs; i++) {
    if (events[i].type === FULL_SNAPSHOT) snap = i
  }
  // Asked for a moment before the first snapshot: start at the first one.
  if (snap < 0) snap = events.findIndex((e) => e.type === FULL_SNAPSHOT)
  if (snap < 0) return null

  let meta = -1
  for (let i = snap - 1; i >= 0; i--) {
    if (events[i].type === META) {
      meta = i
      break
    }
  }
  const out: RrwebEvent[] = meta >= 0 ? [events[meta]] : []
  for (let i = snap; i < events.length; i++) {
    const e = events[i]
    // The snapshot itself always rides along, even when it sits after `to`.
    if (i > snap && e.timestamp > toTs) break
    out.push(e)
  }
  // The Meta can be older than the snapshot by a moment: playback is timed from it.
  const base = out[0].timestamp
  const startTs = Math.max(fromTs, events[snap].timestamp)
  return {
    events: out,
    startOffsetMs: Math.max(0, startTs - base),
    endOffsetMs: Math.max(0, Math.max(toTs, startTs) - base),
    fromMs: startTs - t0,
    toMs: Math.max(to, startTs - t0)
  }
}
