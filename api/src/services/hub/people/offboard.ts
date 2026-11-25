import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { type AccessDeps, askableEnvironments, askEnvironment, inPool } from './access.js'
import type { PersonIdentity } from './directory.js'

/**
 * Nivaro Hub "Offboard everywhere": one person, every app.
 *
 *  1. The Hub refuses the person's Hub sign-in AT ONCE: the run row is a sign-in block
 *     (`blocked`, read by hubSigninBlocked on every Hub OpenID authorize + token), and the Hub's
 *     own account for them (when there is one) is suspended with every session and phone ended —
 *     refused OFFBOARD_SELF for the caller and LAST_HUB_ADMIN for the Hub's last administrator.
 *  2. Every environment (not archived) is asked over its link to SUSPEND the matching accounts
 *     (services/hub-link/people.ts on the app: by email / Entra id only, never delete, refused
 *     LAST_ADMIN). At most PEOPLE_CONCURRENCY at a time; each result is written as it lands.
 *  3. The run ends `done` (every environment suspended / already / none) or `partial`; Retry
 *     asks again only the environments that did not finish (and any added since).
 *
 * Runs in the background (202 at once); the row carries a heartbeat. A run whose server stopped
 * (heartbeat older than STALE_MS) reads as `interrupted` and can be retried. Environments under
 * an open move are asked where they live now: a move never moves the database, so the
 * suspension lands in the same place either way.
 */

const TABLE = 'nivaro_hub_offboards'
export const STALE_MS = 2 * 60_000

export type EnvOutcome =
  | 'pending'
  | 'suspended'
  | 'already'
  | 'none'
  | 'refused'
  | 'no_link'
  | 'failed'

export interface OffboardResult {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  state: EnvOutcome
  code?: string
  /** How many of the person's accounts there (suspended now or before). */
  accounts?: number
  attempts: number
  at: string | null
}

export interface OffboardRow {
  id: number
  label: string | null
  person_key: string | null
  hub_user_id: string | null
  identity: PersonIdentity
  status: 'running' | 'done' | 'partial' | 'interrupted'
  results: OffboardResult[]
  hub_account: string | null
  blocked: boolean
  started_by: string | null
  started_at: string | null
  heartbeat_at: string | null
  finished_at: string | null
  lifted_by: string | null
  lifted_at: string | null
}

const FINAL: ReadonlySet<EnvOutcome> = new Set(['suspended', 'already', 'none'])
const truthy = (v: unknown) => v === true || v === 1 || v === '1'
const iso = (v: unknown) => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parse<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function offboardFromRow(r: Record<string, unknown>): OffboardRow {
  const status = String(r.status ?? 'running') as OffboardRow['status']
  const heartbeat = iso(r.heartbeat_at)
  const stale =
    status === 'running' && (!heartbeat || Date.now() - Date.parse(heartbeat) > STALE_MS)
  return {
    id: Number(r.id),
    label: (r.label as string | null) ?? null,
    person_key: (r.person_key as string | null) ?? null,
    hub_user_id: r.hub_user_id == null ? null : String(r.hub_user_id),
    identity: parse<PersonIdentity>(r.identity, { emails: [], entra: [] }),
    status: stale ? 'interrupted' : status,
    results: parse<OffboardResult[]>(r.results, []),
    hub_account: (r.hub_account as string | null) ?? null,
    blocked: truthy(r.blocked),
    started_by: r.started_by == null ? null : String(r.started_by),
    started_at: iso(r.started_at),
    heartbeat_at: heartbeat,
    finished_at: iso(r.finished_at),
    lifted_by: r.lifted_by == null ? null : String(r.lifted_by),
    lifted_at: iso(r.lifted_at)
  }
}

export async function readOffboard(id: number): Promise<OffboardRow | null> {
  const r = (await db(TABLE).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? offboardFromRow(r) : null
}

export async function listOffboards(
  opts: { personKey?: string; limit?: number } = {}
): Promise<OffboardRow[]> {
  const q = db(TABLE)
    .orderBy('id', 'desc')
    .limit(Math.max(1, Math.min(opts.limit ?? 50, 200)))
  if (opts.personKey) q.where({ person_key: opts.personKey })
  return ((await q) as Record<string, unknown>[]).map(offboardFromRow)
}

export class OffboardError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface OffboardDeps extends AccessDeps {
  /** The Hub's Redis: the person's Hub sessions and phones end at once. */
  redis?: unknown
  suspendHubUser?: (id: string) => Promise<void>
  revokeHubSessions?: (redis: unknown, id: string) => Promise<unknown>
  /** Tests wait on the run; the route never does. */
  onRunDone?: (p: Promise<void>) => void
}

/** Active Hub administrators (people), upper-cased ids. */
async function activeHubAdmins(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id).toUpperCase())
}

