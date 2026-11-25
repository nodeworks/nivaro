import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { deliverHubNotice, type NotifyDeps } from '../notify-events.js'
import { onCallAt, type Rota, type StepKind } from './rota.js'
import {
  activeAccounts,
  activeAdminIds,
  activeOwnerIds,
  addEvent,
  iso,
  listOverrides,
  PAGES,
  patchIncident,
  readRota
} from './store.js'

/**
 * Paging (Hub enhancements 32 + 33): an urgent Hub alert for an app with an on-call rota goes to
 * the person on call FIRST, then — every `escalate_minutes` while nobody acknowledges it — to the
 * rota's next escalation step (next person, the app's owners, the Hub administrators). Each step
 * is a notifyUser delivery through deliverHubNotice (inbox, socket, browser and PHONE push, email;
 * the person's own notification rules and quiet hours still apply), marked urgent.
 *
 *   open → acked      a person it was sent to (or an owner / administrator) acknowledged it
 *   open → closed     its incident was resolved, or the outage it was about ended
 *   open, next_at null  every step was tried; it stays open until someone acknowledges it
 *
 * The minute tick (hub-incident-tick, one leader) moves due pages on; the state is the row, so a
 * tick missed while the Hub was down is picked up by the next. A repeat of the same alert (app,
 * environment, kind) within DEDUPE_MS joins the page already open instead of paging again.
 */

export const DEDUPE_MS = 30 * 60_000
export const MAX_ESCALATIONS_PER_TICK = 50

export type PageStatus = 'open' | 'acked' | 'closed'

export interface SentStep {
  level: number
  step: StepKind
  users: string[]
  at: string
}

export interface Page {
  id: number
  app_id: number
  environment_id: number | null
  incident_id: number | null
  kind: string
  subject: string
  message: string
  path: string
  status: PageStatus
  level: number
  sent_to: SentStep[]
  next_at: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  closed_at: string | null
  created_at: string
}

export function pageFromRow(r: Record<string, unknown>): Page {
  let sent: SentStep[] = []
  try {
    const v = typeof r.sent_to === 'string' ? JSON.parse(r.sent_to) : r.sent_to
    if (Array.isArray(v)) sent = v as SentStep[]
  } catch {
    sent = []
  }
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: r.environment_id == null ? null : Number(r.environment_id),
    incident_id: r.incident_id == null ? null : Number(r.incident_id),
    kind: String(r.kind),
    subject: String(r.subject ?? ''),
    message: String(r.message ?? ''),
    path: String(r.path ?? '/hub/on-call'),
    status: r.status === 'acked' ? 'acked' : r.status === 'closed' ? 'closed' : 'open',
    level: Number(r.level) || 0,
    sent_to: sent,
    next_at: iso(r.next_at),
    acknowledged_by: (r.acknowledged_by as string | null) ?? null,
    acknowledged_at: iso(r.acknowledged_at),
    closed_at: iso(r.closed_at),
    created_at: iso(r.created_at) ?? ''
  }
}

export async function readPage(id: number): Promise<Page | null> {
  const r = (await db(PAGES).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? pageFromRow(r) : null
}

/** Everyone a page was sent to so far (upper-cased). */
export function pagedPeople(p: Page): Set<string> {
  return new Set(p.sent_to.flatMap((s) => s.users.map((u) => u.toUpperCase())))
}

/** Everyone a page was sent to, as stored (each person once), to send them a notice. */
export function pagedUserIds(p: Page): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of p.sent_to.flatMap((s) => s.users)) {
    if (seen.has(u.toUpperCase())) continue
    seen.add(u.toUpperCase())
    out.push(u)
  }
  return out
}

export interface StepPeople {
  rota: Rota
  overrides: Awaited<ReturnType<typeof listOverrides>>
  owners: () => Promise<string[]>
  admins: () => Promise<string[]>
}

/** The people one escalation step names right now (active Hub accounts only). */
export async function stepUsers(step: StepKind, ctx: StepPeople, now: number): Promise<string[]> {
  const oc = onCallAt(ctx.rota, ctx.overrides, now)
  let ids: string[] = []
  if (step === 'on_call') ids = oc.user_id ? [oc.user_id] : []
  else if (step === 'next') ids = oc.next_user_id ? [oc.next_user_id] : []
  else if (step === 'owners') ids = await ctx.owners()
  else if (step === 'admins') ids = await ctx.admins()
  const live = await activeAccounts(ids)
  return ids.filter((id) => live.has(id.toUpperCase()))
}

export interface PageDeps extends NotifyDeps {
  now?: () => number
  /** Hands one notice to people (default deliverHubNotice). */
  deliver?: typeof deliverHubNotice
  owners?: (appId: number) => Promise<string[]>
  admins?: () => Promise<string[]>
}

async function contextFor(rota: Rota, deps: PageDeps): Promise<StepPeople> {
  let owners: string[] | null = null
  let admins: string[] | null = null
  return {
    rota,
    overrides: await listOverrides(rota.app_id, new Date((deps.now ?? Date.now)() - 86_400_000)),
    owners: async () => (owners ??= await (deps.owners ?? activeOwnerIds)(rota.app_id)),
    admins: async () => (admins ??= await (deps.admins ?? activeAdminIds)())
  }
}

