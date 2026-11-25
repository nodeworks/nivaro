// Hub enhancement 47: the retirement wizard's runner — open a retirement on a plan, start a step
// on a person's sign-off, undo the last reversible step, cancel, resume after a stopped process,
// and the tick that heals stale runs.
//
// Gates, judged at every forward start (and again on Resume of one):
//   - the retirement is idle (`open`); the step is the next one; the app's environments are the
//     ones the plan named (PLAN_STALE otherwise);
//   - MOVE_OPEN (services/hub/move-open.ts) and CREATION_OPEN on any of its environments;
//   - freezes and deploy windows with action `retire` (services/hub/releases freeze.ts +
//     windows.ts; the retirement's own freeze `retire:<id>` is left out, an incident's is not);
//   - the pre-deploy checklist (action `retire`, every production environment, THE production
//     rule): claimed once, when the first step starts, and linked to the retirement;
//   - a typed confirm (the app key) to freeze an app that has production, and always to remove;
//   - environments the Hub cannot reach (no hub link / not on a Docker driver) need the person's
//     word at sign-off (`manual`), parts of the export it cannot make a `skip` with a reason.
// Going back (Undo, Cancel) never waits on a freeze, a window or a checklist.
//
// Each leg (a step, an undo, a cancel) runs in the background under the row's lease
// (retire-store.ts): a heartbeat every 30 s; a lease lost mid-run stops it before its next write.

import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { getApp } from '../../io-holder.js'
import { type ChecklistClaim, ChecklistError, checklistGate } from '../changes/checklist.js'
import { creationOpenRefusal } from '../create/store.js'
import { moveOpenRefusal } from '../move-open.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import {
  FREEZES,
  type FreezeRefusal,
  freezeFromRow,
  freezeRefusal,
  freezeUnknown
} from '../releases/freeze.js'
import { windowRefusal } from '../releases/windows.js'
import { gatherPlan, RetireError } from './retire-plan.js'
import {
  type RetireDeps,
  retireFreezeSource,
  STEP_BODIES,
  type StepBody,
  skipsOf,
  UNDO_BODIES
} from './retire-steps.js'
import {
  addLog,
  casRetirement,
  createRetirement,
  HEARTBEAT_MS,
  healStale,
  newRunnerToken,
  nextStep,
  openRetirementOf,
  RETIRE_STEPS,
  type Retirement,
  type RetireStep,
  type RetireStepKey,
  readRetirement,
  runnerWrite,
  STEP_KEYS,
  stepOf,
  undoableStep,
  withStep
} from './retire-store.js'

/** One limit for the final notice: what the maintenance page and the inbox show in full. */
export const NOTICE_MAX = 500
export const NOTE_MAX = 1000
export const REASON_MIN = 10

const numList = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : []

function logger() {
  try {
    return getApp()?.log ?? null
  } catch {
    return null
  }
}

type Leg = 'step' | 'undo' | 'cancel'

// ─── Open ────────────────────────────────────────────────────────────────────────────────────

export async function openRetirement(
  appId: number,
  body: { plan_hash?: unknown; notice?: unknown },
  by: string | null
): Promise<Retirement> {
  const { retirePlan } = await import('./retire-plan.js')
  const plan = await retirePlan(appId)
  if (plan.blockers.length)
    throw new RetireError('PLAN_BLOCKED', plan.blockers.map((b) => b.text).join(' '), 409, {
      blockers: plan.blockers
    })
  if (typeof body.plan_hash !== 'string' || body.plan_hash !== plan.plan_hash)
    throw new RetireError(
      'PLAN_STALE',
      'The app changed since you read the plan: read it again, then open the retirement.'
    )
  const notice = typeof body.notice === 'string' ? body.notice.trim() : ''
  if (notice.length > NOTICE_MAX)
    throw new RetireError('BAD_NOTICE', `The notice is at most ${NOTICE_MAX} characters.`, 400)
  const { blockers: _b, warnings: _w, lines: _l, plan_hash, ...stored } = plan
  const id = await createRetirement({
    appId,
    plan: stored,
    planHash: plan_hash,
    notice: notice || null,
    by
  })
  // One open retirement per app (review M3): the app row's retiring_id is claimed by
  // compare-and-set; a second open at the same moment loses and closes its own row.
  const held = await claimApp(appId, id)
  if (held !== null) {
    const mine = await readRetirement(id)
    if (mine) await casRetirement(id, mine.rev, { status: 'cancelled', finished: true })
    throw new RetireError('RETIRE_OPEN', `Retirement #${held} of this app is already open.`)
  }
  return (await readRetirement(id)) as Retirement
}

