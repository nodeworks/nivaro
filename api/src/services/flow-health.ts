/**
 * Silently-stopped flows (#535) — see migration 339.
 *
 * Two silences hide behind a green run history:
 *  - `quiet` — the flow still FIRES (runs land) but no run has matched — the
 *    condition op rejects every time. The PO-received fan-out looked like
 *    this: runs every import, zero mails, nothing red.
 *  - `stopped` — an event/trigger flow that used to run has recorded no run
 *    at all in the window; its trigger stopped firing (a renamed collection,
 *    an emitter that went away).
 *
 * Both are judged against the flow's OWN history, never a fixed threshold: a
 * weekly flow has a weekly cadence. `typical_gap_days` is the median gap
 * between the DAYS on which runs matched over the last 90 (a burst of twenty
 * runs during one import is one active day, not a twenty-a-day rhythm); a
 * flow is quiet when the time since its last match exceeds 3× that (floor 7
 * days) while runs keep landing, and stopped when the time since its last
 * run does. Flows that matched on fewer than 3 days have no cadence to judge
 * and are reported as `young`. Runs written before migration 339 carry NULL matched
 * and are treated as matched — history never manufactures an alarm.
 */
import { db } from '../db/index.js'

export type FlowVerdict = 'ok' | 'quiet' | 'stopped' | 'idle' | 'young' | 'disabled'

export interface FlowHealthRow {
  id: string
  name: string
  trigger: string
  status: string
  verdict: FlowVerdict
  runs_30d: number
  matched_30d: number
  last_run_at: string | null
  last_match_at: string | null
  typical_gap_days: number | null
  /** Days since the last matched run (or last run for `stopped`). */
  silent_days: number | null
  /** The op key whose reject ended the most recent runs, when they all halted at one place. */
  halts_at: string | null
  reason: string
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export async function flowHealth(): Promise<FlowHealthRow[]> {
  const flows = (await db('nivaro_flows').select('id', 'name', 'trigger', 'status')) as Array<{
    id: string
    name: string
    trigger: string
    status: string
  }>
  if (flows.length === 0) return []
  const since90 = new Date(Date.now() - 90 * 86_400_000)
  const runs = (await db('nivaro_flow_runs')
    .select('flow', 'started_at', 'matched', 'halted_at', 'trigger')
    .where('started_at', '>=', since90)
    .whereNot('trigger', 'test')
    .orderBy('started_at', 'asc')) as Array<{
    flow: string
    started_at: Date
    matched: boolean | null
    halted_at: string | null
    trigger: string
  }>
  const byFlow = new Map<string, typeof runs>()
  for (const r of runs) {
    const k = String(r.flow).toUpperCase()
    const l = byFlow.get(k) ?? []
    l.push(r)
    byFlow.set(k, l)
  }
  const now = Date.now()
  const day = 86_400_000
  const out: FlowHealthRow[] = []
  for (const f of flows) {
    const rs = byFlow.get(String(f.id).toUpperCase()) ?? []
    const matched = rs.filter((r) => r.matched !== false)
    const last = rs.at(-1)
    const lastMatch = matched.at(-1)
    // Cadence over DISTINCT ACTIVE DAYS, not individual runs: a flow that fires
    // twenty times during one import has a burst, not a twenty-times-a-day
    // rhythm, and a median over raw gaps would read 0 and call the next quiet
    // week a failure.
    const activeDays = [
      ...new Set(matched.map((r) => new Date(r.started_at).toISOString().slice(0, 10)))
    ].sort()
    const gaps: number[] = []
    for (let i = 1; i < activeDays.length; i++)
      gaps.push((Date.parse(activeDays[i]) - Date.parse(activeDays[i - 1])) / day)
    const typical = activeDays.length >= 3 ? median(gaps) : null
    const runs30 = rs.filter((r) => now - new Date(r.started_at).getTime() <= 30 * day).length
    const matched30 = matched.filter(
      (r) => now - new Date(r.started_at).getTime() <= 30 * day
    ).length
    const recent = rs.slice(-10)
    const halts = new Set(recent.filter((r) => r.matched === false).map((r) => r.halted_at ?? '?'))
    const haltsAt =
      recent.length > 0 && recent.every((r) => r.matched === false) && halts.size === 1
        ? [...halts][0]
        : null

    let verdict: FlowVerdict
    let reason: string
    let silent: number | null = null
    if (f.status !== 'active') {
      verdict = 'disabled'
      reason = 'Not active.'
    } else if (rs.length === 0) {
      verdict = 'idle'
      reason = 'No runs in 90 days.'
    } else if (typical == null) {
      verdict = 'young'
      reason = `Matched on ${activeDays.length} day${activeDays.length === 1 ? '' : 's'} in the last 90 — not enough history to judge a cadence.`
    } else {
      const threshold = Math.max(7, typical * 3)
      const sinceMatch = lastMatch
        ? (now - new Date(lastMatch.started_at).getTime()) / day
        : Number.POSITIVE_INFINITY
      const sinceRun = last
        ? (now - new Date(last.started_at).getTime()) / day
        : Number.POSITIVE_INFINITY
      if (sinceRun > threshold) {
        verdict = 'stopped'
        silent = Math.round(sinceRun)
        reason = `Used to match every ~${typical.toFixed(1)} days; no run at all for ${Math.round(sinceRun)} days — the trigger has stopped firing.`
      } else if (sinceMatch > threshold) {
        verdict = 'quiet'
        silent = Math.round(sinceMatch)
        reason = `Still fires (${runs30} run${runs30 === 1 ? '' : 's'} in 30 days) but nothing has matched for ${Math.round(sinceMatch)} days; it used to match every ~${typical.toFixed(1)} days${haltsAt ? ` — every recent run halts at "${haltsAt}"` : ''}.`
      } else {
        verdict = 'ok'
        reason = `Matches every ~${typical.toFixed(1)} days; last match ${lastMatch ? Math.round(sinceMatch) : '?'} day(s) ago.`
      }
    }
    out.push({
      id: f.id,
      name: f.name,
      trigger: f.trigger,
      status: f.status,
      verdict,
      runs_30d: runs30,
      matched_30d: matched30,
      last_run_at: last ? new Date(last.started_at).toISOString() : null,
      last_match_at: lastMatch ? new Date(lastMatch.started_at).toISOString() : null,
      typical_gap_days: typical == null ? null : Math.round(typical * 10) / 10,
      silent_days: silent,
      halts_at: haltsAt,
      reason
    })
  }
  const order: Record<FlowVerdict, number> = {
    quiet: 0,
    stopped: 1,
    young: 2,
    ok: 3,
    idle: 4,
    disabled: 5
  }
  return out.sort((a, b) => order[a.verdict] - order[b.verdict] || a.name.localeCompare(b.name))
}