/**
 * Sends step `level` of the rota (skipping steps that name nobody new). Answers the level that
 * was actually sent, how many people were handed the notice and who they were.
 */
async function sendFrom(
  page: Pick<Page, 'id' | 'subject' | 'message' | 'path' | 'kind' | 'app_id'>,
  rota: Rota,
  level: number,
  already: Set<string>,
  escalated: boolean,
  deps: PageDeps
): Promise<{ level: number; step: SentStep | null; handed: number }> {
  const ctx = await contextFor(rota, deps)
  const now = (deps.now ?? Date.now)()
  for (let l = level; l < rota.steps.length; l++) {
    const users = (await stepUsers(rota.steps[l], ctx, now)).filter(
      (u) => !already.has(u.toUpperCase())
    )
    if (!users.length) continue
    const handed = await (deps.deliver ?? deliverHubNotice)(
      users,
      {
        subject: escalated ? `Not acknowledged: ${page.subject}` : page.subject,
        message: escalated
          ? `Nobody acknowledged this within ${rota.escalate_minutes} minutes. ${page.message}`
          : page.message,
        path: `/hub/on-call?page=${page.id}`,
        urgent: true,
        email: true,
        source: { kind: 'hub-page', label: page.kind, id: page.id },
        why:
          rota.steps[l] === 'on_call'
            ? 'You are on call for this app.'
            : rota.steps[l] === 'next'
              ? 'You are next on the on-call rota for this app.'
              : rota.steps[l] === 'owners'
                ? 'You own this app and the page was not acknowledged.'
                : 'You are a Hub administrator and the page was not acknowledged.'
      },
      deps
    )
    return {
      level: l,
      step: { level: l, step: rota.steps[l], users, at: new Date(now).toISOString() },
      handed
    }
  }
  return { level: rota.steps.length, step: null, handed: 0 }
}

/** An enabled rota of the app with at least one way to reach someone, else null. */
export async function pageableRota(appId: number): Promise<Rota | null> {
  const rota = await readRota(appId)
  if (!rota?.enabled) return null
  return rota
}

export interface OpenPageInput {
  app_id: number
  environment_id?: number | null
  incident_id?: number | null
  kind: string
  subject: string
  message: string
  path?: string
}

/**
 * Opens a page (or joins the one open for the same alert within DEDUPE_MS) and sends its first
 * step. Answers null when the app has no enabled rota (the caller falls back to its own
 * notification), else the page id and how many people were handed the notice now.
 */
export async function openPage(
  input: OpenPageInput,
  deps: PageDeps = {}
): Promise<{ page_id: number; handed: number; joined: boolean } | null> {
  const rota = await pageableRota(input.app_id)
  if (!rota) return null
  const now = (deps.now ?? Date.now)()
  if (!input.incident_id) {
    const q = db(PAGES)
      .where({ app_id: input.app_id, kind: input.kind, status: 'open' })
      .where('created_at', '>', new Date(now - DEDUPE_MS))
      .orderBy('id', 'desc')
    if (input.environment_id == null) q.whereNull('environment_id')
    else q.where({ environment_id: input.environment_id })
    const open = (await q.first('id')) as { id: number } | undefined
    if (open) return { page_id: Number(open.id), handed: 0, joined: true }
  }
  const id = Number(
    await insertReturningId(db, PAGES, {
      app_id: input.app_id,
      environment_id: input.environment_id ?? null,
      incident_id: input.incident_id ?? null,
      kind: input.kind.slice(0, 32),
      subject: input.subject.slice(0, 200),
      message: input.message.slice(0, 1000),
      path: (input.path ?? '/hub/on-call').slice(0, 300),
      status: 'open',
      level: 0,
      sent_to: '[]',
      created_at: new Date(now)
    })
  )
  const sent = await sendFrom(
    {
      id,
      subject: input.subject,
      message: input.message,
      path: input.path ?? '',
      kind: input.kind,
      app_id: input.app_id
    },
    rota,
    0,
    new Set(),
    false,
    deps
  )
  if (!sent.step) {
    // Nobody any step names can be reached: the caller falls back to its own notification.
    await db(PAGES)
      .where({ id })
      .update({ status: 'closed', closed_at: new Date(now) })
    return null
  }
  const more = sent.level + 1 < rota.steps.length
  await db(PAGES)
    .where({ id })
    .update({
      level: sent.level,
      sent_to: JSON.stringify(sent.step ? [sent.step] : []),
      next_at: more ? new Date(now + rota.escalate_minutes * 60_000) : null
    })
  if (input.incident_id && sent.step)
    await addEvent(
      input.incident_id,
      'page',
      `Paged ${sent.step.step === 'on_call' ? 'the person on call' : sent.step.step} (${sent.step.users.length})`,
      null
    ).catch(() => {})
  return { page_id: id, handed: sent.handed, joined: false }
}