/** Suspends the person's Hub account (step 1). Answers what hub_account records. */
async function suspendHubAccount(
  hubUserId: string | null,
  caller: string,
  deps: OffboardDeps
): Promise<'suspended' | 'already' | 'none'> {
  if (!hubUserId) return 'none'
  const user = (await db('nivaro_users').where({ id: hubUserId }).first('id', 'status')) as
    | { id: string; status: string | null }
    | undefined
  if (!user) return 'none'
  const id = String(user.id)
  if (id.toUpperCase() === caller.toUpperCase())
    throw new OffboardError(409, 'OFFBOARD_SELF', 'You cannot offboard yourself.')
  const admins = await activeHubAdmins()
  if (admins.includes(id.toUpperCase()) && admins.length <= 1)
    throw new OffboardError(
      409,
      'LAST_HUB_ADMIN',
      'This person is the Hub’s last active administrator; make someone else an administrator first.'
    )
  if (String(user.status ?? '').toLowerCase() === 'suspended') {
    // Already suspended: their sessions are ended again all the same.
    if (deps.redis) await revokeHub(deps, id)
    return 'already'
  }
  if (deps.suspendHubUser) await deps.suspendHubUser(id)
  else {
    const { updateUser } = await import('../../users.js')
    await updateUser(id, { status: 'suspended' } as never)
  }
  if (deps.redis) await revokeHub(deps, id)
  return 'suspended'
}

async function revokeHub(deps: OffboardDeps, id: string) {
  try {
    if (deps.revokeHubSessions) await deps.revokeHubSessions(deps.redis, id)
    else {
      const { revokeUserSessions } = await import('../../../auth/session.js')
      await revokeUserSessions(deps.redis as never, id)
    }
  } catch {
    // The account is suspended: every request re-reads it, so a session still in the store
    // stops on its next use anyway.
  }
}

function statusOf(results: OffboardResult[]): 'done' | 'partial' {
  return results.every((r) => FINAL.has(r.state)) ? 'done' : 'partial'
}

/**
 * Starts an offboard (see the header). `confirm` must be the person's email (or, when the Hub
 * knows none, their directory key). 409 OFFBOARD_RUNNING while another run for them runs.
 */
export async function startOffboard(
  input: {
    personKey: string
    label: string | null
    hubUserId: string | null
    identity: PersonIdentity
    caller: string
  },
  deps: OffboardDeps = {}
): Promise<OffboardRow> {
  if (!input.identity.emails.length && !input.identity.entra.length)
    throw new OffboardError(
      409,
      'NO_IDENTITY',
      'The Hub knows no email or Entra id for this person: nothing to ask the apps about.'
    )
  const open = (
    (await db(TABLE).where({ person_key: input.personKey, status: 'running' }).select()) as Record<
      string,
      unknown
    >[]
  ).map(offboardFromRow)
  if (open.some((r) => r.status === 'running'))
    throw new OffboardError(409, 'OFFBOARD_RUNNING', 'An offboard of this person is running.')

  // Step 1 first: the Hub stops signing them in before anything else is asked.
  const hubAccount = await suspendHubAccount(input.hubUserId, input.caller, deps)
  const envs = await (deps.environments ?? askableEnvironments)()
  const results: OffboardResult[] = envs.map((e) => ({
    environment_id: e.id,
    app_id: e.app_id,
    app_key: e.app_key,
    app_name: e.app_name,
    environment_key: e.key,
    state: 'pending',
    attempts: 0,
    at: null
  }))
  const now = new Date()
  const id = Number(
    await insertReturningId(db, TABLE, {
      label: input.label?.slice(0, 400) ?? null,
      person_key: input.personKey,
      hub_user_id: input.hubUserId,
      identity: JSON.stringify(input.identity),
      status: 'running',
      results: JSON.stringify(results),
      hub_account: hubAccount,
      blocked: true,
      started_by: input.caller || null,
      started_at: now,
      heartbeat_at: now
    })
  )
  await logActivity({
    action: 'hub-offboard-start',
    user: input.caller || null,
    collection: TABLE,
    item: String(id),
    comment: `Offboard everywhere: ${results.length} environment(s); Hub account ${hubAccount}`
  })
  launch(id, deps)
  return (await readOffboard(id)) as OffboardRow
}

/** Retries the environments that did not finish (and any added since). 409 while running. */
export async function retryOffboard(
  id: number,
  caller: string,
  deps: OffboardDeps = {}
): Promise<OffboardRow> {
  const row = await readOffboard(id)
  if (!row) throw new OffboardError(404, 'NOT_FOUND', 'Not found')
  if (row.status === 'running')
    throw new OffboardError(409, 'OFFBOARD_RUNNING', 'This offboard is still running.')
  const envs = await (deps.environments ?? askableEnvironments)()
  const known = new Map(row.results.map((r) => [r.environment_id, r]))
  const results: OffboardResult[] = [
    ...row.results.map((r) => (FINAL.has(r.state) ? r : { ...r, state: 'pending' as const })),
    ...envs
      .filter((e) => !known.has(e.id))
      .map(
        (e): OffboardResult => ({
          environment_id: e.id,
          app_id: e.app_id,
          app_key: e.app_key,
          app_name: e.app_name,
          environment_key: e.key,
          state: 'pending',
          attempts: 0,
          at: null
        })
      )
  ]
  const now = new Date()
  const changed = await db(TABLE)
    .where({ id })
    .whereNot({ status: 'running' })
    .update({
      status: 'running',
      results: JSON.stringify(results),
      heartbeat_at: now,
      finished_at: null,
      // Retrying puts the Hub sign-in block back if it was lifted.
      blocked: true
    })
  if (!changed) throw new OffboardError(409, 'OFFBOARD_RUNNING', 'This offboard is running.')
  await logActivity({
    action: 'hub-offboard-retry',
    user: caller || null,
    collection: TABLE,
    item: String(id)
  })
  launch(id, deps)
  return (await readOffboard(id)) as OffboardRow
}

