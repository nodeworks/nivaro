import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { deliverHubNotice, type HubNotice, type NotifyDeps } from '../notify-events.js'
import { chainOf, onCallAt, type Rota, type StepKind } from './rota.js'
import {
  activeAccounts,
  activeAdminIds,
  activeOwnerIds,
  addEvent,
  iso,
  listOverrides,
  PAGES,
  patchIncident,
  productionEnvIds,
  readRota
} from './store.js'

/**
 * Paging (Hub enhancements 32 + 33): an urgent Hub alert for an app with an on-call rota goes to
 * the person on call FIRST, then — every `escalate_minutes` while nobody acknowledges it — to the
 * rota's next escalation step. Every chain ends with the app's owners, then the Hub
 * administrators, whether the rota lists them or not (chainOf). Each person gets one notifyUser
 * delivery through deliverHubNotice (inbox, socket, browser and PHONE push, email; their own
 * notification rules still apply), marked urgent.
 *
 *   open → acked      a person it was sent to (or an owner / administrator) acknowledged it
 *   open → closed     its incident was resolved, or the outage it was about ended
 *   open, next_at null  every step was tried; it stays open until someone acknowledges it
 *
 * Crash safety (resume): a step is RECORDED (sent_to: who it is for) before anyone is told, and
 * each person is marked `delivered` right after their notice. A due page is claimed with a short
 * lease (next_at = now + LEASE_MS), never cleared: a tick that throws or a process that dies
 * mid-step leaves the lease to run out, and the next tick delivers to whoever of the recorded
 * step was not marked yet — each person at most once per step.
 *
 * One page per alert: while a page of the same app + environment + kind is open (or acked), a
 * repeat joins it, whatever its age; two concurrent opens both insert, and the newer one removes
 * itself before telling anyone (insert-then-check on the row ids).
 *
 * Outages (`uptime_down`): steps are at least OUTAGE_GAP_MS apart, and once the chain is done the
 * person on call is reminded every OUTAGE_GAP_MS while it stays down and nobody acknowledged it.
 *
 * What a person is told: owners and administrators of the app get the alert's own words; anyone
 * else on the rota (who cannot read the app) gets the app name, the kind of environment, the
 * severity and a generic title — never a version, an environment key or the producer's text.
 */

export const LEASE_MS = 2 * 60_000
export const OUTAGE_GAP_MS = 30 * 60_000
export const MAX_ESCALATIONS_PER_TICK = 50

export type PageStatus = 'open' | 'acked' | 'closed'

export interface SentStep {
  level: number
  step: StepKind
  /** Who this step is for (recorded before anyone is told). */
  users: string[]
  /** Who was told so far. */
  delivered: string[]
  at: string
  /** An outage reminder to the person on call (after the chain). */
  repeat?: boolean
}

export interface Page {
  id: number
  app_id: number
  environment_id: number | null
  incident_id: number | null
  kind: string
  severity: string | null
  subject: string
  message: string
  path: string
  status: PageStatus
  level: number
  sent_to: SentStep[]
  next_at: string | null
  last_sent_at: string | null
  acknowledged_by: string | null
  acknowledged_at: string | null
  closed_at: string | null
  created_at: string
}

function sentFrom(v: unknown): SentStep[] {
  let raw: unknown = v
  try {
    raw = typeof v === 'string' ? JSON.parse(v) : v
  } catch {
    raw = []
  }
  if (!Array.isArray(raw)) return []
  return raw.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>
    const users = Array.isArray(o.users) ? o.users.map(String) : []
    return {
      level: Number(o.level) || 0,
      step: String(o.step ?? 'on_call') as StepKind,
      users,
      // A row written before `delivered` existed counts as delivered.
      delivered: Array.isArray(o.delivered) ? o.delivered.map(String) : users,
      at: String(o.at ?? ''),
      ...(o.repeat === true ? { repeat: true } : {})
    }
  })
}

export function pageFromRow(r: Record<string, unknown>): Page {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: r.environment_id == null ? null : Number(r.environment_id),
    incident_id: r.incident_id == null ? null : Number(r.incident_id),
    kind: String(r.kind),
    severity: (r.severity as string | null) ?? null,
    subject: String(r.subject ?? ''),
    message: String(r.message ?? ''),
    path: String(r.path ?? '/hub/on-call'),
    status: r.status === 'acked' ? 'acked' : r.status === 'closed' ? 'closed' : 'open',
    level: Number(r.level) || 0,
    sent_to: sentFrom(r.sent_to),
    next_at: iso(r.next_at),
    last_sent_at: iso(r.last_sent_at),
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

/** Everyone a page is for so far (upper-cased): they may acknowledge it. */
export function pagedPeople(p: Pick<Page, 'sent_to'>): Set<string> {
  return new Set(p.sent_to.flatMap((s) => s.users.map((u) => u.toUpperCase())))
}

/** Everyone a page was delivered to, as stored (each person once), to send them a notice. */
export function pagedUserIds(p: Pick<Page, 'sent_to'>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const u of p.sent_to.flatMap((s) => s.delivered)) {
    if (seen.has(u.toUpperCase())) continue
    seen.add(u.toUpperCase())
    out.push(u)
  }
  return out
}