/** Moves every due page one step on. Answers how many escalated. Never throws per page. */
export async function escalateDuePages(
  deps: PageDeps = {}
): Promise<{ escalated: number; errors: string[] }> {
  const now = (deps.now ?? Date.now)()
  const rows = (await db(PAGES)
    .where({ status: 'open' })
    .whereNotNull('next_at')
    .where('next_at', '<=', new Date(now))
    .orderBy('next_at', 'asc')
    .limit(MAX_ESCALATIONS_PER_TICK)) as Array<Record<string, unknown>>
  let escalated = 0
  const errors: string[] = []
  for (const r of rows) {
    const p = pageFromRow(r)
    try {
      // Claim: only the tick that moves next_at on sends (a second process skips it).
      const claimed = await db(PAGES)
        .where({ id: p.id, status: 'open', level: p.level })
        .where('next_at', '<=', new Date(now))
        .update({ next_at: null })
      if (!claimed) continue
      const rota = await readRota(p.app_id)
      if (!rota) continue
      const sent = await sendFrom(p, rota, p.level + 1, pagedPeople(p), true, deps)
      if (!sent.step) continue
      const more = sent.level + 1 < rota.steps.length
      await db(PAGES)
        .where({ id: p.id })
        .update({
          level: sent.level,
          sent_to: JSON.stringify([...p.sent_to, sent.step]),
          next_at: more ? new Date(now + rota.escalate_minutes * 60_000) : null
        })
      escalated++
      if (p.incident_id)
        await addEvent(
          p.incident_id,
          'escalated',
          `Not acknowledged — paged ${sent.step.step} (${sent.step.users.length})`,
          null
        ).catch(() => {})
    } catch (err) {
      errors.push(`page ${p.id}: ${(err as Error)?.message ?? 'failed'}`)
    }
  }
  return { escalated, errors }
}

export class PageError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

/** Acknowledges a page (and its incident). `mayAct` = the caller is an owner or administrator. */
export async function acknowledgePage(
  id: number,
  userId: string,
  mayAct: boolean,
  now = new Date()
): Promise<Page> {
  const p = await readPage(id)
  if (!p) throw new PageError(404, 'NOT_FOUND', 'Not found')
  if (!mayAct && !pagedPeople(p).has(userId.toUpperCase()))
    throw new PageError(404, 'NOT_FOUND', 'Not found')
  if (p.status !== 'open') return p
  await db(PAGES)
    .where({ id, status: 'open' })
    .update({ status: 'acked', acknowledged_by: userId, acknowledged_at: now, next_at: null })
  if (p.incident_id) {
    await patchIncident(p.incident_id, { acknowledged_by: userId, acknowledged_at: now }).catch(
      () => {}
    )
    await addEvent(p.incident_id, 'acknowledged', 'Page acknowledged', userId, now).catch(() => {})
  }
  return (await readPage(id)) ?? p
}

/** Closes the open pages of an incident (it was resolved). */
export async function closeIncidentPages(incidentId: number, now = new Date()): Promise<void> {
  await db(PAGES)
    .where({ incident_id: incidentId })
    .whereIn('status', ['open', 'acked'])
    .update({ status: 'closed', closed_at: now, next_at: null })
}

/** Closes the open pages of one alert kind on an environment (the outage ended). */
export async function closeAlertPages(
  appId: number,
  envId: number | null,
  kind: string,
  now = new Date()
): Promise<number> {
  const q = db(PAGES).where({ app_id: appId, kind }).whereIn('status', ['open', 'acked'])
  if (envId == null) q.whereNull('environment_id')
  else q.where({ environment_id: envId })
  return Number(await q.update({ status: 'closed', closed_at: now, next_at: null })) || 0
}

/** Pages the caller may see: admins every one; else those sent to them or of apps they own. */
export async function listPages(o: {
  userId: string
  isAdmin: boolean
  ownedAppIds: number[]
  status?: PageStatus | 'active'
  limit?: number
}): Promise<Page[]> {
  const q = db(PAGES)
    .orderBy('id', 'desc')
    .limit(Math.min(o.limit ?? 100, 300))
  if (o.status === 'active') q.whereIn('status', ['open', 'acked'])
  else if (o.status) q.where({ status: o.status })
  const rows = ((await q) as Array<Record<string, unknown>>).map(pageFromRow)
  if (o.isAdmin) return rows
  const me = o.userId.toUpperCase()
  return rows.filter((p) => o.ownedAppIds.includes(p.app_id) || pagedPeople(p).has(me))
}

/**
 * THE on-call route for an urgent Hub event (services/hub/notify-events.ts sendHubEvent calls it
 * before its plain fan-out). Answers how many people were handed the page, or null when the app
 * has no enabled rota — then the event goes to owners and administrators as before.
 */
export async function routeToOnCall(
  e: {
    appId: number
    envId: number | null
    kind: string
    subject: string
    message: string
    path: string
  },
  deps: PageDeps = {}
): Promise<number | null> {
  const out = await openPage(
    {
      app_id: e.appId,
      environment_id: e.envId,
      kind: e.kind,
      subject: e.subject,
      message: e.message,
      path: e.path
    },
    deps
  )
  return out ? out.handed : null
}
