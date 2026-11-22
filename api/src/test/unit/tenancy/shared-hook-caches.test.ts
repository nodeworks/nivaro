import { gzipSync } from 'node:zlib'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6, Task 13 fix round 1 (ruling P6-4): the caches the record hooks reach are per app
// on a shared deployment. Two apps hold the SAME collection names and record ids (dev = a copy of
// prod) with different config; one app's cached answer must never decide for the other.

const created = vi.hoisted(() => [] as Array<{ table: string; row: Record<string, unknown> }>)
vi.mock('../../../services/items.js', () => ({
  createOne: vi.fn(async (_u: unknown, table: string, row: Record<string, unknown>) => {
    created.push({ table, row })
    return { id: 1 }
  }),
  deleteOne: vi.fn(async () => {})
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (row: unknown) => row
}))

const SAVED = { ...process.env }
Object.assign(process.env, {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
})

const { db } = await import('../../../db/index.js')
const { getTenantDb, runWithTenantDb } = await import('../../../db/tenant-context.js')
const { hooks } = await import('../../../hooks/registry.js')

// ── A small in-memory database per app ───────────────────────────────────────────────────────

type Row = Record<string, unknown>
interface FakeDb {
  (table: string): unknown
  reads: string[]
  raw: (sql: string) => Promise<unknown>
  schema: { hasColumn: () => Promise<boolean>; hasTable: () => Promise<boolean> }
  client: { config: { client: string } }
}

function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const reads: string[] = []
  const fn = ((table: string) => {
    reads.push(table)
    let rows = [...(tables[table] ?? [])]
    let result: unknown = rows
    const chain: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = Promise.resolve(result)
            return (p[prop as 'then'] as (...a: unknown[]) => unknown).bind(p)
          }
          return (...args: unknown[]) => {
            if (prop === 'where' || prop === 'andWhere') {
              const [a, b] = args
              // where(col, value) / where({...}); where(col, op, value) is not filtered.
              const cond: Row =
                args.length > 2
                  ? {}
                  : typeof a === 'string'
                    ? { [a]: b }
                    : a && typeof a === 'object'
                      ? (a as Row)
                      : {}
              rows = rows.filter((r) =>
                Object.entries(cond).every(
                  ([k, v]) => k.includes('.') || !(k in r) || String(r[k]) === String(v)
                )
              )
              result = rows
            } else if (prop === 'first') result = rows[0]
            else if (prop === 'pluck') result = rows.map((r) => r[args[0] as string])
            else if (prop === 'insert') result = [{ id: 1 }]
            else if (prop === 'columnInfo')
              result = Object.fromEntries(Object.keys(rows[0] ?? {}).map((k) => [k, {}]))
            else if (prop !== 'select' && prop !== 'orderBy' && prop !== 'whereNotNull')
              result = rows
            return chain
          }
        }
      }
    )
    return chain
  }) as FakeDb
  fn.reads = reads
  fn.raw = async () => {
    const groups = tables.nivaro_pipeline_owner_groups ?? []
    return [{ z: gzipSync(Buffer.from(JSON.stringify(groups), 'utf16le')) }]
  }
  fn.schema = { hasColumn: async () => false, hasTable: async () => false }
  fn.client = { config: { client: 'pg' } }
  return fn
}

function asApp<T>(app: string, appDb: FakeDb, fn: () => Promise<T> | T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      appDb as never,
      app,
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      app
    )
  })
}

beforeEach(() => {
  created.length = 0
  const route = (table: string) => {
    const t = getTenantDb() as unknown as FakeDb | undefined
    if (!t) throw new Error('no app database outside an app')
    return t(table)
  }
  vi.mocked(db).mockImplementation(route as never)
  ;(db as unknown as { raw: unknown }).raw = vi.fn((sql: string) =>
    (getTenantDb() as unknown as FakeDb).raw(sql)
  )
})

const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms))

