import { gunzipSync } from 'node:zlib'
import { db } from '../db/index.js'
import { chunkArray } from './db-batch.js'
import { ReplayNodeMap, type RrwebEventLike } from './session-replay-heat-nodes.js'
import { ensureRecordingHot } from './session-replay-storage.js'
import { normalizeScreenPath } from './traffic-client-facts.js'

/**
 * Click and scroll heatmaps (#1364).
 *
 * A nightly job folds finished recordings into per-route aggregates in
 * nivaro_replay_heat: where on the viewport people clicked (2% buckets of
 * width and height), on which element (a selector that means the same
 * element in every session), and how far down each route visit scrolled.
 * Rows are keyed by app, route pattern, UTC day and viewport class — never by
 * person, recording or session. Once folded, nothing in the aggregate says
 * whose click it was.
 *
 * The fold is bounded and incremental: each run takes at most
 * HEAT_MAX_RECORDINGS recordings / HEAT_MAX_BYTES stored bytes, oldest first,
 * and stamps each with heat_folded_at (the high-water mark) so the next run
 * carries on where this one stopped. Error clips are left out: they exist
 * because something broke, so they would weight the map toward failures.
 *
 * Per route it also keeps a pointer to the newest moment a recording showed
 * that route (nivaro_replay_heat_frames). The Heat tab renders that frame
 * under the overlay; the DOM itself stays in the recording and goes with its
 * retention.
 */

export const HEAT_MAX_RECORDINGS = 300
export const HEAT_MAX_BYTES = 250_000_000
/** A recording still being written is left for a later run. */
export const HEAT_SETTLE_MS = 60 * 60_000
export const HEAT_RETENTION_DAYS = 180
/** Positions are folded into BUCKETS × BUCKETS cells of the viewport (2% each). */
export const BUCKETS = 50
/** Scroll depth is counted in quarter viewport heights; 4 = never scrolled. */
export const DEPTH_STEPS_PER_SCREEN = 4
export const DEPTH_MAX = 80
const INSERT_CHUNK = 150

/** rrweb constants. */
const EV_FULL_SNAPSHOT = 2
const EV_INCREMENTAL = 3
const EV_META = 4
const EV_CUSTOM = 5
const SRC_MOUSE_INTERACTION = 2
const SRC_SCROLL = 3
const SRC_VIEWPORT_RESIZE = 4
const MOUSE_CLICK = 2

export type HeatKind = 'click' | 'scroll'

export interface HeatCell {
  app: string
  route: string
  day: string
  kind: HeatKind
  selector: string | null
  x_bucket: number | null
  y_bucket: number | null
  depth_bucket: number | null
  viewport: string
  count: number
}

export interface HeatFrame {
  app: string
  route: string
  recording_id: string
  at_ms: number
  width: number | null
  height: number | null
}

/** Viewport width class — a phone and a wide monitor lay the same route out differently. */
export function viewportClass(width: number): string {
  if (width < 640) return 'xs'
  if (width < 1024) return 'sm'
  if (width < 1440) return 'md'
  if (width < 1920) return 'lg'
  return 'xl'
}

export function bucketOf(v: number, size: number): number {
  if (!(size > 0) || !Number.isFinite(v)) return 0
  return Math.min(BUCKETS - 1, Math.max(0, Math.floor((v / size) * BUCKETS)))
}

/** Deepest scroll offset → quarter viewport heights reached (4 = the first screen only). */
export function depthBucket(maxScrollY: number, viewportHeight: number): number {
  if (!(viewportHeight > 0)) return DEPTH_STEPS_PER_SCREEN
  const y = Math.max(0, Number.isFinite(maxScrollY) ? maxScrollY : 0)
  return Math.min(
    DEPTH_MAX,
    Math.max(
      DEPTH_STEPS_PER_SCREEN,
      Math.floor(((y + viewportHeight) / viewportHeight) * DEPTH_STEPS_PER_SCREEN)
    )
  )
}

export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** A recorded href or path → route pattern, or null. */
export function routeOf(hrefOrPath: unknown): string | null {
  if (typeof hrefOrPath !== 'string' || !hrefOrPath) return null
  let path = hrefOrPath
  if (!path.startsWith('/')) {
    try {
      path = new URL(path).pathname
    } catch {
      return null
    }
  }
  return normalizeScreenPath(path)
}

