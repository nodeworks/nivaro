import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Gap G-E: Hub auto-renew of a Namecheap domain (Namecheap's API cannot change the registrar's own
// auto-renew). Real SQLite rows (Hub migrations up to 586), the real planDomain + domainSpec and a
// fake Namecheap world: window math, the approval path, one renewal per expiry, and the renewal
// origin refusing everything but one `{renew: true}` update of a Hub-renewed domain.
// Nothing here ever calls Namecheap.

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
  return { db, migrationsDir: '/nowhere' }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const registry = await import('../../../services/hub/providers/registry.js')
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const approval = await import('../../../services/hub/providers/engine/approval.js')
const deps = await import('../../../services/hub/providers/engine/deps.js')
const locks = await import('../../../services/hub/providers/engine/locks.js')
const { assertRenewalOps } = await import('../../../services/hub/providers/engine/gates.js')
const { domainSpec, planDomain } = await import(
  '../../../services/hub/providers/namecheap/domain.js'
)
const { writeCostSettings } = await import('../../../services/hub/providers/estimate.js')
const renewal = await import('../../../services/hub/providers/hooks/domain-renewal.js')
const { renewDaysOf } = await import('../../../services/hub/providers/renewal-window.js')

import type { HubActor } from '../../../services/hub/providers/engine/contract.js'
import type {
  Observed,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '550_hub_oidc',
  '551_hub_signins',
  '552_hub_shared_deployments',
  '553_hub_moves',
  '555_hub_stack_files',
  '565_hub_release_ops',
  '566_hub_fleet',
  '567_hub_capacity',
  '568_hub_ops',
  '569_hub_data',
  '570_hub_people_owner_policy',
  '571_hub_app_templates',
  '573_hub_change_ops',
  '574_hub_verify',
  '576_hub_incidents',
  '579_hub_lifecycle',
  '582_hub_providers',
  '583_hub_provider_hooks',
  '584_hub_provider_bindings',
  '585_hub_cost_live',
  '586_hub_provider_costs'
]

const ADMIN_ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const OWNER_ID = '0a1b2c3d-0000-4000-8000-0000000000a3'
const GONE_ID = '0a1b2c3d-0000-4000-8000-0000000000a2'
const ADMIN: HubActor = { id: ADMIN_ID, isAdmin: true, via: 'session' }
const DAY = 86_400_000
const NOW = Date.parse('2026-11-27T12:00:00Z')
const RENEW_CENTS = 1898

// ── A fake Namecheap world (real plan, fake observe/apply, fixed price) ──

let expires = ''
const calls: string[] = []

const domainType: ResourceTypeSpec = {
  ...domainSpec,
  estimate: async (_c, desired) => ({
    basis: 'price_list',
    confidence: 'list_price',
    currency: 'USD',
    lines: [],
    monthlyCents: Math.round(RENEW_CENTS / 12),
    oneTimeCents: desired?.fields.renew === true ? RENEW_CENTS : 0,
    yearlyCents: RENEW_CENTS,
    priceAsOf: '2026-11-27',
    note: 'fixture'
  })
}

const observed = (): Observed => ({
  type: 'namecheap.domain',
  externalId: 'example.com',
  name: 'example.com',
  fields: {
    name: 'example.com',
    auto_renew: false,
    transfer_lock: true,
    nameservers: [],
    expires_at: expires
  },
  tags: {}
})

const namecheap: ProviderAdapter = {
  key: 'namecheap',
  label: 'Namecheap',
  connection: { fields: [], hosts: () => [], describe: () => 'namecheap' },
  types: [domainType],
  testConnection: async () => ({ ok: true, identity: 'nc', permissions: [], missing: [] }),
  observe: async () => observed(),
  list: async () => ({ items: [], cursor: null }),
  plan: (_c, desired, obs) => planDomain(desired, obs),
  async apply(_c, op, desired) {
    calls.push(`${op.kind}:${op.action ?? ''}`)
    if (op.action === 'renew') expires = new Date(Date.parse(expires) + 365 * DAY).toISOString()
    const o = observed()
    return {
      ok: true,
      externalId: 'example.com',
      observed: {
        ...o,
        fields: {
          ...o.fields,
          hub_auto_renew: desired?.fields.hub_auto_renew === true,
          renew_days_before: desired?.fields.renew_days_before ?? 30
        }
      }
    }
  }
}

let conn = 0
let domainId = 0

beforeAll(async () => {
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  await db.schema.createTable('nivaro_users', (t) => {
    t.uuid('id').primary()
    t.string('status').nullable()
    t.uuid('role').nullable()
  })
  await db.schema.createTable('nivaro_roles', (t) => {
    t.uuid('id').primary()
    t.boolean('admin_access').nullable()
  })
  if (!(await db.schema.hasTable('nivaro_extension_settings')))
    await db.schema.createTable('nivaro_extension_settings', (t) => {
      t.increments('id')
      t.string('extension_id')
      t.string('key')
      t.text('value')
      t.timestamp('updated_at').nullable()
    })
  const role = '0a1b2c3d-0000-4000-8000-0000000000f1'
  await db('nivaro_roles').insert({ id: role, admin_access: true })
  await db('nivaro_users').insert([
    { id: ADMIN_ID, status: 'active', role },
    { id: OWNER_ID, status: 'active', role: null }
  ])
  conn = (
    await store.createConnection({
      provider: 'namecheap',
      name: 'Namecheap account',
      config: {},
      secrets: { api_key: 'test-secret-namecheap-key' }
    })
  ).id
})

afterAll(async () => {
  await db.destroy()
})

beforeEach(async () => {
  calls.length = 0
  registry.resetProvidersForTest()
  registry.registerProvider(namecheap)
  locks.resetMemoryResourceLocksForTest()
  deps.resetResourceEngineForTest()
  deps.configureResourceEngine({
    lock: () => locks.memoryResourceLock(),
    inline: true,
    notify: { notify: vi.fn(async () => null), adminBase: () => '', page: null }
  })
  for (const t of [
    'nivaro_hub_resources',
    'nivaro_hub_resource_changes',
    'nivaro_hub_freezes',
    'nivaro_extension_settings'
  ])
    await db(t).del()
  expires = new Date(NOW + 20 * DAY).toISOString()
  await addDomain({ hub_auto_renew: true })
})

async function addDomain(desired: Record<string, unknown>, createdBy: string | null = OWNER_ID) {
  const row = await store.insertResource({
    connection_id: conn,
    provider: 'namecheap',
    type: 'namecheap.domain',
    external_id: 'example.com',
    name: 'example.com',
    scope: 'shared',
    desired: { name: 'example.com', ...desired },
    observed: observed(),
    created_by: createdBy,
    adopted: true
  })
  domainId = row.id
  return row
}

const row = async () =>
  (await store.readResource(domainId)) as NonNullable<
    Awaited<ReturnType<typeof store.readResource>>
  >

const tickAt = (extra: Partial<Parameters<typeof renewal.domainRenewalFor>[3]> = {}) => {
  const notify = vi.fn()
  const notice = vi.fn(async () => undefined as never)
  return {
    notify,
    notice,
    run: async (at = NOW) =>
      renewal.domainRenewalFor(await row(), 'example.com', new Date(expires), {
        now: () => at,
        notify,
        notice,
        recipients: async () => [ADMIN_ID],
        ...extra
      })
  }
}

// ── Window math ──

describe('window math', () => {
  it('renew_days_before defaults to 30 and stays inside 7–60', () => {
    expect(renewDaysOf({})).toBe(30)
    expect(renewDaysOf({ renew_days_before: 3 })).toBe(7)
    expect(renewDaysOf({ renew_days_before: 400 })).toBe(60)
    expect(renewDaysOf({ renew_days_before: 45 })).toBe(45)
    expect(renewDaysOf({ renew_days_before: 'x' })).toBe(30)
  })

  it('is due only with the switch on, inside the window, for a live domain', () => {
    const r = (desired: Record<string, unknown> | null, ext: string | null = 'example.com') =>
      ({ desired, external_id: ext, deleted_at: null }) as never
    const ends = (days: number) => new Date(NOW + days * DAY)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: true }), ends(30), NOW)).toBe(true)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: true }), ends(31), NOW)).toBe(false)
    expect(
      renewal.hubRenewalDue(r({ hub_auto_renew: true, renew_days_before: 7 }), ends(8), NOW)
    ).toBe(false)
    expect(
      renewal.hubRenewalDue(r({ hub_auto_renew: true, renew_days_before: 7 }), ends(7), NOW)
    ).toBe(true)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: true }), ends(-3), NOW)).toBe(true)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: false }), ends(1), NOW)).toBe(false)
    expect(renewal.hubRenewalDue(r({}), ends(1), NOW)).toBe(false)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: true }), null, NOW)).toBe(false)
    expect(renewal.hubRenewalDue(r({ hub_auto_renew: true }, null), ends(1), NOW)).toBe(false)
  })

  it('does nothing outside the window or with the switch off', async () => {
    const t = tickAt()
    expires = new Date(NOW + 45 * DAY).toISOString()
    expect(await t.run()).toBe('not_due')
    await store.updateResource(domainId, { desired: { name: 'example.com' } })
    expires = new Date(NOW + 3 * DAY).toISOString()
    expect(await t.run()).toBe('off')
    expect(calls).toEqual([])
    expect(await store.listChanges({ limit: 5 })).toHaveLength(0)
  })
})

