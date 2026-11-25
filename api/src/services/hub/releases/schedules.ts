import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { listEnvironments } from '../apps.js'
import { isChecklistWait } from '../changes/checklist.js'
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
import { advanceTrain, createTrain, type TrainInput, validateTrain } from './trains.js'

/**
 * Scheduled promotions (Hub release operations): a promotion of one environment, or a release
 * train, to start at `run_at` (stored UTC; the page shows it in the viewer's zone). The minute
 * tick (one leader) starts what is due:
 *
 *   scheduled → starting → started (deploy_id / train_id)
 *                        → waiting  (a freeze window with on_freeze 'wait', or a refusal that
 *                                    passes on its own: tried again every minute)
 *                        → failed   (on_freeze 'fail' inside a freeze, any other refusal, too
 *                                    many tries, or found more than MISSED_AFTER_MS late —
 *                                    the Hub was down — never a surprise deploy hours later)
 *   scheduled | waiting → cancelled (a person)
 *
 * A start is the same as the person's own (startPlannedPromotion: plan judged again, lock, job
 * run), recorded as started by whoever scheduled it. A claim (`starting`) older than
 * STARTING_STALE_MS is put back to `waiting`; a second start of a promotion that did start is
 * answered ALREADY_RUNS / PROMOTION_RUNNING and settles it.
 */

export const SCHEDULES = 'nivaro_hub_schedules'
export const MISSED_AFTER_MS = 6 * 60 * 60_000
export const MAX_SCHEDULE_ATTEMPTS = 30
export const STARTING_STALE_MS = 5 * 60_000
const VERSION_RE = /^\d+\.\d+\.\d+$/

export type ScheduleStatus =
  | 'scheduled'
  | 'starting'
  | 'waiting'
  | 'started'
  | 'failed'
  | 'cancelled'

export interface HubSchedule {
  id: number
  app_id: number
  environment_id: number | null
  kind: 'promote' | 'train'
  version: string
  run_at: string
  on_freeze: 'wait' | 'fail'
  train: (TrainInput & { keys: string[] }) | null
  status: ScheduleStatus
  attempts: number
  /** The last time it was held back (a freeze's end, a passing refusal); null = never. */
  wait_until: string | null
  note: string | null
  deploy_id: number | null
  train_id: number | null
  error: string | null
  created_by: string | null
  created_at: string | null
  started_at: string | null
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string | Date).toISOString())

export function scheduleFromRow(r: Record<string, unknown>): HubSchedule {
  let train: HubSchedule['train'] = null
  try {
    train = r.train ? JSON.parse(String(r.train)) : null
  } catch {
    train = null
  }
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: r.environment_id == null ? null : Number(r.environment_id),
    kind: r.kind === 'train' ? 'train' : 'promote',
    version: String(r.version),
    run_at: iso(r.run_at) as string,
    on_freeze: r.on_freeze === 'fail' ? 'fail' : 'wait',
    train,
    status: String(r.status) as ScheduleStatus,
    attempts: Number(r.attempts ?? 0),
    wait_until: iso(r.wait_until),
    note: r.note == null ? null : String(r.note),
    deploy_id: r.deploy_id == null ? null : Number(r.deploy_id),
    train_id: r.train_id == null ? null : Number(r.train_id),
    error: r.error == null ? null : String(r.error),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at),
    started_at: iso(r.started_at)
  }
}

export async function listSchedules(o: { appIds?: number[]; limit?: number } = {}) {
  const q = db(SCHEDULES)
    .orderBy('run_at', 'desc')
    .limit(Math.min(o.limit ?? 100, 300))
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  return ((await q) as Array<Record<string, unknown>>).map(scheduleFromRow)
}