const cellKey = (c: Omit<HeatCell, 'count'>) =>
  [
    c.app,
    c.route,
    c.day,
    c.kind,
    c.selector ?? '',
    c.x_bucket ?? '',
    c.y_bucket ?? '',
    c.depth_bucket ?? '',
    c.viewport
  ].join('\u0001')

/** Sums cells across recordings (and, on merge, with what the table already holds). */
export class HeatAccumulator {
  readonly cells = new Map<string, HeatCell>()
  add(c: Omit<HeatCell, 'count'>, n = 1): void {
    const key = cellKey(c)
    const cur = this.cells.get(key)
    if (cur) cur.count += n
    else this.cells.set(key, { ...c, count: n })
  }
  /** Cells grouped by (app, route, day) — the unit the merge rewrites. */
  groups(): Map<string, HeatCell[]> {
    const out = new Map<string, HeatCell[]>()
    for (const c of this.cells.values()) {
      const k = `${c.app}\u0001${c.route}\u0001${c.day}`
      const list = out.get(k) ?? []
      list.push(c)
      out.set(k, list)
    }
    return out
  }
}

interface Visit {
  route: string
  start: number
  lastTs: number
  lastClick: number | null
  maxScrollY: number
  width: number | null
  height: number | null
}

/**
 * Folds ONE recording's event stream, event by event (chunks can be fed as
 * they are decoded — nothing holds the whole recording). Call finish() at
 * the end. Pure: no db.
 */
export class RecordingHeatFolder {
  private readonly nodes = new ReplayNodeMap()
  private width: number | null = null
  private height: number | null = null
  private visit: Visit | null = null
  private readonly frames = new Map<string, HeatFrame>()
  clicks = 0
  unresolved = 0

  constructor(
    private readonly acc: HeatAccumulator,
    private readonly recording: { id: string; app: string | null }
  ) {}

  private get app(): string {
    return this.recording.app || 'admin'
  }

  private enter(route: string, ts: number): void {
    if (this.visit?.route === route) return
    this.closeVisit()
    this.visit = {
      route,
      start: ts,
      lastTs: ts,
      lastClick: null,
      maxScrollY: 0,
      width: this.width,
      height: this.height
    }
  }

  private closeVisit(): void {
    const v = this.visit
    this.visit = null
    if (!v) return
    const width = v.width ?? this.width
    const height = v.height ?? this.height
    if (width && height) {
      this.acc.add({
        app: this.app,
        route: v.route,
        day: utcDay(v.start),
        kind: 'scroll',
        selector: null,
        x_bucket: null,
        y_bucket: null,
        depth_bucket: depthBucket(v.maxScrollY, height),
        viewport: viewportClass(width)
      })
    }
    // The frame shows the route as the person last acted on it (a settled,
    // interactive page), else a moment after it opened.
    const at = v.lastClick ?? v.start + Math.min(2_000, Math.max(0, (v.lastTs - v.start) / 2))
    const key = `${this.app}\u0001${v.route}`
    const prev = this.frames.get(key)
    if (!prev || at > prev.at_ms) {
      this.frames.set(key, {
        app: this.app,
        route: v.route,
        recording_id: this.recording.id,
        at_ms: Math.round(at),
        width,
        height
      })
    }
  }

