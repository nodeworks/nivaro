import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { csvRow } from '../../../lib/csv-cell.js'
import { askableEnvironments, type HubEnvRef, inPool } from '../people/access.js'
import { callPeople, type PeopleTarget, peopleTargetOf } from '../people/link-calls.js'
import { callSecurity, type SecurityCallDeps } from './link.js'
import { nextReviewAfter, PER_APP } from './settings.js'

/**
 * Access reviews (Hub enhancement 41). One review of one app reads, over each environment's hub
 * link, every account that holds a role there (routes/hub-link-security.ts role-holders): admins
 * first. The app's owners (or a Hub admin) decide each one — keep or remove — and complete the
 * review; every "remove" then goes through the app's people suspend route (services/hub-link/
 * people.ts: suspend only, never delete, refused LAST_ADMIN under the admin role lock). A service
 * or machine account, or one without an email, is never suspended over the link: it is marked
 * `manual` (remove it in the app). The finished review is the evidence (CSV + PDF/HTML).
 *
 * Runs (reading the environments, applying removals) go in the background with a heartbeat; the
 * security tick resumes one whose process stopped (stale heartbeat) — re-reading is idempotent
 * (items are replaced per environment), and so is removing (an account already suspended answers
 * `already`).
 *
 *   status  reading → open → completing → completed      (cancelled while reading / open;
 *           failed when no environment could be read)
 */

export const REVIEWS = 'nivaro_hub_access_reviews'
export const ITEMS = 'nivaro_hub_access_review_items'
export const STALE_MS = 2 * 60_000
const HEARTBEAT_MS = 15_000
const CONCURRENCY = 4

export type ReviewStatus = 'reading' | 'open' | 'completing' | 'completed' | 'cancelled' | 'failed'

export interface EnvRead {
  environment_id: number
  environment_key: string
  production: boolean
  state: 'read' | 'no_link' | 'error'
  code?: string
  count: number
  truncated?: boolean
}

export interface Review {
  id: number
  app_id: number
  status: ReviewStatus
  started_via: string
  started_by: string | null
  started_at: string | null
  due_at: string | null
  completed_by: string | null
  completed_at: string | null
  note: string | null
  environments: EnvRead[]
  heartbeat_at: string | null
}

export interface ReviewItem {
  id: number
  review_id: number
  environment_id: number
  app_user_id: string
  email: string | null
  name: string | null
  role: string | null
  admin: boolean
  account_status: string | null
  account_kind: string | null
  last_access: string | null
  break_glass: boolean
  entra_oid: string | null
  decision: 'pending' | 'keep' | 'remove'
  decided_by: string | null
  decided_at: string | null
  note: string | null
  removal_state: string | null
  removal_code: string | null
  removed_at: string | null
}

export class ReviewError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const str = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null

function parseJsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v
  if (typeof v !== 'string' || !v) return []
  try {
    const p = JSON.parse(v)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

export function reviewFromRow(r: Record<string, unknown>): Review {
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    status: String(r.status) as ReviewStatus,
    started_via: String(r.started_via ?? 'person'),
    started_by: r.started_by == null ? null : String(r.started_by),
    started_at: iso(r.started_at),
    due_at: iso(r.due_at),
    completed_by: r.completed_by == null ? null : String(r.completed_by),
    completed_at: iso(r.completed_at),
    note: r.note == null ? null : String(r.note),
    environments: parseJsonArray(r.environments) as EnvRead[],
    heartbeat_at: iso(r.heartbeat_at)
  }
}

