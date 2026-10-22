import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../../admin-base.js'
import { db } from '../../db/index.js'
import { getApp } from '../io-holder.js'
import {
  bindBlindRun,
  blindWindow,
  closeBlindWindow,
  openBlindWindow,
  revealBlindWindow,
  windowOfRun
} from './blind.js'
import { getFault } from './catalog.js'
import { addRunEvent, emitChaosWatch, startDrill, stopDrill } from './drill.js'
import {
  dueInjects,
  dueReminders,
  fmtOffset,
  type GamedayInject,
  type GamedayPlan,
  MARK_LABEL,
  type NoteMark,
  type NotePoints,
  nextMonthlyStart,
  notePoints,
  participantsOf,
  validatePlan
} from './gameday-plan.js'
import { assertChaosAllowed, ChaosError } from './gate.js'
import { CHAOS_KEY_PREFIX } from './registry.js'
import {
  type ChaosRun,
  type ChaosRunEvent,
  createRun,
  getRun,
  listRunEvents,
  listRuns,
  updateRun,
  type Verdict
} from './runs.js'

/**
 * Game days (#2816, #2852, #2853, #2854): a planned exercise with roles, a timed list of injects
 * and a timeline. The game day is a `nivaro_chaos_runs` row of kind `gameday` (planned →
 * running → completed / stopped / aborted) whose `meta.plan` is the plan (gameday-plan.ts);
 * each injected fault is a child drill (`gameday_id`), started AS THE LEAD through the drill
 * lifecycle (pre-flight, hypothesis, job run). Steps, notes and the reveal are run events on
 * the game-day row.
 *
 * Injects fire on time from two deliverers sharing one claim (the huddle-schedule pattern): a
 * timer in the process that started the day, and the `chaos-gamedays` cron (one minute, leader
 * only, cronTicksEnabled) for anything a restart dropped. The claim is a Redis SET NX per
 * inject plus the stored `step` event, so an inject fires once. An inject more than ten
 * minutes late is skipped as missed, never fired late.
 *
 * Chat: an optional private channel for the participants. The timeline bot posts FIXED text
 * only (catalog labels and offsets, never the plan's user-written labels); an announcement
 * inject is user text and goes through the normal send path as the lead.
 */

export interface GamedayMeta {
  plan: GamedayPlan
  warnings?: string[]
  started_by_name?: string | null
  channel_room?: string | null
  reminders_sent?: number[]
  started_how?: 'manual' | 'auto'
  revealed_at?: string | null
  cancelled?: boolean
  points?: NotePoints
  children?: Array<{ id: string; fault_key: string | null; verdict: Verdict | null }>
  /** #2816 monthly: the game day planned after this one. */
  next_id?: string | null
}

export interface Actor {
  id: string | null
  name: string | null
  operator: boolean
  /** An administrator — the only one who may plan a day led by someone else (F5). */
  admin?: boolean
}

/**
 * F5: an operator may only name THEMSELVES as the lead; naming someone else is an
 * administrator's call (announcements and faults run as the planner, but the lead sees blind
 * faults and gets the drill pushes).
 */
function assertMayNameLead(plan: GamedayPlan, by: Actor): void {
  if (by.admin) return
  if (!by.id || lc(plan.lead) !== lc(by.id))
    throw new ChaosError(
      'Only an administrator can plan a game day led by someone else — name yourself as the lead',
      403,
      'CHAOS_LEAD_NOT_SELF'
    )
}

const BOT = { user: null, senderId: null, senderName: 'Nivaro', system: true, skipVisibility: true }
const CLAIM_TTL_S = 2 * 86_400
const TIMER_HORIZON_MS = 8 * 3600_000

const lc = (s: string | null | undefined) => (s ? s.toLowerCase() : '')

export function gamedayMeta(run: ChaosRun): GamedayMeta {
  return run.meta as unknown as GamedayMeta
}

/**
 * The game-day row itself. Its injected faults are runs of kind `gameday` too (the drill
 * lifecycle's kind for a game-day step) but carry `gameday_id` and no plan.
 */
export function isGamedayRow(run: ChaosRun | null | undefined): boolean {
  return !!run && run.kind === 'gameday' && !run.gameday_id && !!gamedayMeta(run)?.plan
}

function appRef(app?: FastifyInstance | null): FastifyInstance | null {
  return app ?? (getApp() as FastifyInstance | null) ?? null
}

/** Where people read the outcome: c-report's run report (#2849), the console's run view otherwise. */
export function reportHref(id: string): string {
  return `/chaos?tab=gamedays&gameday=${id}`
}