// ── The approval path ──

describe('approval path', () => {
  it('waits for a Hub administrator: the renewal is a cost the requester cannot start', async () => {
    const t = tickAt()
    expect(await t.run()).toBe('waiting')
    const [change] = await store.listChanges({ limit: 5 })
    expect(change.status).toBe('pending_approval')
    expect(change.plan?.origin).toEqual({ kind: 'renewal', resourceId: domainId })
    expect(change.requested_by).toBe(OWNER_ID)
    expect(change.plan?.needsConfirm).toBeNull()
    expect(change.plan?.ops.map((o) => o.action)).toEqual(['renew'])
    expect(change.plan?.ops[0].risk).toContain('cost')
    expect(change.plan?.ops[0].cost?.after?.oneTimeCents).toBe(RENEW_CENTS)
    expect(calls).toEqual([])
    expect(t.notify).toHaveBeenCalledWith(
      'domain.expiring',
      expect.objectContaining({ dedupKey: expect.stringContaining('domain-renew:') })
    )
    expect(t.notice).toHaveBeenCalledTimes(1)
    // The administrator approves it; it then renews for one year, once.
    const done = await approval.approveChange(
      change.id,
      { planHash: change.plan_hash ?? '' },
      ADMIN
    )
    expect(done.status).toBe('applied')
    expect(calls).toEqual(['update:renew'])
    expect(Date.parse(expires)).toBeGreaterThan(NOW + 300 * DAY)
    // The renewal one-shot is cleared; the Hub setting stays.
    const after = await row()
    expect(after.desired?.renew).toBeUndefined()
    expect(after.desired?.hub_auto_renew).toBe(true)
  })

  it('runs by itself when the auto-approve limit covers the renewal price', async () => {
    await writeCostSettings({ cost_auto_approve_under_cents: RENEW_CENTS + 1 })
    const t = tickAt()
    expect(await t.run()).toBe('started')
    expect(calls).toEqual(['update:renew'])
    const [change] = await store.listChanges({ limit: 5 })
    expect(change.status).toBe('applied')
    expect(t.notify).not.toHaveBeenCalled()
  })

  it('a limit under the price still waits (increases only, nothing netted)', async () => {
    await writeCostSettings({ cost_auto_approve_under_cents: RENEW_CENTS - 1 })
    expect(await tickAt().run()).toBe('waiting')
    expect(calls).toEqual([])
  })

  it('never acts as an administrator, even for a domain an administrator made', async () => {
    await db('nivaro_hub_resources').where({ id: domainId }).update({ created_by: ADMIN_ID })
    expect(await tickAt().run()).toBe('waiting')
    const [change] = await store.listChanges({ limit: 5 })
    expect(change.status).toBe('pending_approval')
  })

  it('tells the administrators when nobody can act for the domain', async () => {
    await db('nivaro_hub_resources').where({ id: domainId }).update({ created_by: GONE_ID })
    const t = tickAt()
    expect(await t.run()).toBe('no_actor')
    expect(t.notify).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })
})

