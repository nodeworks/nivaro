import { listInstances } from '../instance-roster.js'
import { getIo } from '../io-holder.js'
import type { JobRunHandle } from '../job-runs.js'
import { emitToTenant } from '../record-events.js'
import { currentTenantKey, tenantScopedRoom } from '../tenant-rooms.js'
import { anyHidden, insiderViews, publicArmed } from './armed-visibility.js'
import { enforceChaosCaps } from './caps.js'
import {
  type ArmedFault,
  clampSeconds,
  describeTarget,
  getFault,
  type HypothesisRule
} from './catalog.js'
import { assertChaosAllowed, ChaosError, chaosRefusal } from './gate.js'
import {
  armedFault,
  armedFaults,
  armFault,
  CHAOS_NODE,
  disarm,
  onRegistryChange,
  type RegistryEvent,
  stopAll
} from './registry.js'
import {
  appendRunEvent,
  type ChaosRun,
  type ChaosRunEvent,
  createRun,
  getRun,
  listRuns,
  type RunEventKind,
  type RunKind,
  updateRun,
  type Verdict
} from './runs.js'

/**
 * Drills (#2827): a run that arms one fault, records its timeline and ends with a verdict. The
 * glue between the registry (what is armed), the run store (what happened), the job runs
 * console (every run is a job run), the steady-state watcher (#2828) and the sockets (the
 * banner and the cockpit).
 */

/** What every signed-in person may know about an armed fault (the banner, #2846). */
export interface PublicArmedFault {
  id: string
  fault_key: string
  label: string
  target: string
  started_by_name: string | null
  started_at: number
  ends_at: number
  run_id: string | null
}

export function publicArmedView(f: ArmedFault): PublicArmedFault {
  return {
    id: f.id,
    fault_key: f.fault_key,
    label: f.label,
    target: describeTarget(f.target),
    // A display name or a neutral word — never an email, the list is for everyone signed in.
    started_by_name:
      f.started_by_name && !f.started_by_name.includes('@')
        ? f.started_by_name
        : 'An administrator',
    started_at: f.started_at,
    ends_at: f.ends_at,
    run_id: f.run_id
  }
}

/** `GET /api/chaos/status` — FIXED SHAPE (the client clusters code against it). */
export interface ChaosStatus {
  allowed: boolean
  reason: string | null
  armed: ArmedFault[]
  nodes: string[]
}

export async function chaosStatus(): Promise<ChaosStatus> {
  const reason = chaosRefusal()
  const nodes = new Set<string>([CHAOS_NODE])
  try {
    for (const row of await listInstances()) {
      if (row.id) nodes.add(`${String(row.instance ?? '')}·${String(row.id)}`)
    }
  } catch {
    /* no roster without Redis */
  }
  return { allowed: !reason, reason, armed: reason ? [] : armedFaults(), nodes: [...nodes] }
}

// ─── Socket events ────────────────────────────────────────────────────────────

export const CHAOS_WATCH_ROOM = 'watch:chaos'

/**
 * Everyone: the armed list changed (the banner re-reads or applies the payload). Blind faults
 * (#2854, armed-visibility.ts) leave the broadcast; their insiders get their fuller list in
 * their own room right after, and the console watch room gets everything.
 */
export function emitArmedChanged(): void {
  const at = Date.now()
  const all = armedFaults()
  emitToTenant(currentTenantKey(), 'chaos:armed', {
    at,
    armed: publicArmed(all).map(publicArmedView)
  })
  if (!anyHidden(all)) return
  try {
    const io = getIo()
    for (const [userId, list] of insiderViews(all))
      io?.to(`user:${userId}`).emit('chaos:armed', { at, armed: list.map(publicArmedView) })
    io?.to(tenantScopedRoom(CHAOS_WATCH_ROOM)).emit('chaos:armed', {
      at,
      armed: all.map(publicArmedView)
    })
  } catch {
    /* decoration */
  }
}

/** Admins watching the console (`admin:join chaos`): a run changed or got an event. */
export function emitChaosWatch(
  event: 'chaos:run' | 'chaos:event',
  payload: Record<string, unknown>
): void {
  try {
    getIo()?.to(tenantScopedRoom(CHAOS_WATCH_ROOM)).emit(event, payload)
  } catch {
    /* decoration */
  }
}