/** Claims the app for retirement `id`; answers the id holding it instead, or null (claimed). */
async function claimApp(appId: number, id: number): Promise<number | null> {
  for (let i = 0; i < 3; i++) {
    const n = await db('nivaro_hub_apps')
      .where({ id: appId })
      .whereNull('retiring_id')
      .update({ retiring_id: id })
    if (Number(n) === 1) return null
    const row = (await db('nivaro_hub_apps').where({ id: appId }).first('retiring_id')) as
      | { retiring_id: number | null }
      | undefined
    const cur = row?.retiring_id == null ? null : Number(row.retiring_id)
    if (cur === null) continue
    if (cur === id) return null
    const other = await readRetirement(cur)
    if (other && ['open', 'running', 'interrupted'].includes(other.status)) return cur
    // A claim left by a retirement that has closed: free it (compare-and-set) and try again.
    await db('nivaro_hub_apps').where({ id: appId, retiring_id: cur }).update({ retiring_id: null })
  }
  return -1
}

/** Frees the app's claim when its retirement closes (done or cancelled). */
async function releaseApp(appId: number, id: number): Promise<void> {
  await db('nivaro_hub_apps')
    .where({ id: appId, retiring_id: id })
    .update({ retiring_id: null })
    .catch(() => undefined)
}

// ─── Gates ───────────────────────────────────────────────────────────────────────────────────

/** Freezes (but this retirement's own) and deploy windows, action `retire`. Fails closed. */
export async function retireFreezeRefusal(
  r: Retirement,
  envIds: number[]
): Promise<FreezeRefusal | null> {
  let rows: ReturnType<typeof freezeFromRow>[]
  try {
    const raw = (await db(FREEZES).select('*')) as Array<Record<string, unknown>>
    rows = raw.filter((f) => f.source !== retireFreezeSource(r.id)).map(freezeFromRow)
  } catch {
    try {
      if (!(await db.schema.hasTable(FREEZES))) rows = []
      else return freezeUnknown()
    } catch {
      return freezeUnknown()
    }
  }
  const frozen = await freezeRefusal({ appIds: [r.app_id], action: 'retire', rows, windows: [] })
  if (frozen) return frozen
  for (const envId of envIds) {
    const w = await windowRefusal({ appIds: [r.app_id], action: 'retire', envId })
    if (w) return w
  }
  return null
}

function refusalError(f: FreezeRefusal): RetireError {
  return new RetireError(f.code, f.message, f.status, {
    freeze: f.freeze,
    ...(f.next_opening !== undefined ? { next_opening: f.next_opening } : {})
  })
}

async function commonGates(r: Retirement): Promise<number[]> {
  const plan = r.plan
  if (!plan) throw new RetireError('PLAN_MISSING', 'This retirement has no plan.', 500)
  const envIds = plan.environments.map((e) => e.id)
  const live = await gatherPlan(r.app_id)
  const now = new Set(live.environments.map((e) => e.id))
  const named = new Set(envIds)
  const archiving = nextStep(r)?.key === 'archive'
  const added = [...now].filter((id) => !named.has(id))
  if (archiving && added.length) {
    const keys = live.environments.filter((e) => added.includes(e.id)).map((e) => e.key)
    throw new RetireError(
      'NEW_ENVIRONMENT',
      `${keys.join(', ')} was added after this retirement was planned and was never stopped: archive it on the app page, or remove it, first.`,
      409,
      { environments: added }
    )
  }
  if (!archiving && (now.size !== named.size || added.length))
    throw new RetireError(
      'PLAN_STALE',
      'The app’s environments changed since this retirement opened. Cancel it and open a new one.'
    )
  const move = envIds.length ? await moveOpenRefusal({ envIds }) : null
  if (move) throw new RetireError(move.code, move.message, move.status, { move_id: move.move_id })
  for (const id of envIds) {
    const c = await creationOpenRefusal(id)
    if (c) throw new RetireError(c.code, c.message, c.status)
  }
  const f = await retireFreezeRefusal(r, envIds)
  if (f) throw refusalError(f)
  return envIds
}