// ─── Participants, notifications, chat ───────────────────────────────────────

export function isParticipant(run: ChaosRun, userId: string | null): boolean {
  if (!userId || !isGamedayRow(run)) return false
  return participantsOf(gamedayMeta(run).plan).includes(lc(userId))
}

export function mayLead(run: ChaosRun, actor: Actor): boolean {
  return actor.operator || (!!actor.id && lc(gamedayMeta(run).plan.lead) === lc(actor.id))
}

async function notifyAll(
  app: FastifyInstance | null,
  ids: string[],
  subject: string,
  message: string,
  gamedayId: string
): Promise<number> {
  if (!app) return 0
  let n = 0
  const { notifyUser } = await import('../notification-channels.js')
  for (const id of ids) {
    try {
      await notifyUser(app, id, {
        subject,
        message,
        category: 'chaos',
        target: { kind: 'external', url: `${adminBaseUrl() ?? ''}${reportHref(gamedayId)}` },
        source: { kind: 'chaos', label: 'Game day', id: gamedayId }
      })
      n++
    } catch (err) {
      app.log?.warn({ err, gamedayId }, 'game day: notify failed')
    }
  }
  return n
}

/** A platform line in the day's channel — FIXED text only (see the module comment). */
async function botLine(app: FastifyInstance | null, run: ChaosRun, message: string): Promise<void> {
  const room = gamedayMeta(run).channel_room
  if (!app || !room) return
  try {
    const { postChatMessage } = await import('../chat-send.js')
    await postChatMessage(app, BOT, { room, message })
  } catch (err) {
    app.log?.warn({ err, id: run.id }, 'game day: timeline line failed')
  }
}

/** The private channel for the day, members = participants. Null when chat is unavailable. */
async function createChannel(run: ChaosRun, plan: GamedayPlan): Promise<string | null> {
  try {
    if (!(await db.schema.hasTable('nivaro_chat_channels'))) return null
    const { channels, clearChatCaches } = await import('../chat.js')
    const { upsertMembership } = await import('../chat-send.js')
    const day = plan.starts_at.slice(0, 10)
    let key = `gameday-${day}-${run.id.slice(0, 6)}`
    if ((await channels()).has(key)) key = `${key}-${Date.now().toString(36).slice(-4)}`
    await db('nivaro_chat_channels').insert({
      key,
      name: `Game day: ${plan.title}`.slice(0, 100),
      visibility: 'private',
      created_by: run.started_by ?? plan.lead
    })
    clearChatCaches()
    const room = `ch:${key}`
    for (const id of participantsOf(plan)) {
      try {
        await upsertMembership(id, room, {})
      } catch {
        /* an ops-only rule or a vanished user skips that member */
      }
    }
    const { logActivity } = await import('../activity.js')
    await logActivity({
      action: 'chat-channel-create',
      user: run.started_by ?? plan.lead,
      collection: 'nivaro_chat_channels',
      item: key,
      comment: 'game day channel'
    })
    return room
  } catch {
    return null
  }
}

async function addMembers(room: string | null | undefined, ids: string[]): Promise<void> {
  if (!room) return
  try {
    const { upsertMembership } = await import('../chat-send.js')
    for (const id of ids) await upsertMembership(id, room, {}).catch(() => {})
  } catch {
    /* chat unavailable */
  }
}

// ─── Planning ────────────────────────────────────────────────────────────────

/**
 * Denormalised for the other chaos areas (drill-alert routing #2847, phone Stop push #2861,
 * POST /runs gameday_id trust): who takes part, in which role, and whether the day is blind.
 * `meta.plan` stays the source of truth.
 */
export function rolesMeta(plan: GamedayPlan) {
  return {
    lead: plan.lead,
    participants: participantsOf(plan),
    roles: { lead: plan.lead, scribe: plan.scribe, responders: plan.responders },
    blind: plan.blind
  }
}

function faultExists(key: string): boolean {
  return getFault(key) != null
}

export async function listGamedays(limit = 100): Promise<ChaosRun[]> {
  return (await listRuns({ kind: 'gameday', limit: Math.min(500, limit * 4) }))
    .filter(isGamedayRow)
    .slice(0, limit)
}

export async function getGameday(id: string): Promise<ChaosRun> {
  const run = await getRun(id)
  if (!run || !isGamedayRow(run)) throw new ChaosError('No such game day', 404, 'CHAOS_NO_GAMEDAY')
  return run
}

