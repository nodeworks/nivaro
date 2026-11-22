import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { whereEqualsCi } from '../../db/dialect/h2.js'
import { db } from '../../db/index.js'
import { rawRows } from '../../db/raw-rows.js'
import { nullsOrder, sqlDialect } from '../../db/sql-dialect.js'
import { logActivity } from '../activity.js'
import { ADMINISTRATOR_ROLE_NAME, insertAdministratorRole } from '../admin-role.js'
import { noteUserRoleChange } from '../security-alerts.js'

/**
 * Hub link (app side, phase 3): the first administrator of an app the Nivaro Hub created.
 *
 *   POST /api/hub-link/first-admin {email, first_name?, last_name?} (routes/hub-link.ts)
 *
 * Works ONLY while the app has no active admin person: an active person (`account_kind` null)
 * whose role has `admin_access` (the same rule as infra-drift/store.ts activeAdminIds). Then:
 *  - no user has that email → one is created: role = the oldest role with `admin_access`,
 *    `status` active, no `external_id` (the first Microsoft sign-in links it by email);
 *  - a person has that email → they move to that role, `created: false`. A person not yet started
 *    (draft / invited / pending / unverified) is made active; one disabled on purpose
 *    (suspended, archived, inactive, redacted …) is refused 409 PERSON_DISABLED and nothing is
 *    written; case twins (Postgres) resolve to the exact spelling, else 409 AMBIGUOUS_EMAIL.
 * Once an admin exists every call answers 409 HAS_ADMIN and writes nothing (the Hub's creation
 * runner reads that as done). An install with no admin role at all (a fresh database: migrations
 * seed no roles) first gets an Administrator role (admin + app access, insertAdministratorRole,
 * the same as cloud provisioning), in the same transaction (ruling P3-33).
 *
 * Exactly one call wins, however many race: calls run one at a time in this process, and the
 * check + write run in ONE transaction that first locks the oldest admin role row (`forUpdate`:
 * SQL Server UPDLOCK, Postgres/MySQL FOR UPDATE; SQLite transactions are BEGIN IMMEDIATE, one
 * writer). Every caller locks that same row, so a second process waits until the first commits
 * and then sees its admin; the wait is bounded (FIRST_ADMIN_LOCK_WAIT_MS, then a 500). The
 * activity row ('hub-first-admin', collection nivaro_users, user null) and the security alert
 * (source 'hub', on every create, move or activation) come after the commit. The request's
 * bearer never reaches this module.
 */

export type SeedFirstAdminResult =
  | { ok: true; created: boolean; user_id: string }
  | {
      ok: false
      status: 400 | 409
      code: 'BAD_EMAIL' | 'HAS_ADMIN' | 'NO_ADMIN_ROLE' | 'PERSON_DISABLED' | 'AMBIGUOUS_EMAIL'
      message: string
    }

/** nivaro_users.email is varchar(255): longer cannot be stored (the address limit is 320). */
export const FIRST_ADMIN_EMAIL_MAX = 255
const NAME_MAX = 255
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/

interface CleanInput {
  email: string
  first_name: string | null
  last_name: string | null
}

function cleanName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim().slice(0, NAME_MAX)
  return t ? t : null
}

function cleanInput(input: unknown): CleanInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const body = input as Record<string, unknown>
  if (typeof body.email !== 'string') return null
  const email = body.email.trim()
  if (!email || email.length > FIRST_ADMIN_EMAIL_MAX || !EMAIL_RE.test(email)) return null
  return { email, first_name: cleanName(body.first_name), last_name: cleanName(body.last_name) }
}

/**
 * The oldest role with admin access, locked for the rest of the transaction. Exported for the
 * per-engine SQL test (the lock is what makes concurrent calls take turns across processes).
 */
export function oldestAdminRoleQuery(k: Knex) {
  return k('nivaro_roles')
    .where('admin_access', true)
    .orderByRaw(`?? asc${nullsOrder(k, 'asc')}, ?? asc`, ['created_at', 'id'])
    .forUpdate()
    .first('id')
}

