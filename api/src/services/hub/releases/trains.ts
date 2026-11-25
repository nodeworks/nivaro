import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { readHubDeploy } from '../promote-run.js'
import type { EnvFigures } from './figures.js'
import { readEnvFiguresById } from './figures.js'
import { type FreezeRefusal, freezeRefusal } from './freeze.js'
import { notifyAppPeople, notifyAppPeopleAndAdmins } from './notify.js'
import { type PersonCheck, personCanAct } from './person.js'
import {
  isTransientCode,
  type PlannedStart,
  refusalCode,
  refusalText,
  startPlannedPromotion
} from './start.js'

/**
 * Release trains (Hub release operations): one version promoted through an app's environments
 * in order (e.g. development → staging → production), with a hold after each step.
 *
 * Each step is a NORMAL promotion run (startPlannedPromotion: plan judged again, lock, job run,
 * deploy row, verify, history), recorded as started by the person who started the train. After
 * it succeeds the step holds:
 *
 *   soak        `soak_minutes` must pass after the deploy finished
 *   readiness   then, when `min_readiness` is set, the app's readiness score (hub link) must
 *               reach it; still short `max_hold_minutes` after the soak = `held`, and the
 *               train waits for a person (Skip the hold, or Abort)
 *
 * A rollback of the environment during the hold (automatic or by hand) fails the step. A step
 * whose environment already runs the version goes straight to its hold. A freeze window makes a
 * pending step wait. A refusal that passes on its own (a lock, GitLab unreachable) is tried again
 * on the next tick, at most MAX_ATTEMPTS times; any other refusal fails the step and the train.
 *
 * State lives in the row (steps JSON + step_index + rev): every write is compare-and-set on
 * `rev`, so the minute tick (one leader, services/hub/releases/tick.ts) and a person's action
 * never both move a step. A step is claimed (`starting`) before its promotion starts, and a
 * claim older than STARTING_STALE_MS is settled from the deploy rows — never started twice.
 */

export const TRAINS = 'nivaro_hub_trains'
export const MAX_STEPS = 10
export const MAX_ATTEMPTS = 60
/** Above the worst case of one start (two gathers with GitLab timeouts), so a live start is never
 *  mistaken for a stopped one. */
export const STARTING_STALE_MS = 10 * 60_000
const VERSION_RE = /^\d+\.\d+\.\d+$/

export type TrainStatus = 'running' | 'done' | 'failed' | 'aborted'
export type TrainStepStatus =
  | 'pending'
  | 'starting'
  | 'promoting'
  | 'soaking'
  | 'held'
  | 'passed'
  | 'skipped'
  | 'failed'

export interface TrainStep {
  environment_id: number
  key: string
  soak_minutes: number
  /** null = no readiness gate (the soak alone). */
  min_readiness: number | null
  max_hold_minutes: number
  status: TrainStepStatus
  deploy_id: number | null
  started_at: string | null
  deployed_at: string | null
  passed_at: string | null
  /** The last thing the step waited on, or why it stopped. */
  note: string | null
  readiness: number | null
  attempts: number
  /**
   * The step is held BEFORE its promotion (an earlier environment no longer runs the version,
   * or the person behind the train can no longer act): Skip lets it start without that check.
   */
  blocked?: boolean
  /** Set by a person's Skip of a blocked step: start once without the pre-start checks. */
  override?: boolean
}

export interface Train {
  id: number
  app_id: number
  version: string
  status: TrainStatus
  steps: TrainStep[]
  step_index: number
  rev: number
  error: string | null
  schedule_id: number | null
  started_by: string | null
  started_at: string | null
  updated_at: string | null
  finished_at: string | null
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString())

export function trainFromRow(r: Record<string, unknown>): Train {
  let steps: TrainStep[] = []
  try {
    const x = JSON.parse(String(r.steps ?? '[]'))
    steps = Array.isArray(x) ? x : []
  } catch {
    steps = []
  }
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    version: String(r.version),
    status: String(r.status) as TrainStatus,
    steps,
    step_index: Number(r.step_index ?? 0),
    rev: Number(r.rev ?? 0),
    error: r.error == null ? null : String(r.error),
    schedule_id: r.schedule_id == null ? null : Number(r.schedule_id),
    started_by: r.started_by == null ? null : String(r.started_by),
    started_at: iso(r.started_at),
    updated_at: iso(r.updated_at),
    finished_at: iso(r.finished_at)
  }
}