// ─── What a person is told ──────────────────────────────────────────────────

const GENERIC_TITLE: Record<string, string> = {
  incident: 'An incident was opened',
  promote_failed: 'A deploy did not finish',
  auto_rollback: 'The Hub rolled a deploy back',
  uptime_down: 'The app stopped answering',
  drift: 'What runs no longer matches the Hub',
  test: 'Test page'
}

export const SEV_WORDS: Record<string, string> = { sev1: 'SEV 1', sev2: 'SEV 2', sev3: 'SEV 3' }

/** The notice for someone who cannot read the app (pure): no version, key or producer text. */
export function genericNotice(
  p: Pick<Page, 'kind' | 'severity'>,
  appName: string,
  envWord: string | null
): { subject: string; message: string } {
  const sev = p.severity ? (SEV_WORDS[p.severity] ?? 'Urgent') : 'Urgent'
  return {
    subject: `${sev} alert: ${appName}`.slice(0, 200),
    message: `${appName}${envWord ? ` · ${envWord}` : ''} · ${sev}: ${GENERIC_TITLE[p.kind] ?? 'Urgent alert'}. Open the Hub to acknowledge.`
  }
}

export interface PageDeps extends NotifyDeps {
  now?: () => number
  /** Hands one notice to people (default deliverHubNotice). */
  deliver?: typeof deliverHubNotice
  owners?: (appId: number) => Promise<string[]>
  admins?: () => Promise<string[]>
}

interface StepContext {
  rota: Rota | null
  chain: StepKind[]
  overrides: Awaited<ReturnType<typeof listOverrides>>
  owners: () => Promise<string[]>
  admins: () => Promise<string[]>
  /** Owners + administrators (upper-cased): they get the alert's own words. */
  readers: () => Promise<Set<string>>
  appName: string
  envWord: string | null
}

async function contextFor(
  page: Pick<Page, 'app_id' | 'environment_id'>,
  rota: Rota | null,
  deps: PageDeps
): Promise<StepContext> {
  let owners: string[] | null = null
  let admins: string[] | null = null
  const app = (await db('nivaro_hub_apps').where({ id: page.app_id }).first('key', 'name')) as
    | { key: string; name: string }
    | undefined
  let envWord: string | null = null
  if (page.environment_id != null) {
    const prod = await productionEnvIds(page.app_id).catch(() => [] as number[])
    envWord = prod.includes(page.environment_id) ? 'production' : 'another environment'
  }
  const ctx: StepContext = {
    rota,
    chain: rota ? chainOf(rota) : ['owners', 'admins'],
    overrides: rota
      ? await listOverrides(rota.app_id, new Date((deps.now ?? Date.now)() - 86_400_000))
      : [],
    owners: async () => {
      owners ??= await (deps.owners ?? activeOwnerIds)(page.app_id)
      return owners
    },
    admins: async () => {
      admins ??= await (deps.admins ?? activeAdminIds)()
      return admins
    },
    readers: async () =>
      new Set([...(await ctx.owners()), ...(await ctx.admins())].map((u) => u.toUpperCase())),
    appName: app ? String(app.name || app.key) : `App ${page.app_id}`,
    envWord
  }
  return ctx
}

/** The people one step names right now (active Hub people only, never machine accounts). */
export async function stepUsers(step: StepKind, ctx: StepContext, now: number): Promise<string[]> {
  const oc = onCallAt(ctx.rota, ctx.overrides, now)
  let ids: string[] = []
  if (step === 'on_call') ids = oc.user_id ? [oc.user_id] : []
  else if (step === 'next') ids = oc.next_user_id ? [oc.next_user_id] : []
  else if (step === 'owners') ids = await ctx.owners()
  else if (step === 'admins') ids = await ctx.admins()
  const live = await activeAccounts(ids)
  return ids.filter((id) => live.has(id.toUpperCase()))
}

const WHY: Record<StepKind, string> = {
  on_call: 'You are on call for this app.',
  next: 'You are next on the on-call rota for this app.',
  owners: 'You own this app and the page was not acknowledged.',
  admins: 'You are a Hub administrator and the page was not acknowledged.'
}

async function writeSent(id: number, sent: SentStep[], extra: Record<string, unknown> = {}) {
  await db(PAGES)
    .where({ id })
    .update({ sent_to: JSON.stringify(sent), ...extra })
}