export async function readSchedule(id: number): Promise<HubSchedule | null> {
  const r = (await db(SCHEDULES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? scheduleFromRow(r) : null
}

/** Validates when and what to do if frozen (the what is validated by the caller). */
export function validateWhen(
  b: Record<string, unknown>,
  now = Date.now()
): { run_at: Date; on_freeze: 'wait' | 'fail' } | { error: string } {
  const at = typeof b.run_at === 'string' ? new Date(b.run_at) : null
  if (!at || Number.isNaN(at.getTime())) return { error: 'run_at is an ISO time' }
  if (at.getTime() < now - 60_000) return { error: 'run_at is in the past' }
  if (at.getTime() > now + 90 * 86_400_000) return { error: 'run_at is at most 90 days ahead' }
  const onFreeze =
    b.on_freeze == null || b.on_freeze === 'wait' ? 'wait' : b.on_freeze === 'fail' ? 'fail' : null
  if (!onFreeze) return { error: 'on_freeze is wait or fail' }
  return { run_at: at, on_freeze: onFreeze }
}

export async function createSchedule(row: {
  app_id: number
  environment_id: number | null
  kind: 'promote' | 'train'
  version: string
  run_at: Date
  on_freeze: 'wait' | 'fail'
  train: (TrainInput & { keys: string[] }) | null
  created_by: string | null
}): Promise<HubSchedule> {
  if (!VERSION_RE.test(row.version)) throw new Error('bad version')
  const id = Number(
    await insertReturningId(db, SCHEDULES, {
      app_id: row.app_id,
      environment_id: row.environment_id,
      kind: row.kind,
      version: row.version,
      run_at: row.run_at,
      on_freeze: row.on_freeze,
      train: row.train ? JSON.stringify(row.train) : null,
      status: 'scheduled',
      attempts: 0,
      created_by: row.created_by,
      created_at: new Date()
    })
  )
  return (await readSchedule(id)) as HubSchedule
}

/** A person's Cancel: only while it has not started. */
export async function cancelSchedule(id: number): Promise<boolean> {
  return (
    (await db(SCHEDULES)
      .where({ id })
      .whereIn('status', ['scheduled', 'waiting'])
      .update({ status: 'cancelled', note: 'Cancelled' })) > 0
  )
}

export interface ScheduleDeps {
  now(): number
  freeze(appId: number, envId?: number | null): Promise<FreezeRefusal | null>
  startPromotion(envId: number, o: PlannedStart): Promise<{ deployId: number }>
  startTrain(s: HubSchedule): Promise<{ trainId: number }>
  notify(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean },
    also: Array<string | null>
  ): Promise<unknown>
  /** Owners AND every administrator (the person behind a schedule can no longer act). */
  notifyAll(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean }
  ): Promise<unknown>
  /** Whether the schedule's person may still start promotions. */
  person(userId: string | null): Promise<PersonCheck>
  /** A promote run of `version` started on the environment at or after `since` (adoption). */
  startedSince(envId: number, version: string, since: number): Promise<number | null>
  /** The train this schedule already started, if any (adoption). */
  trainOf(scheduleId: number): Promise<number | null>
  /** Activity row for a promotion or train the schedule started. */
  logStart(s: HubSchedule, item: { deployId?: number; trainId?: number }): Promise<unknown>
}

export function defaultScheduleDeps(): ScheduleDeps {
  return {
    now: () => Date.now(),
    freeze: (appId, envId) => freezeRefusal({ appIds: [appId], action: 'promote', envId }),
    startPromotion: (envId, o) => startPlannedPromotion(envId, o),
    startTrain: async (s) => {
      if (!s.train)
        throw Object.assign(new Error('The schedule holds no train'), { code: 'BAD_TRAIN' })
      // Checked again against the app as it is now (environments reordered, removed, placed on
      // a shared deployment since it was scheduled).
      const envs = await listEnvironments(s.app_id)
      const again = validateTrain(
        { version: s.train.version, steps: s.train.steps },
        envs.map((e) => ({ id: e.id, key: e.key, position: e.position, on_shared: e.on_shared }))
      )
      if ('error' in again)
        throw Object.assign(
          new Error(`The scheduled train no longer fits the app: ${again.error}`),
          {
            code: 'BAD_TRAIN'
          }
        )
      const t = await createTrain(s.app_id, again, { userId: s.created_by, scheduleId: s.id })
      void advanceTrain(t.id).catch(() => undefined)
      return { trainId: t.id }
    },
    notify: (appId, note, also) => notifyAppPeople(appId, note, also),
    notifyAll: (appId, note) => notifyAppPeopleAndAdmins(appId, note),
    person: (userId) => personCanAct(userId),
    startedSince: async (envId, version, since) => {
      const r = (await db('nivaro_hub_deploys')
        .where({ environment_id: envId, version, kind: 'promote' })
        .where('started_at', '>=', new Date(since - 5000))
        .orderBy('id', 'asc')
        .first('id')) as { id: number } | undefined
      return r ? Number(r.id) : null
    },
    trainOf: async (scheduleId) => {
      const r = (await db('nivaro_hub_trains')
        .where({ schedule_id: scheduleId })
        .orderBy('id', 'asc')
        .first('id')) as { id: number } | undefined
      return r ? Number(r.id) : null
    },
    logStart: (s, item) =>
      logActivity({
        action: item.trainId ? 'hub-train-start' : 'hub-promote-start',
        user: s.created_by,
        collection: item.trainId ? 'nivaro_hub_trains' : 'nivaro_hub_deploys',
        item: String(item.trainId ?? item.deployId),
        comment: `Scheduled #${s.id} (${s.kind} ${s.version})`,
        origin: 'machine'
      })
  }
}

