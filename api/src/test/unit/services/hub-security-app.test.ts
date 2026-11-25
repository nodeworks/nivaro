import Fastify from 'fastify'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub security, APP side: role holders for access reviews; break-glass grants in their own
// table (nivaro_break_glass_grants — nivaro_users is never altered): grant, revoke + tombstone,
// the app's own expiry, the request-time judgement, the last-admin count without grantees, the
// offboard of a grantee, the self-elevation guard, and access-review removals by account id.
// Real SQLite (roles, users, activity, migration 578); the activity log and sockets are mocked.

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
const m = vi.hoisted(() => ({
  logActivity: vi.fn(async (..._a: unknown[]) => null),
  endUserSockets: vi.fn(),
  recheck: vi.fn(),
  notice: vi.fn()
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: m.logActivity }))
vi.mock('../../../services/socket-access.js', () => ({
  endUserSockets: m.endUserSockets,
  requestAccessRecheck: m.recheck
}))
vi.mock('../../../services/inactive-people-notice.js', () => ({ noteUsersDeactivated: m.notice }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m578 = await import('../../../db/migrations/578_hub_security.js')
const sec = await import('../../../services/hub-link/security.js')
const people = await import('../../../services/hub-link/people.js')
const grants = await import('../../../services/break-glass-grants.js')
const { grantEnded, roleAfterGrant, grantEndsAt } = await import(
  '../../../services/break-glass-role.js'
)
const guard = await import('../../../services/break-glass-guard.js')
const { setAppRef } = await import('../../../services/io-holder.js')

/** A Redis with what the open-grants marker uses (get / set / compare-and-delete). */
function fakeRedis() {
  const map = new Map<string, string>()
  return {
    map,
    down: false,
    async get(k: string) {
      if (this.down) throw new Error('redis down')
      return map.get(k) ?? null
    },
    async set(k: string, v: string) {
      if (this.down) throw new Error('redis down')
      map.set(k, v)
      return 'OK'
    },
    async eval(_s: string, _n: number, k: string, v: string) {
      if (map.get(k) === v) map.delete(k)
      return 1
    }
  }
}
const redis = fakeRedis()
const HUB_TOKEN = 't'.repeat(40)

const ADMIN_ROLE = 'R-ADMIN'
const OPS_ADMIN = 'R-OPS'
const STAFF_ROLE = 'R-STAFF'
const ANA = 'U-ANA' // the one permanent admin
const BEN = 'U-BEN' // staff, will hold break-glass
const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const H = 3_600_000

beforeAll(async () => {
  process.env.HUB_TOKEN = HUB_TOKEN
  setAppRef({ redis })
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
  await db.schema.createTable('nivaro_activity', (t) => {
    t.increments('id')
    t.string('user')
    t.string('action')
    t.string('collection')
    t.string('item')
    t.dateTime('timestamp')
  })
  await m578.up(db)
  await m578.up(db) // every step is guarded
})
afterAll(async () => {
  delete process.env.HUB_TOKEN
  setAppRef(null)
  await db.destroy()
})
beforeEach(async () => {
  vi.clearAllMocks()
  grants._resetGrantsTableForTests()
  grants._resetMarkerForTests()
  redis.map.clear()
  redis.down = false
  process.env.HUB_TOKEN = HUB_TOKEN
  for (const t of ['nivaro_break_glass_grants', 'nivaro_activity', 'nivaro_users', 'nivaro_roles'])
    await db(t).delete()
  await db('nivaro_roles').insert([
    { id: ADMIN_ROLE, name: 'Administrator', admin_access: true, created_at: new Date(0) },
    { id: OPS_ADMIN, name: 'Ops Admin', admin_access: true, created_at: new Date(5) },
    { id: STAFF_ROLE, name: 'Staff', admin_access: false, created_at: new Date(1) }
  ])
  await db('nivaro_users').insert([
    {
      id: ANA,
      first_name: 'Ana',
      last_name: 'Admin',
      email: 'ana@example.com',
      role: ADMIN_ROLE,
      status: 'active',
      entra_oid: 'oid-ana'
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

const grant = (body: Record<string, unknown>, at = NOW) =>
  sec.grantBreakGlass({ hours: 2, reason: 'Outage fix', ...body }, { now: () => at })
const role = async (id: string) => (await db('nivaro_users').where({ id }).first()).role
const grantRow = (ref: string) => db('nivaro_break_glass_grants').where({ ref }).first()

describe('role holders', () => {
  it('every account with a role, admins first, never placeholders; oid included', async () => {
    const out = await sec.listRoleHolders()
    const ids = out.accounts.map((a) => a.user_id)
    expect(ids).toEqual(expect.arrayContaining([ANA, BEN, 'U-OFF', 'U-SVC']))
    expect(ids).not.toContain('U-PH')
    expect(ids).not.toContain('U-NOROLE')
    expect(out.accounts.find((a) => a.user_id === ANA)).toMatchObject({
      name: 'Ana Admin',
      entra_oid: 'oid-ana',
      admin: true
    })
  })
})

describe('the pure rules', () => {
  it('an unreadable end counts as ended; admin roles always come back; the app clock decides', () => {
    expect(grantEnded({ ends_at: null }, NOW)).toBe(true)
    expect(grantEnded({ ends_at: 'garbage' }, NOW)).toBe(true)
    expect(grantEnded({ ends_at: new Date(NOW + 1000).toISOString() }, NOW)).toBe(false)
    expect(roleAfterGrant({ id: ADMIN_ROLE, admin_access: true }, { role: ADMIN_ROLE })).toBe(
      'restore'
    )
    expect(roleAfterGrant({ id: OPS_ADMIN, admin_access: 1 }, { role: ADMIN_ROLE })).toBe('restore')
    expect(roleAfterGrant({ id: STAFF_ROLE, admin_access: false }, { role: ADMIN_ROLE })).toBe(
      'keep'
    )
    // A Hub clock 10 h ahead cannot stretch a 2 h grant.
    expect(grantEndsAt(2, NOW + 10 * H, NOW).getTime()).toBe(NOW + 2 * H)
    expect(grantEndsAt(2, NOW + H, NOW).getTime()).toBe(NOW + H)
  })
})

describe('break-glass grant', () => {
  it('swaps the role, keeps the grant in its own table, never touches nivaro_users otherwise', async () => {
    const out = await grant({
      ref: 'bg-7',
      emails: ['ben@example.com'],
      until: new Date(NOW + 9 * H).toISOString()
    })
    expect(out).toEqual({
      ok: true,
      state: 'granted',
      user_id: BEN,
      until: new Date(NOW + 2 * H).toISOString()
    })
    expect(await role(BEN)).toBe(ADMIN_ROLE)
    const row = await grantRow('bg-7')
    expect(row).toMatchObject({ user_id: BEN, role: ADMIN_ROLE, prev_role: STAFF_ROLE })
    expect(Object.keys(await db('nivaro_users').where({ id: BEN }).first())).not.toContain(
      'break_glass'
    )
    // The same ref again answers the grant that holds; another ref is refused.
    expect(await grant({ ref: 'bg-7', emails: ['ben@example.com'] })).toMatchObject({
      ok: true,
      state: 'granted'
    })
    expect(await grant({ ref: 'bg-8', emails: ['ben@example.com'] })).toMatchObject({
      ok: false,
      code: 'BREAK_GLASS_ACTIVE'
    })
  })

  it('M3: an Entra id must be the account’s own; email alone only when neither side has one', async () => {
    // The Hub knows an oid; the account has none → refused.
    expect(
      await grant({
        ref: 'bg-1',
        emails: ['ben@example.com'],
        entra: [{ oid: 'oid-ben', tid: null }]
      })
    ).toMatchObject({ ok: false, code: 'IDENTITY_MISMATCH' })
    // The account has an oid; the Hub knows none (email only) → refused.
    await db('nivaro_users').where({ id: BEN }).update({ entra_oid: 'oid-someone-else' })
    expect(await grant({ ref: 'bg-2', emails: ['ben@example.com'] })).toMatchObject({
      ok: false,
      code: 'IDENTITY_MISMATCH'
    })
    // Different oids → refused; the same oid → granted.
    expect(
      await grant({
        ref: 'bg-3',
        emails: ['ben@example.com'],
        entra: [{ oid: 'oid-ben', tid: null }]
      })
    ).toMatchObject({ ok: false, code: 'IDENTITY_MISMATCH' })
    await db('nivaro_users').where({ id: BEN }).update({ entra_oid: 'oid-ben' })
    expect(
      await grant({
        ref: 'bg-4',
        emails: ['ben@example.com'],
        entra: [{ oid: 'oid-ben', tid: null }]
      })
    ).toMatchObject({ ok: true, state: 'granted' })
  })

  it('refuses what it must never do, writing nothing', async () => {
    expect(await grant({ ref: 'bg-1', emails: ['off@example.com'] })).toMatchObject({
      ok: false,
      code: 'ACCOUNT_NOT_ACTIVE'
    })
    expect(await grant({ ref: 'bg-1', emails: ['svc@example.com'] })).toMatchObject({
      ok: false,
      code: 'NO_ACCOUNT'
    })
    expect(await grant({ ref: 'bg-1', emails: ['ben@example.com'], hours: 25 })).toMatchObject({
      ok: false,
      code: 'BAD_HOURS'
    })
    expect(await grant({ ref: 'x', emails: ['ben@example.com'] })).toMatchObject({
      ok: false,
      code: 'BAD_REF'
    })
    expect(await role(BEN)).toBe(STAFF_ROLE)
    expect(await db('nivaro_break_glass_grants').count({ n: '*' })).toEqual([{ n: 0 }])
  })

  it('an admin already is not touched', async () => {
    await db('nivaro_users').where({ id: ANA }).update({ entra_oid: null })
    expect(await grant({ ref: 'bg-2', emails: ['ana@example.com'] })).toMatchObject({
      ok: true,
      state: 'already_admin',
      user_id: ANA
    })
    expect(await grantRow('bg-2')).toBeUndefined()
  })

  it('M1: a revoke that came first leaves a tombstone; the late grant is refused and logged', async () => {
    expect(await sec.revokeBreakGlass({ ref: 'bg-9' })).toMatchObject({ ok: true, state: 'none' })
    expect(await grant({ ref: 'bg-9', emails: ['ben@example.com'] })).toMatchObject({
      ok: false,
      code: 'REF_ENDED'
    })
    expect(await role(BEN)).toBe(STAFF_ROLE)
    expect(m.logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'hub-break-glass-late' })
    )
  })
})

describe('break-glass end', () => {
  it('the Hub revokes by ref: role back, sockets end, the changes are counted', async () => {
    await grant({ ref: 'bg-3', emails: ['ben@example.com'] })
    await db('nivaro_activity').insert({
      user: BEN,
      collection: 'x',
      item: '1',
      timestamp: new Date(NOW + 60_000)
    })
    const out = await sec.revokeBreakGlass({ ref: 'bg-3', user_id: BEN })
    expect(out).toMatchObject({ ok: true, state: 'revoked', user_id: BEN, activity_count: 1 })
    expect(await role(BEN)).toBe(STAFF_ROLE)
    expect((await grantRow('bg-3')).ended_at).not.toBeNull()
    expect(m.endUserSockets).toHaveBeenCalledWith(BEN, expect.any(String))
    expect(m.recheck).toHaveBeenCalledWith({ userIds: [BEN] })
    // Idempotent.
    expect(await sec.revokeBreakGlass({ ref: 'bg-3' })).toMatchObject({
      ok: true,
      state: 'revoked'
    })
  })

  it('H1: a move to ANOTHER admin role is undone at the end, and who did it is named', async () => {
    await grant({ ref: 'bg-5', emails: ['ben@example.com'] })
    await db('nivaro_users').where({ id: BEN }).update({ role: OPS_ADMIN })
    await db('nivaro_activity').insert({
      user: BEN,
      collection: 'nivaro_users',
      item: BEN,
      timestamp: new Date(NOW + 60_000)
    })
    const out = await sec.revokeBreakGlass({ ref: 'bg-5' })
    expect(out).toMatchObject({
      state: 'restored_over_change',
      changed_by: 'Ben',
      changed_to: 'Ops Admin'
    })
    expect(await role(BEN)).toBe(STAFF_ROLE)
  })

  it('a change to a role WITHOUT admin access stays', async () => {
    await grant({ ref: 'bg-6', emails: ['ben@example.com'] })
    await db('nivaro_users').where({ id: BEN }).update({ role: 'R-OTHER' })
    expect(await sec.revokeBreakGlass({ ref: 'bg-6' })).toMatchObject({ state: 'role_changed' })
    expect(await role(BEN)).toBe('R-OTHER')
  })

  it('M7: the app ends a grant by itself (expired, or an unreadable end) — the Hub gone', async () => {
    await grant({ ref: 'bg-10', emails: ['ben@example.com'] })
    expect(await grants.expireGrants(db, new Date(NOW + H))).toEqual([])
    await db('nivaro_break_glass_grants').where({ ref: 'bg-10' }).update({ ends_at: null })
    expect(await grants.expireGrants(db, new Date(NOW + H))).toEqual([BEN])
    expect(await role(BEN)).toBe(STAFF_ROLE)
    expect(await grantRow('bg-10')).toMatchObject({
      end_reason: 'unreadable',
      end_state: 'restored'
    })
  })

  it('the request path judges it in the role statement before any job runs', async () => {
    await grant({ ref: 'bg-11', emails: ['ben@example.com'] })
    const live = await grants.effectiveRole({ id: BEN, role: ADMIN_ROLE }, db, NOW + 30 * 60_000)
    expect(live).toMatchObject({ roleId: ADMIN_ROLE, ended: null })
    expect(live.live?.ref).toBe('bg-11')
    expect((live.role as { admin_access?: unknown }).admin_access).toBeTruthy()
    // Past its end: the request runs with the role it replaced.
    const ended = await grants.effectiveRole({ id: BEN, role: ADMIN_ROLE }, db, NOW + 3 * H)
    expect(ended.roleId).toBe(STAFF_ROLE)
    expect(ended.ended?.ref).toBe('bg-11')
    // H1 at request time too: moved to another admin role → still the old role.
    const moved = await grants.effectiveRole({ id: BEN, role: OPS_ADMIN }, db, NOW + 3 * H)
    expect(moved.roleId).toBe(STAFF_ROLE)
    // An account with no grant reads its own role.
    expect((await grants.effectiveRole({ id: ANA, role: ADMIN_ROLE })).live).toBeNull()
  })
})

describe('H2: the last-admin count never counts a grantee', () => {
  it('the permanent admin cannot be removed while only a grantee would be left', async () => {
    await grant({ ref: 'bg-12', emails: ['ben@example.com'] })
    expect(await role(BEN)).toBe(ADMIN_ROLE)
    const out = await people.suspendPeople({ emails: ['ana@example.com'] })
    expect(out).toMatchObject({ ok: false, code: 'LAST_ADMIN' })
    expect((await db('nivaro_users').where({ id: ANA }).first()).status).toBe('active')
  })

  it('offboarding a grantee ends the grant first and is never refused because of it', async () => {
    await db('nivaro_users').where({ id: ANA }).update({ status: 'suspended' })
    await grant({ ref: 'bg-13', emails: ['ben@example.com'] })
    const out = await people.suspendPeople({ emails: ['ben@example.com'] })
    expect(out).toMatchObject({ ok: true, state: 'suspended' })
    const ben = await db('nivaro_users').where({ id: BEN }).first()
    expect(ben).toMatchObject({ status: 'suspended', role: STAFF_ROLE })
    expect(await grantRow('bg-13')).toMatchObject({ end_reason: 'offboarded' })
  })
})

describe('M4: an access-review removal suspends the reviewed account only', () => {
  it('by id, refused STALE when its email or Entra id changed since the review', async () => {
    await db('nivaro_users').insert({
      id: 'U-TWIN',
      email: 'ben@example.com',
      role: STAFF_ROLE,
      status: 'active'
    })
    const stale = await people.suspendPeople({
      user_ids: [BEN],
      expect: { email: 'ben@old.example', entra_oid: null }
    })
    expect(stale).toMatchObject({ ok: false, code: 'STALE' })
    const ok = await people.suspendPeople({
      user_ids: [BEN],
      expect: { email: 'ben@example.com', entra_oid: null },
      reason: 'access_review'
    })
    expect(ok).toMatchObject({ ok: true, state: 'suspended' })
    // The other account with the same email was not touched.
    expect((await db('nivaro_users').where({ id: 'U-TWIN' }).first()).status).toBe('active')
    // An id query needs `expect` and no emails.
    expect(people.readPeopleQuery({ user_ids: [BEN] })).toBeNull()
    expect(people.readPeopleQuery({ user_ids: [BEN], emails: ['a@b.c'], expect: {} })).toBeNull()
  })
})

describe('H1: a grantee cannot turn borrowed admin into lasting admin', () => {
  it('role, policy and account-role writes refuse BREAK_GLASS_ACTIVE while the grant holds', async () => {
    const app = Fastify()
    guard.installBreakGlassWriteGuard(app)
    const seen: string[] = []
    await app.register(
      async (f) => {
        const sign = async (req: { headers: Record<string, unknown>; breakGlass?: unknown }) => {
          req.breakGlass = req.headers['x-grant'] ? { ref: 'bg-1', ends_at: null } : null
        }
        f.patch('/users/:id', { preHandler: sign }, async () => {
          seen.push('patch-user')
          return { ok: true }
        })
        f.post('/roles', { preHandler: sign }, async () => ({ ok: true }))
        f.post('/roles/:id/simulate', { preHandler: sign }, async () => ({ ok: true }))
        f.post('/items/:collection', { preHandler: sign }, async () => ({ ok: true }))
      },
      { prefix: '/api' }
    )
    await app.ready()
    const as = (grantee: boolean) => (grantee ? { 'x-grant': '1' } : {})
    // Self-elevation: the grantee sets their own role to an admin role.
    const self = await app.inject({
      method: 'PATCH',
      url: `/api/users/${BEN}`,
      headers: as(true),
      payload: { role: OPS_ADMIN }
    })
    expect(self.statusCode).toBe(403)
    expect(self.json().code).toBe('BREAK_GLASS_ACTIVE')
    // Creating an admin role, or the same through /items.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/roles',
          headers: as(true),
          payload: { name: 'x', admin_access: true }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/items/nivaro_roles',
          headers: as(true),
          payload: { name: 'x' }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/items/nivaro_users',
          headers: as(true),
          payload: { email: 'a@b.c', role: ADMIN_ROLE }
        })
      ).statusCode
    ).toBe(403)
    // Deny by default: ANY account write (even a name) and any role route, the reads included.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/roles/r1/simulate',
          headers: as(true),
          payload: {}
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/users/${BEN}`,
          headers: as(true),
          payload: { first_name: 'B' }
        })
      ).statusCode
    ).toBe(403)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/users/${BEN}`,
          headers: as(false),
          payload: { role: OPS_ADMIN }
        })
      ).statusCode
    ).toBe(200)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/items/workflows',
          headers: as(true),
          payload: { role: 'x' }
        })
      ).statusCode
    ).toBe(200)
    await app.close()
  })
})

