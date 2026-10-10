import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ settings: { replay_auto_signals: true } as Record<string, unknown> }))

vi.mock('../../../db/index.js', () => ({
  db: () => {
    const chain: Record<string, unknown> = {}
    chain.where = () => chain
    chain.first = async () => h.settings
    return chain
  }
}))

import {
  AUTO_MAX_PER_HOUR,
  consumeAutoToken,
  fireReplaySignal,
  memoryStore,
  mintAutoToken,
  pagePrefixesFor,
  resetAutoSignalsForTest,
  takeHourSlot
} from '../../../services/replay-auto-signals.js'

beforeEach(() => {
  resetAutoSignalsForTest()
  h.settings = { replay_auto_signals: true }
})

describe('auto-record tokens', () => {
  it('are single-use and bound to the person they were minted for', async () => {
    const store = memoryStore()
    const t = await mintAutoToken(store, 'abc-USER', 'rage-click')
    expect(await consumeAutoToken(store, t, 'someone-else')).toBeNull()
    // the failed attempt burned it: a stolen token cannot be retried either
    expect(await consumeAutoToken(store, t, 'ABC-user')).toBeNull()
    const t2 = await mintAutoToken(store, 'abc-USER', 'monitor')
    expect(await consumeAutoToken(store, t2, 'ABC-user')).toBe('monitor')
    expect(await consumeAutoToken(store, t2, 'ABC-user')).toBeNull()
    expect(await consumeAutoToken(store, 'not-a-token', 'ABC-user')).toBeNull()
  })

  it('expire after two minutes', async () => {
    let now = 1_000_000
    const store = memoryStore(() => now)
    const t = await mintAutoToken(store, 'U1', 'breaker')
    now += 121_000
    expect(await consumeAutoToken(store, t, 'U1')).toBeNull()
  })
})

describe('the hourly cap', () => {
  it('allows AUTO_MAX_PER_HOUR starts per hour for the instance', async () => {
    const store = memoryStore()
    const at = Date.parse('2026-10-10T12:10:00Z')
    for (let i = 0; i < AUTO_MAX_PER_HOUR; i++) expect(await takeHourSlot(store, at)).toBe(true)
    expect(await takeHourSlot(store, at)).toBe(false)
    expect(await takeHourSlot(store, Date.parse('2026-10-10T13:00:00Z'))).toBe(true)
  })
})

describe('fireReplaySignal', () => {
  it('does nothing while replay_auto_signals is off', async () => {
    h.settings = { replay_auto_signals: false }
    const emit = vi.fn()
    expect(
      await fireReplaySignal('rage-click', { userIds: ['U1'] }, { emit, store: memoryStore() })
    ).toEqual({
      sent: 0,
      reason: 'off'
    })
    expect(emit).not.toHaveBeenCalled()
  })

  it('asks the person who raged and everyone on the affected pages, once each', async () => {
    const store = memoryStore()
    const emit = vi.fn()
    const r = await fireReplaySignal(
      'monitor',
      { userIds: ['u1'], pathPrefixes: ['/collections/orders'] },
      { emit, store, usersOnPrefixes: () => ['U1', 'U2'] }
    )
    expect(r).toEqual({ sent: 2 })
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['u1', 'U2'])
    const payload = emit.mock.calls[0][1]
    expect(payload).toMatchObject({ signal: 'monitor', minutes: 3 })
    expect(await consumeAutoToken(store, payload.token, 'U1')).toBe('monitor')
    // a person is asked at most once per ten minutes
    const again = await fireReplaySignal('rage-click', { userIds: ['U1'] }, { emit, store })
    expect(again.sent).toBe(0)
  })

  it('stops at the hourly cap', async () => {
    const store = memoryStore()
    const emit = vi.fn()
    const people = Array.from({ length: 10 }, (_, i) => `P${i}`)
    let sent = 0
    for (let i = 0; i < 2; i++) {
      const r = await fireReplaySignal(
        'breaker',
        { userIds: people.map((p) => `${p}-${i}`) },
        { emit, store }
      )
      sent += r.sent
      if (i === 1) expect(r.reason).toBe('cap')
    }
    expect(sent).toBe(AUTO_MAX_PER_HOUR)
  })
})

describe('pagePrefixesFor', () => {
  it('maps an API path or a breaker entity to the pages that show it', () => {
    expect(pagePrefixesFor('/api/items/orders/5')).toEqual([
      '/collections/orders',
      '/records/orders'
    ])
    expect(pagePrefixesFor('items/claims')).toEqual(['/collections/claims', '/records/claims'])
    expect(pagePrefixesFor('/api/items/nivaro_users')).toEqual([])
    expect(pagePrefixesFor('/api/health')).toEqual([])
  })
})