export async function readTrain(id: number): Promise<Train | null> {
  const r = (await db(TRAINS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? trainFromRow(r) : null
}

export async function listTrains(o: { appIds?: number[]; limit?: number } = {}): Promise<Train[]> {
  const q = db(TRAINS)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 50, 200))
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map(trainFromRow)
}

/**
 * Compare-and-set on `rev`: re-reads and re-applies `fn` up to 3 times. `fn` answers the new
 * train (it may change it in place) or null to leave the row as it is. Answers the stored train.
 */
export async function mutateTrain(
  id: number,
  fn: (t: Train) => Train | null
): Promise<Train | null> {
  for (let i = 0; i < 3; i++) {
    const cur = await readTrain(id)
    if (!cur) return null
    const next = fn(structuredClone(cur))
    if (!next) return null
    const n = await db(TRAINS)
      .where({ id, rev: cur.rev })
      .update({
        status: next.status,
        steps: JSON.stringify(next.steps),
        step_index: next.step_index,
        error: next.error ? next.error.slice(0, 1000) : null,
        rev: cur.rev + 1,
        updated_at: new Date(),
        finished_at: next.finished_at ? new Date(next.finished_at) : null
      })
    if (n) return { ...next, rev: cur.rev + 1 }
  }
  return null
}

// ─── input ──────────────────────────────────────────────────────────────────────────────────

export interface TrainStepInput {
  environment_id: number
  soak_minutes: number
  min_readiness: number | null
  max_hold_minutes: number
}

export interface TrainInput {
  version: string
  steps: TrainStepInput[]
}

/**
 * Validates a train body against the app's environments (id, key, position, on_shared). Steps
 * must be the app's own environments, each once, in the app's order.
 */
export function validateTrain(
  b: Record<string, unknown>,
  envs: Array<{ id: number; key: string; position: number; on_shared?: boolean }>
): (TrainInput & { keys: string[] }) | { error: string } {
  const version = typeof b.version === 'string' ? b.version.trim() : ''
  if (!VERSION_RE.test(version)) return { error: 'version is x.y.z (a Nivaro release)' }
  if (!Array.isArray(b.steps) || b.steps.length === 0)
    return { error: 'steps lists the environments in order' }
  if (b.steps.length > MAX_STEPS) return { error: `a train has at most ${MAX_STEPS} steps` }
  const out: TrainStepInput[] = []
  const keys: string[] = []
  let lastPos = Number.NEGATIVE_INFINITY
  for (const raw of b.steps as unknown[]) {
    const s = (raw ?? {}) as Record<string, unknown>
    const env = envs.find((e) => e.id === Number(s.environment_id))
    if (!env) return { error: 'every step names one of the app’s environments' }
    if (out.some((x) => x.environment_id === env.id))
      return { error: `${env.key} is in the train twice` }
    if (env.position <= lastPos)
      return { error: 'steps follow the app’s environment order (earliest first)' }
    if (env.on_shared)
      return {
        error: `${env.key} runs on a shared deployment: its version follows the deployment, upgrade that instead`
      }
    lastPos = env.position
    const soak = Number(s.soak_minutes ?? 0)
    if (!Number.isInteger(soak) || soak < 0 || soak > 7 * 24 * 60)
      return { error: 'soak_minutes is 0 to 10080 (a week)' }
    const ready = s.min_readiness == null || s.min_readiness === '' ? null : Number(s.min_readiness)
    if (ready != null && (!Number.isInteger(ready) || ready < 1 || ready > 100))
      return { error: 'min_readiness is 1 to 100, or empty for none' }
    const hold = Number(s.max_hold_minutes ?? 240)
    if (!Number.isInteger(hold) || hold < 5 || hold > 7 * 24 * 60)
      return { error: 'max_hold_minutes is 5 to 10080' }
    out.push({
      environment_id: env.id,
      soak_minutes: soak,
      min_readiness: ready,
      max_hold_minutes: hold
    })
    keys.push(env.key)
  }
  return { version, steps: out, keys }
}

