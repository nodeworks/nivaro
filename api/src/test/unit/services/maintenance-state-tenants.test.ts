import { beforeEach, describe, expect, it, vi } from 'vitest'

// Ruling P5-6: maintenanceState() cached ONE state for the whole process. In cloud and on a Hub
// shared deployment, one app's maintenance mode (or its absence) answered for another for up to
// 15 s, and a read could return another tenant's entry written while it awaited. The cache is
// now per tenant, and each call returns the state it computed. Self-hosted keeps one entry.

// The suite's setup mocks db/index.js with a plain vi.fn(); here `db` resolves the tenant's own
// database the way the real proxy does (a tenant context always wins).
vi.mock('../../../db/index.js', async () => {
  const tc = await import('../../../db/tenant-context.js')
  // biome-ignore lint/suspicious/noExplicitAny: test double of the knex proxy
  const db = (...args: unknown[]) => (tc.getTenantDb() as any)(...args)
  return { db, _staticDb: db, _backgroundDb: null, resolveDb: () => db }
})
vi.mock('../../../services/maintenance-live.js', () => ({
  observeMaintenance: () => {},
  recheckMaintenanceSoon: () => {}
}))

const { bustMaintenanceCache, maintenanceState } = await import('../../../services/security.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

/** A tenant database whose settings row says maintenance `on`, answering after `delayMs`. */
function tenantDb(on: boolean, delayMs: number, reads: { n: number }) {
  const chain = {
    where: () => chain,
    first: async () => {
      reads.n++
      await new Promise((r) => setTimeout(r, delayMs))
      return { maintenance_mode: on, maintenance_message: on ? 'Upgrading' : null }
    },
    catch: () => chain
  }
  return (() => chain) as never
}

function asTenant<T>(id: string, knex: never, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(knex, id.toLowerCase(), () => void fn().then(resolve, reject), id)
  })
}

describe('maintenanceState per tenant (P5-6)', () => {
  beforeEach(() => bustMaintenanceCache())

  it('two tenants read at once each get their own state, the slow one included', async () => {
    const ra = { n: 0 }
    const rb = { n: 0 }
    const a = tenantDb(true, 40, ra) // A is in maintenance and answers last
    const b = tenantDb(false, 5, rb)
    const [sa, sb] = await Promise.all([
      asTenant('A', a, () => maintenanceState()),
      asTenant('B', b, () => maintenanceState())
    ])
    expect(sa.on).toBe(true)
    expect(sa.message).toBe('Upgrading')
    expect(sb.on).toBe(false)
    // cached per tenant: a second read answers from that tenant's own entry
    expect((await asTenant('B', b, () => maintenanceState())).on).toBe(false)
    expect((await asTenant('A', a, () => maintenanceState())).on).toBe(true)
    expect(ra.n).toBe(1)
    expect(rb.n).toBe(1)
  })

  it('busting forgets every tenant’s entry', async () => {
    const ra = { n: 0 }
    const a = tenantDb(true, 1, ra)
    await asTenant('A', a, () => maintenanceState())
    bustMaintenanceCache()
    await asTenant('A', a, () => maintenanceState())
    expect(ra.n).toBe(2)
  })
})