/** Append an event to a run's timeline and push it to the cockpit. The one way to add one. */
export async function addRunEvent(
  runId: string,
  kind: RunEventKind,
  data: Record<string, unknown> = {},
  actor: string | null = null
): Promise<ChaosRunEvent | null> {
  const ev = await appendRunEvent(runId, kind, data, actor)
  if (ev) emitChaosWatch('chaos:event', { run_id: runId, event: ev })
  return ev
}

// ─── Hooks the later steps fill (#2828 steady state, #2848 pre-flight) ────────

export interface DrillHooks {
  /** Throws ChaosError(409, 'CHAOS_PREFLIGHT', {checks}) when the run may not start. */
  preflight?: (input: StartDrillInput) => Promise<{ checks: unknown[]; ok: boolean }>
  /** Called once the fault is armed; returns the baseline to store on the run. */
  onArmed?: (run: ChaosRun, fault: ArmedFault) => Promise<Record<string, unknown> | null>
  /** Called when the run ends, before the verdict is written; may decide it. */
  verdict?: (
    run: ChaosRun,
    how: 'completed' | 'stopped' | 'aborted'
  ) => Promise<{ verdict: Verdict; detail: Record<string, unknown> | null } | null>
}

const hooks: DrillHooks = {}
export function setDrillHooks(h: Partial<DrillHooks>): void {
  Object.assign(hooks, h)
}

// ─── Start / stop ─────────────────────────────────────────────────────────────

export interface StartDrillInput {
  fault_key: string
  target?: unknown
  params?: unknown
  seconds?: unknown
  hypothesis?: HypothesisRule[] | null
  /** Admin-only overrides, recorded on the run (only `working_hours` exists, #2848). */
  override?: { working_hours?: boolean } | null
  note?: string | null
  /** Consecutive samples past tolerance before the auto-abort (1–10, default 3; #2828). */
  abort_after?: unknown
  kind?: Extract<RunKind, 'drill' | 'monkey' | 'gameday'>
  preset_id?: string | null
  gameday_id?: string | null
  by: { id: string | null; name: string | null }
}

/** Open job runs by run id (this process started them). */
const jobRuns = new Map<string, JobRunHandle>()

async function openJobRun(run: ChaosRun): Promise<number | null> {
  try {
    const { startJobRun } = await import('../job-runs.js')
    const h = await startJobRun('chaos', `chaos:${run.fault_key ?? run.kind}`, {
      label: `Chaos: ${run.label}`,
      triggeredBy: run.started_by
    })
    jobRuns.set(run.id, h)
    return h.id
  } catch {
    /* bookkeeping never blocks a drill */
    return null
  }
}

function sanitizeHypothesis(raw: unknown): HypothesisRule[] {
  if (!Array.isArray(raw)) return []
  const out: HypothesisRule[] = []
  for (const r of raw.slice(0, 20)) {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    const sampler = String(o.sampler ?? '').trim()
    const op = String(o.op ?? '<')
    const limit = Number(o.limit)
    if (!/^[\w.-]{1,60}$/.test(sampler) || !['<', '<=', '>', '>='].includes(op)) continue
    if (!Number.isFinite(limit)) continue
    const tolerance = o.tolerance == null ? undefined : Math.max(0, Number(o.tolerance) || 0)
    out.push({ sampler, op: op as HypothesisRule['op'], limit, tolerance })
  }
  return out
}

