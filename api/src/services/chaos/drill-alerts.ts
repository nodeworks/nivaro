import type { FastifyInstance } from 'fastify'
import type { NotifyUserOptions } from '../notification-channels.js'
import { alertFired, type FiredAlert, onAlertFired } from './alert-hook.js'
import { addRunEvent } from './drill.js'
import { armedFaults } from './registry.js'
import { type ChaosRun, getRun } from './runs.js'

/**
 * Alerts tagged as drill (#2847). While a fault is armed on this instance, an alert that fires
 * is part of the drill: it is recorded on the run as an `alert` event (its fire time against the
 * run's start is the time to detect), and the paths that tell people (ops monitors, metric
 * alerts, integration signal alerts) tell only the run's participants, subject prefixed
 * "[Drill]", instead of their normal recipients. Rule: ANY alert during an armed fault — simple,
 * and an operator watching a drill is the right person to judge it.
 *
 * With no armed fault nothing changes: `drillAlert` answers null and the caller goes on exactly
 * as before. The Ops Console, Telemetry and Integrations console show the tag by time
 * (`GET /api/chaos/drill-windows`), so rows written by any path read the same.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i

function ids(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw]
  return list.map((v) => String(v ?? '').toLowerCase()).filter((v) => UUID_RE.test(v))
}

/**
 * Who takes part in a run: whoever started it plus the game day's people (`meta.participants`,
 * `meta.roles.{lead, scribe, responders}` on the run or on its game-day row). Blind runs
 * (#2854, `meta.blind`) leave the responders out — they are being tested.
 */
export async function runParticipants(run: ChaosRun): Promise<string[]> {
  const out = new Set<string>(ids(run.started_by))
  const rows: ChaosRun[] = [run]
  if (run.gameday_id) {
    const day = await getRun(run.gameday_id).catch(() => null)
    if (day) rows.push(day)
  }
  const blind = rows.some((r) => r.meta?.blind === true)
  for (const r of rows) {
    const roles = (r.meta?.roles ?? {}) as Record<string, unknown>
    for (const id of ids(r.started_by)) out.add(id)
    for (const id of ids(roles.lead)) out.add(id)
    if (blind) continue
    for (const id of ids(r.meta?.participants)) out.add(id)
    for (const id of ids(roles.scribe)) out.add(id)
    for (const id of ids(roles.responders)) out.add(id)
  }
  return [...out]
}

export interface DrillRouting {
  run_id: string
  label: string
  participants: string[]
}

/** The run(s) armed here right now, newest first; null when nothing is armed. */
async function activeRuns(): Promise<ChaosRun[]> {
  const runIds = [
    ...new Set(
      armedFaults()
        .sort((a, b) => b.started_at - a.started_at)
        .map((f) => f.run_id)
        .filter((id): id is string => !!id)
    )
  ]
  if (!runIds.length) return []
  const runs: ChaosRun[] = []
  for (const id of runIds) {
    const run = await getRun(id).catch(() => null)
    if (run && run.status === 'running') runs.push(run)
  }
  return runs
}

/**
 * Call where an alert fires and people are about to be told. null = no drill: carry on exactly
 * as before. Otherwise the alert is recorded on the run and the caller tells only
 * `participants` (tellDrillParticipants) instead of its normal recipients.
 */
export async function drillAlert(alert: FiredAlert): Promise<DrillRouting | null> {
  alertFired(alert)
  if (!armedFaults().length) return null
  const runs = await activeRuns()
  if (!runs.length) return null
  const people = new Set<string>()
  for (const run of runs) for (const id of await runParticipants(run)) people.add(id)
  return { run_id: runs[0].id, label: runs[0].label, participants: [...people] }
}

/** Tell the run's participants (in-app + push, never email), subject prefixed "[Drill]". */
export async function tellDrillParticipants(
  app: FastifyInstance,
  routing: DrillRouting,
  opts: NotifyUserOptions
): Promise<number> {
  const { notifyUser } = await import('../notification-channels.js')
  let told = 0
  for (const userId of routing.participants) {
    try {
      const r = await notifyUser(app, userId, {
        ...opts,
        subject: `[Drill] ${opts.subject}`,
        message:
          `${opts.message ?? ''}\n\nFired during the chaos drill "${routing.label}". Only the drill's participants were told.`.trim(),
        channels: { inapp: true }
      })
      if (!r?.decision?.dropped) told++
    } catch {
      /* the rest still deserve a try */
    }
  }
  return told
}

// ─── The run's timeline: one `alert` event per alert per run ──────────────────

const recorded = new Set<string>()

async function recordOnRun(a: FiredAlert & { at: number }): Promise<void> {
  if (!armedFaults().length) return
  for (const run of await activeRuns()) {
    const k = `${run.id}|${a.source}|${a.key}`
    if (recorded.has(k)) continue
    recorded.add(k)
    if (recorded.size > 5000) recorded.clear()
    const started = run.started_at ? Date.parse(run.started_at) : Number.NaN
    await addRunEvent(run.id, 'alert', {
      source: a.source,
      key: a.key,
      label: a.label,
      severity: a.severity ?? null,
      fired_at: new Date(a.at).toISOString(),
      // Time to detect: the alert's fire time against the run's start.
      ttd_ms: Number.isFinite(started) ? Math.max(0, a.at - started) : null,
      drill: true
    })
  }
}

let wired = false
export function wireDrillAlerts(): void {
  if (wired) return
  wired = true
  onAlertFired((a) => void recordOnRun(a).catch(() => undefined))
}

export interface DrillWindow {
  run_id: string
  kind: ChaosRun['kind']
  label: string
  fault_key: string | null
  started_at: string
  /** null while it runs. */
  ended_at: string | null
}

/** Runs that armed something, overlapping [since, now] — the tag the alert rows show. */
export function drillWindows(runs: ChaosRun[], since: number, now = Date.now()): DrillWindow[] {
  const out: DrillWindow[] = []
  for (const r of runs) {
    if (!r.started_at || r.status === 'refused' || r.status === 'planned') continue
    if (r.kind === 'ci') continue
    const start = Date.parse(r.started_at)
    const end = r.ended_at
      ? Date.parse(r.ended_at)
      : r.status === 'running'
        ? now
        : Date.parse(r.ends_at ?? '')
    if (!Number.isFinite(start)) continue
    if (Number.isFinite(end) && end < since) continue
    out.push({
      run_id: r.id,
      kind: r.kind,
      label: r.label,
      fault_key: r.fault_key,
      started_at: r.started_at,
      ended_at: r.status === 'running' ? null : (r.ended_at ?? r.ends_at)
    })
  }
  return out
}

/** Tests only. */
export function _resetDrillAlertsForTests(): void {
  recorded.clear()
  wired = false
}