/** What a sign-off may carry for `key` (validated; the typed confirm is checked, never kept). */
export function validateSignOff(
  r: Retirement,
  key: RetireStepKey,
  b: Record<string, unknown>
): Record<string, unknown> {
  const plan = r.plan
  if (!plan) throw new RetireError('PLAN_MISSING', 'This retirement has no plan.', 500)
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  if (note.length > NOTE_MAX)
    throw new RetireError('BAD_NOTE', `A sign-off note is at most ${NOTE_MAX} characters.`, 400)
  const out: Record<string, unknown> = { note: note || null }
  const needsConfirm = key === 'remove' || (key === 'freeze' && plan.production)
  if (needsConfirm && b.confirm !== plan.app.key)
    throw new RetireError(
      'CONFIRM_REQUIRED',
      key === 'remove'
        ? `Type the app key (${plan.app.key}) to stop and remove it. This cannot be undone.`
        : `Type the app key (${plan.app.key}) to freeze its production environments.`,
      400
    )
  if (key === 'freeze' || key === 'remove') {
    const need = plan.environments.filter((e) =>
      key === 'freeze' ? e.freeze === 'manual' : e.kind === 'manual'
    )
    const given = numList(b.manual)
    const missing = need.filter((e) => !given.includes(e.id))
    if (missing.length)
      throw new RetireError(
        'MANUAL_NEEDED',
        key === 'freeze'
          ? `The Hub cannot freeze ${missing.map((e) => e.key).join(', ')} (no hub link): put ${missing.length > 1 ? 'them' : 'it'} in maintenance yourself and tick that you did.`
          : `The Hub cannot stop ${missing.map((e) => e.key).join(', ')}: stop ${missing.length > 1 ? 'them' : 'it'} yourself and tick that you did.`,
        400,
        { environments: missing.map((e) => e.id) }
      )
    if (need.length && !note)
      throw new RetireError('NOTE_REQUIRED', 'Say in the note how you did it by hand.', 400)
    out.manual = need.map((e) => e.id)
  }
  if (key === 'export') {
    const skips = skipsOf(b.skip).filter((s) =>
      plan.environments.some((e) => e.id === s.environment_id)
    )
    const must = plan.environments.flatMap((e) => [
      ...(!e.database ? [{ e, what: 'db' as const }] : []),
      ...(!e.files_target ? [{ e, what: 'files' as const }] : [])
    ])
    const unskipped = must.filter(
      (m) => !skips.some((s) => s.environment_id === m.e.id && s.what === m.what)
    )
    if (unskipped.length)
      throw new RetireError(
        'EXPORT_INCOMPLETE',
        `The Hub cannot back up ${unskipped
          .map(
            (m) => `${m.e.key} ${m.what === 'db' ? '(no database record)' : '(no files target)'}`
          )
          .join(', ')}: set it up on Backups & data, or skip it with a reason.`,
        400,
        { missing: unskipped.map((m) => ({ environment_id: m.e.id, what: m.what })) }
      )
    // Review M5: only a part the Hub cannot back up may be skipped.
    const capable = skips.filter((s) => {
      const e = plan.environments.find((x) => x.id === s.environment_id)
      return e && (s.what === 'db' ? e.database : e.files_target)
    })
    if (capable.length)
      throw new RetireError(
        'SKIP_NOT_ALLOWED',
        'Only a part the Hub cannot back up may be skipped: the others are backed up and verified.',
        400,
        { parts: capable }
      )
    if (skips.length && b.skip_confirm !== plan.app.key)
      throw new RetireError(
        'CONFIRM_REQUIRED',
        `Type the app key (${plan.app.key}) to retire it without the skipped backups.`,
        400
      )
    const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
    if (skips.length && reason.length < REASON_MIN)
      throw new RetireError(
        'REASON_REQUIRED',
        `Say why the skipped parts need no backup (at least ${REASON_MIN} characters).`,
        400
      )
    out.skip = skips
    out.reason = reason || null
  }
  if (key === 'notice') {
    const text = typeof b.notice === 'string' ? b.notice.trim() : ''
    if (text.length > NOTICE_MAX)
      throw new RetireError('BAD_NOTICE', `The notice is at most ${NOTICE_MAX} characters.`, 400)
    if (text) out.notice = text
  }
  return out
}