describe('the hot path (ruling: no join unless a grant may exist)', () => {
  const statements = async (fn: () => Promise<unknown>) => {
    const seen: string[] = []
    const on = (q: { sql: string }) => seen.push(q.sql)
    db.on('query', on)
    try {
      await fn()
    } finally {
      db.off('query', on)
    }
    return seen
  }
  const plain = () => db('nivaro_roles').where({ id: ADMIN_ROLE }).first().toSQL().sql

  it('a plain install (no HUB_TOKEN, not shared) issues exactly the old statement', async () => {
    delete process.env.HUB_TOKEN
    expect(grants.breakGlassPossible()).toBe(false)
    const sql = await statements(() => grants.effectiveRole({ id: ANA, role: ADMIN_ROLE }))
    expect(sql).toEqual([plain()])
    expect(await grants.expireGrants()).toEqual([])
  })

  it('linked, marker says none: the old statement; a grant elsewhere is honoured within 5 s', async () => {
    const t0 = Date.now()
    expect(
      await statements(() => grants.effectiveRole({ id: BEN, role: STAFF_ROLE }, db, t0))
    ).toEqual([plain().replace(ADMIN_ROLE, STAFF_ROLE)])
    // Another replica grants: its marker + row land; this process still holds "none" briefly.
    await db('nivaro_break_glass_grants').insert({
      ref: 'bg-77',
      user_id: BEN,
      role: ADMIN_ROLE,
      prev_role: STAFF_ROLE,
      granted_at: new Date(t0),
      ends_at: new Date(t0 + 60_000)
    })
    await db('nivaro_users').where({ id: BEN }).update({ role: ADMIN_ROLE })
    redis.map.set(grants.openGrantsKey(), 'x')
    const soon = await grants.effectiveRole({ id: BEN, role: ADMIN_ROLE }, db, t0 + 1000)
    expect(soon.live).toBeNull()
    const later = await grants.effectiveRole(
      { id: BEN, role: ADMIN_ROLE },
      db,
      t0 + grants.MARKER_TTL_MS + 1
    )
    expect(later.live?.ref).toBe('bg-77')
  })

  it('an unknown marker (Redis down) joins — fail closed', async () => {
    redis.down = true
    await db('nivaro_break_glass_grants').insert({
      ref: 'bg-78',
      user_id: BEN,
      role: ADMIN_ROLE,
      prev_role: STAFF_ROLE,
      granted_at: new Date(NOW),
      ends_at: new Date(NOW + H)
    })
    expect(await grants.openGrantsMarker()).toBe('unknown')
    const r = await grants.effectiveRole({ id: BEN, role: ADMIN_ROLE }, db, NOW + 2 * H)
    expect(r.roleId).toBe(STAFF_ROLE)
    // And no grant can be made while the marker cannot be stored.
    expect(await grant({ ref: 'bg-79', emails: ['ana@example.com'] })).toMatchObject({
      ok: false,
      code: 'MARKER_UNAVAILABLE'
    })
  })

  it('a grant sets the marker before it answers; the last end clears it; expiry ignores it', async () => {
    expect(await grant({ ref: 'bg-80', emails: ['ben@example.com'] })).toMatchObject({
      state: 'granted'
    })
    expect(redis.map.get(grants.openGrantsKey())).toBeTruthy()
    // The marker lost (a Redis restart): the expiry job still restores, and re-asserts it first.
    redis.map.clear()
    grants._resetMarkerForTests()
    expect(await grants.expireGrants(db, new Date(NOW + 3 * H))).toEqual([BEN])
    expect(await role(BEN)).toBe(STAFF_ROLE)
    // No grant left open: the marker is cleared.
    expect(redis.map.get(grants.openGrantsKey())).toBeUndefined()
  })
})