export function itemFromRow(r: Record<string, unknown>): ReviewItem {
  const d = String(r.decision ?? 'pending')
  return {
    id: Number(r.id),
    review_id: Number(r.review_id),
    environment_id: Number(r.environment_id),
    app_user_id: String(r.app_user_id),
    email: r.email == null ? null : String(r.email),
    name: r.name == null ? null : String(r.name),
    role: r.role == null ? null : String(r.role),
    admin: truthy(r.admin),
    account_status: r.account_status == null ? null : String(r.account_status),
    account_kind: r.account_kind == null ? null : String(r.account_kind),
    last_access: iso(r.last_access),
    break_glass: truthy(r.break_glass),
    entra_oid: r.entra_oid == null ? null : String(r.entra_oid),
    decision: d === 'keep' || d === 'remove' ? d : 'pending',
    decided_by: r.decided_by == null ? null : String(r.decided_by),
    decided_at: iso(r.decided_at),
    note: r.note == null ? null : String(r.note),
    removal_state: r.removal_state == null ? null : String(r.removal_state),
    removal_code: r.removal_code == null ? null : String(r.removal_code),
    removed_at: iso(r.removed_at)
  }
}

export async function readReview(id: number): Promise<Review | null> {
  const r = (await db(REVIEWS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? reviewFromRow(r) : null
}

export async function listReviews(o: {
  appIds: number[] | null
  limit?: number
}): Promise<Review[]> {
  const q = db(REVIEWS)
    .orderBy('id', 'desc')
    .limit(Math.min(200, o.limit ?? 50))
  if (o.appIds) {
    if (!o.appIds.length) return []
    q.whereIn('app_id', o.appIds)
  }
  return ((await q.select()) as Array<Record<string, unknown>>).map(reviewFromRow)
}

export async function reviewItems(reviewId: number): Promise<ReviewItem[]> {
  const rows = (await db(ITEMS)
    .where({ review_id: reviewId })
    .orderBy([
      { column: 'environment_id', order: 'asc' },
      { column: 'admin', order: 'desc' },
      { column: 'id', order: 'asc' }
    ])
    .select()) as Array<Record<string, unknown>>
  return rows.map(itemFromRow)
}

/** Counts a review page shows. Pure. */
export function reviewCounts(items: ReviewItem[]) {
  const c = { total: items.length, pending: 0, keep: 0, remove: 0, admins: 0, removed: 0, open: 0 }
  for (const i of items) {
    c[i.decision]++
    if (i.admin) c.admins++
    if (i.removal_state === 'done' || i.removal_state === 'already') c.removed++
    if (i.decision === 'remove' && (i.removal_state == null || i.removal_state === 'failed'))
      c.open++
  }
  return c
}

export interface ReviewDeps extends SecurityCallDeps {
  environments?: () => Promise<HubEnvRef[]>
  targetOf?: (env: HubEnvRef) => Promise<PeopleTarget | null>
  call?: typeof callSecurity
  suspend?: typeof callPeople
  now?: () => Date
  /** Run in the background (default) or awaited (tests). */
  background?: boolean
  notify?: (appId: number, subject: string, message: string, reviewId: number) => Promise<void>
}

async function appEnvs(appId: number, deps: ReviewDeps): Promise<HubEnvRef[]> {
  return (await (deps.environments ?? askableEnvironments)()).filter((e) => e.app_id === appId)
}

const touch = (id: number, now: Date) =>
  db(REVIEWS).where({ id }).update({ heartbeat_at: now, updated_at: now })

function heartbeat(id: number, deps: ReviewDeps): () => void {
  const t = setInterval(() => {
    void touch(id, (deps.now ?? (() => new Date()))()).catch(() => undefined)
  }, HEARTBEAT_MS)
  t.unref?.()
  return () => clearInterval(t)
}

/** One environment's accounts → items (replacing what an earlier read of it left). */
async function readEnvironment(
  reviewId: number,
  env: HubEnvRef,
  deps: ReviewDeps
): Promise<EnvRead> {
  const base = {
    environment_id: env.id,
    environment_key: env.key,
    production: env.production,
    count: 0
  }
  let target: PeopleTarget | null
  try {
    target = await (deps.targetOf ?? peopleTargetOf)(env)
  } catch {
    return { ...base, state: 'error', code: 'LINK_UNREACHABLE' }
  }
  if (!target) return { ...base, state: 'no_link' }
  const res = await (deps.call ?? callSecurity)(target, 'GET', 'role-holders', undefined, deps)
  if (!res.ok) return { ...base, state: 'error', code: res.code }
  const list = Array.isArray(res.body.accounts) ? res.body.accounts : null
  if (!list) return { ...base, state: 'error', code: 'LINK_BAD_ANSWER' }
  const rows = list
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .filter((a) => typeof a.user_id === 'string' && a.user_id)
    .slice(0, 5000)
    .map((a) => ({
      review_id: reviewId,
      environment_id: env.id,
      app_user_id: String(a.user_id).slice(0, 64),
      email: str(a.email, 320),
      name: str(a.name, 200),
      role: str(a.role, 200),
      admin: a.admin === true,
      account_status: str(a.status, 32),
      account_kind: str(a.kind, 32),
      last_access: a.last_access ? new Date(String(a.last_access)) : null,
      break_glass: !!a.break_glass_until,
      entra_oid: str(a.entra_oid, 64)?.toLowerCase() ?? null,
      decision: 'pending'
    }))
    .map((r) => ({
      ...r,
      last_access: r.last_access && Number.isFinite(r.last_access.getTime()) ? r.last_access : null
    }))
  await db.transaction(async (trx) => {
    await trx(ITEMS).where({ review_id: reviewId, environment_id: env.id }).delete()
    for (let i = 0; i < rows.length; i += 100) await trx(ITEMS).insert(rows.slice(i, i + 100))
  })
  return {
    ...base,
    state: 'read',
    count: rows.length,
    ...(res.body.truncated === true ? { truncated: true } : {})
  }
}

/** Reads every environment of the review's app (the reading leg). */
export async function runReading(reviewId: number, deps: ReviewDeps = {}): Promise<void> {
  const review = await readReview(reviewId)
  if (!review || review.status !== 'reading') return
  const now = deps.now ?? (() => new Date())
  await touch(reviewId, now())
  const stop = heartbeat(reviewId, deps)
  try {
    const envs = await appEnvs(review.app_id, deps)
    const reads = await inPool(envs, CONCURRENCY, (env) =>
      readEnvironment(reviewId, env, deps).catch(
        (): EnvRead => ({
          environment_id: env.id,
          environment_key: env.key,
          production: env.production,
          state: 'error',
          code: 'READ_FAILED',
          count: 0
        })
      )
    )
    const any = reads.some((r) => r.state === 'read')
    await db(REVIEWS)
      .where({ id: reviewId, status: 'reading' })
      .update({
        status: any ? 'open' : 'failed',
        environments: JSON.stringify(reads),
        heartbeat_at: null,
        updated_at: now()
      })
    if (any && deps.notify)
      await deps
        .notify(
          review.app_id,
          'Access review ready',
          'An access review of this app is ready: confirm or remove each administrator and role holder.',
          reviewId
        )
        .catch(() => undefined)
  } finally {
    stop()
  }
}

/** Starts a review of one app (202). One open review per app (409 REVIEW_OPEN). */
export async function startReview(
  appId: number,
  o: { by: string | null; via: 'person' | 'schedule'; note?: string | null },
  deps: ReviewDeps = {}
): Promise<Review> {
  const now = (deps.now ?? (() => new Date()))()
  const open = (await db(REVIEWS)
    .where({ app_id: appId })
    .whereIn('status', ['reading', 'open', 'completing'])
    .first('id')) as { id: unknown } | undefined
  if (open)
    throw new ReviewError(409, 'REVIEW_OPEN', `Access review ${open.id} of this app is still open.`)
  const per = (await db(PER_APP).where({ app_id: appId }).first('review_due_days')) as
    | { review_due_days: unknown }
    | undefined
  const dueDays = Number(per?.review_due_days ?? 14) || 14
  const id = await insertReturningId(db, REVIEWS, {
    app_id: appId,
    status: 'reading',
    started_via: o.via,
    started_by: o.by,
    started_at: now,
    due_at: new Date(now.getTime() + dueDays * 86_400_000),
    note: o.note ? o.note.slice(0, 1000) : null,
    heartbeat_at: now,
    updated_at: now
  })
  const run = runReading(Number(id), deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return (await readReview(Number(id))) as Review
}

/** Owners' decisions on items of an open review. Answers the items changed. */
export async function decideItems(
  reviewId: number,
  decisions: Array<{ id: number; decision: 'keep' | 'remove' | 'pending'; note?: string | null }>,
  by: string,
  now = new Date()
): Promise<number> {
  const review = await readReview(reviewId)
  if (!review) throw new ReviewError(404, 'NOT_FOUND', 'No such access review')
  if (review.status !== 'open')
    throw new ReviewError(
      409,
      'REVIEW_NOT_OPEN',
      'Decisions can change only while the review is open.'
    )
  let n = 0
  for (const d of decisions) {
    n += await db(ITEMS)
      .where({ id: d.id, review_id: reviewId })
      .update({
        decision: d.decision,
        decided_by: d.decision === 'pending' ? null : by,
        decided_at: d.decision === 'pending' ? null : now,
        note: d.note ? String(d.note).slice(0, 500) : null
      })
  }
  return n
}

/** Validates a decisions body. Pure. */
export function readDecisions(
  body: unknown
): Array<{ id: number; decision: 'keep' | 'remove' | 'pending'; note: string | null }> | null {
  const list = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(list) || !list.length || list.length > 1000) return null
  const out: Array<{ id: number; decision: 'keep' | 'remove' | 'pending'; note: string | null }> =
    []
  for (const x of list) {
    if (!x || typeof x !== 'object') return null
    const id = Number((x as { id?: unknown }).id)
    const decision = (x as { decision?: unknown }).decision
    const note = (x as { note?: unknown }).note
    if (!Number.isInteger(id) || id <= 0) return null
    if (decision !== 'keep' && decision !== 'remove' && decision !== 'pending') return null
    if (note != null && (typeof note !== 'string' || note.length > 500)) return null
    out.push({ id, decision, note: typeof note === 'string' && note.trim() ? note.trim() : null })
  }
  return out
}

function removalFor(item: ReviewItem): { state: string; code?: string } | null {
  if (item.account_kind) return { state: 'manual', code: 'NOT_A_PERSON' }
  return null
}

/** The removal leg: every "remove" not yet done goes through the app's suspend route. */
export async function runRemovals(reviewId: number, deps: ReviewDeps = {}): Promise<void> {
  const review = await readReview(reviewId)
  if (!review || review.status !== 'completing') return
  const now = deps.now ?? (() => new Date())
  await touch(reviewId, now())
  const stop = heartbeat(reviewId, deps)
  try {
    const envs = new Map((await appEnvs(review.app_id, deps)).map((e) => [e.id, e]))
    const items = (await reviewItems(reviewId)).filter(
      (i) => i.decision === 'remove' && (i.removal_state == null || i.removal_state === 'failed')
    )
    const targets = new Map<number, PeopleTarget | null>()
    // One environment at a time: the app's admin role lock serialises them anyway.
    for (const item of items) {
      let out = removalFor(item)
      if (!out) {
        const env = envs.get(item.environment_id)
        if (!env) out = { state: 'failed', code: 'ENVIRONMENT_GONE' }
        else {
          if (!targets.has(env.id))
            targets.set(env.id, await (deps.targetOf ?? peopleTargetOf)(env).catch(() => null))
          const target = targets.get(env.id) ?? null
          if (!target) out = { state: 'failed', code: 'NO_LINK' }
          else {
            // By the reviewed ACCOUNT (never by email: another account may share it), and only
            // while its email + Entra oid are what the review read (409 STALE otherwise). `reason`
            // only changes the app's activity text.
            const body: {
              emails: string[]
              entra: Array<{ oid: string; tid: string | null }>
              user_ids: string[]
              expect: { email: string | null; entra_oid: string | null }
              reason: string
            } = {
              emails: [],
              entra: [],
              user_ids: [item.app_user_id],
              expect: {
                email: item.email ? item.email.trim().toLowerCase() : null,
                entra_oid: item.entra_oid
              },
              reason: 'access_review'
            }
            const res = await (deps.suspend ?? callPeople)(target, 'suspend', body, deps)
            if (res.ok)
              out =
                res.state === 'suspended'
                  ? { state: 'done' }
                  : res.state === 'already'
                    ? { state: 'already' }
                    : { state: 'none', code: 'NO_ACCOUNT' }
            else if (res.code === 'LAST_ADMIN') out = { state: 'last_admin', code: 'LAST_ADMIN' }
            else if (res.code === 'STALE') out = { state: 'stale', code: 'STALE' }
            else out = { state: 'failed', code: res.code }
          }
        }
      }
      await db(ITEMS)
        .where({ id: item.id })
        .update({
          removal_state: out.state,
          removal_code: out.code ?? null,
          removed_at: out.state === 'done' || out.state === 'already' ? now() : null
        })
    }
    await db(REVIEWS)
      .where({ id: reviewId, status: 'completing' })
      .update({ status: 'completed', heartbeat_at: null, updated_at: now() })
  } finally {
    stop()
  }
}

/** Completes an open review: every item decided (409 DECISIONS_PENDING), then the removals. */
export async function completeReview(
  reviewId: number,
  by: string,
  deps: ReviewDeps = {}
): Promise<Review> {
  const review = await readReview(reviewId)
  if (!review) throw new ReviewError(404, 'NOT_FOUND', 'No such access review')
  if (review.status !== 'open')
    throw new ReviewError(409, 'REVIEW_NOT_OPEN', 'Only an open review can be completed.')
  const items = await reviewItems(reviewId)
  const pending = items.filter((i) => i.decision === 'pending').length
  if (pending)
    throw new ReviewError(
      409,
      'DECISIONS_PENDING',
      `${pending} account(s) still need a decision (keep or remove).`
    )
  const now = (deps.now ?? (() => new Date()))()
  const n = await db(REVIEWS)
    .where({ id: reviewId, status: 'open' })
    .update({ status: 'completing', completed_by: by, completed_at: now, heartbeat_at: now })
  if (!n) throw new ReviewError(409, 'REVIEW_NOT_OPEN', 'The review changed meanwhile.')
  await scheduleNext(review.app_id, now)
  const run = runRemovals(reviewId, deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return (await readReview(reviewId)) as Review
}

/** A completed review whose removals failed: try those again (owners/admins). */
export async function retryRemovals(reviewId: number, deps: ReviewDeps = {}): Promise<Review> {
  const review = await readReview(reviewId)
  if (!review) throw new ReviewError(404, 'NOT_FOUND', 'No such access review')
  if (review.status !== 'completed')
    throw new ReviewError(409, 'REVIEW_NOT_COMPLETED', 'Only a completed review retries removals.')
  const now = (deps.now ?? (() => new Date()))()
  await db(REVIEWS)
    .where({ id: reviewId, status: 'completed' })
    .update({ status: 'completing', heartbeat_at: now })
  const run = runRemovals(reviewId, deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return (await readReview(reviewId)) as Review
}

export async function cancelReview(reviewId: number, now = new Date()): Promise<void> {
  const n = await db(REVIEWS)
    .where({ id: reviewId })
    .whereIn('status', ['reading', 'open', 'failed'])
    .update({ status: 'cancelled', heartbeat_at: null, updated_at: now })
  if (!n)
    throw new ReviewError(
      409,
      'REVIEW_NOT_OPEN',
      'Only a review that is not completing can be cancelled.'
    )
}

async function scheduleNext(appId: number, now: Date): Promise<void> {
  const per = (await db(PER_APP).where({ app_id: appId }).first('review_every_months')) as
    | { review_every_months: unknown }
    | undefined
  const every = Number(per?.review_every_months ?? 0)
  if (every > 0)
    await db(PER_APP)
      .where({ app_id: appId })
      .update({ next_review_at: nextReviewAfter(now, every) })
}

/**
 * The security tick's review part: resume runs whose process stopped; start the reviews the
 * per-app cadence makes due; remind owners once of a review past its due date.
 */
export async function reviewTick(
  deps: ReviewDeps = {}
): Promise<{ resumed: number[]; started: number[]; reminded: number[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const out = { resumed: [] as number[], started: [] as number[], reminded: [] as number[] }
  const stale = new Date(now.getTime() - STALE_MS)
  const stuck = (await db(REVIEWS)
    .whereIn('status', ['reading', 'completing'])
    .where((w) => w.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .select('id', 'status')) as Array<{ id: unknown; status: string }>
  for (const r of stuck) {
    const id = Number(r.id)
    await touch(id, now)
    if (r.status === 'reading') await runReading(id, { ...deps, background: false })
    else await runRemovals(id, { ...deps, background: false })
    out.resumed.push(id)
  }
  const due = (await db(PER_APP)
    .where('review_every_months', '>', 0)
    .whereNotNull('next_review_at')
    .where('next_review_at', '<=', now)
    .select('app_id', 'review_every_months')) as Array<{
    app_id: unknown
    review_every_months: unknown
  }>
  for (const d of due) {
    const appId = Number(d.app_id)
    const app = await db('nivaro_hub_apps').where({ id: appId }).first('id')
    await db(PER_APP)
      .where({ app_id: appId })
      .update({ next_review_at: nextReviewAfter(now, Number(d.review_every_months)) })
    if (!app) continue
    try {
      const r = await startReview(appId, { by: null, via: 'schedule' }, deps)
      out.started.push(r.id)
    } catch {
      // An open review already covers this period.
    }
  }
  const late = (await db(REVIEWS)
    .where({ status: 'open' })
    .whereNull('reminded_at')
    .where('due_at', '<', now)
    .select('id', 'app_id')) as Array<{ id: unknown; app_id: unknown }>
  for (const r of late) {
    await db(REVIEWS).where({ id: r.id }).update({ reminded_at: now })
    if (deps.notify)
      await deps
        .notify(
          Number(r.app_id),
          'Access review overdue',
          'An access review of this app is past its due date: finish the decisions and complete it.',
          Number(r.id)
        )
        .catch(() => undefined)
    out.reminded.push(Number(r.id))
  }
  return out
}

// ─── Evidence ───────────────────────────────────────────────────────────────────────────────

export const EVIDENCE_HEADER = [
  'review_id',
  'app',
  'environment',
  'production',
  'account_id',
  'name',
  'email',
  'role',
  'admin',
  'account_status',
  'account_kind',
  'last_sign_in',
  'break_glass',
  'decision',
  'decided_by',
  'decided_at',
  'note',
  'removal',
  'removal_code',
  'removed_at'
]

/** The review as CSV evidence (one row per account). Pure. */
export function evidenceCsv(
  review: Review,
  appName: string,
  items: ReviewItem[],
  people: Map<string, string>
): string {
  const envs = new Map(review.environments.map((e) => [e.environment_id, e]))
  const lines = [csvRow(EVIDENCE_HEADER)]
  for (const i of items) {
    const env = envs.get(i.environment_id)
    lines.push(
      csvRow([
        review.id,
        appName,
        env?.environment_key ?? i.environment_id,
        env?.production ? 'yes' : 'no',
        i.app_user_id,
        i.name,
        i.email,
        i.role,
        i.admin ? 'yes' : 'no',
        i.account_status,
        i.account_kind,
        i.last_access,
        i.break_glass ? 'yes' : 'no',
        i.decision,
        i.decided_by ? (people.get(i.decided_by.toUpperCase()) ?? i.decided_by) : '',
        i.decided_at,
        i.note,
        i.removal_state,
        i.removal_code,
        i.removed_at
      ])
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

/** Display names of Hub people by upper-cased id (decided_by / started_by). */
export async function hubNames(
  ids: Array<string | null | undefined>
): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x).map((x) => x.toUpperCase()))]
  const out = new Map<string, string>()
  if (!want.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', want.slice(0, 500))
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter((x) => typeof x === 'string' && x).join(' ')
    out.set(String(r.id).toUpperCase(), name || String(r.email ?? r.id))
  }
  return out
}