/**
 * The Administrator role of an install that has no admin role yet. "Administrator" may be taken
 * by a role without admin access (names are unique): the role is then "Administrator (Hub)".
 */
async function makeAdministratorRole(trx: Knex.Transaction): Promise<string> {
  const taken = await trx('nivaro_roles').where('name', ADMINISTRATOR_ROLE_NAME).first('id')
  return insertAdministratorRole(trx, taken ? { name: `${ADMINISTRATOR_ROLE_NAME} (Hub)` } : {})
}

/** First active admin person, or undefined (activeAdminIds' rule, first row only). */
function firstActiveAdmin(k: Knex) {
  return k('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .first('u.id')
}

// One call at a time in this process (the transaction's row lock covers other processes).
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** How long the role-row lock is waited for before the call fails (a 500, the Hub retries). */
export const FIRST_ADMIN_LOCK_WAIT_MS = 10_000

/**
 * Runs `fn` with a bounded lock wait on the transaction's connection: Postgres `SET LOCAL
 * lock_timeout` (ends with the transaction); SQL Server `SET LOCK_TIMEOUT` and MySQL/MariaDB
 * `innodb_lock_wait_timeout` are per session, so the previous value is read first and put back
 * on both paths (the pooled connection goes back unchanged). SQLite: busy_timeout already.
 * Only integers reach the SQL text.
 */
export async function withLockWait<T>(trx: Knex.Transaction, fn: () => Promise<T>): Promise<T> {
  const d = sqlDialect(trx)
  if (d === 'pg') {
    await trx.raw(`SET LOCAL lock_timeout = '${Math.round(FIRST_ADMIN_LOCK_WAIT_MS / 1000)}s'`)
    return fn()
  }
  if (d !== 'mssql' && d !== 'mysql') return fn()
  const read =
    d === 'mssql' ? 'SELECT @@LOCK_TIMEOUT AS t' : 'SELECT @@SESSION.innodb_lock_wait_timeout AS t'
  const before = Number(rawRows<{ t: unknown }>(await trx.raw(read))[0]?.t)
  const set = (v: number) =>
    d === 'mssql'
      ? `SET LOCK_TIMEOUT ${Math.trunc(v)}`
      : `SET SESSION innodb_lock_wait_timeout = ${Math.trunc(v)}`
  const restore = Number.isSafeInteger(before) ? before : d === 'mssql' ? -1 : 50
  await trx.raw(set(d === 'mssql' ? FIRST_ADMIN_LOCK_WAIT_MS : FIRST_ADMIN_LOCK_WAIT_MS / 1000))
  try {
    return await fn()
  } finally {
    await Promise.resolve(trx.raw(set(restore))).catch(() => undefined)
  }
}

/** Statuses of a person not yet started (a draft or an invitation): the Hub may activate them.
 *  Every other status but 'active' (suspended, archived, inactive, disabled …) was set by
 *  someone on purpose and is never undone over the link. */
const ONBOARDING_STATUSES = new Set(['draft', 'invited', 'pending', 'unverified'])

type RefusedCode =
  | 'HAS_ADMIN'
  | 'NO_ADMIN_ROLE'
  | 'BAD_EMAIL'
  | 'PERSON_DISABLED'
  | 'AMBIGUOUS_EMAIL'

type Outcome =
  | {
      kind: 'done'
      created: boolean
      user_id: string
      role: string
      fromRole: string | null
    }
  | { kind: 'refused'; code: RefusedCode }

interface MatchRow {
  id: unknown
  email: unknown
  role: unknown
  status: unknown
  account_kind: unknown
  is_redacted: unknown
}

async function seedInTransaction(k: Knex, input: CleanInput): Promise<Outcome> {
  return k.transaction((trx) =>
    withLockWait(trx, async (): Promise<Outcome> => {
      const role = (await oldestAdminRoleQuery(trx)) as { id: unknown } | undefined
      if (role?.id && (await firstActiveAdmin(trx))) return { kind: 'refused', code: 'HAS_ADMIN' }
      // A fresh install has no roles at all: the Administrator role is made here, in the same
      // transaction as the person and only right before the person is written (a refusal writes
      // nothing), the way cloud provisioning makes it (ruling P3-33).
      const adminRole = async () => (role?.id ? String(role.id) : makeAdministratorRole(trx))
      const now = new Date()

      const matches = (await whereEqualsCi(trx('nivaro_users'), trx, 'email', input.email).select(
        'id',
        'email',
        'role',
        'status',
        'account_kind',
        'is_redacted'
      )) as MatchRow[]
      // People first; an address held only by a service / placeholder account is not one a
      // person can sign in with as this administrator. Postgres compares email case-sensitively
      // in its unique index, so case twins can exist there: the exact spelling wins, else the
      // address is ambiguous.
      const people = matches.filter((m) => m.account_kind == null)
      if (people.length === 0) {
        if (matches.length > 0) return { kind: 'refused', code: 'BAD_EMAIL' }
        const id = randomUUID()
        const roleId = await adminRole()
        await trx('nivaro_users').insert({
          id,
          email: input.email,
          first_name: input.first_name,
          last_name: input.last_name,
          role: roleId,
          status: 'active',
          external_id: null,
          created_at: now,
          updated_at: now
        })
        return { kind: 'done', created: true, user_id: id, role: roleId, fromRole: null }
      }
      const person =
        people.length === 1 ? people[0] : people.find((m) => String(m.email) === input.email)
      if (!person) return { kind: 'refused', code: 'AMBIGUOUS_EMAIL' }

      const status = String(person.status ?? '')
        .trim()
        .toLowerCase()
      const redacted = person.is_redacted === true || Number(person.is_redacted) === 1
      if (redacted || (status !== 'active' && !ONBOARDING_STATUSES.has(status))) {
        return { kind: 'refused', code: 'PERSON_DISABLED' }
      }
      const activated = status !== 'active'
      const roleId = await adminRole()
      await trx('nivaro_users')
        .where('id', person.id as string)
        .update({ role: roleId, ...(activated ? { status: 'active' } : {}), updated_at: now })
      const previous = person.role == null ? null : String(person.role)
      return {
        kind: 'done',
        created: false,
        user_id: String(person.id),
        role: roleId,
        // A person who was not active held no access through that role: the alert reads
        // "from no role", so it fires even when the role itself is unchanged.
        fromRole: activated ? null : previous
      }
    })
  )
}

const MESSAGES: Record<RefusedCode, string> = {
  BAD_EMAIL: 'email must be an address (up to 255 characters) a person can sign in with',
  HAS_ADMIN: 'This app already has an administrator',
  NO_ADMIN_ROLE: 'This app has no role with admin access',
  PERSON_DISABLED:
    'The person with that email was suspended or archived here; an administrator of this app must restore them',
  AMBIGUOUS_EMAIL: 'More than one person has that email in a different case; give the exact one'
}

export async function seedFirstAdmin(input: unknown, k: Knex = db): Promise<SeedFirstAdminResult> {
  const clean = cleanInput(input)
  if (!clean) return { ok: false, status: 400, code: 'BAD_EMAIL', message: MESSAGES.BAD_EMAIL }

  const out = await serialized(() => seedInTransaction(k, clean))
  if (out.kind === 'refused') {
    const status = out.code === 'BAD_EMAIL' ? 400 : 409
    return { ok: false, status, code: out.code, message: MESSAGES[out.code] }
  }

  await logActivity({
    action: 'hub-first-admin',
    user: null,
    collection: 'nivaro_users',
    item: out.user_id,
    comment: out.created
      ? 'Created by the Nivaro Hub as the first administrator'
      : 'Made the first administrator by the Nivaro Hub',
    origin: 'integration'
  })
  // A new administrator is always a security event (as POST /users and a role change raise it).
  noteUserRoleChange({
    actor: null,
    source: 'hub',
    userId: out.user_id,
    fromRole: out.fromRole,
    toRole: out.role,
    created: out.created
  })
  return { ok: true, created: out.created, user_id: out.user_id }
}