  push(e: RrwebEventLike): void {
    if (!e || typeof e.type !== 'number') return
    const ts = Number(e.timestamp)
    if (!Number.isFinite(ts)) return
    if (this.visit) this.visit.lastTs = Math.max(this.visit.lastTs, ts)

    if (e.type === EV_META) {
      const w = Number(e.data?.width)
      const h = Number(e.data?.height)
      if (w > 0 && h > 0) {
        this.width = w
        this.height = h
        if (this.visit && this.visit.width == null) {
          this.visit.width = w
          this.visit.height = h
        }
      }
      const route = routeOf(e.data?.href)
      if (route) this.enter(route, ts)
      return
    }
    if (e.type === EV_FULL_SNAPSHOT) {
      this.nodes.ingest(e)
      return
    }
    if (e.type === EV_CUSTOM) {
      if (e.data?.tag !== 'route') return
      const route = routeOf((e.data?.payload as { path?: unknown } | undefined)?.path)
      if (route) this.enter(route, ts)
      return
    }
    if (e.type !== EV_INCREMENTAL || !e.data) return
    const source = Number(e.data.source)
    if (source === 0) {
      this.nodes.ingest(e)
      return
    }
    if (source === SRC_VIEWPORT_RESIZE) {
      const w = Number(e.data.width)
      const h = Number(e.data.height)
      if (w > 0 && h > 0) {
        this.width = w
        this.height = h
      }
      return
    }
    if (!this.visit) return
    if (source === SRC_SCROLL) {
      const y = Number(e.data.y)
      if (Number.isFinite(y) && y > this.visit.maxScrollY) this.visit.maxScrollY = y
      return
    }
    if (source === SRC_MOUSE_INTERACTION && Number(e.data.type) === MOUSE_CLICK) {
      const x = Number(e.data.x)
      const y = Number(e.data.y)
      if (!this.width || !this.height || !Number.isFinite(x) || !Number.isFinite(y)) return
      const selector = this.nodes.selectorFor(Number(e.data.id))
      if (!selector) this.unresolved++
      this.clicks++
      this.visit.lastClick = ts
      this.acc.add({
        app: this.app,
        route: this.visit.route,
        day: utcDay(ts),
        kind: 'click',
        selector,
        x_bucket: bucketOf(x, this.width),
        y_bucket: bucketOf(y, this.height),
        depth_bucket: null,
        viewport: viewportClass(this.width)
      })
    }
  }

  /** Close the open visit; returns the newest frame per route this recording showed. */
  finish(): HeatFrame[] {
    this.closeVisit()
    return [...this.frames.values()]
  }
}

/** Fold a whole in-memory event list (tests, small inputs). */
export function foldEvents(
  events: RrwebEventLike[],
  recording: { id: string; app: string | null },
  acc = new HeatAccumulator()
): { acc: HeatAccumulator; frames: HeatFrame[]; clicks: number; unresolved: number } {
  const folder = new RecordingHeatFolder(acc, recording)
  for (const e of events) folder.push(e)
  const frames = folder.finish()
  return { acc, frames, clicks: folder.clicks, unresolved: folder.unresolved }
}

/** Stored chunks are `gz:` + base64 gzip, or plain JSON from before gzip storage. */
export function decodeStoredChunk(stored: string): string {
  if (stored.startsWith('gz:')) {
    return gunzipSync(Buffer.from(stored.slice(3), 'base64')).toString('utf8')
  }
  return stored
}

/** Merge existing table rows with new cells: same key → counts add. */
export function mergeCells(existing: HeatCell[], fresh: HeatCell[]): HeatCell[] {
  const acc = new HeatAccumulator()
  for (const c of existing) acc.add(c, Number(c.count) || 0)
  for (const c of fresh) acc.add(c, c.count)
  return [...acc.cells.values()].filter((c) => c.count > 0)
}

const toNum = (v: unknown): number | null => (v == null ? null : Number(v))

/**
 * The nightly job. Folds the oldest unfolded, settled recordings into the
 * heat table and stamps them. Returns a one-line summary for the job log.
 */