/** Stores a new running train (one per app at a time). */
export async function createTrain(
  appId: number,
  input: TrainInput & { keys: string[] },
  o: { userId: string | null; scheduleId?: number | null }
): Promise<Train> {
  const running = await db(TRAINS).where({ app_id: appId, status: 'running' }).first('id')
  if (running)
    throw Object.assign(new Error(`Train #${running.id} of this app is still running`), {
      code: 'TRAIN_RUNNING',
      status: 409
    })
  const steps: TrainStep[] = input.steps.map((s, i) => ({
    ...s,
    key: input.keys[i],
    status: 'pending',
    deploy_id: null,
    started_at: null,
    deployed_at: null,
    passed_at: null,
    note: null,
    readiness: null,
    attempts: 0
  }))
  const { insertReturningId } = await import('../../../db/dialect/ef.js')
  const id = Number(
    await insertReturningId(db, TRAINS, {
      app_id: appId,
      version: input.version,
      status: 'running',
      steps: JSON.stringify(steps),
      step_index: 0,
      rev: 0,
      schedule_id: o.scheduleId ?? null,
      started_by: o.userId,
      started_at: new Date(),
      updated_at: new Date()
    })
  )
  return (await readTrain(id)) as Train
}

// ─── the state machine ──────────────────────────────────────────────────────────────────────

export interface TrainDeps {
  now(): number
  start(envId: number, o: PlannedStart): Promise<{ deployId: number }>
  deploy(
    id: number
  ): Promise<{ status: string; finished_at: string | null; error: string | null } | null>
  figures(envId: number): Promise<EnvFigures>
  freeze(appId: number): Promise<FreezeRefusal | null>
  /** A rollback of the environment ran after deploy `afterId` (automatic or by hand). */
  rolledBack(envId: number, afterId: number): Promise<boolean>
  /** When the environment last finished a successful deploy of `version` (ALREADY_RUNS). */
  lastSuccess(envId: number, version: string): Promise<string | null>
  /** A promote run of `version` started on the environment at or after `since` (a lost claim). */
  startedSince(envId: number, version: string, since: number): Promise<number | null>
  notify(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean },
    also: Array<string | null>
  ): Promise<unknown>
  /** The automatic rollback watch of a deploy: 'pending' = a rule applies, no watch row yet. */
  watch(envId: number, deployId: number): Promise<WatchState>
  /** What the environment answers it runs now (a fresh status read); null = cannot tell. */
  liveVersion(envId: number): Promise<string | null>
  /** Whether the train's person may still start promotions. */
  person(userId: string | null): Promise<PersonCheck>
  /** Tells owners AND every administrator (a run nobody can vouch for any more). */
  notifyAll(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean }
  ): Promise<unknown>
  /** Activity row for a promotion the train started. */
  logStart(deployId: number, comment: string, userId: string | null): Promise<unknown>
}

export type WatchState =
  | 'none'
  | 'pending'
  | 'watching'
  | 'rolling'
  | 'passed'
  | 'rolled_back'
  | 'failed'
  | 'superseded'

/** The watch state of a deploy from the rule and watch rows (the default deps read it). */
export async function watchStateOf(
  envId: number,
  deployId: number,
  now = Date.now()
): Promise<WatchState> {
  const w = (await db('nivaro_hub_rollback_watches')
    .where({ deploy_id: deployId })
    .first('status')) as { status: string } | undefined
  if (w) return w.status as WatchState
  const rule = (await db('nivaro_hub_rollback_rules')
    .where({ environment_id: envId, enabled: true })
    .first('window_minutes', 'updated_at')) as
    | { window_minutes: number; updated_at: unknown }
    | undefined
  if (!rule) return 'none'
  const d = (await db('nivaro_hub_deploys')
    .where({ id: deployId })
    .first('finished_at', 'kind', 'status', 'from_version', 'version')) as
    | {
        finished_at: unknown
        kind: string
        status: string
        from_version: unknown
        version: unknown
      }
    | undefined
  if (!d || d.kind !== 'promote' || d.status !== 'success' || !d.finished_at) return 'none'
  if (d.from_version == null || d.from_version === d.version) return 'none'
  const fin = new Date(d.finished_at as string).getTime()
  const since = rule.updated_at ? new Date(rule.updated_at as string).getTime() : 0
  // The watch opens on the next minute tick for a deploy inside the window after the rule.
  if (fin < since || now - fin > Number(rule.window_minutes) * 60_000) return 'none'
  return 'pending'
}