export async function startDrill(
  request: StartDrillInput
): Promise<{ run: ChaosRun; fault: ArmedFault }> {
  assertChaosAllowed()
  const def = getFault(request.fault_key)
  if (!def) throw new ChaosError(`unknown fault ${request.fault_key}`, 400, 'CHAOS_UNKNOWN_FAULT')
  // #2862 — this environment's caps, whatever the caller sent (clamped or refused, CHAOS_CAP).
  const capped = await enforceChaosCaps(def, request)
  const input: StartDrillInput = {
    ...request,
    target: capped.target,
    params: capped.params,
    seconds: capped.seconds
  }
  const seconds = clampSeconds(def, input.seconds)
  const hypothesis =
    input.hypothesis == null
      ? (def.hypothesis_defaults ?? [])
      : sanitizeHypothesis(input.hypothesis)
  const base = {
    kind: input.kind ?? ('drill' as const),
    fault_key: def.key,
    label: def.label,
    hypothesis,
    started_by: input.by.id,
    preset_id: input.preset_id ?? null,
    gameday_id: input.gameday_id ?? null,
    meta: {
      started_by_name: input.by.name,
      note: input.note ? String(input.note).slice(0, 500) : null,
      node: CHAOS_NODE,
      override: input.override ?? null,
      seconds,
      caps: capped.applied.length ? capped.applied : undefined,
      abort_after: Math.min(10, Math.max(1, Math.round(Number(input.abort_after)) || 3))
    } as Record<string, unknown>
  }

  if (hooks.preflight) {
    const pf = await hooks.preflight(input)
    if (!pf.ok) {
      const refused = await createRun({
        ...base,
        status: 'refused',
        ended_at: new Date().toISOString(),
        meta: { ...base.meta, preflight: pf.checks }
      })
      emitChaosWatch('chaos:run', { run: refused })
      throw new ChaosError('Pre-flight failed', 409, 'CHAOS_PREFLIGHT', {
        run_id: refused.id,
        checks: pf.checks
      })
    }
    base.meta.preflight = pf.checks
  }

  const now = Date.now()
  const run = await createRun({
    ...base,
    status: 'running',
    started_at: new Date(now).toISOString(),
    ends_at: new Date(now + seconds * 1000).toISOString()
  })
  const jobRunId = await openJobRun(run)
  if (jobRunId != null) run.meta = { ...run.meta, job_run_id: jobRunId }

  let fault: ArmedFault
  try {
    fault = await armFault({
      fault_key: def.key,
      target: input.target,
      params: input.params,
      seconds,
      started_by: input.by.id,
      started_by_name: input.by.name,
      run_id: run.id
    })
  } catch (err) {
    const e = err as ChaosError
    await updateRun(run.id, {
      status: 'refused',
      ended_at: new Date().toISOString(),
      meta: { ...run.meta, refusal: e?.message ?? String(err) }
    })
    await addRunEvent(run.id, 'note', { refusal: e?.message ?? String(err) }, input.by.id)
    await jobRuns.get(run.id)?.fail(err)
    jobRuns.delete(run.id)
    throw err
  }

  // #2862 — a capped share sampled on top of the target shows in the run's params too.
  const runParams =
    fault.target.sample_pct != null
      ? { ...fault.params, sample_pct: fault.target.sample_pct }
      : fault.params
  const stored = (await updateRun(run.id, {
    target: fault.target,
    params: runParams,
    ends_at: new Date(fault.ends_at).toISOString(),
    meta: { ...run.meta, fault_id: fault.id }
  })) ?? { ...run, target: fault.target, params: runParams }
  await addRunEvent(
    run.id,
    'armed',
    {
      fault_id: fault.id,
      fault_key: fault.fault_key,
      target: describeTarget(fault.target),
      params: runParams,
      seconds
    },
    input.by.id
  )
  jobRuns
    .get(run.id)
    ?.log(`armed ${fault.fault_key} on ${describeTarget(fault.target)} for ${seconds}s`)
  if (hooks.onArmed) {
    try {
      const baseline = await hooks.onArmed(stored, fault)
      if (baseline) await updateRun(run.id, { baseline })
    } catch {
      /* the watcher reports its own trouble */
    }
  }
  emitChaosWatch('chaos:run', { run: stored })
  return { run: stored, fault }
}

/**
 * Close a run: verdict, status, ended_at, the 'stop'/'disarmed'/'abort' event, the job run and
 * the cockpit. Conditional on the run still being open, so two replicas ending the same run
 * keep the first outcome.
 */
