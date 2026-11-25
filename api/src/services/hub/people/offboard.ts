import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { runInBackgroundPool } from '../../../db/pool-context.js'
import { logActivity } from '../../activity.js'
import { type AccessDeps, askableEnvironments, askEnvironment, inPool } from './access.js'
import { type BlockDeps, type BlockSubject, offboardBlocks } from './block.js'
import type { PersonIdentity } from './directory.js'

/**
 * Nivaro Hub "Offboard everywhere": one person, every app.
 *
 *  1. The Hub refuses the person's Hub sign-in AT ONCE: the run is a sign-in block (`blocked`,
 *     indexed in nivaro_hub_offboard_ids, read by hubSigninBlocked on every Hub OpenID authorize
 *     + token), and the Hub's own account for them (when there is one) is suspended with every
 *     session and phone ended — refused OFFBOARD_SELF (the identity names the caller),
 *     IDENTITY_SHARED (it names another Hub account, of any status) and LAST_HUB_ADMIN, all checked under
 *     the admin lock with the single-flight check.
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
async function activeHubAdmins(k: Knex): Promise<string[]> {
  const rows = (await k('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id).toUpperCase())
}

/**
 * Runs `fn` in one transaction holding the oldest admin role row's lock — the same row the
 * first-admin seed and every app-side suspend lock (hub-link/first-admin.ts), so starts, retries
 * and lifts of offboards, and admin counts, take turns across every Hub process.
 */
async function underAdminLock<T>(fn: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
  const { oldestAdminRoleQuery, withLockWait } = await import('../../hub-link/first-admin.js')
  return db.transaction((trx) =>
    withLockWait(trx, async () => {
      await oldestAdminRoleQuery(trx)
      return fn(trx)
    })
  )
}

const upperId = (v: unknown) => String(v ?? '').toUpperCase()

/**
 * H2: the identity never names the caller, nor any OTHER Hub account of ANY status (an email or
 * Entra id that belongs to someone else would suspend them in every app, and the sign-in block
 * would hold against a suspended or not-yet-authorized holder the moment it is activated). The
 * person's own Hub account (`hubUserId`) is the only account it may name; a run with no Hub
 * account may name only emails / ids no Hub account holds.
 */
async function identityRefusal(
  k: Knex,
  identity: PersonIdentity,
  hubUserId: string | null,
  caller: string
): Promise<void> {
  const { emailMatchSql } = await import('../signins.js')
  const me = (await k('nivaro_users').where({ id: caller }).first('id', 'email')) as
    | { id: string; email: string | null }
    | undefined
  const hasOid = await k.schema.hasColumn('nivaro_users', 'entra_oid')
  const callerOid = hasOid
    ? ((await k('nivaro_users').where({ id: caller }).first('entra_oid')) as
        | { entra_oid?: string | null }
        | undefined)
    : undefined
  const myEmail = String(me?.email ?? '')
    .trim()
    .toLowerCase()
  const myOid = String(callerOid?.entra_oid ?? '').toLowerCase()
  if (
    (hubUserId && upperId(hubUserId) === upperId(caller)) ||
    (myEmail && identity.emails.includes(myEmail)) ||
    (myOid && identity.entra.some((x) => x.oid === myOid))
  )
    throw new OffboardError(409, 'OFFBOARD_SELF', 'You cannot offboard yourself.')
  const others = new Set<string>()
  for (const email of identity.emails) {
    const rows = (await k('nivaro_users')
      .whereRaw(emailMatchSql(k), [email])
      .select('id')) as Array<{ id: unknown }>
    for (const r of rows) if (upperId(r.id) !== upperId(hubUserId)) others.add(upperId(r.id))
  }
  if (hasOid && identity.entra.length) {
    const rows = (await k('nivaro_users')
      .whereIn(
        'entra_oid',
        identity.entra.map((x) => x.oid)
      )
      .select('id')) as Array<{ id: unknown }>
    for (const r of rows) if (upperId(r.id) !== upperId(hubUserId)) others.add(upperId(r.id))
  }
  if (others.size)
    throw new OffboardError(
      409,
      'IDENTITY_SHARED',
      'An email or Microsoft id in this list belongs to another Hub account (active or not): the apps would suspend them too, and the block would hold against them.'
    )
}