/** Claims the `retire` checklist of every production environment (first step only). */
async function claimChecklists(
  r: Retirement,
  given: unknown
): Promise<{ claims: ChecklistClaim[]; map: Record<string, number> }> {
  const plan = r.plan as NonNullable<Retirement['plan']>
  const runs =
    given && typeof given === 'object' && !Array.isArray(given)
      ? (given as Record<string, unknown>)
      : {}
  const claims: ChecklistClaim[] = []
  const map: Record<string, number> = {}
  try {
    for (const e of plan.environments.filter((x) => x.production)) {
      const c = await checklistGate({
        target: { kind: 'environment', envId: e.id },
        action: 'retire',
        version: null,
        runId: runs[String(e.id)]
      })
      if (c) {
        claims.push(c)
        map[String(e.id)] = c.runId
      }
    }
  } catch (err) {
    for (const c of claims) await c.release().catch(() => undefined)
    if (err instanceof ChecklistError)
      throw new RetireError(err.code, err.message, err.status, err.extra)
    throw err
  }
  return { claims, map }
}

// ─── Legs ────────────────────────────────────────────────────────────────────────────────────

class LeaseLost extends Error {}

async function notifyTeam(r: Retirement, subject: string, message: string, urgent = false) {
  try {
    const ids = await hubEventRecipients(r.app_id)
    await deliverHubNotice(ids, {
      subject,
      message,
      path: `/hub/lifecycle?retirement=${r.id}`,
      urgent,
      source: { kind: 'hub-retirement', label: r.plan?.app.key ?? null, id: r.id },
      why: 'You are a Hub administrator or an owner of this app.'
    })
  } catch {
    /* a notice never fails a leg */
  }
}

/**
 * Runs one leg under the lease `runner`. `keys` = the steps it walks, in order (one for a step or
 * an undo, every done reversible step newest first for a cancel).
 */
