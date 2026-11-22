import { describe, expect, it, vi } from 'vitest'

// Ruling P5-10 item 2: on a shared deployment the incident-thread check and the agent-trigger
// prune run once per app, so their "last checked" marks are kept per app. A process-wide mark let
// the first app of a tick swallow every other app's window (review I2).

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

const { criticalCheckSince } = await import('../../../services/ops-incidents.js')
const { deliveryPruneDue } = await import('../../../services/agent-trigger-delivery.js')
const { runWithTenantDb } = await import('../../../db/tenant-context.js')

const inApp = <T>(id: string, fn: () => T) =>
  new Promise<T>((resolve) => runWithTenantDb({} as never, id, () => resolve(fn()), id))

describe('incident check window per app', () => {
  it('app B gets its own window after app A was checked', async () => {
    const t0 = 1_800_000_000_000
    const a1 = await inApp('A', () => criticalCheckSince(t0))
    const b1 = await inApp('B', () => criticalCheckSince(t0 + 1000))
    expect(a1.getTime()).toBe(t0 - 5 * 60_000)
    expect(b1.getTime()).toBe(t0 + 1000 - 5 * 60_000)
    expect((await inApp('A', () => criticalCheckSince(t0 + 60_000))).getTime()).toBe(t0)
    expect((await inApp('B', () => criticalCheckSince(t0 + 61_000))).getTime()).toBe(t0 + 1000)
  })
})

describe('agent-trigger delivery prune per app', () => {
  it('each app prunes on its own hourly clock', async () => {
    const t0 = 1_800_000_000_000
    expect(await inApp('A', () => deliveryPruneDue(t0))).toBe(true)
    expect(await inApp('A', () => deliveryPruneDue(t0 + 1000))).toBe(false)
    expect(await inApp('B', () => deliveryPruneDue(t0 + 1000))).toBe(true)
    expect(await inApp('A', () => deliveryPruneDue(t0 + 3_600_001))).toBe(true)
  })
})
