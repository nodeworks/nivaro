/**
 * Host runbook estimates (#720 follow-up) — pure. Every successful phase (and
 * each sub-step of a phase) a host runbook ran is a row in
 * nivaro_runbook_step_timings; a phase's TYPICAL duration is the median of
 * its last few successful passes in the same mode. The live estimate adds
 * what is left of the running phase (its typical minus its elapsed, never
 * below zero — a phase running long is "running longer than usual") to the
 * typicals of the phases still to come.
 *
 * Also here: the parser that reads timings out of a runbook's own history
 * logs (`history_dirs` — e.g. a nightly cron writing `=== 3-promote END …
 * elapsed=7m8s ===` and `─── step done in 12m05s ───`).
 */
import type { StepEvent } from './runbook-runs.js'

export interface TimingRow {
  step: string
  parent_step: string | null
  mode: 'dry' | 'go'
  secs: number
  max_quiet_secs?: number | null
  finished_at: string | Date
}

/** How many recent passes a typical is the median of. */
export const SAMPLE = 7
/** No output for this long is a stall when history knows no longer silence. */
export const DEFAULT_STALL_SECS = 600

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const v = [...values].sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

const when = (r: TimingRow) =>
  Date.parse(r.finished_at instanceof Date ? r.finished_at.toISOString() : r.finished_at)

/** The median of the step's last SAMPLE passes in `mode`, else in any mode; null = no history. */
export function typicalSecs(
  rows: TimingRow[],
  step: string,
  mode: 'dry' | 'go',
  parent: string | null = null
): number | null {
  const of = rows
    .filter((r) => r.step === step && (r.parent_step ?? null) === parent)
    .sort((a, b) => when(b) - when(a))
  const same = of.filter((r) => r.mode === mode)
  const pick = (same.length ? same : of).slice(0, SAMPLE)
  return median(pick.map((r) => r.secs))
}

/** The longest silence history saw in that phase — the stall threshold (at least 2 minutes). */
export function stallAfterSecs(rows: TimingRow[], step: string): number {
  const gaps = rows
    .filter((r) => r.step === step && !r.parent_step && r.max_quiet_secs != null)
    .map((r) => Number(r.max_quiet_secs))
  return gaps.length ? Math.max(120, Math.max(...gaps)) : DEFAULT_STALL_SECS
}

export interface PlanEstimate {
  phases: Array<{ key: string; label: string; secs: number | null }>
  /** The typical whole run starting at each phase (unknown phases count as 0). */
  from: Record<string, number | null>
  /** How many phases from that start have no history. */
  unknown_from: Record<string, number>
}

/** Typical durations before a run starts: per phase, and for each starting phase. */
export function planEstimate(
  phases: Array<{ key: string; label: string }>,
  rows: TimingRow[],
  mode: 'dry' | 'go'
): PlanEstimate {
  const list = phases.map((p) => ({ ...p, secs: typicalSecs(rows, p.key, mode) }))
  const from: Record<string, number | null> = {}
  const unknown: Record<string, number> = {}
  for (let i = 0; i < list.length; i++) {
    const rest = list.slice(i)
    const known = rest.filter((p) => p.secs != null)
    from[list[i].key] = known.length ? known.reduce((s, p) => s + (p.secs as number), 0) : null
    unknown[list[i].key] = rest.length - known.length
  }
  return { phases: list, from, unknown_from: unknown }
}

export interface LiveEstimate {
  elapsed_secs: number
  current: string | null
  current_elapsed_secs: number
  current_typical_secs: number | null
  /** The running phase has run past its typical — it is assumed to finish soon. */
  over_typical: boolean
  /** Seconds left by the estimate; null when nothing ahead has history. */
  remaining_secs: number | null
  total_secs: number | null
  percent: number | null
  eta: string | null
  phases: Array<{
    key: string
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
    actual_secs: number | null
    typical_secs: number | null
  }>
  /** Phases ahead with no history (the estimate leaves them out). */
  unknown: number
}

/**
 * The estimate while a run is going. `startedAt` is when the run started;
 * phases before `from` are not part of this run.
 */
