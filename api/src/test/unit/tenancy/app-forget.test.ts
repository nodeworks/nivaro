import type { Knex } from 'knex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 final review (rest) I-1: an app that leaves a shared deployment's process and comes
// back must not meet the hand-keyed module caches it left behind (appKey maps, Map<tenant, …>,
// tenantState()). forgetAppState drops them too, and the Hub tenant source calls it when an app
// leaves the list AND when one (re)appears in it.

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => undefined }))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { forgetAppState } = await import('../../../services/app-state.js')
const { keyNamesApp, registerAppKeyed } = await import('../../../services/app-forget.js')
const { appKey } = await import('../../../services/app-keyed.js')
const { tenantState } = await import('../../../services/ai-tenant-state.js')
const fireAppLeft = vi.fn()
vi.mock('../../../services/tenancy/app-lifecycle.js', () => ({ fireAppLeft }))
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

describe('keyNamesApp', () => {
  it('matches the app key alone or between separators, never inside another key', () => {
    expect(keyNamesApp('appa-e1', 'appa-e1')).toBe(true)
    expect(keyNamesApp('appa-e1\u0000workflows', 'appa-e1')).toBe(true)
    expect(keyNamesApp('appa-e1|user|7', 'appa-e1')).toBe(true)
    expect(keyNamesApp('t:appa-e1:room', 'appa-e1')).toBe(true)
    expect(keyNamesApp('scope|appa-e1', 'appa-e1')).toBe(true)
    expect(keyNamesApp('appa-e12\u0000workflows', 'appa-e1')).toBe(false)
    expect(keyNamesApp('xappa-e1|k', 'appa-e1')).toBe(false)
    expect(keyNamesApp('\u0000workflows', '')).toBe(false)
    expect(keyNamesApp(42, 'appa-e1')).toBe(false)
  })
})

describe('forgetAppState drops hand-keyed entries', () => {
  it('appKey maps, Map<tenant, …>, Sets and tenantState() lose that app only', () => {
    const byAppKey = registerAppKeyed(new Map<string, string>())
    const byTenant = registerAppKeyed(new Map<string, string>())
    const seen = registerAppKeyed(new Set<string>())
    const state = tenantState(() => ({ n: 0 }))
    for (const app of ['appa-e1', 'appb-e2']) {
      inApp(app, () => {
        byAppKey.set(appKey('workflows'), app)
        byTenant.set(app, app)
        seen.add(`${app}|done`)
        state().n = 5
      })
    }
    byAppKey.set(appKey('workflows'), 'outside')
    expect(forgetAppState('appa-e1')).toBeGreaterThanOrEqual(4)
    expect(inApp('appa-e1', () => byAppKey.get(appKey('workflows')))).toBeUndefined()
    expect(byTenant.has('appa-e1')).toBe(false)
    expect(seen.has('appa-e1|done')).toBe(false)
    expect(inApp('appa-e1', () => state().n)).toBe(0)
    // The other app and the deployment's own '' entries stay.
    expect(inApp('appb-e2', () => byAppKey.get(appKey('workflows')))).toBe('appb-e2')
    expect(byTenant.get('appb-e2')).toBe('appb-e2')
    expect(seen.has('appb-e2|done')).toBe(true)
    expect(inApp('appb-e2', () => state().n)).toBe(5)
    expect(byAppKey.get(appKey('workflows'))).toBe('outside')
  })

  it('a Map subclass that rewrites keys (RelationCache shape) is emptied by its stored keys', () => {
    class Prefixed extends Map<string, number> {
      private k(key: string) {
        return `${(globalThis as { __app?: string }).__app ?? ''}\u0000${key}`
      }
      override get(key: string) {
        return super.get(this.k(key))
      }
      override set(key: string, v: number) {
        return super.set(this.k(key), v)
      }
      override delete(key: string) {
        return super.delete(this.k(key))
      }
    }
    const m = registerAppKeyed(new Prefixed())
    ;(globalThis as { __app?: string }).__app = 'appa-e1'
    m.set('rel', 1)
    ;(globalThis as { __app?: string }).__app = 'appb-e2'
    m.set('rel', 2)
    expect(forgetAppState('appa-e1')).toBeGreaterThanOrEqual(1)
    ;(globalThis as { __app?: string }).__app = 'appa-e1'
    expect(m.get('rel')).toBeUndefined()
    ;(globalThis as { __app?: string }).__app = 'appb-e2'
    expect(m.get('rel')).toBe(2)
    delete (globalThis as { __app?: string }).__app
  })
})

describe('the Hub tenant source forgets an app that (re)appears in its list', () => {
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

  it('a returning app starts clean even when its leave was never seen; apps already listed keep theirs', async () => {
    const answers = [
      list([tenant('appb-e2', 'b.example.com')]),
      list([tenant('appa-e1', 'a.example.com'), tenant('appb-e2', 'b.example.com')])
    ]
    let i = 0
    const fetchFn = vi.fn(async () => answers[Math.min(i++, answers.length - 1)].clone())
    const cache = registerAppKeyed(new Map<string, string>())
    const reg = (await startHubTenantSource({
      redis: null,
      fetch: fetchFn as unknown as typeof fetch,
      now: () => 1_000,
      refreshMs: 600_000
    })) as unknown as { refresh(): Promise<void> }
    // Entries left from an earlier stay of appa (its leave happened while no list was read).
    inApp('appa-e1', () => cache.set(appKey('relations'), 'stale'))
    inApp('appb-e2', () => cache.set(appKey('relations'), 'B'))
    await reg.refresh()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(inApp('appa-e1', () => cache.get(appKey('relations')))).toBeUndefined()
    expect(inApp('appb-e2', () => cache.get(appKey('relations')))).toBe('B')
  })
  it('fires app left for an app that left the list, not for one that appears or stays', async () => {
    const answers = [
      list([tenant('appa-e1', 'a.example.com'), tenant('appb-e2', 'b.example.com')]),
      list([tenant('appb-e2', 'b.example.com'), tenant('appc-e3', 'c.example.com')])
    ]
    let i = 0
    const fetchFn = vi.fn(async () => answers[Math.min(i++, answers.length - 1)].clone())
    const reg = (await startHubTenantSource({
      redis: null,
      fetch: fetchFn as unknown as typeof fetch,
      now: () => 1_000,
      refreshMs: 600_000
    })) as unknown as { refresh(): Promise<void> }
    fireAppLeft.mockClear()
    await reg.refresh()
    expect(fireAppLeft.mock.calls).toEqual([['appa-e1']])
  })
})