/** Step 1 inside the lock: the person's Hub account. Answers what hub_account records. */
async function suspendHubAccount(
  k: Knex,
  hubUserId: string | null,
  deps: OffboardDeps,
  marker: Date
): Promise<'suspended' | 'already' | 'none'> {
  if (!hubUserId) return 'none'
  const user = (await k('nivaro_users').where({ id: hubUserId }).first('id', 'status')) as
    | { id: string; status: string | null }
    | undefined
  if (!user) return 'none'
  const id = String(user.id)
  if (String(user.status ?? '').toLowerCase() === 'suspended') return 'already'
  const admins = await activeHubAdmins(k)
  if (admins.includes(upperId(id)) && admins.length <= 1)
    throw new OffboardError(
      409,
      'LAST_HUB_ADMIN',
      'This person is the Hub’s last active administrator; make someone else an administrator first.'
    )
  if (deps.suspendHubUser) await deps.suspendHubUser(id)
  // `marker` (whole seconds: every engine stores it exactly) is kept on the run: Lift reactivates
  // the account only while its suspension is still this one (nobody touched it since).
  else await k('nivaro_users').where({ id }).update({ status: 'suspended', updated_at: marker })
  return 'suspended'
}

/** A Date without milliseconds (MySQL DATETIME keeps whole seconds). */
const wholeSecond = (d = new Date()) => new Date(Math.floor(d.getTime() / 1000) * 1000)

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

/** The indexed sign-in block entries of one run (nivaro_hub_offboard_ids). */
function blockIds(
  offboardId: number,
  hubUserId: string | null,
  identity: PersonIdentity
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (hubUserId) out.push({ offboard_id: offboardId, kind: 'user', value: upperId(hubUserId) })
  for (const e of identity.emails) out.push({ offboard_id: offboardId, kind: 'email', value: e })
  for (const x of identity.entra) out.push({ offboard_id: offboardId, kind: 'oid', value: x.oid })
  return out
}

const IDS = 'nivaro_hub_offboard_ids'

/**
 * Starts an offboard (see the header). Single-flight per person: the running check, the Hub
 * account checks + suspension and the insert run in one transaction under the admin lock, so a
 * double click (or two admins) never starts two runs. 409 OFFBOARD_RUNNING, NO_IDENTITY,
 * OFFBOARD_SELF, IDENTITY_SHARED, LAST_HUB_ADMIN.
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
  const { id, hubAccount } = await underAdminLock(async (trx) => {
    if (await trx(TABLE).where({ person_key: input.personKey, status: 'running' }).first('id'))
      throw new OffboardError(409, 'OFFBOARD_RUNNING', 'An offboard of this person is running.')
    await identityRefusal(trx, input.identity, input.hubUserId, input.caller)
    // Step 1 first: the Hub stops signing them in before anything else is asked.
    const marker = wholeSecond()
    const hubAccount = await suspendHubAccount(trx, input.hubUserId, deps, marker)
    const now = new Date()
    const id = Number(
      await insertReturningId(trx, TABLE, {
        label: input.label?.slice(0, 400) ?? null,
        person_key: input.personKey,
        hub_user_id: input.hubUserId,
        identity: JSON.stringify(input.identity),
        status: 'running',
        results: JSON.stringify(results),
        hub_account: hubAccount,
        hub_suspended_at: hubAccount === 'suspended' ? marker : null,
        blocked: true,
        started_by: input.caller || null,
        started_at: now,
        heartbeat_at: now
      })
    )
    const ids = blockIds(id, input.hubUserId, input.identity)
    if (ids.length) await trx(IDS).insert(ids)
    return { id, hubAccount }
  })
  if (input.hubUserId && hubAccount !== 'none' && deps.redis) await revokeHub(deps, input.hubUserId)
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
  await underAdminLock(async (trx) => {
    // Who the identity names may have changed since the run started.
    await identityRefusal(trx, row.identity, row.hub_user_id, caller)
    const other = await trx(TABLE)
      .where({ person_key: row.person_key, status: 'running' })
      .whereNot({ id })
      .first('id')
    if (other)
      throw new OffboardError(409, 'OFFBOARD_RUNNING', 'An offboard of this person is running.')
    const changed = await trx(TABLE)
      .where({ id })
      .whereNot({ status: 'running' })
      .update({
        status: 'running',
        results: JSON.stringify(results),
        heartbeat_at: new Date(),
        finished_at: null,
        // Retrying puts the Hub sign-in block back if it was lifted.
        blocked: true
      })
    if (!changed) throw new OffboardError(409, 'OFFBOARD_RUNNING', 'This offboard is running.')
  })
  await logActivity({
    action: 'hub-offboard-retry',
    user: caller || null,
    collection: TABLE,
    item: String(id)
  })
  launch(id, deps)
  return (await readOffboard(id)) as OffboardRow
}

/** What the admin types to lift a block: the run's first email, else its person key. */
export function liftConfirmOf(row: Pick<OffboardRow, 'identity' | 'person_key' | 'id'>): string {
  return row.identity.emails[0] ?? row.person_key ?? String(row.id)
}