export async function runHeatFold(
  opts: { now?: Date; maxRecordings?: number; maxBytes?: number } = {}
): Promise<string> {
  const now = opts.now ?? new Date()
  const maxRecordings = opts.maxRecordings ?? HEAT_MAX_RECORDINGS
  const maxBytes = opts.maxBytes ?? HEAT_MAX_BYTES
  const settled = new Date(now.getTime() - HEAT_SETTLE_MS)

  const candidates = (await db('nivaro_session_recordings')
    .whereNull('heat_folded_at')
    .where((w) => w.whereNull('app').orWhereNot('app', 'error-clip'))
    .where((w) => w.whereNotNull('ended_at').orWhere('last_event_at', '<', settled))
    .orderBy('started_at', 'asc')
    .limit(maxRecordings)
    .select('id', 'app', 'byte_size')) as Array<{
    id: string
    app: string | null
    byte_size: number | null
  }>

  const acc = new HeatAccumulator()
  const frames = new Map<string, HeatFrame>()
  const folded: string[] = []
  let bytes = 0
  let clicks = 0
  for (const rec of candidates) {
    const size = Number(rec.byte_size) || 0
    // Always take at least one, so a recording bigger than the budget cannot stall the queue.
    if (folded.length > 0 && bytes + size > maxBytes) break
    bytes += size
    const folder = new RecordingHeatFolder(acc, { id: String(rec.id), app: rec.app })
    const chunks = (await db('nivaro_session_events')
      .where({ recording: rec.id })
      .orderBy('seq', 'asc')
      .select('events')) as Array<{ events: string }>
    for (const c of chunks) {
      let events: RrwebEventLike[]
      try {
        events = JSON.parse(decodeStoredChunk(c.events)) as RrwebEventLike[]
      } catch {
        continue // a corrupt chunk loses its own events only
      }
      for (const e of events) folder.push(e)
    }
    for (const f of folder.finish()) {
      const key = `${f.app}\u0001${f.route}`
      const prev = frames.get(key)
      if (!prev || f.at_ms > prev.at_ms) frames.set(key, f)
    }
    clicks += folder.clicks
    folded.push(String(rec.id))
  }

  const groups = acc.groups()
  if (groups.size > 0) {
    await db.transaction(async (trx) => {
      for (const cells of groups.values()) {
        const { app, route, day } = cells[0]
        const existing = (
          (await trx('nivaro_replay_heat')
            .where({ app, route, day })
            .select(
              'app',
              'route',
              'day',
              'kind',
              'selector',
              'x_bucket',
              'y_bucket',
              'depth_bucket',
              'viewport',
              'count'
            )) as Array<Record<string, unknown>>
        ).map(
          (r): HeatCell => ({
            app: String(r.app),
            route: String(r.route),
            day: String(r.day),
            kind: r.kind as HeatKind,
            selector: r.selector == null ? null : String(r.selector),
            x_bucket: toNum(r.x_bucket),
            y_bucket: toNum(r.y_bucket),
            depth_bucket: toNum(r.depth_bucket),
            viewport: String(r.viewport),
            count: Number(r.count) || 0
          })
        )
        const merged = mergeCells(existing, cells)
        await trx('nivaro_replay_heat').where({ app, route, day }).delete()
        for (const chunk of chunkArray(merged, INSERT_CHUNK)) {
          await trx('nivaro_replay_heat').insert(chunk)
        }
      }
    })
  }

  for (const f of frames.values()) {
    const prev = (await db('nivaro_replay_heat_frames')
      .where({ app: f.app, route: f.route })
      .first('id', 'at_ms')) as { id: number; at_ms: number | string } | undefined
    if (!prev) {
      await db('nivaro_replay_heat_frames').insert({ ...f, updated_at: now })
    } else if (f.at_ms > Number(prev.at_ms)) {
      await db('nivaro_replay_heat_frames')
        .where({ id: prev.id })
        .update({ ...f, updated_at: now })
    }
  }

  for (const ids of chunkArray(folded, 500)) {
    await db('nivaro_session_recordings').whereIn('id', ids).update({ heat_folded_at: now })
  }

  // Housekeeping: aggregates age out; a frame whose recording is gone points nowhere.
  const cutoff = utcDay(now.getTime() - HEAT_RETENTION_DAYS * 86_400_000)
  await db('nivaro_replay_heat')
    .where('day', '<', cutoff)
    .delete()
    .catch(() => 0)
  await pruneOrphanFrames().catch(() => 0)

  return `${folded.length} recording(s) folded (${clicks} clicks, ${acc.cells.size} cells, ${frames.size} route frame(s))${
    candidates.length > folded.length
      ? `; ${candidates.length - folded.length} left for the next run`
      : ''
  }`
}

// ─── Reads (the Heat tab) ────────────────────────────────────────────────────

export interface HeatQuery {
  app: string
  route: string
  from: string
  to: string
  viewport?: string | null
}

export interface HeatView {
  app: string
  route: string
  from: string
  to: string
  viewport: string | null
  /** Clicks per viewport class, before the viewport filter — feeds the filter chips. */
  viewports: Array<{ viewport: string; clicks: number }>
  clicks: Array<{ x: number; y: number; count: number }>
  total_clicks: number
  selectors: Array<{ selector: string; count: number }>
  unresolved_clicks: number
  scroll: Array<{ depth: number; visits: number }>
  total_visits: number
  frame: { recording_id: string; at_ms: number; width: number | null; height: number | null } | null
}