export async function finalizeRun(
  runId: string,
  how: 'completed' | 'stopped' | 'aborted',
  opts: {
    reason?: string
    actor?: string | null
    verdict?: Verdict
    detail?: Record<string, unknown> | null
  } = {}
): Promise<ChaosRun | null> {
  const run = await getRun(runId)
  if (!run || !['running', 'preflight', 'planned'].includes(run.status)) return null
  let verdict: Verdict = opts.verdict ?? (how === 'aborted' ? 'aborted' : 'held')
  let detail = opts.detail ?? null
  if (!opts.verdict && hooks.verdict) {
    try {
      const v = await hooks.verdict(run, how)
      if (v) {
        verdict = v.verdict
        detail = v.detail
      }
    } catch {
      /* keep the default */
    }
  }
  const ended_at = new Date().toISOString()
  const next = await updateRun(
    run.id,
    { status: how, verdict, verdict_detail: detail, ended_at },
    { ifStatus: ['running', 'preflight', 'planned'] }
  )
  if (!next) return null
  await addRunEvent(
    run.id,
    how === 'aborted' ? 'abort' : how === 'stopped' ? 'stop' : 'disarmed',
    { reason: opts.reason ?? how, verdict },
    opts.actor ?? null
  )
  const h = jobRuns.get(run.id)
  if (h) {
    jobRuns.delete(run.id)
    try {
      if (how === 'aborted') await h.fail(new Error(`aborted: ${opts.reason ?? 'limit crossed'}`))
      else await h.complete(`${how}; verdict ${verdict}`)
    } catch {
      /* bookkeeping */
    }
  }
  emitChaosWatch('chaos:run', { run: next })
  return next
}

/** Stop one run's fault everywhere and close the run. */
export async function stopDrill(
  runId: string,
  by: { id: string | null },
  reason = 'stopped by operator'
): Promise<ChaosRun> {
  const run = await getRun(runId)
  if (!run) throw new ChaosError('No such run', 404, 'CHAOS_NO_RUN')
  if (run.status !== 'running')
    throw new ChaosError('The run is not running', 409, 'CHAOS_NOT_RUNNING')
  const faultId = typeof run.meta.fault_id === 'string' ? run.meta.fault_id : null
  if (faultId) await disarm(faultId, reason)
  const next = await finalizeRun(run.id, 'stopped', { reason, actor: by.id })
  return next ?? ((await getRun(run.id)) as ChaosRun)
}

/** Auto-abort (#2828): the fault is disarmed and the run closed with verdict `aborted`. */
export async function abortDrill(
  runId: string,
  reason: string,
  detail: Record<string, unknown> | null = null
): Promise<ChaosRun | null> {
  const run = await getRun(runId)
  if (run?.status !== 'running') return null
  const faultId = typeof run.meta.fault_id === 'string' ? run.meta.fault_id : null
  if (faultId) await disarm(faultId, `aborted: ${reason}`)
  return finalizeRun(run.id, 'aborted', { reason, verdict: 'aborted', detail })
}

/** Stop every fault on every replica and close every open run. */
export async function stopAllDrills(
  by: { id: string | null },
  reason = 'stop all'
): Promise<{ faults: ArmedFault[]; runs: string[] }> {
  const faults = await stopAll(reason)
  const closed = new Set<string>()
  for (const f of faults) {
    if (!f.run_id) continue
    if (await finalizeRun(f.run_id, 'stopped', { reason, actor: by.id })) closed.add(f.run_id)
  }
  // Open runs whose fault is already gone (another node's expiry we never heard of).
  for (const run of await listRuns({ status: 'running', limit: 50 })) {
    if (closed.has(run.id)) continue
    if (await finalizeRun(run.id, 'stopped', { reason, actor: by.id })) closed.add(run.id)
  }
  return { faults, runs: [...closed] }
}

// ─── Game-day ids from a request body ─────────────────────────────────────────

/**
 * A `gameday_id` in a POST /runs body is honoured only when a game-day run with that id is
 * running and the caller leads it (meta.lead / started_by) or is an administrator; anything
 * else is stripped, so the pre-flight's "one drill at a time" exemption cannot be claimed by
 * naming another drill's id. The scheduler calls startDrill() server-side and stays trusted.
 */