/**
 * Tells everyone of the LAST recorded step who was not told yet, marking each right after
 * their notice (the step itself was written before). Answers how many were handed a notice.
 */
async function deliverLast(
  page: Page,
  sent: SentStep[],
  ctx: StepContext,
  deps: PageDeps,
  escalated: boolean
): Promise<number> {
  const entry = sent[sent.length - 1]
  if (!entry) return 0
  const readers = await ctx.readers()
  const done = new Set(entry.delivered.map((u) => u.toUpperCase()))
  let handed = 0
  for (const u of entry.users) {
    if (done.has(u.toUpperCase())) continue
    const own = readers.has(u.toUpperCase())
    const text = own
      ? { subject: page.subject, message: page.message }
      : genericNotice(page, ctx.appName, ctx.envWord)
    const minutes = ctx.rota?.escalate_minutes ?? 15
    const notice: HubNotice = {
      subject: escalated && !entry.repeat ? `Not acknowledged: ${text.subject}` : text.subject,
      message:
        escalated && !entry.repeat
          ? `Nobody acknowledged this within ${minutes} minutes. ${text.message}`
          : entry.repeat
            ? `Still not answering. ${text.message}`
            : text.message,
      path: `/hub/on-call?page=${page.id}`,
      urgent: true,
      email: true,
      source: { kind: 'hub-page', label: page.kind, id: page.id },
      why: WHY[entry.step] ?? WHY.on_call
    }
    handed += await (deps.deliver ?? deliverHubNotice)([u], notice, deps)
    entry.delivered.push(u)
    done.add(u.toUpperCase())
    await writeSent(page.id, sent)
  }
  return handed
}

/** The gap before the next step of this page. */
function gapFor(kind: string, ctx: StepContext): number {
  const step = (ctx.rota?.escalate_minutes ?? 15) * 60_000
  return kind === 'uptime_down' ? Math.max(step, OUTAGE_GAP_MS) : step
}

/** The first level from `from` that names someone not in `skip`, with those people. */
async function nextStep(
  ctx: StepContext,
  from: number,
  skip: Set<string>,
  now: number
): Promise<SentStep | null> {
  for (let l = from; l < ctx.chain.length; l++) {
    const users = (await stepUsers(ctx.chain[l], ctx, now)).filter(
      (u) => !skip.has(u.toUpperCase())
    )
    if (users.length)
      return { level: l, step: ctx.chain[l], users, delivered: [], at: new Date(now).toISOString() }
  }
  return null
}

/** An enabled rota of the app, else null (the caller keeps its own notification). */
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
  severity?: string | null
  subject: string
  message: string
  path?: string
}

/** Open / acked pages of one alert (app + environment + kind), oldest first. */
async function openForAlert(appId: number, envId: number | null, kind: string) {
  const q = db(PAGES)
    .where({ app_id: appId, kind })
    .whereIn('status', ['open', 'acked'])
    .whereNull('incident_id')
    .orderBy('id', 'asc')
  if (envId == null) q.whereNull('environment_id')
  else q.where({ environment_id: envId })
  return ((await q.select('id')) as Array<{ id: number }>).map((r) => Number(r.id))
}

/**
 * Opens a page (or joins the one open for the same alert) and sends its first step. Answers null
 * when the app has no enabled rota (the caller falls back to its own notification), else the page
 * id and how many people were handed the notice now.
 */
