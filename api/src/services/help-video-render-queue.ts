import { db } from '../db/index.js'

// The help-video render queue as Background Jobs shows it (#1532): what is
// rendering, what waits and in which order, how far along each is, and how
// long each should take. Read-only; Cancel lives in help-video-render.ts.
//
// Estimates come from history: the median render time per minute of source
// recording over the newest completed renders (job runs of kind 'render').
// A running render's remaining time uses its own pace once it is 5 % in.
// Queued items are rendered one after another (one render per process at a
// time, in queue order), so each waits for everything ahead of it.

const VERSIONS = 'nivaro_help_video_versions'
const SAMPLE = 30

export interface RenderQueueItem {
  version_id: string
  video_id: string
  title: string
  version: number
  status: 'rendering' | 'queued'
  /** 1 = renders next; null while rendering. */
  position: number | null
  progress: number | null
  source_ms: number | null
  queued_at: string | null
  started_at: string | null
  /** The running job run (Background Jobs history), when one is found. */
  run_id: number | null
  /** e.g. "libx264 veryfast crf 23", from the run's progress. */
  encoder: string | null
  /** The whole render's expected length, from history. */
  estimate_ms: number | null
  /** Rendering: time left. Queued: time until it is done (waits included). */
  remaining_ms: number | null
}

export interface RenderQueue {
  items: RenderQueueItem[]
  /** Median render milliseconds per source minute; null without history. */
  ms_per_source_minute: number | null
  /** How many past renders the median is taken from. */
  sample: number
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
const low = (v: unknown) => String(v).toLowerCase()

/** Median ms of rendering per source minute over the newest completed renders. */
export async function renderPace(): Promise<{ rate: number | null; sample: number }> {
  const runs = (await db('nivaro_job_runs')
    .where({ kind: 'render', status: 'completed' })
    .where('job_id', 'like', 'help-video:%')
    .whereNotNull('duration_ms')
    .orderBy('id', 'desc')
    .limit(SAMPLE * 2)
    .select('job_id', 'duration_ms', 'outcome')) as Array<{
    job_id: string
    duration_ms: number
    outcome: string | null
  }>
  // Only real renders: not a discarded one (lost its claim) or a cancel.
  const real = runs.filter((r) => /^rendered\b/.test(String(r.outcome ?? ''))).slice(0, SAMPLE)
  if (!real.length) return { rate: null, sample: 0 }
  const ids = [...new Set(real.map((r) => r.job_id.slice('help-video:'.length)))]
  const src = (await db(VERSIONS).whereIn('id', ids).select('id', 'source_duration_ms')) as Array<{
    id: string
    source_duration_ms: number | null
  }>
  const minutes = new Map(src.map((v) => [low(v.id), Number(v.source_duration_ms) / 60_000]))
  const rates: number[] = []
  for (const r of real) {
    const m = minutes.get(low(r.job_id.slice('help-video:'.length)))
    if (m && Number.isFinite(m) && m > 0) rates.push(Number(r.duration_ms) / m)
  }
  return { rate: median(rates), sample: rates.length }
}

/** Remaining time of a running render: its own pace once it is 5 % in,
 *  else the history estimate less the time it has run. */
export function remainingFor(
  estimate: number | null,
  progress: number | null,
  elapsed: number | null
): number | null {
  if (elapsed !== null && progress !== null && progress >= 5 && progress < 100) {
    return Math.round((elapsed / progress) * (100 - progress))
  }
  if (estimate === null) return null
  return Math.max(0, Math.round(estimate - (elapsed ?? 0)))
}

export async function listRenderQueue(now = Date.now()): Promise<RenderQueue> {
  const rows = (await db(`${VERSIONS} as v`)
    .leftJoin('nivaro_help_videos as h', 'h.id', 'v.video_id')
    .whereIn('v.render_status', ['queued', 'rendering'])
    .select(
      'v.id',
      'v.video_id',
      'v.version',
      'v.render_status',
      'v.render_progress',
      'v.render_started_at',
      'v.created_at',
      'v.source_duration_ms',
      'h.title'
    )) as Array<Record<string, unknown>>
  const { rate, sample } = await renderPace().catch(() => ({ rate: null, sample: 0 }))
  const rendering = rows
    .filter((r) => r.render_status === 'rendering')
    .sort(
      (a, b) => +new Date(a.render_started_at as string) - +new Date(b.render_started_at as string)
    )
  // The order the renderer takes them: oldest version first.
  const queued = rows
    .filter((r) => r.render_status === 'queued')
    .sort((a, b) => +new Date(a.created_at as string) - +new Date(b.created_at as string))

  const runs = rendering.length
    ? ((await db('nivaro_job_runs')
        .where({ kind: 'render', status: 'running' })
        .whereIn(
          'job_id',
          rendering.map((r) => `help-video:${low(r.id)}`)
        )
        .orderBy('id', 'desc')
        .select('id', 'job_id', 'progress')) as Array<{
        id: number
        job_id: string
        progress: string | null
      }>)
    : []
  const runFor = new Map<string, { id: number; encoder: string | null }>()
  for (const r of runs) {
    const key = r.job_id.slice('help-video:'.length)
    if (runFor.has(key)) continue
    let encoder: string | null = null
    try {
      const p = r.progress ? (JSON.parse(r.progress) as { encoder?: unknown }) : null
      if (typeof p?.encoder === 'string') encoder = p.encoder
    } catch {
      /* no progress yet */
    }
    runFor.set(key, { id: Number(r.id), encoder })
  }

  const estimateOf = (sourceMs: number | null) =>
    rate !== null && sourceMs ? Math.round((rate * sourceMs) / 60_000) : null
  const items: RenderQueueItem[] = []
  let ahead = 0
  let aheadKnown = true
  for (const r of rendering) {
    const sourceMs = r.source_duration_ms == null ? null : Number(r.source_duration_ms)
    const started = r.render_started_at ? new Date(r.render_started_at as string).getTime() : null
    const progress = r.render_progress == null ? null : Number(r.render_progress)
    const estimate = estimateOf(sourceMs)
    const remaining = remainingFor(estimate, progress, started === null ? null : now - started)
    // Renders on other processes run side by side: the queue waits for the
    // one that finishes last.
    if (remaining === null) aheadKnown = false
    else ahead = Math.max(ahead, remaining)
    const run = runFor.get(low(r.id))
    items.push({
      version_id: low(r.id),
      video_id: low(r.video_id),
      title: String(r.title ?? 'Untitled video'),
      version: Number(r.version),
      status: 'rendering',
      position: null,
      progress,
      source_ms: sourceMs,
      queued_at: iso(r.created_at),
      started_at: iso(r.render_started_at),
      run_id: run?.id ?? null,
      encoder: run?.encoder ?? null,
      estimate_ms: estimate,
      remaining_ms: remaining
    })
  }
  queued.forEach((r, i) => {
    const sourceMs = r.source_duration_ms == null ? null : Number(r.source_duration_ms)
    const estimate = estimateOf(sourceMs)
    if (estimate === null) aheadKnown = false
    else ahead += estimate
    items.push({
      version_id: low(r.id),
      video_id: low(r.video_id),
      title: String(r.title ?? 'Untitled video'),
      version: Number(r.version),
      status: 'queued',
      position: i + 1,
      progress: null,
      source_ms: sourceMs,
      queued_at: iso(r.created_at),
      started_at: null,
      run_id: null,
      encoder: null,
      estimate_ms: estimate,
      remaining_ms: aheadKnown ? ahead : null
    })
  })
  return { items, ms_per_source_minute: rate === null ? null : Math.round(rate), sample }
}
