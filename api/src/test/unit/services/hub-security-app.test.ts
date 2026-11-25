import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub security, APP side (services/hub-link/security.ts + services/break-glass-role.ts): role
// holders for access reviews, break-glass grant / revoke / the app's own expiry. Real SQLite with
// the app's users + roles and migration 578's nivaro_users.break_glass column.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
const m = vi.hoisted(() => ({ logActivity: vi.fn(async (..._a: unknown[]) => null) }))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m578 = await import('../../../db/migrations/578_hub_security.js')
const sec = await import('../../../services/hub-link/security.js')
const { breakGlassRoleFor, readBreakGlassMark } = await import(
  '../../../services/break-glass-role.js'
)

const ADMIN_ROLE = 'R-ADMIN'
const STAFF_ROLE = 'R-STAFF'
const ANA = 'U-ANA'
const BEN = 'U-BEN'
const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const until = (h: number) => new Date(NOW + h * 3_600_000).toISOString()

beforeAll(async () => {
  await db.schema.createTable('nivaro_roles', (t) => {
    t.string('id').primary()
    t.string('name')
    t.boolean('admin_access')
    t.dateTime('created_at')
  })
  await db.schema.createTable('nivaro_users', (t) => {
    t.string('id').primary()
    t.string('first_name')
    t.string('last_name')
    t.string('email')
    t.string('role')
    t.string('status')
    t.string('account_kind')
    t.string('entra_oid')
    t.string('entra_tid')
    t.dateTime('last_access')
    t.dateTime('created_at')
    t.dateTime('updated_at')
  })
  await m578.up(db)
  // Twice: every step is guarded.
  await m578.up(db)
})
afterAll(async () => {
  await db.destroy()
})
beforeEach(async () => {
  vi.clearAllMocks()
  await db('nivaro_users').delete()
  await db('nivaro_roles').delete()
  await db('nivaro_roles').insert([
    { id: ADMIN_ROLE, name: 'Administrator', admin_access: true, created_at: new Date(0) },
    { id: STAFF_ROLE, name: 'Staff', admin_access: false, created_at: new Date(1) }
  ])
  await db('nivaro_users').insert([
    {
      id: ANA,
      first_name: 'Ana',
      last_name: 'Admin',
      email: 'ana@example.com',
      role: ADMIN_ROLE,
      status: 'active'
    },
    { id: BEN, first_name: 'Ben', email: 'ben@example.com', role: STAFF_ROLE, status: 'active' },
    { id: 'U-OFF', email: 'off@example.com', role: STAFF_ROLE, status: 'suspended' },
    {
      id: 'U-SVC',
      email: 'svc@example.com',
      role: ADMIN_ROLE,
      status: 'active',
      account_kind: 'service'
    },
    {
      id: 'U-PH',
      email: 'ph@example.com',
      role: STAFF_ROLE,
      status: 'active',
      account_kind: 'placeholder'
    },
    { id: 'U-NOROLE', email: 'none@example.com', role: null, status: 'active' }
  ])
})

const grant = (body: Record<string, unknown>) => sec.grantBreakGlass(body, { now: () => NOW })

describe('role holders', () => {
  it('lists every account with a role, admins first, never placeholders or role-less ones', async () => {
    const out = await sec.listRoleHolders()
    const ids = out.accounts.map((a) => a.user_id)
    expect(ids).toEqual(expect.arrayContaining([ANA, BEN, 'U-OFF', 'U-SVC']))
    expect(ids).not.toContain('U-PH')
    expect(ids).not.toContain('U-NOROLE')
    expect(out.accounts.slice(0, 2).every((a) => a.admin)).toBe(true)
    const ana = out.accounts.find((a) => a.user_id === ANA)
    expect(ana).toMatchObject({
      name: 'Ana Admin',
      role: 'Administrator',
      email: 'ana@example.com'
    })
    expect(out.accounts.find((a) => a.user_id === 'U-SVC')?.kind).toBe('service')
    // No credential or preference column is ever answered.
    expect(Object.keys(ana ?? {}).sort()).toEqual(
      [
        'admin',
        'break_glass_until',
        'created_at',
        'email',
        'kind',
        'last_access',
        'name',
        'role',
        'status',
        'user_id'
      ].sort()
    )
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-access-review-read' })
    )
  })
})