export async function openPage(
  input: OpenPageInput,
  deps: PageDeps = {}
): Promise<{ page_id: number; handed: number; joined: boolean } | null> {
  const rota = await pageableRota(input.app_id)
  if (!rota) return null
  const now = (deps.now ?? Date.now)()
  const env = input.environment_id ?? null
  if (!input.incident_id) {
    const open = await openForAlert(input.app_id, env, input.kind)
    if (open.length) return { page_id: open[0], handed: 0, joined: true }
  }
  const id = Number(
    await insertReturningId(db, PAGES, {
      app_id: input.app_id,
      environment_id: env,
      incident_id: input.incident_id ?? null,
      kind: input.kind.slice(0, 32),
      severity: input.severity ?? null,
      subject: input.subject.slice(0, 200),
      message: input.message.slice(0, 1000),
      path: (input.path ?? '/hub/on-call').slice(0, 300),
      status: 'open',
      level: 0,
      sent_to: '[]',
      next_at: new Date(now + LEASE_MS),
      created_at: new Date(now)
    })
  )
  if (!input.incident_id) {
    // Two opens at once: the older row wins, the newer removes itself before telling anyone.
    const open = await openForAlert(input.app_id, env, input.kind)
    if (open.length && open[0] !== id) {
      await db(PAGES).where({ id }).del()
      return { page_id: open[0], handed: 0, joined: true }
    }
  }
  const page = (await readPage(id)) as Page
  const ctx = await contextFor(page, rota, deps)
  const first = await nextStep(ctx, 0, new Set(), now)
  if (!first) {
    // Nobody any step names is reachable now: keep the page open and try the chain again later.
    await db(PAGES)
      .where({ id })
      .update({ next_at: new Date(now + gapFor(page.kind, ctx)) })
    return { page_id: id, handed: 0, joined: false }
  }
  const sent = [first]
  // Recorded before anyone is told: a crash now leaves a page the next tick resumes.
  await writeSent(id, sent, { level: first.level })
  const handed = await deliverLast(page, sent, ctx, deps, false)
  const more = first.level + 1 < ctx.chain.length || page.kind === 'uptime_down'
  await db(PAGES)
    .where({ id })
    .update({
      next_at: more ? new Date(now + gapFor(page.kind, ctx)) : null,
      last_sent_at: new Date(now)
    })
  if (input.incident_id)
    await addEvent(
      input.incident_id,
      'page',
      `Paged ${first.step === 'on_call' ? 'the person on call' : first.step} (${first.users.length})`,
      null
    ).catch(() => {})
  return { page_id: id, handed, joined: false }
}

/** Moves every due page on (see the header). Answers how many sent a step. */
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
      // Claim with a lease: a throw or a crash below leaves it to run out (the next tick resumes).
      const claimed = await db(PAGES)
        .where({ id: p.id, status: 'open', level: p.level })
        .where('next_at', '<=', new Date(now))
        .update({ next_at: new Date(now + LEASE_MS) })
      if (!claimed) continue
      const rota = await readRota(p.app_id)
      const ctx = await contextFor(p, rota?.enabled ? rota : null, deps)
      const sent = p.sent_to.map((s) => ({ ...s, delivered: [...s.delivered] }))
      const last = sent[sent.length - 1]
      let entry: SentStep | null = null
      const resumed =
        !!last &&
        last.users.some((u) => !last.delivered.some((d) => d.toUpperCase() === u.toUpperCase()))
      if (resumed) entry = last
      else {
        entry = await nextStep(ctx, last ? last.level + 1 : 0, pagedPeople(p), now)
        if (!entry && p.kind === 'uptime_down') {
          // After the chain: remind whoever is on call now (else the owners), every gap.
          const users =
            (await stepUsers('on_call', ctx, now)).length > 0
              ? await stepUsers('on_call', ctx, now)
              : await stepUsers('owners', ctx, now)
          if (users.length)
            entry = {
              level: last?.level ?? 0,
              step: 'on_call',
              users,
              delivered: [],
              at: new Date(now).toISOString(),
              repeat: true
            }
        }
        if (entry) {
          sent.push(entry)
          await writeSent(p.id, sent, { level: entry.level })
        }
      }
      if (!entry) {
        // Every step was tried: open until someone acknowledges it.
        await db(PAGES).where({ id: p.id }).update({ next_at: null })
        continue
      }
      await deliverLast({ ...p, level: entry.level }, sent, ctx, deps, true)
      const more = entry.level + 1 < ctx.chain.length || p.kind === 'uptime_down'
      await db(PAGES)
        .where({ id: p.id })
        .update({
          next_at: more ? new Date(now + gapFor(p.kind, ctx)) : null,
          last_sent_at: new Date(now)
        })
      escalated++
      if (p.incident_id && !resumed)
        await addEvent(
          p.incident_id,
          'escalated',
          `Not acknowledged — paged ${entry.step} (${entry.users.length})`,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Pages the caller may see, filtered in SQL before the limit: administrators every page; anyone
 * else pages of the apps they own and pages sent to them.
 */
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
  if (!o.isAdmin) {
    const me = UUID_RE.test(o.userId) ? o.userId.toUpperCase() : null
    q.where((w) => {
      w.whereIn('app_id', o.ownedAppIds.length ? o.ownedAppIds : [-1])
      if (me) w.orWhereRaw('UPPER(sent_to) LIKE ?', [`%"${me}"%`])
    })
  }
  const rows = ((await q) as Array<Record<string, unknown>>).map(pageFromRow)
  if (o.isAdmin) return rows
  // The LIKE is a pre-filter; the parsed recipients decide.
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
    severity?: string | null
  },
  deps: PageDeps = {}
): Promise<number | null> {
  const out = await openPage(
    {
      app_id: e.appId,
      environment_id: e.envId,
      kind: e.kind,
      severity: e.severity ?? null,
      subject: e.subject,
      message: e.message,
      path: e.path
    },
    deps
  )
  return out ? out.handed : null
}