async function settle(id: number, patch: Record<string, unknown>): Promise<void> {
  await db(SCHEDULES).where({ id, status: 'starting' }).update(patch)
}

const what = (s: HubSchedule) =>
  s.kind === 'train' ? `the release train of ${s.version}` : `the promotion to ${s.version}`

/**
 * When a schedule counts as missed from: its run_at, or the last time it was held back (a
 * freeze's end, a passing refusal) — a Hub that was down for hours after either never deploys
 * by surprise when it comes back.
 */
function missedFrom(s: HubSchedule): number {
  const due = Date.parse(s.run_at)
  const held = s.wait_until ? Date.parse(s.wait_until) : Number.NaN
  return Number.isFinite(held) ? Math.max(due, held) : due
}

/** Starts every due schedule (the tick). Answers how many started. */
export async function runDueSchedules(deps: ScheduleDeps = defaultScheduleDeps()): Promise<number> {
  const now = deps.now()
  // Claims a stopped tick left behind go back to waiting; the next claim adopts what it started.
  await db(SCHEDULES)
    .where({ status: 'starting' })
    .where('claimed_at', '<', new Date(now - STARTING_STALE_MS))
    .update({ status: 'waiting', note: 'The Hub stopped while starting it; checking again' })
  const due = (
    (await db(SCHEDULES)
      .whereIn('status', ['scheduled', 'waiting'])
      .where('run_at', '<=', new Date(now))
      .orderBy('run_at', 'asc')
      .limit(50)) as Array<Record<string, unknown>>
  ).map(scheduleFromRow)
  let started = 0
  for (const s of due) {
    const firstTry = s.started_at ? Date.parse(s.started_at) : null
    const claimed = await db(SCHEDULES)
      .where({ id: s.id, status: s.status })
      .update({
        status: 'starting',
        claimed_at: new Date(now),
        started_at: firstTry == null ? new Date(now) : new Date(firstTry)
      })
    if (!claimed) continue
    // An earlier claim may have started it already (its settle was lost): adopt, never start twice.
    if (firstTry != null) {
      if (s.kind === 'train') {
        const trainId = await deps.trainOf(s.id)
        if (trainId != null) {
          await settle(s.id, { status: 'started', train_id: trainId, note: 'Started earlier' })
          continue
        }
      } else if (s.environment_id != null) {
        const deployId = await deps.startedSince(s.environment_id, s.version, firstTry)
        if (deployId != null) {
          await settle(s.id, { status: 'started', deploy_id: deployId, note: 'Started earlier' })
          continue
        }
      }
    }
    if (now - missedFrom(s) > MISSED_AFTER_MS) {
      await settle(s.id, {
        status: 'failed',
        error: 'MISSED: the Hub was not running its schedule when this was due'
      })
      await deps.notify(
        s.app_id,
        {
          subject: `Scheduled ${s.kind} of ${s.version} missed`,
          message: `The Hub did not start ${what(s)} in time (due ${s.run_at}): it was not running its schedule then. Nothing was deployed.`
        },
        [s.created_by]
      )
      continue
    }
    const who = await deps.person(s.created_by)
    if (!who.ok) {
      await settle(s.id, {
        status: 'failed',
        error: `PERSON_GONE: ${who.why}; nobody vouches for this schedule`.slice(0, 1000)
      })
      await deps.notifyAll(s.app_id, {
        subject: `Scheduled ${s.kind} of ${s.version} needs a person`,
        message: `${what(s)} was not started: ${who.why}. Schedule it again if it should still run.`,
        urgent: true
      })
      continue
    }
    const frozen = await deps.freeze(s.app_id, s.kind === 'promote' ? s.environment_id : null)
    if (frozen) {
      // A deploy window that cannot be read needs a person, and so does a schedule no window
      // opens for within 14 days: both end here (missed / failed, people told) instead of
      // waiting for a surprise deploy whenever someone edits a window.
      const noOpening = frozen.code === 'OUTSIDE_WINDOW' && frozen.next_opening === null
      // A retired (archived) app never deploys again: the schedule ends too.
      if (noOpening || frozen.code === 'WINDOW_INVALID' || frozen.code === 'ENV_ARCHIVED') {
        await settle(s.id, {
          status: 'failed',
          error: (noOpening
            ? `MISSED: no deploy window opens within 14 days. ${frozen.message}`
            : `${frozen.code}: ${frozen.message}`
          ).slice(0, 1000)
        })
        await deps.notify(
          s.app_id,
          {
            subject: noOpening
              ? `Scheduled ${s.kind} of ${s.version} missed`
              : `Scheduled ${s.kind} of ${s.version} not started`,
            message: `${what(s)} was not started: ${frozen.message} Nothing was deployed; schedule it again.`,
            urgent: true
          },
          [s.created_by]
        )
        continue
      }
      // Waits never use up tries; the missed rule counts from the freeze's end (a deploy
      // window's next opening counts the same way: OUTSIDE_WINDOW).
      const timed = frozen.code === 'FROZEN' || frozen.code === 'OUTSIDE_WINDOW'
      const wordsOf =
        frozen.code === 'OUTSIDE_WINDOW' ? 'outside its deploy window' : 'inside a freeze window'
      if (timed && s.on_freeze === 'fail') {
        await settle(s.id, {
          status: 'failed',
          error: `${frozen.code}: ${frozen.message}`.slice(0, 1000)
        })
        await deps.notify(
          s.app_id,
          {
            subject: `Scheduled ${s.kind} of ${s.version} not started`,
            message: `${what(s)} was due ${wordsOf} and was set to fail then: ${frozen.message}`
          },
          [s.created_by]
        )
      } else {
        await settle(s.id, {
          status: 'waiting',
          wait_until: timed ? new Date(frozen.freeze.ends_at) : new Date(now),
          note: (frozen.code === 'OUTSIDE_WINDOW'
            ? `Waiting for the deploy window: ${frozen.message}`
            : timed
              ? `Waiting for the freeze to end: ${frozen.message}`
              : `Trying again: ${frozen.message}`
          ).slice(0, 500)
        })
      }
      continue
    }
    const attempts = s.attempts + 1
    await db(SCHEDULES).where({ id: s.id, status: 'starting' }).update({ attempts })
    try {
      if (s.kind === 'train') {
        const { trainId } = await deps.startTrain(s)
        await settle(s.id, { status: 'started', train_id: trainId, note: null })
        await Promise.resolve(deps.logStart(s, { trainId })).catch(() => undefined)
      } else {
        if (s.environment_id == null)
          throw Object.assign(new Error('No environment'), { code: 'NOT_FOUND' })
        const { deployId } = await deps.startPromotion(s.environment_id, {
          kind: 'promote',
          version: s.version,
          userId: s.created_by,
          checklist: { kind: 'schedule', id: s.id }
        })
        await settle(s.id, { status: 'started', deploy_id: deployId, note: null })
        await Promise.resolve(deps.logStart(s, { deployId })).catch(() => undefined)
      }
      started++
    } catch (err) {
      const code = refusalCode(err)
      if (code === 'ALREADY_RUNS' && s.kind === 'promote') {
        await settle(s.id, { status: 'started', note: 'The environment already ran this version' })
        continue
      }
      // A production pre-deploy checklist not ticked yet: wait without using a try, and keep
      // wait_until as it is, so the 6-hour missed rule still counts from when it was due.
      if (isChecklistWait(code)) {
        await settle(s.id, {
          status: 'waiting',
          attempts: s.attempts,
          note: `Waiting for its pre-deploy checklist: ${refusalText(err)}`.slice(0, 500)
        })
        continue
      }
      if (isTransientCode(code) && attempts < MAX_SCHEDULE_ATTEMPTS) {
        await settle(s.id, {
          status: 'waiting',
          wait_until: new Date(now),
          note: `Trying again: ${code}: ${refusalText(err)}`.slice(0, 500)
        })
        continue
      }
      await settle(s.id, { status: 'failed', error: `${code}: ${refusalText(err)}`.slice(0, 1000) })
      await deps.notify(
        s.app_id,
        {
          subject: `Scheduled ${s.kind} of ${s.version} could not start`,
          message: `${what(s)} could not start: ${refusalText(err)}`,
          urgent: true
        },
        [s.created_by]
      )
    }
  }
  return started
}