async function runLeg(
  id: number,
  runner: string,
  leg: Leg,
  keys: RetireStepKey[],
  by: string | null,
  deps: RetireDeps
): Promise<void> {
  let lost = false
  const beat = setInterval(() => {
    void runnerWrite(id, runner, { heartbeat: true })
      .then((ok) => {
        if (!ok) lost = true
      })
      .catch(() => undefined)
  }, HEARTBEAT_MS)
  beat.unref?.()
  let current: RetireStepKey | null = null
  let r = (await readRetirement(id)) as Retirement
  const write = async (patch: Parameters<typeof runnerWrite>[2]) => {
    if (lost || !(await runnerWrite(id, runner, patch))) {
      lost = true
      throw new LeaseLost()
    }
    r = (await readRetirement(id)) as Retirement
  }
  try {
    for (const key of keys) {
      current = key
      const body: StepBody | undefined = leg === 'step' ? STEP_BODIES[key] : UNDO_BODIES[key]
      if (!body) continue
      const s = stepOf(r, key)
      const note = await body({
        ret: r,
        plan: r.plan as NonNullable<Retirement['plan']>,
        key,
        input: s.input,
        by,
        detail: s.detail ?? {},
        deps,
        save: async (detail) => {
          await write({ steps: withStep(r.steps, key, { detail }), heartbeat: true })
        }
      })
      const at = new Date()
      const cur = stepOf(r, key)
      const next: Partial<RetireStep> =
        leg === 'step'
          ? {
              state: 'done',
              finished_at: at.toISOString(),
              note,
              log: addLog(cur.log, { what: 'done', by, note }, at)
            }
          : {
              state: 'pending',
              signed_off_by: null,
              signed_off_at: null,
              sign_note: null,
              started_at: null,
              finished_at: null,
              note: `Undone: ${note}`,
              detail: {},
              input: {},
              log: addLog(cur.log, { what: 'undone', by, note }, at)
            }
      await write({ steps: withStep(r.steps, key, next), heartbeat: true })
    }
    current = null
    const finished = (leg === 'step' && keys[0] === 'archive') || leg === 'cancel'
    if (leg === 'cancel') {
      // A cancel before the freeze step still ends any freeze it may have made.
      const at = new Date()
      await db(FREEZES)
        .where({ source: retireFreezeSource(id) })
        .where('ends_at', '>', at)
        .update({ ends_at: at, updated_at: at })
    }
    await write({
      status: leg === 'cancel' ? 'cancelled' : finished ? 'done' : 'open',
      step: null,
      runner: null,
      error: leg === 'cancel' ? r.error : null,
      finished
    })
    if (finished) await releaseApp(r.app_id, id)
    if (leg === 'step' && keys[0] === 'archive')
      await notifyTeam(
        r,
        `${r.plan?.app.name ?? 'An app'} is retired`,
        stepOf(r, 'archive').note ?? 'Retired.'
      )
    if (leg === 'cancel')
      await notifyTeam(
        r,
        `Retirement of ${r.plan?.app.name ?? 'an app'} cancelled`,
        'Every reversible step was undone; the app serves again.'
      )
  } catch (err) {
    if (err instanceof LeaseLost) {
      logger()?.warn?.({ retirement: id }, 'hub retirement: lease lost, the leg stopped')
      return
    }
    const text =
      err instanceof RetireError
        ? err.message
        : 'The step stopped on an unexpected error; the Hub log has the detail. Retry runs it again.'
    if (!(err instanceof RetireError))
      logger()?.warn?.(
        { retirement: id, code: (err as { code?: unknown } | null)?.code ?? null },
        'hub retirement step failed'
      )
    const at = new Date()
    const steps = current
      ? withStep(r.steps, current, {
          ...(leg === 'step' ? { state: 'failed' as const, note: text } : {}),
          log: addLog(
            stepOf(r, current).log,
            { what: leg === 'step' ? 'failed' : 'undo_failed', by, note: text },
            at
          )
        })
      : r.steps
    await runnerWrite(id, runner, {
      status: 'open',
      step: null,
      runner: null,
      steps,
      error: `${current ? `${current}: ` : ''}${text}`
    }).catch(() => undefined)
    await notifyTeam(
      r,
      `Retirement of ${r.plan?.app.name ?? 'an app'}: ${current ?? leg} ${leg === 'step' ? 'failed' : 'could not be undone'}`,
      text,
      true
    )
  } finally {
    clearInterval(beat)
  }
}

function launch(p: Promise<void>, deps: RetireDeps): Promise<void> {
  if (deps.background === false) return p
  void p.catch(() => undefined)
  return Promise.resolve()
}

// ─── Start a step (sign-off) ─────────────────────────────────────────────────────────────────

