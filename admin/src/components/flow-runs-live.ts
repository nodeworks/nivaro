/**
 * The flow run viewer's live state (rt4 #16): the server sends `flow:run` when a run starts and
 * ends and `flow:step` as each step finishes, both naming the run. Payloads carry step keys,
 * types, outcomes and timings — never the flow's data.
 */

export interface LiveStep {
  op: string
  type: string
  /** resolve | reject | async */
  status: string
  ms: number | null
}

export interface LiveRun {
  status: 'running' | 'success' | 'error'
  steps: LiveStep[]
  ms: number | null
  /** When the page first heard of this run (newest wins the header chip). */
  seen: number
}

export type LiveRuns = Record<string, LiveRun>

/** Runs kept per page: the newest, so a busy flow never grows the page without bound. */
export const MAX_LIVE_RUNS = 30
/** Steps kept per run. */
export const MAX_LIVE_STEPS = 200

function prune(runs: LiveRuns): LiveRuns {
  const ids = Object.keys(runs)
  if (ids.length <= MAX_LIVE_RUNS) return runs
  const keep = ids.sort((a, b) => runs[b].seen - runs[a].seen).slice(0, MAX_LIVE_RUNS)
  return Object.fromEntries(keep.map((id) => [id, runs[id]]))
}

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

export function applyRunEvent(
  cur: LiveRuns,
  p: Record<string, unknown>,
  now = Date.now()
): LiveRuns {
  const id = str(p.run_id)
  if (!id) return cur
  const status = p.status === 'success' || p.status === 'error' ? p.status : 'running'
  const prev = cur[id]
  const ms = typeof p.ms === 'number' ? p.ms : (prev?.ms ?? null)
  // A late "running" never undoes an end that already arrived.
  if (prev && prev.status !== 'running' && status === 'running') return cur
  return prune({ ...cur, [id]: { status, steps: prev?.steps ?? [], ms, seen: prev?.seen ?? now } })
}

export function applyStepEvent(
  cur: LiveRuns,
  p: Record<string, unknown>,
  now = Date.now()
): LiveRuns {
  const id = str(p.run_id)
  // Steps from a server that does not name the run yet (older API) are ignored here; the
  // header chip still reads them through liveSummary of whatever runs are known.
  if (!id) return cur
  const prev = cur[id] ?? { status: 'running' as const, steps: [], ms: null, seen: now }
  if (prev.steps.length >= MAX_LIVE_STEPS) return cur
  const step: LiveStep = {
    op: str(p.op) || 'step',
    type: str(p.type),
    status: str(p.status) || 'resolve',
    ms: typeof p.ms === 'number' ? p.ms : null
  }
  return prune({ ...cur, [id]: { ...prev, steps: [...prev.steps, step] } })
}

/** The header chip: the newest running run's latest step ("send-mail — resolve"), or null. */
export function liveSummary(runs: LiveRuns): string | null {
  let best: LiveRun | null = null
  for (const r of Object.values(runs))
    if (r.status === 'running' && (!best || r.seen > best.seen)) best = r
  if (!best) return null
  const last = best.steps[best.steps.length - 1]
  if (!last) return 'Starting…'
  return `${last.op} — ${last.status === 'reject' ? 'failed' : last.status === 'async' ? 'started' : 'done'}`
}