export async function createGameday(raw: unknown, by: Actor, app?: FastifyInstance | null) {
  const now = Date.now()
  const { plan, warnings } = validatePlan(raw, { faultExists, now })
  assertMayNameLead(plan, by)
  const start = Date.parse(plan.starts_at)
  // Reminders whose moment already passed are covered by the invitation itself.
  const reminders_sent = plan.reminders_min.filter((m) => now >= start - m * 60_000)
  let run = await createRun({
    kind: 'gameday',
    status: 'planned',
    label: plan.title,
    started_by: by.id,
    ends_at: new Date(start + plan.duration_min * 60_000).toISOString(),
    meta: {
      plan,
      warnings,
      started_by_name: by.name,
      reminders_sent,
      ...rolesMeta(plan)
    } as Record<string, unknown>
  })
  if (plan.channel) {
    const room = await createChannel(run, plan)
    if (room) run = (await updateRun(run.id, { meta: { ...run.meta, channel_room: room } })) ?? run
  }
  await addRunEvent(run.id, 'step', { phase: 'planned' }, by.id)
  const a = appRef(app)
  await notifyAll(
    a,
    participantsOf(plan),
    `Game day planned: ${plan.title}`,
    `You are taking part in a game day on ${fmtEastern(plan.starts_at)} (${plan.duration_min} min).`,
    run.id
  )
  emitChaosWatch('chaos:run', { run })
  return { run, warnings }
}

