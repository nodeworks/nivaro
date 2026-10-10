/**
 * Pure pieces of the replay player: clock formatting, the event rail's
 * offsets / thinning / colours (#1356). No React, no DOM — tested on their own.
 */

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// ── Event rail (#1356) ───────────────────────────────────────────────────────

export type RailKind = 'request' | 'error' | 'route' | 'transition'

/** One row of GET /session-recordings/:id/events-rail. */
export interface RailItem {
  kind: RailKind
  at: string
  label: string
  status?: number
  href?: string
  id?: string | number
}

export interface RailMarker extends RailItem {
  /** ms into the recording. */
  offset: number
}

export interface MarkerGroup {
  /** Earliest offset in the group — where a click seeks. */
  offset: number
  /** 0–1 along the scrubber. */
  left: number
  markers: RailMarker[]
  color: string
}

/**
 * Items further than this outside the recording are dropped; closer ones sit
 * on the edge. The server's window carries a few seconds of clock slack.
 */
export const RAIL_EDGE_MS = 10_000

/** Server timestamps → offsets from the first replay event; out-of-window items skip. */
export function railMarkers(items: RailItem[], firstTs: number, total: number): RailMarker[] {
  const out: RailMarker[] = []
  if (!(total > 0)) return out
  for (const it of items) {
    const ms = Date.parse(it.at)
    if (!Number.isFinite(ms)) continue
    const raw = ms - firstTs
    if (raw < -RAIL_EDGE_MS || raw > total + RAIL_EDGE_MS) continue
    out.push({ ...it, offset: Math.min(total, Math.max(0, raw)) })
  }
  return out.sort((a, b) => a.offset - b.offset)
}

export const RAIL_COLORS = {
  route: '#38bdf8', // sky
  transition: '#8b5cf6', // violet
  error: '#ef4444', // red
  serverError: '#ef4444',
  clientError: '#f59e0b', // amber
  ok: '#94a3b8' // muted slate
} as const

/** Colour + weight of one marker; the heaviest marker colours its group. */
export function markerTone(m: Pick<RailItem, 'kind' | 'status'>): { color: string; rank: number } {
  if (m.kind === 'error') return { color: RAIL_COLORS.error, rank: 6 }
  if (m.kind === 'request') {
    const s = Number(m.status) || 0
    if (s >= 500 || s === 0) return { color: RAIL_COLORS.serverError, rank: 5 }
    if (s >= 400) return { color: RAIL_COLORS.clientError, rank: 4 }
    return { color: RAIL_COLORS.ok, rank: 1 }
  }
  if (m.kind === 'transition') return { color: RAIL_COLORS.transition, rank: 3 }
  return { color: RAIL_COLORS.route, rank: 2 }
}

/**
 * Thin markers to what the scrubber can show: everything that lands in the
 * same `bucketPx`-wide slot becomes one group (500 requests on a 600 px rail
 * stay clickable). Markers must be sorted by offset.
 */
export function thinMarkers(
  markers: RailMarker[],
  total: number,
  widthPx: number,
  bucketPx = 6
): MarkerGroup[] {
  const groups: MarkerGroup[] = []
  if (!(total > 0) || markers.length === 0) return groups
  const slots = Math.max(1, Math.floor(Math.max(widthPx, 1) / bucketPx))
  let slot = -1
  let rank = -1
  for (const m of markers) {
    const s = Math.min(slots - 1, Math.floor((m.offset / total) * slots))
    const tone = markerTone(m)
    const g = groups[groups.length - 1]
    if (g && s === slot) {
      g.markers.push(m)
      if (tone.rank > rank) {
        rank = tone.rank
        g.color = tone.color
      }
      continue
    }
    slot = s
    rank = tone.rank
    groups.push({ offset: m.offset, left: m.offset / total, markers: [m], color: tone.color })
  }
  return groups
}

const KIND_WORD: Record<RailKind, string> = {
  request: 'request',
  error: 'error',
  route: 'page',
  transition: 'transition'
}

/** Hover text for a group: one marker reads as itself; a cluster lists its first few. */
export function groupTip(g: MarkerGroup, max = 6): string {
  if (g.markers.length === 1) return `${fmtClock(g.offset)} · ${g.markers[0].label}`
  const counts = new Map<RailKind, number>()
  for (const m of g.markers) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1)
  const summary = [...counts]
    .map(([k, n]) => `${n} ${KIND_WORD[k]}${n === 1 ? '' : 's'}`)
    .join(', ')
  const lines = g.markers.slice(0, max).map((m) => `${fmtClock(m.offset)} ${m.label}`)
  const more = g.markers.length > max ? [`… ${g.markers.length - max} more`] : []
  return [`${fmtClock(g.offset)} · ${summary}`, ...lines, ...more].join('\n')
}