/**
 * Lifts THIS run's Hub sign-in block. The Hub account is made active again only when this run
 * suspended it, its suspension is still that one (status suspended and updated_at = the run's
 * marker: an administrator who suspended or edited the account since wins), and no other run of
 * the person is running or blocked — all judged and written in one transaction under the admin
 * lock. Otherwise the block is lifted and the account left as it is; the answer and the activity
 * row say which. Their accounts in the apps stay suspended. Needs the typed confirm.
 */
export async function liftOffboardBlock(
  id: number,
  caller: string,
  confirm: unknown
): Promise<OffboardRow & { hub_account_reactivated: boolean; hub_account_note: string }> {
  const row = await readOffboard(id)
  if (!row) throw new OffboardError(404, 'NOT_FOUND', 'Not found')
  const expected = liftConfirmOf(row)
  if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== expected.toLowerCase())
    throw new OffboardError(400, 'CONFIRM_REQUIRED', `Type ${expected} to lift the block`)
  const outcome = await underAdminLock(async (trx) => {
    const me = (await trx(TABLE)
      .where({ id })
      .first('status', 'hub_account', 'hub_suspended_at')) as
      | { status: string; hub_account: string | null; hub_suspended_at: unknown }
      | undefined
    if (!me) throw new OffboardError(404, 'NOT_FOUND', 'Not found')
    if (me.status === 'running')
      throw new OffboardError(409, 'OFFBOARD_RUNNING', 'Wait for the offboard to finish first.')
    await trx(TABLE)
      .where({ id })
      .update({ blocked: false, lifted_by: caller || null, lifted_at: new Date() })
    if (!row.hub_user_id || me.hub_account !== 'suspended') return 'not_ours' as const
    const others = row.person_key
      ? await trx(TABLE)
          .where({ person_key: row.person_key })
          .whereNot({ id })
          .where((w) => w.where({ status: 'running' }).orWhere('blocked', true))
          .first('id')
      : undefined
    if (others) return 'other_block' as const
    const user = (await trx('nivaro_users')
      .where({ id: row.hub_user_id })
      .first('status', 'updated_at')) as { status: string | null; updated_at: unknown } | undefined
    const at = (v: unknown) => {
      if (v == null) return Number.NaN
      const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v))
      return Math.floor(d.getTime() / 1000)
    }
    const ours =
      String(user?.status ?? '').toLowerCase() === 'suspended' &&
      at(me.hub_suspended_at) === at(user?.updated_at)
    if (!ours) return 'changed' as const
    await trx('nivaro_users')
      .where({ id: row.hub_user_id, status: 'suspended' })
      .update({ status: 'active', updated_at: new Date() })
    return 'reactivated' as const
  })
  const note = {
    reactivated: 'Hub sign-in block lifted; the Hub account is active again',
    not_ours: 'Hub sign-in block lifted; this offboard did not suspend a Hub account',
    other_block:
      'Hub sign-in block lifted; the Hub account stays suspended (another offboard of this person still blocks or runs)',
    changed:
      'Hub sign-in block lifted; the Hub account stays suspended (it was suspended or changed again since the offboard)'
  }[outcome]
  await logActivity({
    action: 'hub-offboard-lift',
    user: caller || null,
    collection: TABLE,
    item: String(id),
    comment: note
  })
  const fresh = (await readOffboard(id)) as OffboardRow
  return { ...fresh, hub_account_reactivated: outcome === 'reactivated', hub_account_note: note }
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
 * Whether the Hub must refuse this account's sign-in now (block.ts offboardBlocks: the run's
 * account or Microsoft id always; a listed email unless the account is a proven different,
 * older person with a Microsoft id of its own). Fails closed.
 */
export async function hubSigninBlocked(user: BlockSubject, deps: BlockDeps = {}): Promise<boolean> {
  return offboardBlocks(user, deps)
}

export { assertEmailNotOffboarded, EMAIL_OFFBOARDED, EmailOffboardedError } from './block.js'