export async function updateGameday(
  id: string,
  raw: unknown,
  by: Actor,
  app?: FastifyInstance | null
) {
  const run = await getGameday(id)
  if (!mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can edit it', 403, 'CHAOS_NOT_LEAD')
  if (run.status !== 'planned')
    throw new ChaosError('Only a planned game day can be edited', 409, 'CHAOS_NOT_PLANNED')
  // F5: announcements run as the planner, so only the planner (or an administrator) rewrites them.
  if (!by.admin && lc(run.started_by) !== lc(by.id))
    throw new ChaosError(
      'Only the person who planned this day or an administrator can edit it',
      403,
      'CHAOS_NOT_PLANNER'
    )
  const now = Date.now()
  const { plan, warnings } = validatePlan(raw, { faultExists, now })
  assertMayNameLead(plan, by)
  const before = gamedayMeta(run)
  const start = Date.parse(plan.starts_at)
  const moved = plan.starts_at !== before.plan.starts_at
  const reminders_sent = moved
    ? plan.reminders_min.filter((m) => now >= start - m * 60_000)
    : (before.reminders_sent ?? [])
  const added = participantsOf(plan).filter((p) => !participantsOf(before.plan).includes(p))
  const next = await updateRun(
    run.id,
    {
      label: plan.title,
      ends_at: new Date(start + plan.duration_min * 60_000).toISOString(),
      meta: { ...run.meta, plan, warnings, reminders_sent, ...rolesMeta(plan) }
    },
    { ifStatus: ['planned'] }
  )
  if (!next) throw new ChaosError('The game day changed meanwhile', 409, 'CHAOS_NOT_PLANNED')
  await addMembers(before.channel_room, added)
  await notifyAll(
    appRef(app),
    added,
    `Game day planned: ${plan.title}`,
    `You are taking part in a game day on ${fmtEastern(plan.starts_at)} (${plan.duration_min} min).`,
    run.id
  )
  emitChaosWatch('chaos:run', { run: next })
  return { run: next, warnings }
}

export async function cancelGameday(id: string, by: Actor, app?: FastifyInstance | null) {
  const run = await getGameday(id)
  if (!mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can cancel it', 403, 'CHAOS_NOT_LEAD')
  const next = await updateRun(
    run.id,
    {
      status: 'stopped',
      ended_at: new Date().toISOString(),
      meta: { ...run.meta, cancelled: true }
    },
    { ifStatus: ['planned'] }
  )
  if (!next)
    throw new ChaosError('Only a planned game day can be cancelled', 409, 'CHAOS_NOT_PLANNED')
  await addRunEvent(run.id, 'step', { phase: 'cancelled' }, by.id)
  await botLine(appRef(app), next, 'This game day was cancelled.')
  await notifyAll(
    appRef(app),
    participantsOf(gamedayMeta(run).plan),
    `Game day cancelled: ${gamedayMeta(run).plan.title}`,
    'The game day you were invited to will not take place.',
    run.id
  )
  emitChaosWatch('chaos:run', { run: next })
  await planSuccessor(next, appRef(app))
  return next
}

/** A monthly day (#2816) plans its successor once it ends or is cancelled. */
async function planSuccessor(run: ChaosRun, app: FastifyInstance | null): Promise<string | null> {
  const meta = gamedayMeta(run)
  if (meta.plan?.repeat !== 'monthly' || meta.next_id) return null
  if (!(await claim(`${run.id}:successor`))) return null
  try {
    const { run: next } = await createGameday(
      { ...meta.plan, starts_at: nextMonthlyStart(meta.plan.starts_at) },
      // The plan was accepted when it was made; next month repeats it as is.
      { id: run.started_by, name: meta.started_by_name ?? null, operator: true, admin: true },
      app
    )
    const fresh = (await getRun(run.id)) ?? run
    await updateRun(run.id, { meta: { ...fresh.meta, next_id: next.id } })
    return next.id
  } catch (err) {
    app?.log?.warn({ err, id: run.id }, 'game day: next month could not be planned')
    return null
  }
}

// ─── Running ─────────────────────────────────────────────────────────────────

export async function startGameday(
  id: string,
  by: Actor,
  opts: { auto?: boolean; app?: FastifyInstance | null } = {}
): Promise<ChaosRun> {
  assertChaosAllowed()
  const run = await getGameday(id)
  if (!opts.auto && !mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can start it', 403, 'CHAOS_NOT_LEAD')
  if (run.status !== 'planned')
    throw new ChaosError('This game day is not waiting to start', 409, 'CHAOS_NOT_PLANNED')
  const { plan } = gamedayMeta(run)
  const now = Date.now()
  const endsAt = now + plan.duration_min * 60_000
  // The window goes out BEFORE any fault is armed, so no replica shows a blind fault.
  if (plan.blind)
    await openBlindWindow({
      id: run.id,
      kind: 'gameday',
      // Faults are armed as the planner (F5); the lead and the planner are both insiders.
      lead: run.started_by ?? plan.lead,
      insiders: [plan.lead],
      until: endsAt + 5 * 60_000
    })
  const next = await updateRun(
    run.id,
    {
      status: 'running',
      started_at: new Date(now).toISOString(),
      ends_at: new Date(endsAt).toISOString(),
      meta: { ...run.meta, started_how: opts.auto ? 'auto' : 'manual' }
    },
    { ifStatus: ['planned'] }
  )
  if (!next) {
    if (plan.blind) await closeBlindWindow(run.id)
    throw new ChaosError('This game day is not waiting to start', 409, 'CHAOS_NOT_PLANNED')
  }
  const app = appRef(opts.app)
  await addRunEvent(run.id, 'step', { phase: 'started', how: opts.auto ? 'auto' : 'manual' }, by.id)
  await botLine(app, next, 'The game day has started. Timeline posts follow here.')
  await notifyAll(
    app,
    participantsOf(plan),
    `Game day started: ${plan.title}`,
    'The game day is running now. Use the scribe buttons to stamp what you notice.',
    run.id
  )
  emitChaosWatch('chaos:run', { run: next })
  armInjectTimers(next, app)
  // Injects at +0:00 go out now.
  await fireDue(next.id, app)
  return (await getRun(next.id)) ?? next
}

const timers = new Map<string, ReturnType<typeof setTimeout>[]>()

/** In-process timers for this day's injects (dev laptops never tick crons). */
export function armInjectTimers(run: ChaosRun, app: FastifyInstance | null): void {
  clearInjectTimers(run.id)
  const started = Date.parse(run.started_at ?? '')
  if (!Number.isFinite(started)) return
  const list: ReturnType<typeof setTimeout>[] = []
  const now = Date.now()
  const marks = new Set(gamedayMeta(run).plan.injects.map((i) => started + i.at_s * 1000))
  const end = Date.parse(run.ends_at ?? '')
  if (Number.isFinite(end)) marks.add(end)
  for (const at of marks) {
    const wait = at - now
    if (wait <= 0 || wait > TIMER_HORIZON_MS) continue
    const t = setTimeout(() => void fireDue(run.id, app).catch(() => {}), wait + 50)
    t.unref?.()
    list.push(t)
  }
  timers.set(run.id, list)
}

function clearInjectTimers(id: string): void {
  for (const t of timers.get(id) ?? []) clearTimeout(t)
  timers.delete(id)
}

// Claims: Redis SET NX across replicas, this process's set when Redis is absent.
const localClaims = new Set<string>()

async function claim(key: string): Promise<boolean> {
  const redis = (getApp() as { redis?: { set(...a: unknown[]): Promise<unknown> } } | null)?.redis
  if (redis) {
    try {
      const ok = await redis.set(`${CHAOS_KEY_PREFIX}gd:${key}`, '1', 'EX', CLAIM_TTL_S, 'NX')
      return ok === 'OK'
    } catch {
      /* fall through: this process decides */
    }
  }
  if (localClaims.has(key)) return false
  localClaims.add(key)
  if (localClaims.size > 5000) localClaims.delete(localClaims.values().next().value as string)
  return true
}

async function doneInjects(id: string): Promise<Set<string>> {
  const done = new Set<string>()
  for (const ev of await listRunEvents(id, { kinds: ['step'], limit: 3000 }))
    if (typeof ev.data?.inject_id === 'string') done.add(ev.data.inject_id)
  return done
}

/** Fire every inject that is due on a running day, skip the missed ones, end it when its time is up. */
export async function fireDue(id: string, app?: FastifyInstance | null): Promise<number> {
  const run = await getRun(id)
  if (!run || !isGamedayRow(run) || run.status !== 'running') return 0
  const started = Date.parse(run.started_at ?? '')
  if (!Number.isFinite(started)) return 0
  const now = Date.now()
  const done = await doneInjects(run.id)
  const { due, missed } = dueInjects(gamedayMeta(run).plan, started, now, done)
  let fired = 0
  for (const inj of missed) {
    if (!(await claim(`${run.id}:${inj.id}`))) continue
    await addRunEvent(run.id, 'step', { inject_id: inj.id, kind: inj.kind, outcome: 'missed' })
  }
  for (const inj of due) {
    if (!(await claim(`${run.id}:${inj.id}`))) continue
    await fireInject(run, inj, null, appRef(app))
    fired++
  }
  const end = Date.parse(run.ends_at ?? '')
  if (Number.isFinite(end) && now >= end) await endGameday(run.id, 'completed', null, { app })
  return fired
}

/** Who injected faults run as: the person who planned the day (F5), never the named lead. */
function plannerActor(run: ChaosRun): { id: string | null; name: string | null } {
  const name = gamedayMeta(run).started_by_name
  return { id: run.started_by, name: typeof name === 'string' && !name.includes('@') ? name : null }
}

/**
 * Fire one inject. Faults are armed AS THE LEAD (blind windows match on the lead) and go
 * through the drill lifecycle, pre-flight included; a refusal is a step event, not a throw.
 */
export async function fireInject(
  run: ChaosRun,
  inj: GamedayInject,
  stepper: Actor | null,
  app: FastifyInstance | null
): Promise<ChaosRunEvent | null> {
  const { plan } = gamedayMeta(run)
  const off = fmtOffset(inj.at_s)
  const blind = !!blindWindow(run.id) && !blindWindow(run.id)?.revealed_at
  const base = { inject_id: inj.id, kind: inj.kind, ...(stepper ? { manual: true } : {}) }
  const actor = stepper?.id ?? null
  if (inj.kind === 'checkpoint') {
    const n =
      plan.injects.filter((i) => i.kind === 'checkpoint').findIndex((i) => i.id === inj.id) + 1
    const total = plan.injects.filter((i) => i.kind === 'checkpoint').length
    await botLine(app, run, `+${off}: checkpoint ${n} of ${total}.`)
    return addRunEvent(run.id, 'step', { ...base, outcome: 'checkpoint' }, actor)
  }
  if (inj.kind === 'announce') {
    let outcome = 'announced'
    const room = gamedayMeta(run).channel_room
    if (room && app && inj.text) {
      try {
        // F5: the planner's own words, as the planner — never put in another person's mouth.
        const user = run.started_by
          ? await db('nivaro_users').where({ id: run.started_by }).first()
          : null
        if (!user) throw new Error('no planner')
        const { postChatMessage } = await import('../chat-send.js')
        // User text: through the normal send path, never a system line.
        await postChatMessage(app, { user, isAdmin: false }, { room, message: inj.text })
      } catch {
        outcome = 'announce_failed'
      }
    }
    return addRunEvent(run.id, 'step', { ...base, outcome }, actor)
  }
  // fault
  const key = inj.fault?.fault_key ?? ''
  const def = key ? getFault(key) : null
  if (!def) {
    await addRunEvent(
      run.id,
      'step',
      {
        ...base,
        outcome: 'refused',
        reason: `${key || 'preset'} is not in this instance's catalog`
      },
      actor
    )
    if (!blind) await botLine(app, run, `+${off}: a fault inject was skipped (not available here).`)
    return null
  }
  if (def.key === 'kill_web_task') {
    const { killTaskRefusal } = await import('./faults/gameday.js')
    const why = await killTaskRefusal(String(inj.fault?.params?.env ?? 'staging'))
    if (why) {
      await addRunEvent(
        run.id,
        'step',
        { ...base, outcome: 'refused', fault_key: def.key, reason: why },
        actor
      )
      if (!blind) await botLine(app, run, `+${off}: ${def.label} was refused (no host runbook).`)
      return null
    }
  }
  const planner = plannerActor(run)
  try {
    const { run: child, fault } = await startDrill({
      fault_key: def.key,
      target: inj.fault?.target,
      params: inj.fault?.params,
      seconds: inj.fault?.seconds,
      kind: 'gameday',
      gameday_id: run.id,
      preset_id: inj.preset_id ?? null,
      note: `Game day inject ${inj.id}${stepper?.name ? ` (stepped by ${stepper.name})` : ''}`,
      by: planner
    })
    if (plan.blind) await bindBlindRun(run.id, child.id)
    const seconds = Math.round((fault.ends_at - fault.started_at) / 1000)
    if (!blind) await botLine(app, run, `+${off}: ${def.label} armed for ${seconds} s.`)
    return addRunEvent(
      run.id,
      'step',
      { ...base, outcome: 'armed', fault_key: def.key, child_run_id: child.id, seconds },
      actor
    )
  } catch (err) {
    const e = err as ChaosError
    await addRunEvent(
      run.id,
      'step',
      {
        ...base,
        outcome: 'refused',
        fault_key: def.key,
        reason: e?.message ?? String(err),
        code: e?.code ?? null,
        child_run_id: (e?.details as { run_id?: string } | undefined)?.run_id ?? null
      },
      actor
    )
    if (!blind) await botLine(app, run, `+${off}: ${def.label} was refused by pre-flight.`)
    return null
  }
}

/** The lead steps by hand: fire one inject now (once — the same claim as the scheduler). */
export async function stepGameday(
  id: string,
  injectId: string,
  by: Actor,
  app?: FastifyInstance | null
) {
  assertChaosAllowed()
  const run = await getGameday(id)
  if (!mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can step', 403, 'CHAOS_NOT_LEAD')
  if (run.status !== 'running')
    throw new ChaosError('The game day is not running', 409, 'CHAOS_NOT_RUNNING')
  const inj = gamedayMeta(run).plan.injects.find((i) => i.id === injectId)
  if (!inj) throw new ChaosError('No such inject', 404, 'CHAOS_NO_INJECT')
  if ((await doneInjects(run.id)).has(inj.id) || !(await claim(`${run.id}:${inj.id}`)))
    throw new ChaosError('That inject already ran', 409, 'CHAOS_INJECT_DONE')
  return fireInject(run, inj, by, appRef(app))
}

function rollupVerdict(children: ChaosRun[]): Verdict {
  if (children.some((c) => c.verdict === 'broke')) return 'broke'
  if (children.some((c) => c.verdict === 'aborted')) return 'aborted'
  return 'held'
}

export async function childRuns(id: string): Promise<ChaosRun[]> {
  return (await listRuns({ limit: 500 })).filter((r) => lc(r.gameday_id) === lc(id))
}

/**
 * End a running day: stop its child drills still armed, close the blind window, write the
 * roll-up (verdict = worst child, TTD/TTF from the scribe marks), tell the participants.
 */
export async function endGameday(
  id: string,
  how: 'completed' | 'stopped' | 'aborted',
  by: Actor | null,
  opts: { reason?: string; app?: FastifyInstance | null } = {}
): Promise<ChaosRun | null> {
  const run = await getRun(id)
  if (!run || !isGamedayRow(run) || run.status !== 'running') return null
  if (by && !mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can end it', 403, 'CHAOS_NOT_LEAD')
  clearInjectTimers(run.id)
  const kids = await childRuns(run.id)
  for (const c of kids.filter((k) => k.status === 'running')) {
    try {
      await stopDrill(c.id, { id: by?.id ?? null }, `game day ${how}`)
    } catch {
      /* already ended elsewhere */
    }
  }
  await closeBlindWindow(run.id)
  const settled = await childRuns(run.id)
  const points = notePoints(await listRunEvents(run.id, { limit: 3000 }))
  const verdict: Verdict = how === 'aborted' ? 'aborted' : rollupVerdict(settled)
  const next = await updateRun(
    run.id,
    {
      status: how,
      verdict,
      ended_at: new Date().toISOString(),
      verdict_detail: { ...points, children: settled.length },
      meta: {
        ...run.meta,
        points,
        children: settled.map((c) => ({ id: c.id, fault_key: c.fault_key, verdict: c.verdict }))
      }
    },
    { ifStatus: ['running'] }
  )
  if (!next) return null
  await addRunEvent(
    run.id,
    how === 'aborted' ? 'abort' : 'step',
    { phase: 'ended', how, reason: opts.reason ?? how, verdict },
    by?.id ?? null
  )
  const app = appRef(opts.app)
  await botLine(app, next, 'The game day has ended. The report is in the chaos console.')
  const { plan } = gamedayMeta(run)
  await notifyAll(
    app,
    participantsOf(plan),
    `Game day ended: ${plan.title}`,
    'The game day is over. The report and timeline are in the chaos console.',
    run.id
  )
  emitChaosWatch('chaos:run', { run: next })
  await planSuccessor(next, app)
  return next
}

export async function revealGameday(id: string, by: Actor, app?: FastifyInstance | null) {
  const run = await getGameday(id)
  if (!mayLead(run, by))
    throw new ChaosError('Only the lead or a chaos operator can reveal', 403, 'CHAOS_NOT_LEAD')
  const w = await revealBlindWindow(run.id)
  if (!w) throw new ChaosError('This game day is not blind', 409, 'CHAOS_NOT_BLIND')
  const next =
    (await updateRun(run.id, {
      meta: { ...run.meta, revealed_at: new Date().toISOString(), blind: false }
    })) ?? run
  await addRunEvent(run.id, 'step', { phase: 'revealed' }, by.id)
  await botLine(
    appRef(app),
    next,
    'This was a drill. The faults now show on the banner for everyone.'
  )
  emitChaosWatch('chaos:run', { run: next })
  return next
}

// ─── Scribe marks (#2853) and Declare incident (#2854) ───────────────────────

/** The row a note lands on: a game day's child run notes go on the game day. */
async function noteHome(runId: string): Promise<ChaosRun> {
  const run = await getRun(runId)
  if (!run) throw new ChaosError('No such run', 404, 'CHAOS_NO_RUN')
  if (run.gameday_id) {
    const day = await getRun(run.gameday_id)
    if (day) return day
  }
  return run
}

export async function addNote(
  runId: string,
  input: { mark?: NoteMark | null; text?: string | null },
  by: Actor,
  app?: FastifyInstance | null
): Promise<ChaosRunEvent | null> {
  const home = await noteHome(runId)
  if (!by.operator && !isParticipant(home, by.id))
    throw new ChaosError('Only people taking part can stamp notes', 403, 'CHAOS_NOT_PARTICIPANT')
  if (!['running', 'planned'].includes(home.status) && !by.operator)
    throw new ChaosError('This run has ended', 409, 'CHAOS_NOT_RUNNING')
  const text = String(input.text ?? '')
    .trim()
    .slice(0, 500)
  const mark = input.mark ?? null
  if (!mark && !text) throw new ChaosError('Pick a mark or write a note')
  const ev = await addRunEvent(
    home.id,
    'note',
    {
      mark,
      text: text || null,
      by_name: by.name,
      ...(lc(home.id) !== lc(runId) ? { on_run: runId } : {})
    },
    by.id
  )
  if (mark && isGamedayRow(home) && home.status === 'running')
    await botLine(appRef(app), home, `Marked: ${MARK_LABEL[mark]}.`)
  return ev
}

/**
 * "Declare incident": a `declared` mark on every running game day and every blind drill in
 * flight. The answer never says whether anything was running (a blind responder must not learn
 * it was a drill from the button).
 */
export async function declareIncident(by: Actor): Promise<number> {
  let n = 0
  const homes = new Map<string, ChaosRun>()
  for (const r of await listRuns({ status: 'running', limit: 100 })) {
    if (isGamedayRow(r)) homes.set(r.id, r)
    else if (r.gameday_id) {
      const day = await getRun(r.gameday_id)
      if (day?.status === 'running') homes.set(day.id, day)
    } else if (windowOfRun(r.id)) homes.set(r.id, r)
  }
  const since = Date.now() - DECLARE_REPEAT_MS
  for (const home of homes.values()) {
    // F8: one declared mark per person per run per minute — a repeat adds nothing.
    const recent = (await listRunEvents(home.id, { kinds: ['note'], limit: 3000 })).some(
      (e) => e.data?.mark === 'declared' && lc(e.actor) === lc(by.id) && Date.parse(e.at) >= since
    )
    if (recent) continue
    await addRunEvent(home.id, 'note', { mark: 'declared', text: null, by_name: by.name }, by.id)
    n++
  }
  return n
}

const DECLARE_REPEAT_MS = 60_000

// ─── Per-person rate limits (F8) ──────────────────────────────────────────────

const tries = new Map<string, number[]>()

/**
 * True when `key` has used up `max` tries in the last `windowMs` (this try counted). Process
 * local, like the phone-push limiter — a replica each still bounds a loop to a trickle.
 */
export function chaosRateLimited(key: string, max: number, windowMs: number, now = Date.now()) {
  const list = (tries.get(key) ?? []).filter((t) => now - t < windowMs)
  list.push(now)
  tries.set(key, list)
  if (tries.size > 5000) tries.clear()
  return list.length > max
}

// ─── The scheduler (cron `chaos-gamedays`, every minute, leader only) ────────

export async function runGamedayTick(app?: FastifyInstance | null): Promise<{
  reminded: number
  started: number
  fired: number
}> {
  const a = appRef(app)
  const now = Date.now()
  let reminded = 0
  let started = 0
  let fired = 0
  for (const run of await listRuns({ kind: 'gameday', status: 'planned', limit: 200 })) {
    if (!isGamedayRow(run)) continue
    const meta = gamedayMeta(run)
    for (const m of dueReminders(meta.plan, now, meta.reminders_sent ?? [])) {
      if (!(await claim(`${run.id}:reminder:${m}`))) continue
      const fresh = (await getRun(run.id)) ?? run
      const sent = [...new Set([...(gamedayMeta(fresh).reminders_sent ?? []), m])]
      await updateRun(
        run.id,
        { meta: { ...fresh.meta, reminders_sent: sent } },
        { ifStatus: ['planned'] }
      )
      reminded += await notifyAll(
        a,
        participantsOf(meta.plan),
        `Game day reminder: ${meta.plan.title}`,
        `The game day starts ${m >= 120 ? `in ${Math.round(m / 60)} hours` : `in ${m} minutes`} (${fmtEastern(meta.plan.starts_at)}).`,
        run.id
      )
    }
    if (meta.plan.auto_start && now >= Date.parse(meta.plan.starts_at)) {
      if (!(await claim(`${run.id}:autostart`))) continue
      try {
        await startGameday(
          run.id,
          { id: run.started_by, name: meta.started_by_name ?? null, operator: false },
          { auto: true, app: a }
        )
        started++
      } catch (err) {
        await addRunEvent(run.id, 'step', {
          phase: 'start_refused',
          reason: (err as Error)?.message ?? String(err)
        })
      }
    }
  }
  for (const run of await listRuns({ kind: 'gameday', status: 'running', limit: 200 })) {
    if (isGamedayRow(run)) fired += await fireDue(run.id, a)
  }
  return { reminded, started, fired }
}

// ─── Views ───────────────────────────────────────────────────────────────────

export async function gamedayDetail(id: string) {
  const run = await getGameday(id)
  const events = await listRunEvents(run.id, { limit: 3000 })
  const children = await childRuns(run.id)
  const { plan } = gamedayMeta(run)
  const ids = participantsOf(plan)
  let people: Array<{ id: string; name: string }> = []
  try {
    const rows = (await db('nivaro_users')
      .whereIn('id', ids)
      .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, string | null>>
    people = rows.map((u) => ({
      id: lc(u.id),
      name: [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Someone'
    }))
  } catch {
    /* names are decoration */
  }
  const w = blindWindow(run.id)
  return {
    run,
    events,
    children,
    people,
    points: notePoints(events),
    blind: { on: plan.blind, revealed: !!(w?.revealed_at ?? gamedayMeta(run).revealed_at) }
  }
}

/** "9:45 PM ET, Tue Oct 21" — the console and notifications speak Eastern time. */
export function fmtEastern(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit'
  })
  const day = d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
  return `${time} ET, ${day}`
}

/** Tests only. */
export function _resetGamedayForTests(): void {
  tries.clear()
  for (const id of [...timers.keys()]) clearInjectTimers(id)
  localClaims.clear()
}

/**
 * A run's events for its report (#2849): a game day's fault run gets the day's scribe marks
 * stamped inside its window (+5 min), since people stamp on the day, not on one fault. Ids of
 * the borrowed events are negated so they never collide with the run's own.
 */
export async function reportEvents(run: ChaosRun): Promise<ChaosRunEvent[]> {
  const own = await listRunEvents(run.id, { limit: 3000 })
  if (!run.gameday_id || !run.started_at) return own
  const from = Date.parse(run.started_at)
  const to = Date.parse(run.ended_at ?? run.ends_at ?? '') + 5 * 60_000
  const borrowed = (await listRunEvents(run.gameday_id, { kinds: ['note'], limit: 3000 }))
    .filter((e) => {
      const t = Date.parse(e.at)
      return t >= from && (!Number.isFinite(to) || t <= to)
    })
    .map((e) => ({ ...e, id: -e.id, run_id: run.id }))
  return [...own, ...borrowed].sort((a, b) => a.at.localeCompare(b.at))
}
