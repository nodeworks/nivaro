import type { VideoEdits } from '../../types'

/** A lane with one row of bars. */
export const LANE_H = 28
/** One sub-row when a lane stacks bars that overlap in time. */
export const SUB_H = 22
/** Past this many sub-rows, the rest share the last one. */
export const MAX_ROWS = 4

export type Packed = { row: Map<string, number>; rows: number }
type Bar = { id: string; start_ms: number; end_ms: number }

/**
 * Greedy row packing for one lane: bars in start order (then id, so the
 * layout is stable), each on the first row whose last bar ends at or before
 * it starts, else on a new row. At most MAX_ROWS rows; overflow goes on the
 * last row. An empty lane has one row.
 */
export function packRows(bars: Bar[], maxRows = MAX_ROWS): Packed {
  const sorted = [...bars].sort(
    (a, b) => a.start_ms - b.start_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const ends: number[] = []
  const row = new Map<string, number>()
  for (const b of sorted) {
    let r = ends.findIndex((end) => end <= b.start_ms)
    if (r < 0) {
      if (ends.length < maxRows) {
        r = ends.length
        ends.push(b.end_ms)
      } else {
        r = maxRows - 1
        ends[r] = Math.max(ends[r], b.end_ms)
      }
    } else ends[r] = b.end_ms
    row.set(b.id, r)
  }
  return { row, rows: Math.max(1, ends.length) }
}

export type TimedLane = 'annotations' | 'zooms' | 'blurs' | 'captions'
export type LaneKey = 'cuts' | 'chapters' | 'holds' | TimedLane

/** A lane's height: the usual one for a single row, else a sub-row each. */
export const heightFor = (rows: number) => (rows > 1 ? rows * SUB_H : LANE_H)

/** Where each bar sits in the four timed lanes, and every lane's height.
 *  The timeline computes this once per edit and gives it to both the label
 *  column and the lanes, so they always line up. */
export function laneLayout(e: VideoEdits): {
  lanes: Record<TimedLane, Packed>
  height: Record<LaneKey, number>
} {
  const lanes = {
    annotations: packRows(e.annotations),
    zooms: packRows(e.zooms),
    blurs: packRows(e.blurs),
    captions: packRows(e.captions)
  }
  return {
    lanes,
    height: {
      cuts: LANE_H,
      chapters: LANE_H,
      holds: LANE_H,
      annotations: heightFor(lanes.annotations.rows),
      zooms: heightFor(lanes.zooms.rows),
      blurs: heightFor(lanes.blurs.rows),
      captions: heightFor(lanes.captions.rows)
    }
  }
}