// ── One renewal per expiry ──

describe('idempotence', () => {
  it('plans one renewal for one expiry date, whatever its state', async () => {
    const t = tickAt()
    expect(await t.run()).toBe('waiting')
    expect(await t.run(NOW + 3_600_000)).toBe('skipped')
    expect(await t.run(NOW + 30 * 3_600_000)).toBe('skipped')
    expect(await store.listChanges({ limit: 10 })).toHaveLength(1)
  })

  it('a declined renewal for this expiry is not asked for again', async () => {
    const t = tickAt()
    await t.run()
    const [change] = await store.listChanges({ limit: 5 })
    await approval.declineChange(change.id, 'we are letting it go', ADMIN)
    expect(await t.run(NOW + 48 * 3_600_000)).toBe('skipped')
    expect(await store.listChanges({ limit: 10 })).toHaveLength(1)
  })

  it('a renewed domain is not renewed again: its new expiry is out of the window', async () => {
    await writeCostSettings({ cost_auto_approve_under_cents: RENEW_CENTS + 1 })
    const t = tickAt()
    expect(await t.run()).toBe('started')
    expect(await t.run(NOW + 3_600_000)).toBe('not_due')
    expect(calls).toEqual(['update:renew'])
  })

  it('a failed renewal is retried after the retry window, not before', () => {
    const exp = new Date(NOW + 5 * DAY)
    const failed = (at: number) => [
      {
        status: 'failed',
        created_at: new Date(at).toISOString(),
        plan: {
          origin: { kind: 'renewal' },
          resourceIds: [7],
          ops: [{ preconditions: { expires_at: exp.toISOString() } }]
        }
      }
    ]
    expect(renewal.renewalHeld(failed(NOW - 3_600_000), 7, exp, NOW)).toBe(true)
    expect(renewal.renewalHeld(failed(NOW - 7 * 3_600_000), 7, exp, NOW)).toBe(false)
    // A change for another expiry date, resource or origin holds nothing.
    expect(renewal.renewalHeld(failed(NOW - 3_600_000), 8, exp, NOW)).toBe(false)
    expect(renewal.renewalHeld(failed(NOW - 3_600_000), 7, new Date(NOW + 9 * DAY), NOW)).toBe(
      false
    )
  })
})