describe('second review: nothing a grantee makes outlasts the grant', () => {
  it('a grantee minting a token for another admin is refused', async () => {
    const app = Fastify()
    guard.installBreakGlassWriteGuard(app)
    await app.register(
      async (f) => {
        const sign = async (req: { breakGlass?: unknown }) => {
          req.breakGlass = { ref: 'bg-1', ends_at: null }
        }
        f.post('/users/:id/token', { preHandler: sign }, async () => ({ token: 'x' }))
        f.post('/api-keys', { preHandler: sign }, async () => ({ key: 'x' }))
        f.post('/user-groups/:id/members', { preHandler: sign }, async () => ({ ok: true }))
        f.delete('/api-keys/:id', { preHandler: sign }, async () => ({ ok: true }))
        f.patch('/users/me/preferences', { preHandler: sign }, async () => ({ ok: true }))
      },
      { prefix: '/api' }
    )
    await app.ready()
    const mint = await app.inject({ method: 'POST', url: `/api/users/${ANA}/token` })
    expect(mint.statusCode).toBe(403)
    expect(mint.json()).toMatchObject({ code: 'BREAK_GLASS_ACTIVE' })
    expect(
      (await app.inject({ method: 'POST', url: '/api/api-keys', payload: { name: 'k' } }))
        .statusCode
    ).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: '/api/user-groups/1/members', payload: {} }))
        .statusCode
    ).toBe(403)
    expect((await app.inject({ method: 'DELETE', url: '/api/api-keys/3' })).statusCode).toBe(200)
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/users/me/preferences',
          payload: { theme: 'dark' }
        })
      ).statusCode
    ).toBe(200)
    await app.close()
  })

  it('a key or token made during the grant (by any path) is revoked at its end', async () => {
    await db.schema.createTable('nivaro_api_keys', (t) => {
      t.increments('id')
      t.string('name')
      t.string('user')
      t.boolean('is_active')
      t.dateTime('created_at')
    })
    await db.schema.alterTable('nivaro_users', (t) => t.string('static_token'))
    try {
      await grant({ ref: 'bg-90', emails: ['ben@example.com'] })
      const during = new Date(NOW + 10 * 60_000)
      // A key for ANOTHER admin, made by the grantee; one the grantee owns; one from before.
      const [k1] = await db('nivaro_api_keys')
        .insert({ name: 'for ana', user: ANA, is_active: true, created_at: during })
        .returning('id')
      await db('nivaro_api_keys').insert({
        name: 'own',
        user: BEN,
        is_active: true,
        created_at: during
      })
      await db('nivaro_api_keys').insert({
        name: 'old',
        user: ANA,
        is_active: true,
        created_at: new Date(0)
      })
      const id1 = typeof k1 === 'object' ? (k1 as { id: number }).id : k1
      await db('nivaro_activity').insert([
        {
          user: BEN,
          action: 'api_key_created',
          collection: 'nivaro_api_keys',
          item: String(id1),
          timestamp: during
        },
        {
          user: BEN,
          action: 'token.generate',
          collection: 'nivaro_users',
          item: ANA,
          timestamp: during
        }
      ])
      await db('nivaro_users').where({ id: ANA }).update({ static_token: 'minted-by-ben' })
      const out = await sec.revokeBreakGlass({ ref: 'bg-90' })
      expect(out).toMatchObject({
        state: 'revoked',
        revoked_credentials: { api_keys: 2, static_tokens: 1, connections: 0 }
      })
      const keys = await db('nivaro_api_keys').orderBy('id').select('name', 'is_active')
      expect(keys.map((k) => [k.name, !!k.is_active])).toEqual([
        ['for ana', false],
        ['own', false],
        ['old', true]
      ])
      expect((await db('nivaro_users').where({ id: ANA }).first()).static_token).toBeNull()
    } finally {
      await db.schema.dropTable('nivaro_api_keys')
    }
  })
})