/** Folds summed table rows into what the Heat tab draws. Pure. */
export function shapeHeat(
  rows: Array<{
    kind: string
    selector: string | null
    x_bucket: number | null
    y_bucket: number | null
    depth_bucket: number | null
    viewport: string
    n: number
  }>,
  viewport: string | null
): Pick<
  HeatView,
  | 'viewports'
  | 'clicks'
  | 'total_clicks'
  | 'selectors'
  | 'unresolved_clicks'
  | 'scroll'
  | 'total_visits'
> {
  const vp = new Map<string, number>()
  const cells = new Map<string, { x: number; y: number; count: number }>()
  const selectors = new Map<string, number>()
  const depths = new Map<number, number>()
  let total = 0
  let unresolved = 0
  let visits = 0
  for (const r of rows) {
    const n = Number(r.n) || 0
    if (r.kind === 'click') vp.set(r.viewport, (vp.get(r.viewport) ?? 0) + n)
    if (viewport && r.viewport !== viewport) continue
    if (r.kind === 'click') {
      if (r.x_bucket == null || r.y_bucket == null) continue
      total += n
      const key = `${r.x_bucket},${r.y_bucket}`
      const c = cells.get(key) ?? { x: Number(r.x_bucket), y: Number(r.y_bucket), count: 0 }
      c.count += n
      cells.set(key, c)
      if (r.selector) selectors.set(r.selector, (selectors.get(r.selector) ?? 0) + n)
      else unresolved += n
    } else if (r.kind === 'scroll' && r.depth_bucket != null) {
      visits += n
      const d = Number(r.depth_bucket)
      depths.set(d, (depths.get(d) ?? 0) + n)
    }
  }
  return {
    viewports: [...vp.entries()]
      .map(([v, clicks]) => ({ viewport: v, clicks }))
      .sort((a, b) => b.clicks - a.clicks),
    clicks: [...cells.values()].sort((a, b) => b.count - a.count),
    total_clicks: total,
    selectors: [...selectors.entries()]
      .map(([selector, count]) => ({ selector, count }))
      .sort((a, b) => b.count - a.count || a.selector.localeCompare(b.selector))
      .slice(0, 30),
    unresolved_clicks: unresolved,
    scroll: [...depths.entries()]
      .map(([depth, n]) => ({ depth, visits: n }))
      .sort((a, b) => a.depth - b.depth),
    total_visits: visits
  }
}

export async function readHeat(q: HeatQuery): Promise<HeatView> {
  const rows = (await db('nivaro_replay_heat')
    .where({ app: q.app, route: q.route })
    .where('day', '>=', q.from)
    .where('day', '<=', q.to)
    .groupBy('kind', 'selector', 'x_bucket', 'y_bucket', 'depth_bucket', 'viewport')
    .select('kind', 'selector', 'x_bucket', 'y_bucket', 'depth_bucket', 'viewport')
    .sum({ n: 'count' })
    .limit(50_000)) as Parameters<typeof shapeHeat>[0]
  const frame = await readFrame(q.app, q.route)
  return {
    app: q.app,
    route: q.route,
    from: q.from,
    to: q.to,
    viewport: q.viewport ?? null,
    ...shapeHeat(rows, q.viewport ?? null),
    frame
  }
}

/** Routes with heat in the range, busiest first — feeds the route picker. */
export async function readHeatRoutes(
  from: string,
  to: string
): Promise<Array<{ app: string; route: string; clicks: number; visits: number }>> {
  const rows = (await db('nivaro_replay_heat')
    .where('day', '>=', from)
    .where('day', '<=', to)
    .groupBy('app', 'route', 'kind')
    .select('app', 'route', 'kind')
    .sum({ n: 'count' })) as Array<{ app: string; route: string; kind: string; n: number | string }>
  const out = new Map<string, { app: string; route: string; clicks: number; visits: number }>()
  for (const r of rows) {
    const key = `${r.app}\u0001${r.route}`
    const o = out.get(key) ?? { app: r.app, route: r.route, clicks: 0, visits: 0 }
    if (r.kind === 'click') o.clicks += Number(r.n) || 0
    else if (r.kind === 'scroll') o.visits += Number(r.n) || 0
    out.set(key, o)
  }
  return [...out.values()]
    .sort((a, b) => b.clicks - a.clicks || b.visits - a.visits || a.route.localeCompare(b.route))
    .slice(0, 300)
}

