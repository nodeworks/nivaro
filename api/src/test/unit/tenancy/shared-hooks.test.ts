import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import ts from 'typescript'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6, Task 13: on a Hub shared deployment (one process, many apps) the core record hooks
// and event flows run per app. The registrars run once per process, every hook reads the database
// of the app whose write it runs for, and event flows are read per app (never one process-wide
// hook per flow, which would fire app A's flow on app B's writes). Nivaro Cloud is unchanged: no
// registration, no event flows. Self-hosted is unchanged (the hook and flow suites).

// ── Spies on every registrar (the activity hooks stay real) ──────────────────────────────────

const spies = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>)
const spy = (name: string) => {
  spies[name] = vi.fn()
  return spies[name]
}
vi.mock('../../../hooks/activity.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../hooks/activity.js')>()
  spies.registerActivityHooks = vi.fn(real.registerActivityHooks)
  return { ...real, registerActivityHooks: spies.registerActivityHooks }
})
vi.mock('../../../hooks/field-watches.js', () => ({
  registerFieldWatchHooks: spy('registerFieldWatchHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/watch-list.js', () => ({
  registerWatchListHooks: spy('registerWatchListHooks')
}))
vi.mock('../../../hooks/inactive-people.js', () => ({
  registerInactivePeopleHooks: spy('registerInactivePeopleHooks')
}))
vi.mock('../../../hooks/notification-subscriptions.js', () => ({
  registerNotificationSubscriptionHooks: spy('registerNotificationSubscriptionHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/pipeline-autostart.js', () => ({
  registerPipelineAutostartHooks: spy('registerPipelineAutostartHooks')
}))
vi.mock('../../../hooks/alerts.js', () => ({
  registerAlertHooks: spy('registerAlertHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/embeddings.js', () => ({
  registerEmbeddingHooks: spy('registerEmbeddingHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/cross-triggers.js', () => ({
  registerCrossTriggerHooks: spy('registerCrossTriggerHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/ai-validation.js', () => ({
  registerAiValidationHooks: spy('registerAiValidationHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/aggregate-caps.js', () => ({
  registerAggregateCapHooks: spy('registerAggregateCapHooks'),
  setApp: vi.fn()
}))
vi.mock('../../../hooks/queue-materialization.js', () => ({
  registerQueueMaterializationHooks: spy('registerQueueMaterializationHooks')
}))
vi.mock('../../../hooks/record-integrity.js', () => ({
  registerRecordIntegrityHooks: spy('registerRecordIntegrityHooks')
}))
vi.mock('../../../hooks/notification-snooze.js', () => ({
  registerSnoozeWakeHooks: spy('registerSnoozeWakeHooks')
}))
vi.mock('../../../hooks/task-done-when.js', () => ({
  registerTaskDoneWhenHooks: spy('registerTaskDoneWhenHooks')
}))
vi.mock('../../../hooks/presence-typing-strip.js', () => ({
  registerPresenceTypingStripHooks: spy('registerPresenceTypingStripHooks')
}))
vi.mock('../../../hooks/agent-triggers.js', () => ({
  registerAgentTriggerHooks: spy('registerAgentTriggerHooks')
}))
vi.mock('../../../hooks/workflow-auto.js', () => ({
  registerWorkflowAutoHooks: spy('registerWorkflowAutoHooks')
}))
vi.mock('../../../hooks/approval-changes.js', () => ({
  registerApprovalChangeHooks: spy('registerApprovalChangeHooks')
}))
vi.mock('../../../flows/core-triggers.js', () => ({
  registerCoreTriggers: spy('registerCoreTriggers')
}))

// The flow routes' outside world.
vi.mock('../../../middleware/authenticate.js', () => ({ requireAdmin: vi.fn(async () => {}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: vi.fn() }))
const flow = vi.hoisted(() => ({ executeFlow: vi.fn(async (_ctx: unknown) => ({})) }))
vi.mock('../../../services/flow-executor.js', () => flow)
// Webhooks fire after every write; nothing to deliver here.
vi.mock('../../../services/webhook-dispatch.js', () => ({ fireWebhooks: vi.fn(async () => {}) }))

// ── Env: a Hub shared deployment ─────────────────────────────────────────────────────────────

const SELF_HOSTED: Record<string, string> = {}
const CLOUD: Record<string, string> = { CLOUD_META_DB_URL: 'postgres://meta/x' }
const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const KEYS = ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}
useEnv(SHARED)

const { db } = await import('../../../db/index.js')
const { getTenantDb, runWithTenantDb } = await import('../../../db/tenant-context.js')
const { hooks } = await import('../../../hooks/registry.js')
const { registerCoreRecordHooks } = await import('../../../hooks/core-hooks.js')
const { isMultiTenant, tenantSource } = await import('../../../services/deployment-mode.js')
const { cachedEventFlowTenants, forgetTenantEventFlows, startTenantEventFlows } = await import(
  '../../../flows/tenant-event-flows.js'
)
const { flowsRoutes } = await import('../../../routes/flows.js')

afterAll(() => {
  process.env = { ...saved }
})

// ── A fake database per app: records the tables it was asked for, answers from its rows ──────

interface FakeDb {
  (table: string): unknown
  tables: string[]
  inserts: Array<{ table: string; row: Record<string, unknown> }>
  rows: Record<string, Array<Record<string, unknown>>>
  raw: () => Promise<unknown[]>
  schema: { hasColumn: () => Promise<boolean>; hasTable: () => Promise<boolean> }
  client: { config: { client: string } }
}

function fakeDb(rows: Record<string, Array<Record<string, unknown>>> = {}): FakeDb {
  const tables: string[] = []
  const inserts: FakeDb['inserts'] = []
  const fn = ((table: string) => {
    tables.push(table)
    let result: unknown = rows[table] ?? []
    const chain: unknown = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = Promise.resolve(result)
            return (p[prop as 'then'] as (...a: unknown[]) => unknown).bind(p)
          }
          return (...args: unknown[]) => {
            if (prop === 'first') result = (rows[table] ?? [])[0]
            else if (prop === 'insert') {
              inserts.push({ table, row: args[0] as Record<string, unknown> })
              result = [{ id: 1 }]
            } else if (prop === 'update' || prop === 'delete' || prop === 'del') result = 1
            return chain
          }
        }
      }
    )
    return chain
  }) as FakeDb
  fn.tables = tables
  fn.inserts = inserts
  fn.rows = rows
  fn.raw = async () => []
  fn.schema = { hasColumn: async () => false, hasTable: async () => false }
  fn.client = { config: { client: 'pg' } }
  return fn
}

/** Run as an app: its database, its tenant id. */
function asApp<T>(tenantId: string, appDb: FakeDb, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(appDb as never, tenantId, () => void fn().then(resolve, reject), tenantId)
  })
}

// The global db mock (test/setup.ts) answers through the current app's database, as the real
// db proxy does on a multi-tenant deployment.
beforeEach(() => {
  vi.mocked(db).mockImplementation(((table: string) => {
    const t = getTenantDb() as unknown as FakeDb | undefined
    if (!t) throw new Error('no app database outside an app')
    return t(table)
  }) as never)
})

const sleep = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const appStub = { log } as unknown as FastifyInstance

// ── index.ts: who registers the hooks ────────────────────────────────────────────────────────

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const indexFile = join(SRC, 'index.ts')
const sf = ts.createSourceFile(
  indexFile,
  readFileSync(indexFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

/** The condition of the nearest `if` whose THEN branch holds the statement starting `needle`. */
function guardOf(needle: string): string | null {
  let hit: ts.Node | undefined
  const visit = (n: ts.Node) => {
    if (hit) return
    if (n.parent && ts.isBlock(n.parent) && n.getText(sf).startsWith(needle)) hit = n
    ts.forEachChild(n, visit)
  }
  visit(sf)
  expect(hit, `${needle} is in index.ts`).toBeDefined()
  let child = hit as ts.Node
  for (let n = child.parent; n; child = n, n = n.parent) {
    if (ts.isIfStatement(n)) return n.thenStatement === child ? n.expression.getText(sf) : null
  }
  return null
}

const GATE = "(!isMultiTenant() || tenantSource() === 'hub') && !realtime"
const opens = (env: Record<string, string>, realtime = false) =>
  (!isMultiTenant(env) || tenantSource(env) === 'hub') && !realtime

describe('index.ts: which deployments register the core hooks and event flows', () => {
  it('registration and the event-flow block sit under the same gate', () => {
    expect(guardOf('registerCoreRecordHooks()')).toBe(GATE)
    expect(guardOf("if (tenantSource() === 'hub') startTenantEventFlows(app)")).toBe(GATE)
    expect(guardOf('setCoreHookApps(app)')).toBe(GATE)
  })

  it('opens self-hosted and on a shared deployment, never in Nivaro Cloud or on realtime', () => {
    expect(opens(SELF_HOSTED)).toBe(true)
    expect(opens(SHARED)).toBe(true)
    expect(opens(CLOUD)).toBe(false)
    expect(opens(SELF_HOSTED, true)).toBe(false)
  })

  it('under the cloud env the registrars are never called', () => {
    useEnv(CLOUD)
    try {
      if (opens(process.env as Record<string, string>)) registerCoreRecordHooks()
      for (const [name, fn] of Object.entries(spies)) expect(fn, name).not.toHaveBeenCalled()
    } finally {
      useEnv(SHARED)
    }
  })

  it('under the shared env each of the 20 registrars is called exactly once', () => {
    expect(opens(process.env as Record<string, string>)).toBe(true)
    expect(registerCoreRecordHooks()).toBe(true)
    expect(registerCoreRecordHooks()).toBe(false)
    expect(Object.keys(spies).sort()).toHaveLength(20)
    for (const [name, fn] of Object.entries(spies)) expect(fn, name).toHaveBeenCalledTimes(1)
  })
})

// ── Record hooks write through the app's own database ────────────────────────────────────────

describe('core record hooks per app', () => {
  it("a create's after-hooks (as the items service fires them) in app A write A's activity row; B's database gets nothing", async () => {
    registerCoreRecordHooks()
    const a = fakeDb()
    const b = fakeDb()
    await asApp('app-a-e1', a, () =>
      hooks.trigger('after', {
        collection: 'orders',
        action: 'create',
        keys: [7],
        payload: { name: 'Order 7' },
        result: { id: 7, name: 'Order 7' },
        database: db as never
      })
    )
    expect(a.inserts.map((i) => i.table)).toContain('nivaro_activity')
    expect(a.inserts.find((i) => i.table === 'nivaro_activity')?.row).toMatchObject({
      action: 'create',
      collection: 'orders',
      item: '7'
    })
    expect(b.tables).toEqual([])
    expect(b.inserts).toEqual([])
  })

  it("the audit level is read per app: A's 'none' never silences B", async () => {
    const a = fakeDb({ nivaro_collections: [{ accountability: '' }] })
    const b = fakeDb({ nivaro_collections: [{ accountability: 'all' }] })
    const write = () =>
      hooks.trigger('after', {
        collection: 'tickets',
        action: 'create',
        keys: [1],
        result: { id: 1 },
        database: db as never
      })
    await asApp('app-a-e1', a, write)
    await asApp('app-b-e2', b, write)
    expect(a.inserts.filter((i) => i.table === 'nivaro_activity')).toHaveLength(0)
    expect(b.inserts.filter((i) => i.table === 'nivaro_activity')).toHaveLength(1)
  })
})

// ── Event flows per app ──────────────────────────────────────────────────────────────────────

const eventFlow = (id: string, collections: string[]) => ({
  id,
  name: `Flow ${id}`,
  trigger: 'event',
  status: 'active',
  trigger_options: JSON.stringify({ timing: 'after', types: ['create'], collections })
})

describe('event flows per app', () => {
  beforeEach(() => {
    flow.executeFlow.mockClear()
    forgetTenantEventFlows()
  })
  afterEach(() => forgetTenantEventFlows())

  const created = (collection: string) =>
    hooks.trigger('after', {
      collection,
      action: 'create',
      keys: [1],
      payload: { x: 1 },
      result: { id: 1 },
      database: db as never
    })

  it("a flow saved in A fires on A's event and not on B's", async () => {
    startTenantEventFlows(appStub)
    startTenantEventFlows(appStub) // idempotent: one dispatcher
    const a = fakeDb({ nivaro_flows: [eventFlow('F-A', ['orders'])] })
    const b = fakeDb({ nivaro_flows: [] })

    await asApp('app-b-e2', b, () => created('orders'))
    await sleep()
    expect(flow.executeFlow).not.toHaveBeenCalled()

    await asApp('app-a-e1', a, () => created('orders'))
    await sleep()
    expect(flow.executeFlow).toHaveBeenCalledTimes(1)
    expect(flow.executeFlow.mock.calls[0]?.[0]).toMatchObject({
      flowId: 'F-A',
      trigger: 'after:create'
    })

    // A's flow listens to orders only.
    await asApp('app-a-e1', a, () => created('invoices'))
    await sleep()
    expect(flow.executeFlow).toHaveBeenCalledTimes(1)
    // B's database was never asked for A's flows, and A's flows were read from A's.
    expect(a.tables).toContain('nivaro_flows')
  })

  it('no process-wide hook per flow: nothing fires outside an app', async () => {
    const before = hooks.timings().length
    await created('orders')
    await sleep()
    expect(flow.executeFlow).not.toHaveBeenCalled()
    expect(hooks.timings().length).toBe(before)
  })

  it("saving a flow in A busts A's cache only (and registers no process-wide hook)", async () => {
    const a = fakeDb({ nivaro_flows: [eventFlow('F-A', ['orders'])] })
    const b = fakeDb({ nivaro_flows: [eventFlow('F-B', ['orders'])] })
    await asApp('app-a-e1', a, () => created('orders'))
    await asApp('app-b-e2', b, () => created('orders'))
    expect(cachedEventFlowTenants().sort()).toEqual(['app-a-e1', 'app-b-e2'])

    const server = Fastify()
    ;(server as unknown as { cron: unknown }).cron = {
      schedule: vi.fn(),
      unschedule: vi.fn(),
      list: () => []
    }
    await server.register(flowsRoutes)
    await server.ready()
    const hooksBefore = hooks.timings().length
    try {
      const res = await asApp('app-a-e1', a, () =>
        server.inject({
          method: 'POST',
          url: '/',
          payload: {
            name: 'New',
            trigger: 'event',
            status: 'active',
            trigger_options: { collections: ['orders'] }
          }
        })
      )
      expect(res.statusCode).toBe(201)
      expect(cachedEventFlowTenants()).toEqual(['app-b-e2'])
      expect(hooks.timings().length).toBe(hooksBefore)
    } finally {
      await server.close()
    }
  })
})
