import { describe, expect, it, vi } from 'vitest'
import {
  diffSnapshot,
  evaluateAll,
  ROW_CAP,
  registerIntegrationSignal,
  runSignalsCycle,
  type SignalRow
} from '../../../services/integration-signals.js'

vi.mock('../../../services/integration-signal-settings.js', () => ({
  resolveThresholds: vi.fn(async (s: { thresholds: Array<{ key: string; default: number }> }) => ({
    enabled: true,
    severity: 'warn',
    thresholds: Object.fromEntries(s.thresholds.map((t) => [t.key, t.default]))
  }))
}))

const row = (key: string, extra: Partial<SignalRow> = {}): SignalRow => ({
  key,
  title: `t ${key}`,
  actions: [],
  ...extra
})

describe('diffSnapshot', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const earlier = new Date('2026-09-23T10:00:00Z')

  it('keeps first_seen for a key seen again and updates its payload', () => {
    const d = diffSnapshot(
      [{ id: 1, row_key: 'a', first_seen: earlier }],
      [row('a', { title: 'new title' })],
      now
    )
    expect(d.inserts).toEqual([])
    expect(d.updates).toEqual([{ id: 1, row: row('a', { title: 'new title' }) }])
    expect(d.clears).toEqual([])
  })

  it('inserts unseen keys with first_seen = since ?? now and clears vanished ones', () => {
    const d = diffSnapshot(
      [{ id: 1, row_key: 'gone', first_seen: earlier }],
      [row('b', { since: '2026-09-22T08:00:00Z' }), row('c')],
      now
    )
    expect(d.inserts.map((i) => [i.row.key, i.first_seen.toISOString()])).toEqual([
      ['b', '2026-09-22T08:00:00.000Z'],
      ['c', now.toISOString()]
    ])
    expect(d.clears).toEqual([1])
  })

  it('dedupes duplicate keys in the fresh list (last wins)', () => {
    const d = diffSnapshot([], [row('x', { title: 'one' }), row('x', { title: 'two' })], now)
    expect(d.inserts).toHaveLength(1)
    expect(d.inserts[0].row.title).toBe('two')
  })
})

describe('evaluateAll', () => {
  it('isolates a throwing and a hanging signal, caps rows, keeps the exact count', async () => {
    registerIntegrationSignal({
      id: 'test:many',
      label: 'many',
      description: '',
      tab: 'pushes',
      severity: 'warn',
      thresholds: [],
      evaluate: async () => ({
        count: 900,
        rows: Array.from({ length: 900 }, (_, i) => row(`k${i}`))
      })
    })
    registerIntegrationSignal({
      id: 'test:throws',
      label: 'throws',
      description: '',
      tab: 'pushes',
      severity: 'warn',
      thresholds: [],
      evaluate: async () => {
        throw new Error('boom')
      }
    })
    registerIntegrationSignal({
      id: 'test:hangs',
      label: 'hangs',
      description: '',
      tab: 'pushes',
      severity: 'warn',
      thresholds: [],
      evaluate: () => new Promise(() => {})
    })
    const res = await evaluateAll({
      only: ['test:many', 'test:throws', 'test:hangs'],
      budgetMs: 50
    })
    const by = Object.fromEntries(res.map((r) => [r.signal, r]))
    expect(by['test:many'].count).toBe(900)
    expect(by['test:many'].rows).toHaveLength(ROW_CAP)
    expect(by['test:throws'].error).toBe('boom')
    expect(by['test:hangs'].error).toMatch(/timed out/)
  })
})

describe('runSignalsCycle', () => {
  it('is single-flight: a second call while one runs awaits the same promise', async () => {
    let calls = 0
    registerIntegrationSignal({
      id: 'test:slow',
      label: 'slow',
      description: '',
      tab: 'pushes',
      severity: 'warn',
      thresholds: [],
      evaluate: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 20))
        return { count: 0, rows: [] }
      }
    })
    const [a, b] = await Promise.all([
      runSignalsCycle({ only: ['test:slow'] }),
      runSignalsCycle({ only: ['test:slow'] })
    ])
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })
})