export async function trustedGamedayId(
  raw: unknown,
  caller: { id: string | null; isAdmin: boolean }
): Promise<{ gameday_id: string | null; note: string | null }> {
  if (raw == null || raw === '') return { gameday_id: null, note: null }
  const id = String(raw).slice(0, 80)
  const runs = await listRuns({ status: 'running', kind: 'gameday', limit: 50 })
  const day = runs.find((r) => r.gameday_id === id)
  if (!day)
    return { gameday_id: null, note: `gameday_id ${id} ignored: no running game day by that id` }
  const lead = typeof day.meta.lead === 'string' ? day.meta.lead.toLowerCase() : null
  const me = caller.id?.toLowerCase() ?? null
  const leads = !!me && (me === lead || me === day.started_by?.toLowerCase())
  if (!leads && !caller.isAdmin)
    return {
      gameday_id: null,
      note: `gameday_id ${id} ignored: the caller does not lead that game day`
    }
  return { gameday_id: id, note: null }
}

// ─── Record-only runs (CI, game-day steps measured elsewhere) ──────────────────

export interface RecordRunInput {
  kind: Extract<RunKind, 'ci' | 'gameday'>
  fault_key?: string | null
  label: string
  verdict: Verdict
  metrics?: Record<string, unknown> | null
  started_at?: string | null
  ended_at?: string | null
  meta?: Record<string, unknown> | null
  gameday_id?: string | null
}

export async function recordRun(
  input: RecordRunInput,
  by: { id: string | null; name: string | null }
): Promise<ChaosRun> {
  if (!['ci', 'gameday'].includes(input.kind)) throw new ChaosError('kind must be ci or gameday')
  if (!['held', 'broke', 'aborted'].includes(input.verdict))
    throw new ChaosError('verdict must be held, broke or aborted')
  const label = String(input.label ?? '')
    .trim()
    .slice(0, 200)
  if (!label) throw new ChaosError('label is required')
  const started = input.started_at ? new Date(input.started_at) : new Date()
  const ended = input.ended_at ? new Date(input.ended_at) : new Date()
  if (Number.isNaN(started.getTime()) || Number.isNaN(ended.getTime()))
    throw new ChaosError('started_at / ended_at must be dates')
  const run = await createRun({
    kind: input.kind,
    status: input.verdict === 'aborted' ? 'aborted' : 'completed',
    fault_key: input.fault_key ? String(input.fault_key).slice(0, 64) : null,
    label,
    verdict: input.verdict,
    verdict_detail: input.metrics ?? null,
    started_by: by.id,
    started_at: started.toISOString(),
    ends_at: ended.toISOString(),
    ended_at: ended.toISOString(),
    gameday_id: input.gameday_id ?? null,
    meta: { ...(input.meta ?? {}), started_by_name: by.name, recorded: true, node: CHAOS_NODE }
  })
  emitChaosWatch('chaos:run', { run })
  return run
}

// ─── Registry listener: expiry closes runs, every change updates the banner ───

let wired = false
export function wireDrillListeners(): void {
  if (wired) return
  wired = true
  onRegistryChange((ev: RegistryEvent) => void onRegistryEvent(ev))
}

async function onRegistryEvent(ev: RegistryEvent): Promise<void> {
  emitArmedChanged()
  if (ev.type === 'expired' && !ev.remote && ev.fault.run_id) {
    await finalizeRun(ev.fault.run_id, 'completed', { reason: 'window ended' })
  } else if (
    ev.type === 'disarmed' &&
    !ev.remote &&
    ev.fault.run_id &&
    ev.reason.startsWith('apply failed')
  ) {
    await addRunEvent(ev.fault.run_id, 'note', { apply_failed: ev.reason })
  }
}

/** The run a fault belongs to, when it is still armed here. */
export function runIdOfFault(faultId: string): string | null {
  return armedFault(faultId)?.run_id ?? null
}

/** Tests only. */
export function _resetDrillForTests(): void {
  jobRuns.clear()
  for (const k of Object.keys(hooks) as Array<keyof DrillHooks>) delete hooks[k]
  wired = false
}
