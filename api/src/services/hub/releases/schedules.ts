import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { type FreezeRefusal, freezeRefusal } from './freeze.js'
import { notifyAppPeople } from './notify.js'
import {
  isTransientCode,
  type PlannedStart,
  refusalCode,
  refusalText,
  startPlannedPromotion
} from './start.js'
import { advanceTrain, createTrain, type TrainInput } from './trains.js'

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
  freeze(appId: number): Promise<FreezeRefusal | null>
  startPromotion(envId: number, o: PlannedStart): Promise<{ deployId: number }>
  startTrain(s: HubSchedule): Promise<{ trainId: number }>
  notify(
    appId: number,
    note: { subject: string; message: string; urgent?: boolean },
    also: Array<string | null>
  ): Promise<unknown>
}

export function defaultScheduleDeps(): ScheduleDeps {
  return {
    now: () => Date.now(),
    freeze: (appId) => freezeRefusal({ appIds: [appId], action: 'promote' }),
    startPromotion: (envId, o) => startPlannedPromotion(envId, o),
    startTrain: async (s) => {
      if (!s.train)
        throw Object.assign(new Error('The schedule holds no train'), { code: 'BAD_TRAIN' })
      const t = await createTrain(s.app_id, s.train, { userId: s.created_by, scheduleId: s.id })
      void advanceTrain(t.id).catch(() => undefined)
      return { trainId: t.id }
    },
    notify: (appId, note, also) => notifyAppPeople(appId, note, also)
  }
}

async function settle(id: number, patch: Record<string, unknown>): Promise<void> {
  await db(SCHEDULES).where({ id, status: 'starting' }).update(patch)
}

const what = (s: HubSchedule) =>
  s.kind === 'train' ? `the release train of ${s.version}` : `the promotion to ${s.version}`

/** Starts every due schedule (the tick). Answers how many started. */
export async function runDueSchedules(deps: ScheduleDeps = defaultScheduleDeps()): Promise<number> {
  const now = deps.now()
  // Claims a stopped tick left behind go back to waiting (a re-start settles itself).
  await db(SCHEDULES)
    .where({ status: 'starting' })
    .where('started_at', '<', new Date(now - STARTING_STALE_MS))
    .update({ status: 'waiting', note: 'The Hub stopped while starting it; trying again' })
  const due = (
    (await db(SCHEDULES)
      .whereIn('status', ['scheduled', 'waiting'])
      .where('run_at', '<=', new Date(now))
      .orderBy('run_at', 'asc')
      .limit(50)) as Array<Record<string, unknown>>
  ).map(scheduleFromRow)
  let started = 0
  for (const s of due) {
    const claimed = await db(SCHEDULES)
      .where({ id: s.id, status: s.status })
      .update({ status: 'starting', started_at: new Date(now), attempts: s.attempts + 1 })
    if (!claimed) continue
    if (s.status === 'scheduled' && now - Date.parse(s.run_at) > MISSED_AFTER_MS) {
      await settle(s.id, {
        status: 'failed',
        error: 'MISSED: the Hub was not running its schedule when this was due'
      })
      await deps.notify(
        s.app_id,
        {
          subject: `Scheduled ${s.kind} of ${s.version} missed`,
          message: `The Hub did not start ${what(s)} at ${s.run_at}: it was not running its schedule then. Nothing was deployed.`
        },
        [s.created_by]
      )
      continue
    }
    const frozen = await deps.freeze(s.app_id)
    if (frozen) {
      if (s.on_freeze === 'fail') {
        await settle(s.id, { status: 'failed', error: `FROZEN: ${frozen.message}`.slice(0, 1000) })
        await deps.notify(
          s.app_id,
          {
            subject: `Scheduled ${s.kind} of ${s.version} not started`,
            message: `${what(s)} was due inside a freeze window and was set to fail then: ${frozen.message}`
          },
          [s.created_by]
        )
      } else {
        await settle(s.id, {
          status: 'waiting',
          note: `Waiting for the freeze to end: ${frozen.message}`.slice(0, 500)
        })
      }
      continue
    }
    try {
      if (s.kind === 'train') {
        const { trainId } = await deps.startTrain(s)
        await settle(s.id, { status: 'started', train_id: trainId, note: null })
      } else {
        if (s.environment_id == null)
          throw Object.assign(new Error('No environment'), { code: 'NOT_FOUND' })
        const { deployId } = await deps.startPromotion(s.environment_id, {
          kind: 'promote',
          version: s.version,
          userId: s.created_by
        })
        await settle(s.id, { status: 'started', deploy_id: deployId, note: null })
      }
      started++
    } catch (err) {
      const code = refusalCode(err)
      if (code === 'ALREADY_RUNS' && s.kind === 'promote') {
        await settle(s.id, { status: 'started', note: 'The environment already ran this version' })
        continue
      }
      if (isTransientCode(code) && s.attempts + 1 < MAX_SCHEDULE_ATTEMPTS) {
        await settle(s.id, {
          status: 'waiting',
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