export async function startStep(
  id: number,
  key: string,
  body: Record<string, unknown>,
  by: string | null,
  deps: RetireDeps = {}
): Promise<Retirement> {
  if (!STEP_KEYS.includes(key as RetireStepKey))
    throw new RetireError('BAD_STEP', 'No such step.', 404)
  const k = key as RetireStepKey
  const r = await readRetirement(id)
  if (!r) throw new RetireError('NOT_FOUND', 'Not found', 404)
  if (r.status === 'running')
    throw new RetireError('RETIRE_RUNNING', 'A step of this retirement is running: wait for it.')
  if (r.status === 'interrupted')
    throw new RetireError('RETIRE_INTERRUPTED', 'A step stopped half-way: Resume it first.')
  if (r.status !== 'open') throw new RetireError('RETIRE_CLOSED', `This retirement is ${r.status}.`)
  const next = nextStep(r)
  if (!next || next.key !== k)
    throw new RetireError(
      'STEP_OUT_OF_ORDER',
      next ? `The next step is “${next.label}”; steps go in order.` : 'Every step is done already.'
    )
  const input = validateSignOff(r, k, body)
  await commonGates(r)
  let claims: ChecklistClaim[] = []
  let checklists = r.checklists
  if (!Object.keys(r.checklists).length) {
    const c = await claimChecklists(r, body.checklist_runs)
    claims = c.claims
    checklists = c.map
  }
  const runner = newRunnerToken()
  const at = new Date()
  const s = stepOf(r, k)
  const { note, ...kept } = input
  const steps = withStep(r.steps, k, {
    state: 'running',
    signed_off_by: by,
    signed_off_at: at.toISOString(),
    sign_note: (note as string | null) ?? null,
    started_at: at.toISOString(),
    finished_at: null,
    note: null,
    input: { ...kept, attempt: runner },
    log: addLog(s.log, { what: 'signed_off', by, note: (note as string | null) ?? null }, at)
  })
  const won = await casRetirement(
    id,
    r.rev,
    { status: 'running', step: k, runner, steps, checklists, heartbeat: true, error: null },
    at
  )
  if (!won) {
    for (const c of claims) await c.release().catch(() => undefined)
    throw new RetireError('RETIRE_CHANGED', 'The retirement changed a moment ago: look again.')
  }
  for (const c of claims) await c.link('retire', id).catch(() => undefined)
  await launch(runLeg(id, runner, 'step', [k], by, deps), deps)
  return (await readRetirement(id)) as Retirement
}

// ─── Undo, cancel, resume ────────────────────────────────────────────────────────────────────

export async function undoLastStep(
  id: number,
  by: string | null,
  deps: RetireDeps = {}
): Promise<Retirement> {
  await healStale().catch(() => [])
  const r = await readRetirement(id)
  if (!r) throw new RetireError('NOT_FOUND', 'Not found', 404)
  // Review M4: going back works from an interrupted retirement too, and never waits on a gate.
  if (r.status !== 'open' && r.status !== 'interrupted')
    throw new RetireError(
      r.status === 'running' ? 'RETIRE_RUNNING' : 'RETIRE_CLOSED',
      r.status === 'running' ? 'A step is running: wait for it.' : `This retirement is ${r.status}.`
    )
  const s = undoableStep(r)
  if (!s)
    throw new RetireError(
      'NOT_UNDOABLE',
      'Nothing to undo: no step is done, or the removal has started (it cannot be undone).'
    )
  const runner = newRunnerToken()
  const at = new Date()
  const won = await casRetirement(
    id,
    r.rev,
    { status: 'running', step: `undo:${s.key}`, runner, heartbeat: true, error: null },
    at
  )
  if (!won)
    throw new RetireError('RETIRE_CHANGED', 'The retirement changed a moment ago: look again.')
  await launch(runLeg(id, runner, 'undo', [s.key], by, deps), deps)
  return (await readRetirement(id)) as Retirement
}