describe('break-glass grant', () => {
  it('swaps the role to the oldest admin role and stores the expiry on the account', async () => {
    const out = await grant({
      ref: 'bg-7',
      emails: ['ben@example.com'],
      until: until(2),
      reason: 'Outage fix'
    })
    expect(out).toEqual({ ok: true, state: 'granted', user_id: BEN, until: until(2) })
    const row = await db('nivaro_users').where({ id: BEN }).first()
    expect(row.role).toBe(ADMIN_ROLE)
    expect(readBreakGlassMark(row.break_glass)).toMatchObject({
      ref: 'bg-7',
      role: ADMIN_ROLE,
      prev_role: STAFF_ROLE
    })
    // The same ref again answers the grant that holds; another ref is refused.
    expect(
      await grant({ ref: 'bg-7', emails: ['ben@example.com'], until: until(3), reason: 'again' })
    ).toMatchObject({
      ok: true,
      until: until(2)
    })
    expect(
      await grant({ ref: 'bg-8', emails: ['ben@example.com'], until: until(1), reason: 'x' })
    ).toMatchObject({
      ok: false,
      code: 'BREAK_GLASS_ACTIVE'
    })
  })

  it('refuses what it must never do', async () => {
    expect(
      await grant({ ref: 'bg-1', emails: ['off@example.com'], until: until(1), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'ACCOUNT_NOT_ACTIVE'
    })
    expect(
      await grant({ ref: 'bg-1', emails: ['svc@example.com'], until: until(1), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'NO_ACCOUNT'
    })
    expect(
      await grant({ ref: 'bg-1', emails: ['nobody@example.com'], until: until(1), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'NO_ACCOUNT'
    })
    expect(
      await grant({ ref: 'bg-1', emails: ['ben@example.com'], until: until(26), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'TOO_LONG'
    })
    expect(
      await grant({ ref: 'bg-1', emails: ['ben@example.com'], until: until(-1), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'BAD_UNTIL'
    })
    expect(
      await grant({ ref: 'x', emails: ['ben@example.com'], until: until(1), reason: 'r' })
    ).toMatchObject({
      ok: false,
      code: 'BAD_REF'
    })
    // Nothing was written by any refusal.
    expect((await db('nivaro_users').where({ id: BEN }).first()).role).toBe(STAFF_ROLE)
    expect((await db('nivaro_users').where({ id: 'U-OFF' }).first()).status).toBe('suspended')
  })

  it('an admin already is not touched', async () => {
    expect(
      await grant({ ref: 'bg-2', emails: ['ana@example.com'], until: until(1), reason: 'r' })
    ).toEqual({
      ok: true,
      state: 'already_admin',
      user_id: ANA,
      until: null
    })
    expect((await db('nivaro_users').where({ id: ANA }).first()).break_glass).toBeNull()
  })
})

describe('break-glass end', () => {
  it('the Hub revokes by ref + account (role back), and a second revoke answers none', async () => {
    await grant({ ref: 'bg-3', emails: ['ben@example.com'], until: until(2), reason: 'r' })
    expect(await sec.revokeBreakGlass({ ref: 'bg-4', user_id: BEN })).toEqual({
      ok: true,
      state: 'none'
    })
    expect(await sec.revokeBreakGlass({ ref: 'bg-3', user_id: BEN })).toEqual({
      ok: true,
      state: 'revoked'
    })
    const row = await db('nivaro_users').where({ id: BEN }).first()
    expect(row.role).toBe(STAFF_ROLE)
    expect(row.break_glass).toBeNull()
    expect(await sec.revokeBreakGlass({ ref: 'bg-3', user_id: BEN })).toEqual({
      ok: true,
      state: 'none'
    })
  })

  it('revokes by identity when the Hub never learned the account id', async () => {
    await grant({ ref: 'bg-5', emails: ['ben@example.com'], until: until(2), reason: 'r' })
    expect(await sec.revokeBreakGlass({ ref: 'bg-5', emails: ['ben@example.com'] })).toEqual({
      ok: true,
      state: 'revoked'
    })
  })

  it('a role changed during the grant stays as it is', async () => {
    await grant({ ref: 'bg-6', emails: ['ben@example.com'], until: until(2), reason: 'r' })
    await db('nivaro_users').where({ id: BEN }).update({ role: 'R-OTHER' })
    expect(await sec.revokeBreakGlass({ ref: 'bg-6', user_id: BEN })).toEqual({
      ok: true,
      state: 'role_changed'
    })
    expect((await db('nivaro_users').where({ id: BEN }).first()).role).toBe('R-OTHER')
  })

  it('the app ends a grant by itself once its time ran out (the Hub gone)', async () => {
    await grant({ ref: 'bg-9', emails: ['ben@example.com'], until: until(1), reason: 'r' })
    expect(await sec.expireBreakGlass({ now: () => NOW + 30 * 60_000 })).toEqual([])
    expect(await sec.expireBreakGlass({ now: () => NOW + 61 * 60_000 })).toEqual([BEN])
    const row = await db('nivaro_users').where({ id: BEN }).first()
    expect(row.role).toBe(STAFF_ROLE)
    expect(row.break_glass).toBeNull()
  })

  it('every request judges the mark before any job runs (read-time fail-safe)', async () => {
    await grant({ ref: 'bg-10', emails: ['ben@example.com'], until: until(1), reason: 'r' })
    const row = await db('nivaro_users').where({ id: BEN }).first()
    expect(breakGlassRoleFor(row, NOW + 10 * 60_000)).toEqual({ role: ADMIN_ROLE, expired: false })
    expect(breakGlassRoleFor(row, NOW + 61 * 60_000)).toEqual({ role: STAFF_ROLE, expired: true })
    // A role changed on purpose during the grant is kept.
    expect(breakGlassRoleFor({ ...row, role: 'R-OTHER' }, NOW + 61 * 60_000)).toEqual({
      role: 'R-OTHER',
      expired: true
    })
    expect(breakGlassRoleFor({ role: STAFF_ROLE, break_glass: 'not json' })).toEqual({
      role: STAFF_ROLE,
      expired: false
    })
  })
})
