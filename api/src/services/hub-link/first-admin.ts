import { randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import { whereEqualsCi } from '../../db/dialect/h2.js'
import { db } from '../../db/index.js'
import { nullsOrder } from '../../db/sql-dialect.js'
import { logActivity } from '../activity.js'
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
 *  - a person has that email → they move to that role (and are made active): `created: false`.
 * Once an admin exists every call answers 409 HAS_ADMIN and writes nothing (the Hub's creation
 * runner reads that as done). No admin role at all = 409 NO_ADMIN_ROLE.
 *
 * Exactly one call wins, however many race: calls run one at a time in this process, and the
 * check + write run in ONE transaction that first locks the oldest admin role row (`forUpdate`:
 * SQL Server UPDLOCK, Postgres/MySQL FOR UPDATE; SQLite transactions are BEGIN IMMEDIATE, one
 * writer). Every caller locks that same row, so a second process waits until the first commits
 * and then sees its admin. The activity row ('hub-first-admin', collection nivaro_users, user
 * null) is written after the commit. The request's bearer never reaches this module.
 */

export type SeedFirstAdminResult =
  | { ok: true; created: boolean; user_id: string }
  | {
      ok: false
      status: 400 | 409
      code: 'BAD_EMAIL' | 'HAS_ADMIN' | 'NO_ADMIN_ROLE'
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

type Outcome =
  | { kind: 'done'; created: boolean; user_id: string; role: string; fromRole: string | null }
  | { kind: 'refused'; code: 'HAS_ADMIN' | 'NO_ADMIN_ROLE' | 'BAD_EMAIL' }

async function seedInTransaction(k: Knex, input: CleanInput): Promise<Outcome> {
  return k.transaction(async (trx) => {
    const role = (await oldestAdminRoleQuery(trx)) as { id: unknown } | undefined
    if (!role?.id) return { kind: 'refused', code: 'NO_ADMIN_ROLE' } as const
    if (await firstActiveAdmin(trx)) return { kind: 'refused', code: 'HAS_ADMIN' } as const
    const roleId = String(role.id)
    const now = new Date()

    const matches = (await whereEqualsCi(trx('nivaro_users'), trx, 'email', input.email).select(
      'id',
      'role',
      'account_kind'
    )) as Array<{
      id: unknown
      role: unknown
      account_kind: unknown
    }>
    // A person first (Postgres compares email case-sensitively in its unique index, so case
    // twins can exist there); an address held only by a service / placeholder account is not
    // one a person can sign in with as this administrator.
    const person = matches.find((m) => m.account_kind == null)
    if (person) {
      await trx('nivaro_users')
        .where('id', person.id as string)
        .update({ role: roleId, status: 'active', updated_at: now })
      return {
        kind: 'done',
        created: false,
        user_id: String(person.id),
        role: roleId,
        fromRole: person.role == null ? null : String(person.role)
      } as const
    }
    if (matches.length > 0) return { kind: 'refused', code: 'BAD_EMAIL' } as const

    const id = randomUUID()
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
    return { kind: 'done', created: true, user_id: id, role: roleId, fromRole: null } as const
  })
}

const MESSAGES = {
  BAD_EMAIL: 'email must be an address (up to 255 characters) a person can sign in with',
  HAS_ADMIN: 'This app already has an administrator',
  NO_ADMIN_ROLE: 'This app has no role with admin access'
} as const

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
  // A new administrator is a security event (as POST /users and a role change raise it).
  noteUserRoleChange({
    actor: null,
    userId: out.user_id,
    fromRole: out.fromRole,
    toRole: out.role,
    created: out.created
  })
  return { ok: true, created: out.created, user_id: out.user_id }
}