/** Lifts the Hub sign-in block (the apps' suspensions stay; restore those in each app). */
export async function liftOffboardBlock(id: number, caller: string): Promise<OffboardRow> {
  const row = await readOffboard(id)
  if (!row) throw new OffboardError(404, 'NOT_FOUND', 'Not found')
  if (row.status === 'running')
    throw new OffboardError(409, 'OFFBOARD_RUNNING', 'Wait for the offboard to finish first.')
  await db(TABLE)
    .where({ id })
    .update({ blocked: false, lifted_by: caller || null, lifted_at: new Date() })
  await logActivity({
    action: 'hub-offboard-lift',
    user: caller || null,
    collection: TABLE,
    item: String(id),
    comment: 'Hub sign-in block lifted'
  })
  return (await readOffboard(id)) as OffboardRow
}

function launch(id: number, deps: OffboardDeps) {
  const p = runInBackgroundPool(() => runOffboard(id, deps)).catch(() => undefined)
  deps.onRunDone?.(p)
}

/** Asks every pending environment to suspend the person; writes each result as it lands. */
export async function runOffboard(id: number, deps: OffboardDeps = {}): Promise<void> {
  const row = await readOffboard(id)
  if (!row) return
  const results = row.results.map((r) => ({ ...r }))
  const envs = await (deps.environments ?? askableEnvironments)()
  const byId = new Map(envs.map((e) => [e.id, e]))
  // One write at a time: results land from several calls at once.
  let writing: Promise<unknown> = Promise.resolve()
  const save = () => {
    writing = writing
      .then(() =>
        db(TABLE)
          .where({ id })
          .update({ results: JSON.stringify(results), heartbeat_at: new Date() })
      )
      .catch(() => undefined)
    return writing
  }
  const beat = setInterval(() => void save(), 30_000)
  try {
    const todo = results.filter((r) => r.state === 'pending')
    await inPool(todo, 6, async (entry) => {
      const env = byId.get(entry.environment_id)
      entry.attempts += 1
      if (!env) {
        // Archived or removed since: nothing left to ask.
        Object.assign(entry, { state: 'none', code: 'ENVIRONMENT_GONE', at: new Date() })
      } else {
        const { target, result } = await askEnvironment(env, 'suspend', row.identity, deps)
        const at = new Date().toISOString()
        if (target === null) Object.assign(entry, { state: 'no_link', code: 'NO_LINK', at })
        else if (!result || !result.ok) {
          const code = result?.code ?? 'LINK_UNREACHABLE'
          Object.assign(entry, {
            state: code === 'LAST_ADMIN' ? 'refused' : 'failed',
            code,
            at
          })
        } else {
          Object.assign(entry, {
            state: result.state ?? 'none',
            accounts: result.accounts.length,
            at
          })
          delete entry.code
        }
      }
      await save()
    })
  } finally {
    clearInterval(beat)
    await writing
  }
  const status = statusOf(results)
  await db(TABLE)
    .where({ id })
    .update({
      status,
      results: JSON.stringify(results),
      finished_at: new Date(),
      heartbeat_at: new Date()
    })
  await logActivity({
    action: 'hub-offboard-done',
    user: row.started_by,
    collection: TABLE,
    item: String(id),
    comment: `${results.filter((r) => r.state === 'suspended').length} suspended, ${results.filter((r) => !FINAL.has(r.state)).length} not finished`
  }).catch(() => null)
}

/**
 * Whether the Hub must refuse this person's sign-in now: a blocked offboard names their Hub
 * account, one of their emails, or their Entra object id. Any read failure answers false: the
 * suspended Hub account (step 1) is what really refuses them, this covers an account made again.
 */
export async function hubSigninBlocked(user: {
  id?: unknown
  email?: unknown
  entra_oid?: unknown
}): Promise<boolean> {
  try {
    const rows = (await db(TABLE)
      .where('blocked', true)
      .select('hub_user_id', 'identity')
      .limit(5000)) as Array<{ hub_user_id: string | null; identity: string }>
    if (!rows.length) return false
    const id = user.id == null ? '' : String(user.id).toUpperCase()
    const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
    const oid = typeof user.entra_oid === 'string' ? user.entra_oid.trim().toLowerCase() : ''
    for (const r of rows) {
      if (id && r.hub_user_id && String(r.hub_user_id).toUpperCase() === id) return true
      const ident = parse<PersonIdentity>(r.identity, { emails: [], entra: [] })
      if (email && ident.emails?.includes(email)) return true
      if (oid && ident.entra?.some((x) => x.oid === oid)) return true
    }
    return false
  } catch {
    return false
  }
}
