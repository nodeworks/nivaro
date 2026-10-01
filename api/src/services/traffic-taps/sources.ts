// api/src/services/traffic-taps/sources.ts
/**
 * Topology tap `sources` (#1105 cron jobs, #1106 flows, #1143 import worker): run outcomes per
 * source, the partner / channel calls each source makes (source → down edges the map draws
 * directly, since a job with no request has no drawn lane to route through), the triggers that
 * fire each flow, and the import run in progress.
 *
 * Writes and partner calls are attributed by the core (traffic-map.ts reads the traffic-source
 * store); this tap only adds what the core does not count.
 */
import { currentTraceMeta } from '../request-trace.js'
import { currentTrafficSource, onTrafficSourceRun, type TrafficSource } from '../traffic-source.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { currentEntityKey, LatencySample, MinuteTotals } from './util.js'

export const SOURCES_TAP = 'sources'
const MAX_SOURCES = 200
const MAX_FRAME_RUNS = 20

interface LastRun {
  at: number
  ms: number
  ok: boolean
}
interface ImportRunState {
  run_id: number
  key: string
  label: string | null
  started_at: number
  rows: number | null
  phase: string
}
interface SourcesState {
  /** `<id>|run` / `<id>|err` per minute. */
  runs: MinuteTotals
  last: Map<string, LastRun>
  lat: Map<string, LatencySample>
  meta: Map<string, { label: string; kind: string }>
  /** `<source>><down>` per minute. */
  sd: MinuteTotals
  /** `<flow source>|<trigger>` per minute. */
  triggers: MinuteTotals
  /** This second's increments, for the frame. */
  secRuns: Array<{ id: string; ok: boolean; ms: number; at: number }>
  /** Since the last frame (like the map's own edges, a frame may lead its second by up to 1 s). */
  secSd: Map<string, number>
  importRun: ImportRunState | null
  importLast: (ImportRunState & { ok: boolean; finished_at: number }) | null
}

function state(): SourcesState {
  return tapState<SourcesState>(SOURCES_TAP, () => ({
    runs: new MinuteTotals(MAX_SOURCES * 2),
    last: new Map(),
    lat: new Map(),
    meta: new Map(),
    sd: new MinuteTotals(200),
    triggers: new MinuteTotals(200),
    secRuns: [],
    secSd: new Map(),
    importRun: null,
    importLast: null
  }))
}

function remember(src: { id: string; label: string; kind: string }): void {
  const s = state()
  if (!s.meta.has(src.id) && s.meta.size >= MAX_SOURCES) return
  s.meta.set(src.id, { label: src.label, kind: src.kind })
}

function onRun(src: TrafficSource, ok: boolean, ms: number, at: number): void {
  try {
    const s = state()
    remember(src)
    const sec = Math.floor(at / 1000)
    s.runs.add(`${src.id}|run`, sec)
    if (!ok) s.runs.add(`${src.id}|err`, sec)
    if (s.last.has(src.id) || s.last.size < MAX_SOURCES) s.last.set(src.id, { at, ms, ok })
    let lat = s.lat.get(src.id)
    if (!lat && s.lat.size < MAX_SOURCES) {
      lat = new LatencySample(60)
      s.lat.set(src.id, lat)
    }
    lat?.push(ms)
    if (s.secRuns.length < MAX_FRAME_RUNS) s.secRuns.push({ id: src.id, ok, ms, at })
  } catch {
    /* never */
  }
}
onTrafficSourceRun(onRun)

/** A call into a down node (partner, channel, AI, webhook) made by the current source, if any. */
export function noteSourceDown(downId: string, at = Date.now()): void {
  const src = currentTrafficSource()
  if (!src) return
  try {
    const s = state()
    remember(src)
    const sec = Math.floor(at / 1000)
    const key = `${src.id}>${downId}`
    s.sd.add(key, sec)
    if (s.secSd.has(key) || s.secSd.size < 100) s.secSd.set(key, (s.secSd.get(key) ?? 0) + 1)
  } catch {
    /* never */
  }
}

/**
 * The trigger key a flow run hangs off, for the map's trigger → flow edge: the job that runs it,
 * the collection whose write fired it, the request lane it ran in, else the trigger kind.
 */
export function flowTriggerKey(trigger: string, payload: Record<string, unknown>): string {
  const outer = currentTrafficSource()
  if (outer) return outer.id
  const collection = typeof payload?.collection === 'string' ? payload.collection : null
  if (collection && /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}$/.test(collection)) {
    return `${/^(nivaro_|directus_|sys)/.test(collection) ? 'system' : 'items'}/${collection}`
  }
  if (currentTraceMeta()) {
    const k = currentEntityKey()
    if (k) return k
  }
  const kind = String(trigger ?? '')
    .replace(/^shadow:/, '')
    .split(/[:.]/)[0]
  return `trigger:${(kind || 'manual').slice(0, 40)}`
}