// ── The renewal origin refuses everything else ──

describe('origin refusal', () => {
  const owner: HubActor = { id: OWNER_ID, isAdmin: false, via: 'session' }
  const plan = (ops: Parameters<typeof engine.planCarriedResourceChange>[0]['ops'], rid = 0) =>
    engine.planCarriedResourceChange({ connectionId: conn, scope: 'shared', ops }, owner, {
      kind: 'renewal',
      resourceId: rid || domainId
    })

  it('plans the one renew and nothing else', async () => {
    const p = await plan([{ action: 'update', resourceId: domainId, fields: { renew: true } }])
    expect(p.blockers).toEqual([])
    expect(p.needsApproval).toBe(true)
  })

  it('refuses another field, another action, another resource and a second op', async () => {
    const refused = (ops: Parameters<typeof plan>[0], rid?: number) =>
      expect(plan(ops, rid)).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    await refused([
      { action: 'update', resourceId: domainId, fields: { renew: true, transfer_lock: false } }
    ])
    await refused([
      {
        action: 'update',
        resourceId: domainId,
        fields: { nameservers: ['a.example.net', 'b.example.net'] }
      }
    ])
    await refused([{ action: 'update', resourceId: domainId, fields: {} }])
    await refused([{ action: 'reapply', resourceId: domainId }])
    await refused([{ action: 'delete', resourceId: domainId }])
    await refused(
      [{ action: 'update', resourceId: domainId, fields: { renew: true } }],
      domainId + 50
    )
    // A second op is refused too (the same resource named twice, or by the origin).
    await expect(
      plan([
        { action: 'update', resourceId: domainId, fields: { renew: true } },
        { action: 'update', resourceId: domainId, fields: { renew: true } }
      ])
    ).rejects.toBeInstanceOf(engine.ResourceChangeError)
  })

  it('refuses when the Hub switch is off or the domain is outside its window', async () => {
    const ops = [{ action: 'update' as const, resourceId: domainId, fields: { renew: true } }]
    const keep = (await row()).observed as Observed
    await store.updateResource(domainId, {
      observed: {
        ...keep,
        fields: { ...keep.fields, expires_at: new Date(Date.now() + 90 * DAY).toISOString() }
      }
    })
    await expect(plan(ops)).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
    await store.updateResource(domainId, {
      observed: {
        ...keep,
        fields: { ...keep.fields, expires_at: new Date(Date.now() + 2 * DAY).toISOString() }
      },
      desired: { name: 'example.com', hub_auto_renew: false }
    })
    await expect(plan(ops)).rejects.toMatchObject({ code: 'ORIGIN_INVALID' })
  })

  it('a person without the origin still cannot change a shared domain', async () => {
    await expect(
      engine.planResourceChange(
        {
          connectionId: conn,
          scope: 'shared',
          ops: [{ action: 'update', resourceId: domainId, fields: { renew: true } }]
        },
        owner
      )
    ).rejects.toMatchObject({ code: 'SHARED_ADMIN_ONLY' })
  })

  it('assertRenewalOps still lets only the renew op through', () => {
    expect(() =>
      assertRenewalOps({ kind: 'renewal', resourceId: 1 }, [{ kind: 'update', action: 'renew' }])
    ).not.toThrow()
    expect(() =>
      assertRenewalOps({ kind: 'renewal', resourceId: 1 }, [{ kind: 'update' }])
    ).toThrow(/only renews/)
  })
})