export function defaultTrainDeps(): TrainDeps {
  const DEPLOYS = 'nivaro_hub_deploys'
  return {
    now: () => Date.now(),
    start: (envId, o) => startPlannedPromotion(envId, o),
    deploy: async (id) => {
      const r = await readHubDeploy(id)
      return r ? { status: r.status, finished_at: iso(r.finished_at), error: r.error } : null
    },
    figures: (envId) => readEnvFiguresById(envId),
    freeze: (appId) => freezeRefusal({ appIds: [appId], action: 'promote' }),
    rolledBack: async (envId, afterId) =>
      !!(await db(DEPLOYS)
        .where({ environment_id: envId, kind: 'rollback' })
        .where('id', '>', afterId)
        .first('id')),
    lastSuccess: async (envId, version) => {
      const r = (await db(DEPLOYS)
        .where({ environment_id: envId, version, status: 'success' })
        .whereIn('kind', ['promote', 'rollback'])
        .orderBy('id', 'desc')
        .first('finished_at')) as { finished_at: unknown } | undefined
      return r ? iso(r.finished_at) : null
    },
    startedSince: async (envId, version, since) => {
      const r = (await db(DEPLOYS)
        .where({ environment_id: envId, version, kind: 'promote' })
        .where('started_at', '>=', new Date(since - 5000))
        .orderBy('id', 'asc')
        .first('id')) as { id: number } | undefined
      return r ? Number(r.id) : null
    },
    notify: (appId, note, also) => notifyAppPeople(appId, note, also),
    watch: (envId, deployId) => watchStateOf(envId, deployId),
    liveVersion: async (envId) => {
      const row = (await db('nivaro_hub_environments').where({ id: envId }).first()) as
        | Record<string, unknown>
        | undefined
      if (!row) return null
      const { readEnvironmentStatus } = await import('../status.js')
      const st = await readEnvironmentStatus(
        {
          id: envId,
          key: String(row.key),
          base_url: String(row.base_url),
          hub_token: (row.hub_token as string | null) ?? null,
          placement_id: row.placement_id == null ? null : Number(row.placement_id)
        },
        { fresh: true }
      )
      return st.version
    },
    person: (userId) => personCanAct(userId),
    notifyAll: (appId, note) => notifyAppPeopleAndAdmins(appId, note),
    logStart: (deployId, comment, userId) =>
      logActivity({
        action: 'hub-promote-start',
        user: userId,
        collection: 'nivaro_hub_deploys',
        item: String(deployId),
        comment,
        origin: 'machine'
      })
  }
}

type Step = 'again' | 'wait'

/** Changes the current step (when it is still `status`). */
function stepPatch(
  idx: number,
  status: TrainStepStatus | TrainStepStatus[],
  patch: Partial<TrainStep>,
  extra?: (t: Train) => void
) {
  const allowed = Array.isArray(status) ? status : [status]
  return (t: Train): Train | null => {
    if (t.status !== 'running' || t.step_index !== idx) return null
    const s = t.steps[idx]
    if (!s || !allowed.includes(s.status)) return null
    Object.assign(s, patch)
    extra?.(t)
    return t
  }
}

const at = (ms: number) => new Date(ms).toISOString()

async function failTrain(t: Train, idx: number, note: string, deps: TrainDeps) {
  const done = await mutateTrain(t.id, (x) => {
    if (x.status !== 'running') return null
    const s = x.steps[idx]
    if (s && s.status !== 'failed') {
      s.status = 'failed'
      s.note = note
    }
    x.status = 'failed'
    x.error = `${s?.key ?? 'a step'}: ${note}`
    x.finished_at = at(deps.now())
    return x
  })
  if (done)
    await deps.notify(
      t.app_id,
      {
        subject: `Release train ${t.version} stopped at ${t.steps[idx]?.key ?? 'a step'}`,
        message: `The release train of ${t.version} stopped: ${note}`,
        urgent: true
      },
      [t.started_by]
    )
}