/** Record a flow run's trigger (run outcomes come through noteTrafficSourceRun). */
export function noteFlowTrigger(src: TrafficSource, at = Date.now()): void {
  try {
    if (!src.trigger) return
    const s = state()
    remember(src)
    s.triggers.add(`${src.id}|${src.trigger}`, Math.floor(at / 1000))
  } catch {
    /* never */
  }
}

/** The staged-import worker's current run (#1143). */
export function noteImportRun(
  phase: 'start' | 'rows' | 'done' | 'error',
  run: { run_id: number; key: string; label?: string | null; rows?: number | null }
): void {
  try {
    const s = state()
    if (phase === 'start') {
      s.importRun = {
        run_id: run.run_id,
        key: run.key,
        label: run.label ?? null,
        started_at: Date.now(),
        rows: null,
        phase: 'running'
      }
      return
    }
    const cur = s.importRun && s.importRun.run_id === run.run_id ? s.importRun : null
    if (phase === 'rows') {
      if (cur) cur.rows = run.rows ?? cur.rows
      return
    }
    const base: ImportRunState = cur ?? {
      run_id: run.run_id,
      key: run.key,
      label: run.label ?? null,
      started_at: Date.now(),
      rows: null,
      phase
    }
    s.importLast = {
      ...base,
      rows: run.rows ?? base.rows,
      phase,
      ok: phase === 'done',
      finished_at: Date.now()
    }
    if (cur) s.importRun = null
  } catch {
    /* never */
  }
}

export interface SourceSnapshot {
  sources: Record<
    string,
    {
      label: string
      kind: string
      runs: number
      errors: number
      p95_ms: number
      last: LastRun | null
    }
  >
  /** `<source>><down>` → calls in the window. */
  sd: Record<string, number>
  /** flow source id → [{trigger, n}] */
  triggers: Record<string, Array<{ key: string; n: number }>>
  import: {
    current: (ImportRunState & { rows_per_s: number | null }) | null
    last: SourcesState['importLast']
  }
}

export function sourcesSnapshot(windowS: number, sec: number): SourceSnapshot | undefined {
  const s = state()
  const out: SourceSnapshot = {
    sources: {},
    sd: {},
    triggers: {},
    import: { current: null, last: null }
  }
  for (const [id, m] of s.meta) {
    const runs = s.runs.sum(`${id}|run`, windowS, sec)
    const last = s.last.get(id) ?? null
    if (!runs && !last) continue
    out.sources[id] = {
      label: m.label,
      kind: m.kind,
      runs,
      errors: s.runs.sum(`${id}|err`, windowS, sec),
      p95_ms: s.lat.get(id)?.p(0.95) ?? 0,
      last
    }
  }
  for (const [k, n] of s.sd.entries(windowS, sec)) out.sd[k] = n
  for (const [k, n] of s.triggers.entries(windowS, sec)) {
    const cut = k.indexOf('|')
    if (cut < 0) continue
    const flow = k.slice(0, cut)
    const list = out.triggers[flow] ?? []
    list.push({ key: k.slice(cut + 1), n })
    out.triggers[flow] = list
  }
  if (s.importRun) {
    const elapsed = (Date.now() - s.importRun.started_at) / 1000
    out.import.current = {
      ...s.importRun,
      rows_per_s:
        s.importRun.rows != null && elapsed > 0
          ? Math.round((s.importRun.rows / elapsed) * 10) / 10
          : null
    }
  }
  out.import.last = s.importLast
  const empty =
    !Object.keys(out.sources).length &&
    !Object.keys(out.sd).length &&
    !out.import.current &&
    !out.import.last
  return empty ? undefined : out
}

registerTrafficTap({
  id: SOURCES_TAP,
  onOutbound(c) {
    noteSourceDown(c.downId, c.ev.at)
  },
  frame(sec) {
    const s = state()
    // runs that finished while nobody watched are not news (the snapshot carries them)
    const runs = s.secRuns.filter((r) => r.at >= (sec - 5) * 1000)
    const sd = Object.fromEntries(s.secSd)
    s.secRuns = []
    s.secSd.clear()
    const importRun = s.importRun
      ? { run_id: s.importRun.run_id, key: s.importRun.key, rows: s.importRun.rows }
      : null
    if (!runs.length && !Object.keys(sd).length && !importRun) return undefined
    return { runs, sd, import: importRun }
  },
  snapshot: (windowS, sec) => sourcesSnapshot(windowS, sec),
  sweep(sec) {
    const s = state()
    s.runs.sweep(sec)
    s.sd.sweep(sec)
    s.triggers.sweep(sec)
    const cutoff = (sec - 900) * 1000
    for (const [id, l] of s.last) {
      if (l.at < cutoff) {
        s.last.delete(id)
        s.lat.delete(id)
        s.meta.delete(id)
      }
    }
  }
})
