import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  acquireReadSlot,
  type ReadSlot,
  readGateProcessFigures,
  readGateStats,
  resetReadGate
} from '../../../services/read-gate.js'

// Hub shared deployment: the apps of one process share the heavy-read budget fairly. Each app
// has a cap inside it (HEAVY_READ_PER_APP, and its own pool size minus one), a freed slot goes to
// the app holding the fewest, and one busy app can never hold every slot. Nivaro Cloud keeps its
// independent per-tenant gates.

const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example.test',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(40)
}
const KEYS = ['CLOUD_META_DB_URL', ...Object.keys(SHARED)]
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetReadGate()
})

const tick = () => new Promise((r) => setTimeout(r, 0))

/** A fake app pool: only its size is read. */
const poolOf = (max: number) => ({ client: { config: { pool: { max } } } }) as never

function inApp<T>(app: string, fn: () => T, poolMax = 10): T {
  let out!: T
  runWithTenantDb(
    poolOf(poolMax),
    app,
    () => {
      out = fn()
    },
    app
  )
  return out
}

/** A slot request in an app that records when it was granted. */
function ask(app: string, who: string, poolMax = 10) {
  const state: { slot: ReadSlot | null } = { slot: null }
  const p = inApp(app, () => acquireReadSlot(who), poolMax).then((s) => {
    state.slot = s
    return s
  })
  return { p, state }
}

describe('read gate on a Hub shared deployment', () => {
  it('caps one app at its share of the process budget', async () => {
    Object.assign(process.env, SHARED)
    resetReadGate({ global: 4, perApp: 2, perUser: 10, maxWaitMs: 60_000 })
    const a = [ask('A', 'a1'), ask('A', 'a2'), ask('A', 'a3')]
    await tick()
    expect(a.map((x) => !!x.state.slot)).toEqual([true, true, false])
    // Another app still gets slots while A is at its cap.
    const b = [ask('B', 'b1'), ask('B', 'b2')]
    await tick()
    expect(b.every((x) => !!x.state.slot)).toBe(true)
    expect(readGateProcessFigures()).toMatchObject({
      limit: 4,
      per_app: 2,
      active: 4,
      queued: 1,
      apps_active: 2,
      apps_waiting: 1
    })
  })

  it("never more than the app's own pool size minus one", async () => {
    Object.assign(process.env, SHARED)
    resetReadGate({ global: 10, perApp: 8, perUser: 10, maxWaitMs: 60_000 })
    const a = [ask('A', 'a1', 3), ask('A', 'a2', 3), ask('A', 'a3', 3)]
    await tick()
    expect(a.map((x) => !!x.state.slot)).toEqual([true, true, false])
    expect(inApp('A', () => readGateStats(), 3).limits.global).toBe(2)
  })

  it('a freed slot goes to the app holding the fewest, not the oldest waiter', async () => {
    Object.assign(process.env, SHARED)
    resetReadGate({ global: 3, perApp: 3, perUser: 10, maxWaitMs: 60_000 })
    const a = [ask('A', 'a1'), ask('A', 'a2'), ask('A', 'a3')]
    await tick()
    expect(a.every((x) => !!x.state.slot)).toBe(true)
    // The process budget is full: A queues first, then B.
    const a4 = ask('A', 'a4')
    const b1 = ask('B', 'b1')
    await tick()
    expect(a4.state.slot).toBeNull()
    expect(b1.state.slot).toBeNull()
    // One of A's slots frees: B (holding none) gets it, though A's request is older.
    a[0].state.slot?.release()
    await tick()
    expect(b1.state.slot).not.toBeNull()
    expect(a4.state.slot).toBeNull()
    // The next release goes to A again.
    a[1].state.slot?.release()
    await tick()
    expect(a4.state.slot).not.toBeNull()
  })

  it('each app sees only its own gate', async () => {
    Object.assign(process.env, SHARED)
    resetReadGate({ global: 4, perApp: 2, perUser: 10, maxWaitMs: 60_000 })
    ask('A', 'a1')
    ask('A', 'a2')
    await tick()
    expect(inApp('B', () => readGateStats()).active).toBe(0)
    expect(inApp('A', () => readGateStats()).active).toBe(2)
  })

  it('Nivaro Cloud keeps independent per-tenant gates (no shared budget)', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta.example.test/meta'
    resetReadGate({ global: 2, perApp: 1, perUser: 10, maxWaitMs: 60_000 })
    const a = [ask('A', 'a1'), ask('A', 'a2')]
    const b = [ask('B', 'b1'), ask('B', 'b2')]
    await tick()
    // TENANT_POOL_MAX - 1 = 4 caps nothing here; the global 2 applies per tenant, not across.
    expect([...a, ...b].every((x) => !!x.state.slot)).toBe(true)
  })
})