async function stepOnce(t: Train, deps: TrainDeps): Promise<Step> {
  const idx = t.step_index
  const s = t.steps[idx]
  const now = deps.now()
  if (!s) {
    const done = await mutateTrain(t.id, (x) =>
      x.status === 'running' && x.step_index === idx
        ? { ...x, status: 'done', finished_at: at(now) }
        : null
    )
    if (done)
      await deps.notify(
        t.app_id,
        {
          subject: `Release train ${t.version} finished`,
          message: `${t.version} went through ${t.steps.map((x) => x.key).join(' → ')}.`
        },
        [t.started_by]
      )
    return 'wait'
  }
  switch (s.status) {
    case 'passed':
    case 'skipped': {
      await mutateTrain(t.id, (x) =>
        x.status === 'running' && x.step_index === idx ? { ...x, step_index: idx + 1 } : null
      )
      return 'again'
    }
    case 'failed':
      await failTrain(t, idx, s.note ?? 'the step failed', deps)
      return 'wait'
    case 'held':
      return 'wait'
    case 'pending': {
      const frozen = await deps.freeze(t.app_id)
      if (frozen) {
        const note = `Waiting for the freeze to end: ${frozen.message}`
        if (s.note !== note) await mutateTrain(t.id, stepPatch(idx, 'pending', { note }))
        return 'wait'
      }
      if (!s.override) {
        const block = async (why: string, subject: string): Promise<Step> => {
          const held = await mutateTrain(
            t.id,
            stepPatch(idx, 'pending', {
              status: 'held',
              blocked: true,
              note: `Held before ${s.key}: ${why} — skip to start it anyway, or abort the train`
            })
          )
          if (held)
            await deps.notifyAll(t.app_id, {
              subject,
              message: `The release train of ${t.version} is held before ${s.key}: ${why}.`,
              urgent: true
            })
          return 'wait'
        }
        const who = await deps.person(t.started_by)
        if (!who.ok)
          return block(
            `${who.why}, so nobody vouches for this train`,
            `Release train ${t.version} needs a person`
          )
        // Every earlier environment the train promoted must still run the version (a rollback,
        // a deploy outside the Hub or a long freeze wait may have changed it since).
        for (const e of t.steps.slice(0, idx)) {
          if (e.status !== 'passed') continue
          const live = await deps.liveVersion(e.environment_id)
          if (live == null) {
            const note = `Waiting: cannot read which version ${e.key} runs`
            if (s.note !== note) await mutateTrain(t.id, stepPatch(idx, 'pending', { note }))
            return 'wait'
          }
          if (live !== t.version)
            return block(
              `${e.key} runs ${live} now, not ${t.version}`,
              `Release train ${t.version} held: ${e.key} no longer runs it`
            )
        }
      }
      const claimed = await mutateTrain(
        t.id,
        stepPatch(idx, 'pending', {
          status: 'starting',
          started_at: at(now),
          attempts: s.attempts + 1,
          note: null,
          override: false
        })
      )
      if (!claimed) return 'again'
      try {
        const out = await deps.start(s.environment_id, {
          kind: 'promote',
          version: t.version,
          userId: t.started_by
        })
        await mutateTrain(
          t.id,
          stepPatch(idx, 'starting', { status: 'promoting', deploy_id: out.deployId })
        )
        await Promise.resolve(
          deps.logStart(
            out.deployId,
            `Release train #${t.id} step ${idx + 1} (${s.key})`,
            t.started_by
          )
        ).catch(() => undefined)
        return 'again'
      } catch (err) {
        const code = refusalCode(err)
        if (code === 'ALREADY_RUNS') {
          const since = await deps.lastSuccess(s.environment_id, t.version)
          await mutateTrain(
            t.id,
            stepPatch(idx, 'starting', {
              status: 'soaking',
              deployed_at: since ?? at(now),
              note: `${s.key} already runs ${t.version}`
            })
          )
          return 'again'
        }
        const retry = code === 'FROZEN' || (isTransientCode(code) && s.attempts + 1 < MAX_ATTEMPTS)
        await mutateTrain(
          t.id,
          stepPatch(idx, 'starting', {
            status: retry ? 'pending' : 'failed',
            note: `${retry ? 'Trying again: ' : ''}${code}: ${refusalText(err)}`
          })
        )
        return retry ? 'wait' : 'again'
      }
    }
    case 'starting': {
      const since = s.started_at ? Date.parse(s.started_at) : now
      if (now - since < STARTING_STALE_MS) return 'wait'
      // The claim of a tick that stopped: adopt the run it started, else start again.
      const id = await deps.startedSince(s.environment_id, t.version, since)
      await mutateTrain(
        t.id,
        stepPatch(
          idx,
          'starting',
          id
            ? { status: 'promoting', deploy_id: id }
            : { status: 'pending', note: 'Starting again' }
        )
      )
      return 'again'
    }
    case 'promoting': {
      const d = s.deploy_id == null ? null : await deps.deploy(s.deploy_id)
      if (!d) {
        await mutateTrain(
          t.id,
          stepPatch(idx, 'promoting', { status: 'failed', note: 'The promotion run is gone' })
        )
        return 'again'
      }
      if (d.status === 'running' || d.status === 'planned') return 'wait'
      if (d.status === 'success') {
        await mutateTrain(
          t.id,
          stepPatch(idx, 'promoting', {
            status: 'soaking',
            deployed_at: d.finished_at ?? at(now),
            note: null
          })
        )
        return 'again'
      }
      await mutateTrain(
        t.id,
        stepPatch(idx, 'promoting', {
          status: 'failed',
          note: `The promotion ${d.status}${d.error ? `: ${d.error}` : ''}`.slice(0, 900)
        })
      )
      return 'again'
    }
    case 'soaking': {
      if (s.deploy_id != null && (await deps.rolledBack(s.environment_id, s.deploy_id))) {
        await mutateTrain(
          t.id,
          stepPatch(idx, 'soaking', {
            status: 'failed',
            note: `${s.key} was rolled back during the hold`
          })
        )
        return 'again'
      }
      const deployed = s.deployed_at ? Date.parse(s.deployed_at) : now
      const soakEnd = deployed + s.soak_minutes * 60_000
      if (now < soakEnd) {
        const note = `Soaking until ${at(soakEnd)}`
        if (s.note !== note) await mutateTrain(t.id, stepPatch(idx, 'soaking', { note }))
        return 'wait'
      }
      /** The hold passed: the deploy's rollback watch must also end clean (or none applies). */
      const passIfWatched = async (readiness: number | null): Promise<Step> => {
        const w = s.deploy_id == null ? 'none' : await deps.watch(s.environment_id, s.deploy_id)
        if (w === 'rolled_back') {
          await mutateTrain(
            t.id,
            stepPatch(idx, 'soaking', {
              status: 'failed',
              note: `${s.key} was rolled back automatically`
            })
          )
          return 'again'
        }
        if (w === 'pending' || w === 'watching' || w === 'rolling') {
          const note = 'Waiting for the automatic rollback watch to end'
          if (s.note !== note) await mutateTrain(t.id, stepPatch(idx, 'soaking', { note }))
          return 'wait'
        }
        if (w === 'failed') {
          const held = await mutateTrain(
            t.id,
            stepPatch(idx, 'soaking', {
              status: 'held',
              note: `Held: the automatic rollback watch of ${s.key} ended without a verdict — check ${s.key}, then skip the hold or abort the train`
            })
          )
          if (held)
            await deps.notify(
              t.app_id,
              {
                subject: `Release train ${t.version} needs a person at ${s.key}`,
                message: `The automatic rollback watch of ${s.key} ended without a verdict. Check it, then skip the hold or abort the train.`,
                urgent: true
              },
              [t.started_by]
            )
          return 'wait'
        }
        await mutateTrain(
          t.id,
          stepPatch(idx, 'soaking', {
            status: 'passed',
            passed_at: at(now),
            ...(readiness != null ? { readiness } : {}),
            note: null
          })
        )
        return 'again'
      }
      if (s.min_readiness == null) return passIfWatched(null)
      const f = await deps.figures(s.environment_id)
      const score = f.readiness_score
      if (score != null && score >= s.min_readiness) return passIfWatched(score)
      const why = !f.linked
        ? `the readiness score cannot be read (${f.error ?? 'no hub link'})`
        : score == null
          ? 'the readiness score is not computed yet'
          : `readiness ${score} is below ${s.min_readiness}`
      if (now >= soakEnd + s.max_hold_minutes * 60_000) {
        const held = await mutateTrain(
          t.id,
          stepPatch(idx, 'soaking', {
            status: 'held',
            readiness: score,
            note: `Held: ${why} after ${s.max_hold_minutes} min — skip the hold or abort the train`
          })
        )
        if (held)
          await deps.notify(
            t.app_id,
            {
              subject: `Release train ${t.version} needs a person at ${s.key}`,
              message: `The hold of ${s.key} did not pass: ${why}. Skip the hold to go on, or abort the train.`,
              urgent: true
            },
            [t.started_by]
          )
        return 'wait'
      }
      const note = `Waiting: ${why}`
      if (s.note !== note || s.readiness !== score)
        await mutateTrain(t.id, stepPatch(idx, 'soaking', { note, readiness: score }))
      return 'wait'
    }
  }
  return 'wait'
}