/**
 * Frames whose recording has gone (retention, a delete) point nowhere. Read
 * and checked in two steps rather than joined: the pointer is a string id and
 * the recording's is a uuid, which not every dialect compares.
 */
export async function pruneOrphanFrames(): Promise<number> {
  const frames = (await db('nivaro_replay_heat_frames').select('id', 'recording_id')) as Array<{
    id: number
    recording_id: string
  }>
  if (frames.length === 0) return 0
  const live = new Set<string>()
  for (const ids of chunkArray([...new Set(frames.map((f) => String(f.recording_id)))], 500)) {
    const rows = (await db('nivaro_session_recordings').whereIn('id', ids).select('id')) as Array<{
      id: string
    }>
    for (const r of rows) live.add(String(r.id).toLowerCase())
  }
  const dead = frames
    .filter((f) => !live.has(String(f.recording_id).toLowerCase()))
    .map((f) => f.id)
  for (const ids of chunkArray(dead, 500)) {
    await db('nivaro_replay_heat_frames').whereIn('id', ids).delete()
  }
  return dead.length
}

export async function readFrame(app: string, route: string): Promise<HeatView['frame']> {
  const f = (await db('nivaro_replay_heat_frames')
    .where({ app, route })
    .first('recording_id', 'at_ms', 'width', 'height')) as
    | { recording_id: string; at_ms: number | string; width: number | null; height: number | null }
    | undefined
  if (!f) return null
  // The recording may have expired since the fold; then there is nothing to show.
  const rec = await db('nivaro_session_recordings').where({ id: f.recording_id }).first('id')
  if (!rec) return null
  return {
    recording_id: String(f.recording_id),
    at_ms: Number(f.at_ms),
    width: toNum(f.width),
    height: toNum(f.height)
  }
}

/**
 * Incremental sources that shape what the frame looks like: mutations,
 * scroll, viewport resize, input (masked values), stylesheet rules, style
 * declarations and adopted stylesheets. Mouse moves and clicks are not.
 */
const FRAME_SOURCES = new Set([0, 3, 4, 5, 8, 13, 15])

/** Decoded bytes a frame read may pull before it gives up. */
export const FRAME_MAX_DECODED = 60_000_000

/**
 * The events needed to show a recording at `atMs`: the last full snapshot at
 * or before it (with the Meta event before that), then the incremental events
 * up to `atMs`. Pure over an event list — the route feeds it chunk by chunk.
 */
export class FrameCollector {
  private meta: RrwebEventLike | null = null
  private out: RrwebEventLike[] = []
  done = false
  constructor(private readonly atMs: number) {}
  push(e: RrwebEventLike): void {
    if (this.done || !e || typeof e.type !== 'number') return
    if (Number(e.timestamp) > this.atMs) {
      if (this.out.length > 0) this.done = true
      return
    }
    if (e.type === EV_META) {
      this.meta = e
      return
    }
    if (e.type === EV_FULL_SNAPSHOT) {
      this.out = this.meta ? [this.meta, e] : [e]
      return
    }
    if (this.out.length === 0) return
    // Only what changes the DOM or its geometry; the rest (mouse moves, custom events) is noise here.
    if (e.type === EV_INCREMENTAL) {
      const s = Number(e.data?.source)
      if (FRAME_SOURCES.has(s)) this.out.push(e)
    }
  }
  events(): RrwebEventLike[] {
    return this.out
  }
}

export async function readFrameEvents(
  recordingId: string,
  atMs: number
): Promise<RrwebEventLike[] | null> {
  // #1411 — a cold recording is read back from object storage first.
  await ensureRecordingHot(recordingId, { wait: true }).catch(() => null)
  const chunks = (await db('nivaro_session_events')
    .where({ recording: recordingId })
    .orderBy('seq', 'asc')
    .select('events')) as Array<{ events: string }>
  if (chunks.length === 0) return null
  const fc = new FrameCollector(atMs)
  let decoded = 0
  for (const c of chunks) {
    let json: string
    try {
      json = decodeStoredChunk(c.events)
    } catch {
      continue
    }
    decoded += json.length
    let events: RrwebEventLike[]
    try {
      events = JSON.parse(json) as RrwebEventLike[]
    } catch {
      continue
    }
    for (const e of events) fc.push(e)
    if (fc.done || decoded > FRAME_MAX_DECODED) break
  }
  const out = fc.events()
  return out.length > 0 ? out : null
}