/** Undoes every done reversible step, newest first, then closes the retirement. */
export async function cancelRetirement(
  id: number,
  by: string | null,
  deps: RetireDeps = {},
  reason: string | null = null
): Promise<Retirement> {
  await healStale().catch(() => [])
  const r = await readRetirement(id)
  if (!r) throw new RetireError('NOT_FOUND', 'Not found', 404)
  // Review M4: an interrupted retirement can be cancelled; Cancel never waits on a gate.
  if (r.status !== 'open' && r.status !== 'interrupted')
    throw new RetireError(
      r.status === 'running' ? 'RETIRE_RUNNING' : 'RETIRE_CLOSED',
      r.status === 'running' ? 'A step is running: wait for it.' : `This retirement is ${r.status}.`
    )
  const removeStarted = (['remove', 'archive'] as RetireStepKey[]).some(
    (k) => stepOf(r, k).signed_off_at != null || stepOf(r, k).state !== 'pending'
  )
  if (removeStarted)
    throw new RetireError(
      'NOT_CANCELLABLE',
      'The removal has started: it cannot be undone. Finish the retirement instead.'
    )
  const keys = RETIRE_STEPS.filter((d) => d.reversible)
    .map((d) => d.key)
    .filter((k) => {
      const st = stepOf(r, k).state
      return st === 'done' || st === 'failed' || st === 'interrupted'
    })
    .reverse()
  const runner = newRunnerToken()
  const why = (reason ?? '').trim().slice(0, 500)
  const won = await casRetirement(id, r.rev, {
    status: 'running',
    step: 'cancel',
    runner,
    heartbeat: true,
    // Why it was cancelled stays on the row (shown on the retirement and in the activity log).
    error: why ? `Cancelled: ${why}` : 'Cancelled.'
  })
  if (!won)
    throw new RetireError('RETIRE_CHANGED', 'The retirement changed a moment ago: look again.')
  await launch(runLeg(id, runner, 'cancel', keys, by, deps), deps)
  return (await readRetirement(id)) as Retirement
}

/** Continues an interrupted leg with the input it was signed off with. */
export async function resumeRetirement(
  id: number,
  by: string | null,
  deps: RetireDeps = {}
): Promise<Retirement> {
  await healStale().catch(() => [])
  const r = await readRetirement(id)
  if (!r) throw new RetireError('NOT_FOUND', 'Not found', 404)
  if (r.status !== 'interrupted')
    throw new RetireError('NOT_RESUMABLE', `A ${r.status} retirement cannot be resumed.`)
  const stepName = String(r.step ?? '')
  let leg: Leg = 'step'
  let keys: RetireStepKey[] = []
  if (stepName === 'cancel') {
    leg = 'cancel'
    keys = RETIRE_STEPS.filter((d) => d.reversible)
      .map((d) => d.key)
      .filter((k) => ['done', 'failed', 'interrupted'].includes(stepOf(r, k).state))
      .reverse()
  } else if (stepName.startsWith('undo:')) {
    leg = 'undo'
    keys = [stepName.slice(5) as RetireStepKey]
  } else if (STEP_KEYS.includes(stepName as RetireStepKey)) {
    keys = [stepName as RetireStepKey]
    // A forward step is judged again: a freeze or a move that started meanwhile wins.
    await commonGates(r)
  } else throw new RetireError('NOT_RESUMABLE', 'The stopped leg cannot be read.')
  const runner = newRunnerToken()
  const at = new Date()
  const steps =
    leg === 'step'
      ? withStep(r.steps, keys[0], {
          state: 'running',
          note: null,
          log: addLog(stepOf(r, keys[0]).log, { what: 'resumed', by, note: null }, at)
        })
      : r.steps
  const won = await casRetirement(
    id,
    r.rev,
    { status: 'running', runner, steps, heartbeat: true, error: null },
    at
  )
  if (!won)
    throw new RetireError('RETIRE_CHANGED', 'The retirement changed a moment ago: look again.')
  await launch(runLeg(id, runner, leg, keys, by, deps), deps)
  return (await readRetirement(id)) as Retirement
}

/** The tick: heals runs whose process stopped (tells the app's people once). */
export async function retireTick(now = new Date()): Promise<{ healed: number[] }> {
  const healed = await healStale(now)
  for (const id of healed) {
    const r = await readRetirement(id)
    if (r)
      await notifyTeam(
        r,
        `Retirement of ${r.plan?.app.name ?? 'an app'} stopped`,
        'The Hub process running a step stopped. Open the retirement and Resume it.',
        true
      )
  }
  return { healed }
}

/** Logged by the routes (one row per person action). */
export async function logRetireAction(o: {
  action: string
  by: string | null
  r: Retirement
  comment?: string
  req?: unknown
}): Promise<void> {
  await logActivity({
    action: o.action,
    user: o.by,
    collection: 'nivaro_hub_retirements',
    item: String(o.r.id),
    comment: (o.comment ?? `${o.r.plan?.app.key ?? o.r.app_id}`).slice(0, 400),
    req: o.req as never
  }).catch(() => undefined)
}