export function liveEstimate(opts: {
  phases: Array<{ key: string }>
  from: string | null
  events: StepEvent[]
  rows: TimingRow[]
  mode: 'dry' | 'go'
  startedAt: string
  now: number
}): LiveEstimate {
  const startIdx = Math.max(0, opts.from ? opts.phases.findIndex((p) => p.key === opts.from) : 0)
  const plan = opts.phases.slice(startIdx)
  const state = new Map<
    string,
    { status: LiveEstimate['phases'][number]['status']; secs: number | null; at: number | null }
  >()
  for (const e of opts.events) {
    const t = Date.parse(e.at)
    const cur = state.get(e.step)
    if (e.status === 'start') state.set(e.step, { status: 'running', secs: null, at: t })
    else if (e.status === 'ok')
      state.set(e.step, { status: 'done', secs: e.secs ?? null, at: cur?.at ?? null })
    else if (e.status === 'fail')
      state.set(e.step, { status: 'failed', secs: e.secs ?? null, at: cur?.at ?? null })
    else if (e.status === 'skip') state.set(e.step, { status: 'skipped', secs: null, at: null })
  }
  const elapsed = Math.max(0, Math.round((opts.now - Date.parse(opts.startedAt)) / 1000))
  let current: string | null = null
  let currentElapsed = 0
  let remaining = 0
  let anyKnown = false
  let unknown = 0
  const phases = plan.map((p) => {
    const s = state.get(p.key)
    const typical = typicalSecs(opts.rows, p.key, opts.mode)
    const status = s?.status ?? 'pending'
    if (status === 'running') {
      current = p.key
      currentElapsed = s?.at ? Math.max(0, Math.round((opts.now - (s.at as number)) / 1000)) : 0
      if (typical != null) {
        anyKnown = true
        remaining += Math.max(0, typical - currentElapsed)
      } else unknown++
    } else if (status === 'pending') {
      if (typical != null) {
        anyKnown = true
        remaining += typical
      } else unknown++
    }
    return { key: p.key, status, actual_secs: s?.secs ?? null, typical_secs: typical }
  })
  const currentTypical = current ? typicalSecs(opts.rows, current, opts.mode) : null
  const remainingSecs =
    anyKnown || phases.every((p) => p.status !== 'pending' && p.status !== 'running')
      ? remaining
      : null
  const total = remainingSecs == null ? null : elapsed + remainingSecs
  return {
    elapsed_secs: elapsed,
    current,
    current_elapsed_secs: currentElapsed,
    current_typical_secs: currentTypical,
    over_typical: currentTypical != null && currentElapsed > currentTypical,
    remaining_secs: remainingSecs,
    total_secs: total,
    percent: total ? Math.min(99, Math.round((elapsed / total) * 100)) : null,
    eta: remainingSecs == null ? null : new Date(opts.now + remainingSecs * 1000).toISOString(),
    phases,
    unknown
  }
}

// ── history logs ────────────────────────────────────────────────────────────

/** `7m8s`, `12m05s`, `45s`, `1h2m` → seconds; null when unreadable. */
export function parseElapsed(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

/**
 * Successful phases out of a run's summary: `=== 3-promote END 00:41:10
 * exit=0 elapsed=7m8s ===` → { promote: 428, n: 3 }. Failed phases (exit≠0)
 * are not timings.
 */
export function parsePhaseSummary(text: string): Array<{ step: string; n: number; secs: number }> {
  const out: Array<{ step: string; n: number; secs: number }> = []
  const re = /^=== (\d+)-([A-Za-z0-9_-]+) END \S+ exit=(\d+) elapsed=(\S+) ===\s*$/gm
  for (const m of text.matchAll(re)) {
    if (m[3] !== '0') continue
    const secs = parseElapsed(m[4])
    if (secs != null) out.push({ step: m[2], n: Number(m[1]), secs })
  }
  return out
}

/** Sub-steps out of one phase's log: `─── state-views done in 12m05s ───`. */
export function parseSubSteps(text: string): Array<{ step: string; secs: number }> {
  const out: Array<{ step: string; secs: number }> = []
  for (const m of text.matchAll(/^─── (\S+) done in (\S+) ───\s*$/gm)) {
    const secs = parseElapsed(m[2])
    if (secs != null) out.push({ step: m[1], secs })
  }
  return out
}

/** Has this history run finished (so its timings are final)? */
export function historyRunFinished(summary: string): boolean {
  return /^(NIGHTLY COMPLETE|NIGHTLY ABORTED|### DONE|### FAILED)/m.test(summary)
}

/** `2026-10-06_0015` → that local time; null when the name is not a run stamp. */
export function runDirTime(name: string): Date | null {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]))
}