// ── The Hub settings ──

describe('Hub settings', () => {
  it('turning the switch on is a plain update with no provider call and no cost', async () => {
    await store.updateResource(domainId, { desired: { name: 'example.com' } })
    const p = await engine.planResourceChange(
      {
        connectionId: conn,
        scope: 'shared',
        ops: [
          {
            action: 'update',
            resourceId: domainId,
            fields: { hub_auto_renew: true, renew_days_before: 21 }
          }
        ]
      },
      ADMIN
    )
    expect(p.ops).toHaveLength(1)
    expect(p.ops[0].risk).not.toContain('cost')
    expect(p.ops[0].changes.map((c) => c.field).sort()).toEqual([
      'hub_auto_renew',
      'renew_days_before'
    ])
    const out = await engine.startResourceChange(p.changeId, { planHash: p.planHash }, ADMIN)
    expect(out.status).toBe('applied')
    const after = await row()
    expect(after.desired?.hub_auto_renew).toBe(true)
    expect(after.desired?.renew_days_before).toBe(21)
    // The stored echo makes the next plan a no-op.
    const again = planDomain(
      {
        type: 'namecheap.domain',
        resourceId: domainId,
        externalId: 'example.com',
        fields: after.desired ?? {},
        refs: {},
        tags: {}
      } as never,
      after.observed as Observed
    )
    expect(again.map((o) => o.kind)).toEqual(['noop'])
  })

  it('a field outside 7–60 days is refused', async () => {
    await expect(
      engine.planResourceChange(
        {
          connectionId: conn,
          scope: 'shared',
          ops: [{ action: 'update', resourceId: domainId, fields: { renew_days_before: 90 } }]
        },
        ADMIN
      )
    ).rejects.toMatchObject({ code: 'INVALID_FIELDS' })
  })
})
