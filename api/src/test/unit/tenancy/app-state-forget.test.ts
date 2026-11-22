import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6, Task 16 (T22 carry M-2): an app that leaves a shared deployment's process
// (unplaced, or moved away at retire_source) leaves no per-app module state behind there.
// forgetAppState drops that app's slot in every appMap / appSet / appBox; the Hub tenant source
// calls it for every app the new list no longer names.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => undefined }))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { appBox, appMap, appSet, forgetAppState } = await import('../../../services/app-state.js')
const { resetHubTenantSourceForTests, startHubTenantSource } = await import(
  '../../../services/tenancy/hub-source.js'
)

const fakeKnex = {} as Knex
function inApp<T>(app: string, fn: () => T): T {
  let out!: T
  runWithTenantDb(
    fakeKnex,
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

describe('forgetAppState', () => {
  it('drops one app’s slot in every container, keeps the others and the deployment’s own', () => {
    const m = appMap<string, string>()
    const s = appSet<string>()
    const b = appBox(() => 0)
    for (const app of ['app-a-e1', 'app-b-e2']) {
      inApp(app, () => {
        m.set('k', app)
        s.add(app)
        b.value = 7
      })
    }
    m.set('k', 'outside')
    expect(forgetAppState('app-a-e1')).toBeGreaterThanOrEqual(3)
    expect(inApp('app-a-e1', () => m.get('k'))).toBeUndefined()
    expect(inApp('app-a-e1', () => s.has('app-a-e1'))).toBe(false)
    expect(inApp('app-a-e1', () => b.value)).toBe(0)
    expect(inApp('app-b-e2', () => m.get('k'))).toBe('app-b-e2')
    expect(inApp('app-b-e2', () => b.value)).toBe(7)
    expect(m.get('k')).toBe('outside')
    // The deployment's own slot is never dropped; an unknown app drops nothing.
    expect(forgetAppState('')).toBe(0)
    expect(m.get('k')).toBe('outside')
    expect(forgetAppState('never-seen-e9')).toBe(0)
  })
})

describe('the Hub tenant source forgets an app it no longer lists', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    process.env.HUB_URL = 'https://hub.example/'
    process.env.HUB_DEPLOYMENT_TOKEN = `hubtok-${'q'.repeat(40)}`
    process.env.ENCRYPTION_KEY = 'a'.repeat(64)
    delete process.env.CLOUD_META_DB_URL
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    resetHubTenantSourceForTests()
    process.env = { ...saved }
    vi.restoreAllMocks()
  })

  const tenant = (id: string, host: string) => ({
    id,
    app_key: id.split('-e')[0],
    env_key: 'prod',
    name: id,
    status: 'active',
    hostnames: [host],
    db: { client: 'pg', connection: `postgres://u:p@db.internal/${id.replace(/-/g, '_')}` }
  })
  const list = (tenants: unknown[]) =>
    new Response(
      JSON.stringify({
        data: { deployment: 'shared-a', generated_at: '2026-11-22T00:00:00Z', tenants }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )

  it('a tenant gone from the list (unplaced / retired here) loses its cached state; the others keep theirs', async () => {
    const answers = [
      list([tenant('appa-e1', 'a.example.com'), tenant('appb-e2', 'b.example.com')]),
      list([tenant('appb-e2', 'b.example.com')])
    ]
    let i = 0
    const fetchFn = vi.fn(async () => answers[Math.min(i++, answers.length - 1)].clone())
    const cache = appMap<string, string>()
    const reg = await startHubTenantSource({
      redis: null,
      fetch: fetchFn as unknown as typeof fetch,
      now: () => 1_000,
      refreshMs: 600_000
    })
    // start() read the first list (both apps).
    expect(fetchFn).toHaveBeenCalledTimes(1)
    inApp('appa-e1', () => cache.set('workflows', 'A'))
    inApp('appb-e2', () => cache.set('workflows', 'B'))
    await reg.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(inApp('appa-e1', () => cache.get('workflows'))).toBeUndefined()
    expect(inApp('appb-e2', () => cache.get('workflows'))).toBe('B')
  })
})
