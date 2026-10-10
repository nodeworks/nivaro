/**
 * Cutting a time range out of an rrweb recording (#1366, #1415, #1362).
 *
 * A replay can only start from a full snapshot (type 2) with its Meta (type 4)
 * in front of it — the page's DOM and viewport. A range that starts mid-way
 * through a recording therefore begins at the latest full snapshot at or
 * before `fromMs` and carries every event after it, so the DOM is rebuilt
 * exactly as it stood at `fromMs`. The lead-in (snapshot → fromMs) is pinned
 * to the range's first instant: the Replayer applies it synchronously at
 * time 0, and the cut plays from `fromMs` instead of from the snapshot.
 *
 * Custom events (console lines, requests) from the lead-in are dropped — they
 * happened before the range. The latest `route` mark is the exception: it is
 * kept at time 0 so the cut still knows which page it opens on.
 *
 * Events are copied as stored: masking applied by the recorder (inputs,
 * blocked nodes) is the masking of the cut. Pure — no I/O; offsets are ms
 * from the recording's first event, the player's own clock.
 */

export interface ReplayEvent {
  type: number
  timestamp: number
  data?: unknown
  [k: string]: unknown
}

export interface CutResult {
  events: ReplayEvent[]
  /** Where the cut starts, ms from the source's first event (may be later than asked: see below). */
  fromMs: number
  toMs: number
  /** Absolute (epoch ms) first and last instant of the cut. */
  startTs: number
  endTs: number
}

/** m:ss — the player's clock. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const EVENT_TYPE = { DomContentLoaded: 0, Load: 1, FullSnapshot: 2, Meta: 4, Custom: 5 }

function isEvent(e: unknown): e is ReplayEvent {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as ReplayEvent).type === 'number' &&
    typeof (e as ReplayEvent).timestamp === 'number' &&
    Number.isFinite((e as ReplayEvent).timestamp)
  )
}

function customTag(e: ReplayEvent): string | null {
  if (e.type !== EVENT_TYPE.Custom) return null
  const tag = (e.data as { tag?: unknown } | undefined)?.tag
  return typeof tag === 'string' ? tag : null
}

/** Events sorted by timestamp, stable (chunk order breaks ties), junk dropped. */
export function sortEvents(events: unknown[]): ReplayEvent[] {
  return events
    .map((e, i) => [e, i] as const)
    .filter((p): p is readonly [ReplayEvent, number] => isEvent(p[0]))
    .sort((a, b) => a[0].timestamp - b[0].timestamp || a[1] - b[1])
    .map(([e]) => e)
}

/**
 * The events that replay `[fromMs, toMs]` of a recording, or null when the
 * range holds nothing replayable (empty, inverted, or no full snapshot before
 * its end). When no snapshot exists at or before `fromMs` (the range starts
 * before the page was first captured) the cut starts at the first snapshot
 * inside the range, and `fromMs` in the result says so.
 */
export function cutEvents(events: unknown[], fromMs: number, toMs: number): CutResult | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null
  const sorted = sortEvents(events)
  if (sorted.length === 0) return null
  const base = sorted[0].timestamp
  const total = sorted[sorted.length - 1].timestamp - base
  const lo = Math.max(0, Math.min(fromMs, toMs))
  const hi = Math.min(total, Math.max(fromMs, toMs))
  if (!(hi > lo)) return null
  const absFrom = base + lo
  const absTo = base + hi

  let snap = -1
  for (let i = 0; i < sorted.length && sorted[i].timestamp <= absFrom; i++) {
    if (sorted[i].type === EVENT_TYPE.FullSnapshot) snap = i
  }
  if (snap < 0) {
    snap = sorted.findIndex((e) => e.type === EVENT_TYPE.FullSnapshot && e.timestamp <= absTo)
    if (snap < 0) return null
  }
  const startTs = Math.max(absFrom, sorted[snap].timestamp)
  if (!(absTo > startTs)) return null

  let meta = -1
  for (let i = snap - 1; i >= 0; i--) {
    if (sorted[i].type === EVENT_TYPE.Meta) {
      meta = i
      break
    }
  }

  const pin = (e: ReplayEvent): ReplayEvent =>
    e.timestamp < startTs ? { ...e, timestamp: startTs } : e
  const out: ReplayEvent[] = []
  if (meta >= 0) out.push(pin(sorted[meta]))
  let lastRoute: ReplayEvent | null = null
  for (let i = snap; i < sorted.length; i++) {
    const e = sorted[i]
    if (e.timestamp > absTo) break
    if (e.timestamp < startTs) {
      const tag = customTag(e)
      if (tag === 'route') lastRoute = e
      // Other lead-in custom / plugin events happened before the range.
      if (e.type === EVENT_TYPE.Custom || e.type === 6) continue
      out.push(pin(e))
      continue
    }
    if (lastRoute) {
      out.push(pin(lastRoute))
      lastRoute = null
    }
    out.push(e)
  }
  if (lastRoute) out.push(pin(lastRoute))
  return { events: out, fromMs: startTs - base, toMs: hi, startTs, endTs: absTo }
}

/**
 * Split events into storage chunks of at most `maxChars` of JSON each (one
 * oversized event still gets its own chunk). Each chunk is a JSON array, the
 * shape the recorder uploads and /:id/events concatenates.
 */
export function chunkEvents(events: ReplayEvent[], maxChars = 2_000_000): string[] {
  const chunks: string[] = []
  let parts: string[] = []
  let size = 2
  for (const e of events) {
    const json = JSON.stringify(e)
    if (parts.length > 0 && size + json.length + 1 > maxChars) {
      chunks.push(`[${parts.join(',')}]`)
      parts = []
      size = 2
    }
    parts.push(json)
    size += json.length + 1
  }
  if (parts.length > 0) chunks.push(`[${parts.join(',')}]`)
  return chunks
}

export interface ClipSummary {
  /** The page the cut opens on. */
  route: string | null
  /** console.error lines inside the cut, ms from its start. */
  errors: Array<{ offset: number; text: string }>
}

/** Route at the cut's start and its console errors — what an issue raised from it says. */
export function summarizeCut(cut: CutResult): ClipSummary {
  let route: string | null = null
  let metaHref: string | null = null
  const errors: ClipSummary['errors'] = []
  for (const e of cut.events) {
    if (e.type === EVENT_TYPE.Meta && metaHref == null) {
      const href = (e.data as { href?: unknown } | undefined)?.href
      if (typeof href === 'string') metaHref = href
    }
    const tag = customTag(e)
    if (!tag) continue
    const payload = ((e.data as { payload?: Record<string, unknown> }).payload ?? {}) as Record<
      string,
      unknown
    >
    if (tag === 'route' && route == null && e.timestamp <= cut.startTs) {
      route = String(payload.path ?? '') || null
    } else if (tag === 'console' && String(payload.level ?? '') === 'error') {
      errors.push({
        offset: Math.max(0, e.timestamp - cut.startTs),
        text: String(payload.msg ?? '').slice(0, 300)
      })
    }
  }
  if (route == null && metaHref) {
    try {
      route = new URL(metaHref).pathname || '/'
    } catch {
      route = metaHref.split(/[?#]/)[0] || null
    }
  }
  return { route, errors }
}