describe('caches the hooks reach are per app', () => {
  it('integrity: app A’s compiled checks never judge app B, and a bust in A keeps B', async () => {
    const { hasChecks, bustCompiledChecks } = await import(
      '../../../services/config-conformance.js'
    )
    const a = fakeDb({ nivaro_fields: [{ field: 'name', required: true, label: 'Name' }] })
    const b = fakeDb({ nivaro_fields: [] })
    expect(await asApp('app-a', a, () => hasChecks('orders'))).toBe(true)
    expect(await asApp('app-b', b, () => hasChecks('orders'))).toBe(false)
    const bReads = b.reads.length
    await asApp('app-a', a, () => bustCompiledChecks())
    expect(await asApp('app-b', b, () => hasChecks('orders'))).toBe(false)
    expect(b.reads.length).toBe(bReads)
  })

  it('a transition in flight in A never skips B’s on the same record id', async () => {
    const { holdTransitionFlight, isTransitionInFlight } = await import(
      '../../../services/workflow-transitions.js'
    )
    const a = fakeDb()
    const b = fakeDb()
    const release = await asApp('app-a', a, () => holdTransitionFlight('workflows', 5))
    expect(await asApp('app-a', a, () => isTransitionInFlight('workflows', 5))).toBe(true)
    expect(await asApp('app-b', b, () => isTransitionInFlight('workflows', 5))).toBe(false)
    release()
    expect(await asApp('app-a', a, () => isTransitionInFlight('workflows', 5))).toBe(false)
  })

  it('human id column per app', async () => {
    const { friendlyIdField } = await import('../../../services/workflow-transitions.js')
    const a = fakeDb({ nivaro_collections: [{ collection: 'orders', friendly_id_field: 'po_no' }] })
    const b = fakeDb({ nivaro_collections: [{ collection: 'orders', friendly_id_field: 'ref' }] })
    expect(await asApp('app-a', a, () => friendlyIdField('orders'))).toBe('po_no')
    expect(await asApp('app-b', b, () => friendlyIdField('orders'))).toBe('ref')
  })

  it('owner matrix per app: the same state id resolves to each app’s own groups', async () => {
    const { getOwnerGroupsForStates } = await import('../../../services/pipeline-engine.js')
    const group = (id: string) => ({ id, state: 'S1', sort: 0, is_default: true, filters: null })
    const a = fakeDb({ nivaro_pipeline_owner_groups: [group('GA')] })
    const b = fakeDb({ nivaro_pipeline_owner_groups: [group('GB')] })
    const ga = await asApp('app-a', a, () => getOwnerGroupsForStates(['S1'], db as never))
    const gb = await asApp('app-b', b, () => getOwnerGroupsForStates(['S1'], db as never))
    expect(ga.get('S1')?.groups.map((g) => g.id)).toEqual(['GA'])
    expect(gb.get('S1')?.groups.map((g) => g.id)).toEqual(['GB'])
  })

  it('links: portal and address lookups per app', async () => {
    const { portalRegistration, userIdForEmail } = await import('../../../services/app-links.js')
    const a = fakeDb({
      nivaro_settings: [{ id: 1, portal_url: 'https://a.example', portal_routes: null }],
      nivaro_users: [{ id: 'UA', email: 'pat@x.org' }]
    })
    const b = fakeDb({
      nivaro_settings: [{ id: 1, portal_url: 'https://b.example', portal_routes: null }],
      nivaro_users: [{ id: 'UB', email: 'pat@x.org' }]
    })
    expect((await asApp('app-a', a, () => portalRegistration()))?.base).toBe('https://a.example')
    expect((await asApp('app-b', b, () => portalRegistration()))?.base).toBe('https://b.example')
    expect(await asApp('app-a', a, () => userIdForEmail('pat@x.org'))).toBe('UA')
    expect(await asApp('app-b', b, () => userIdForEmail('pat@x.org'))).toBe('UB')
  })

  it('notification wording per app', async () => {
    const { renderNotificationTemplate } = await import(
      '../../../services/notification-templates.js'
    )
    const a = fakeDb({ nivaro_mail_templates: [{ name: 'notification:x', body: 'From A\nbody' }] })
    const b = fakeDb({ nivaro_mail_templates: [] })
    expect((await asApp('app-a', a, () => renderNotificationTemplate('x', {})))?.subject).toBe(
      'From A'
    )
    expect(await asApp('app-b', b, () => renderNotificationTemplate('x', {}))).toBeNull()
  })

  it('formula constants and alert banners per app', async () => {
    const { getFormulaContext } = await import('../../../services/formula-context.js')
    const { bannerDefinitionIds } = await import('../../../services/alert-banners.js')
    const a = fakeDb({
      nivaro_settings: [{ formula_constants: '{"RATE":2}', fiscal_year_start_month: 7 }],
      nivaro_extension_settings: [{ value: '[1]' }]
    })
    const b = fakeDb({
      nivaro_settings: [{ formula_constants: '{"RATE":3}', fiscal_year_start_month: 1 }],
      nivaro_extension_settings: [{ value: '[2]' }]
    })
    expect((await asApp('app-a', a, () => getFormulaContext())).constants.RATE).toBe(2)
    expect((await asApp('app-b', b, () => getFormulaContext())).constants.RATE).toBe(3)
    expect([...(await asApp('app-a', a, () => bannerDefinitionIds()))]).toEqual([1])
    expect([...(await asApp('app-b', b, () => bannerDefinitionIds()))]).toEqual([2])
  })
})

describe('cross-triggers: the first junction write in an app after boot', () => {
  it('waits for the app’s watch map and runs the M2M mirror sync (never skips it)', async () => {
    const { registerCrossTriggerHooks } = await import('../../../hooks/cross-triggers.js')
    registerCrossTriggerHooks()
    const rule = {
      id: 1,
      name: 'Project zones to workflows',
      collection: 'projects',
      trigger: 'update',
      enabled: true,
      conditions: null,
      actions: JSON.stringify([
        {
          type: 'cross_collection',
          target_collection: 'workflows',
          operation: 'update',
          field_map: { project: '{{id}}' },
          match_field: 'project',
          m2m_map: { zones: 'zones' }
        }
      ])
    }
    const app = fakeDb({
      nivaro_rules: [rule],
      nivaro_roles: [{ id: 'ADMIN', admin_access: true }],
      nivaro_relations: [
        {
          one_collection: 'projects',
          one_field: 'zones',
          many_collection: 'projects_zones',
          many_field: 'projects_id',
          junction_field: 'zones_id'
        },
        {
          one_collection: 'workflows',
          one_field: 'zones',
          many_collection: 'workflows_zones',
          many_field: 'workflows_id',
          junction_field: 'zones_id'
        }
      ],
      projects: [{ id: 5 }],
      projects_zones: [{ id: 9, projects_id: 5, zones_id: 3 }],
      workflows: [{ id: 77, project: 5 }],
      workflows_zones: []
    })
    await asApp('app-fresh', app, () =>
      hooks.trigger('after', {
        collection: 'projects_zones',
        action: 'create',
        keys: [9],
        payload: { projects_id: 5, zones_id: 3 },
        result: { id: 9, projects_id: 5, zones_id: 3 },
        database: db as never
      })
    )
    await sleep(80)
    expect(created).toEqual([
      { table: 'workflows_zones', row: { workflows_id: 77, zones_id: '3' } }
    ])
  })
})

afterAll(() => {
  process.env = { ...SAVED }
})