/** Moves a running train as far as it can go now. Never throws for a step's refusal. */
export async function advanceTrain(
  id: number,
  deps: TrainDeps = defaultTrainDeps()
): Promise<Train | null> {
  for (let i = 0; i < 3 * MAX_STEPS; i++) {
    const t = await readTrain(id)
    if (!t || t.status !== 'running') return t
    if ((await stepOnce(t, deps)) === 'wait') return readTrain(id)
  }
  return readTrain(id)
}

/** Every running train, one after another (the tick). */
export async function advanceRunningTrains(deps: TrainDeps = defaultTrainDeps()): Promise<number> {
  const ids = (
    (await db(TRAINS).where({ status: 'running' }).select('id')) as Array<{ id: number }>
  ).map((r) => Number(r.id))
  for (const id of ids) {
    try {
      await advanceTrain(id, deps)
    } catch {
      /* one train never stops the others; the next tick tries again */
    }
  }
  return ids.length
}

export class TrainActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409
  ) {
    super(message)
  }
}

/**
 * A person's Skip on the current step: a pending step is skipped (its environment is not
 * promoted), a hold (soaking or held) is passed now. A step whose promotion is starting or
 * running cannot be skipped (cancel the promotion instead).
 */
export async function skipStep(
  id: number,
  index: number,
  userName: string,
  now = Date.now()
): Promise<Train> {
  const t = await readTrain(id)
  if (!t) throw new TrainActionError('NOT_FOUND', 'No such train', 404)
  if (t.status !== 'running') throw new TrainActionError('NOT_RUNNING', 'That train is not running')
  if (index !== t.step_index)
    throw new TrainActionError('NOT_CURRENT', 'Only the current step can be skipped')
  const s = t.steps[index]
  if (!s) throw new TrainActionError('NOT_CURRENT', 'Only the current step can be skipped')
  if (s.status === 'starting' || s.status === 'promoting')
    throw new TrainActionError(
      'STEP_RUNNING',
      'Its promotion is running — cancel the promotion instead'
    )
  const next = await mutateTrain(id, (x) => {
    if (x.status !== 'running' || x.step_index !== index) return null
    const st = x.steps[index]
    if (st.status === 'pending') {
      st.status = 'skipped'
      st.note = `Skipped by ${userName}`
    } else if (st.status === 'held' && st.blocked) {
      st.status = 'pending'
      st.blocked = false
      st.override = true
      st.note = `Check skipped by ${userName}`
    } else if (st.status === 'soaking' || st.status === 'held') {
      st.status = 'passed'
      st.passed_at = at(now)
      st.note = `Hold skipped by ${userName}`
    } else return null
    return x
  })
  if (!next) throw new TrainActionError('CHANGED', 'The train moved on — look again')
  return next
}

/** A person's Abort: the train stops; a promotion already running finishes on its own. */
export async function abortTrain(id: number, userName: string, now = Date.now()): Promise<Train> {
  const next = await mutateTrain(id, (x) => {
    if (x.status !== 'running') return null
    x.status = 'aborted'
    x.error = `Aborted by ${userName}`
    x.finished_at = at(now)
    return x
  })
  if (!next) {
    const t = await readTrain(id)
    if (!t) throw new TrainActionError('NOT_FOUND', 'No such train', 404)
    throw new TrainActionError('NOT_RUNNING', 'That train is not running')
  }
  return next
}
