import { describe, expect, it, vi } from 'vitest'
import {
  diffSnapshot,
  evaluateAll,
  isReoccurrence,
  type OpenRow,
  planSnapshotWrite,
  ROW_CAP,
  registerIntegrationSignal,
  runSignalsCycle,
  type SignalRow
} from '../../../services/integration-signals.js'

// Only `resolveThresholds` needs faking (evaluateAll's own settings lookup) —
// `isReoccurrence` (integration-signals.ts) calls the REAL `rowOccurrence`
// from this module, so the mock must keep everything else genuine rather
// than replacing the whole module.
vi.mock('../../../services/integration-signal-settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../services/integration-signal-settings.js')>()
  return {
    ...actual,
    resolveThresholds: vi.fn(
      async (s: { thresholds: Array<{ key: string; default: number }> }) => ({
        enabled: true,
        severity: 'warn',
        thresholds: Object.fromEntries(s.thresholds.map((t) => [t.key, t.default]))
      })
    )
  }
})

const row = (key: string, extra: Partial<SignalRow> = {}): SignalRow => ({
  key,
  title: `t ${key}`,
  actions: [],
  ...extra
})

/** diffSnapshot only ever reads id/row_key/first_seen — payload/group_key are
 *  dummy filler here since planSnapshotWrite (not diffSnapshot) is what reads them. */
const openRow = (
  id: number,
  row_key: string,
  first_seen: Date,
  extra: Partial<OpenRow> = {}
): OpenRow => ({
  id,
  row_key,
  first_seen,
  payload: '{}',
  group_key: null,
  ...extra
})

describe('diffSnapshot', () => {
  const now = new Date('2026-09-23T12:00:00Z')
  const earlier = new Date('2026-09-23T10:00:00Z')

  it('keeps first_seen for a key seen again and updates its payload', () => {
    const d = diffSnapshot([openRow(1, 'a', earlier)], [row('a', { title: 'new title' })], now)
    expect(d.inserts).toEqual([])
    expect(d.updates).toEqual([{ id: 1, row: row('a', { title: 'new title' }) }])
    expect(d.clears).toEqual([])
  })

  it('inserts unseen keys with first_seen = since ?? now and clears vanished ones', () => {
    const d = diffSnapshot(
      [openRow(1, 'gone', earlier)],
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

describe('planSnapshotWrite', () => {
  const now = new Date('2026-09-23T12:00:00Z')

  it('touch only: unchanged payload and group_key advance last_seen without a row write', () => {
    const freshRow = row('a', { group: 'g1' })
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(freshRow), group_key: 'g1' })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.touchIds).toEqual([1])
    expect(plan.changed).toEqual([])
    expect(plan.inserts).toEqual([])
    expect(plan.clears).toEqual([])
  })

  it('changed: a differing payload string goes in `changed`, not `touchIds`', () => {
    const staleRow = row('a', { title: 'old title' })
    const freshRow = row('a', { title: 'new title' })
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(staleRow), group_key: null })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.touchIds).toEqual([])
    expect(plan.changed).toEqual([{ id: 1, payload: JSON.stringify(freshRow), group_key: null }])
  })

  it('changed: an identical payload string but a drifted group_key still counts as changed', () => {
    const freshRow = row('a', { group: 'g-new' })
    // The stored payload is byte-identical to what the fresh row serializes
    // to — only the separate group_key column has drifted (e.g. from a
    // truncation-length change in an older release). The comparison must
    // check group_key independently of payload, not payload alone.
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(freshRow), group_key: 'g-old' })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.touchIds).toEqual([])
    expect(plan.changed).toEqual([{ id: 1, payload: JSON.stringify(freshRow), group_key: 'g-new' }])
  })

  it('new row: an unseen key plans an insert carrying the untruncated key, the truncated row_key/group_key, the serialized payload and first_seen', () => {
    const freshRow = row('b', { since: '2026-09-22T08:00:00Z', group: 'g1' })
    const diff = diffSnapshot([], [freshRow], now)
    const plan = planSnapshotWrite([], diff)
    expect(plan.inserts).toEqual([
      {
        key: 'b',
        row_key: 'b',
        group_key: 'g1',
        payload: JSON.stringify(freshRow),
        first_seen: new Date('2026-09-22T08:00:00Z')
      }
    ])
    expect(plan.changed).toEqual([])
    expect(plan.touchIds).toEqual([])
  })

  it('string-compares serialized payloads rather than deep-comparing: differently key-ordered but semantically-equal objects are treated as changed', () => {
    // Same fields, different insertion order — JSON.stringify preserves
    // property order, so these two strings differ even though a deep-equal
    // check would call them the same record. Per spec this MUST still
    // register as changed: the stored string is exactly what was written
    // last time, so plain string equality is the correct (and only) check.
    const stored = JSON.stringify({ title: 't a', key: 'a', actions: [] })
    const freshRow = row('a') // serializes as {"key":"a","title":"t a","actions":[]}
    expect(JSON.stringify(freshRow)).not.toBe(stored)
    const open = [openRow(1, 'a', now, { payload: stored, group_key: null })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.touchIds).toEqual([])
    expect(plan.changed).toEqual([{ id: 1, payload: JSON.stringify(freshRow), group_key: null }])
  })

  it('carries clears straight through from the diff, untouched', () => {
    const open = [openRow(9, 'gone', now)]
    const diff = diffSnapshot(open, [], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.clears).toEqual([9])
  })

  it('a changed row whose occurrence moved on is reported in reoccurredKeys', () => {
    const staleRow = row('a', { occurrence: 'run:1' })
    const freshRow = row('a', { occurrence: 'run:2' })
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(staleRow), group_key: null })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.changed).toEqual([{ id: 1, payload: JSON.stringify(freshRow), group_key: null }])
    expect(plan.reoccurredKeys).toEqual(['a'])
  })

  it('a changed row whose occurrence is unchanged is NOT a re-occurrence, even though the payload differs', () => {
    const staleRow = row('a', { occurrence: 'run:1', detail: 'old detail' })
    const freshRow = row('a', { occurrence: 'run:1', detail: 'new detail' })
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(staleRow), group_key: null })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.changed).toEqual([{ id: 1, payload: JSON.stringify(freshRow), group_key: null }])
    expect(plan.reoccurredKeys).toEqual([])
  })

  it('an unchanged row (touch-only) never appears in reoccurredKeys', () => {
    const freshRow = row('a', { occurrence: 'run:1', group: 'g1' })
    const open = [openRow(1, 'a', now, { payload: JSON.stringify(freshRow), group_key: 'g1' })]
    const diff = diffSnapshot(open, [freshRow], now)
    const plan = planSnapshotWrite(open, diff)
    expect(plan.touchIds).toEqual([1])
    expect(plan.reoccurredKeys).toEqual([])
  })

  it('an insert (unseen key) is never in reoccurredKeys — it is already reported via `inserts`', () => {
    const freshRow = row('b')
    const diff = diffSnapshot([], [freshRow], now)
    const plan = planSnapshotWrite([], diff)
    expect(plan.reoccurredKeys).toEqual([])
  })
})

describe('isReoccurrence', () => {
  it('same explicit occurrence: not a re-occurrence', () => {
    const stored = JSON.stringify(row('a', { occurrence: 'run:1', detail: 'x' }))
    expect(isReoccurrence(stored, row('a', { occurrence: 'run:1', detail: 'y' }))).toBe(false)
  })

  it('a new explicit occurrence on the same key: a re-occurrence', () => {
    const stored = JSON.stringify(row('a', { occurrence: 'run:1' }))
    expect(isReoccurrence(stored, row('a', { occurrence: 'run:2' }))).toBe(true)
  })

  it('payload change without an occurrence change is not a re-occurrence', () => {
    const stored = JSON.stringify(row('a', { occurrence: 'run:1', title: 'old title' }))
    expect(isReoccurrence(stored, row('a', { occurrence: 'run:1', title: 'new title' }))).toBe(
      false
    )
  })

  it('neither side sets an explicit occurrence: falls back to the since/hash compare, and a real change registers', () => {
    // No `since` on either side, so both fall through to stableRowHash — a
    // genuine (non-digit) content change moves the hash, which IS a
    // re-occurrence under the fallback.
    const stored = JSON.stringify(row('a', { title: 'has expired' }))
    expect(isReoccurrence(stored, row('a', { title: 'has failed' }))).toBe(true)
  })

  it('neither side sets an explicit occurrence and nothing meaningful changed: not a re-occurrence', () => {
    const stored = JSON.stringify(row('a', { title: 't', detail: 'gap 4' }))
    expect(isReoccurrence(stored, row('a', { title: 't', detail: 'gap 9' }))).toBe(false)
  })

  it('stored had NO explicit occurrence and the fresh row now sets one for the first time: NOT a re-occurrence', () => {
    // This is the "first cycle after this signal starts setting `occurrence`"
    // case (pre-existing rows, or genuinely pre-349 rows, whose stored JSON
    // has no `occurrence` key at all) — the since/hash fallback for the
    // stored side would almost certainly differ from the new real
    // occurrence value, which would otherwise flag EVERY open row as
    // freshly re-occurred the moment a signal's evaluate() gains an
    // explicit `occurrence`. That is a richer-identity upgrade, not a new
    // instance of the problem, so it is deliberately excluded.
    const stored = JSON.stringify(row('a', { title: 't', detail: 'd' }))
    expect(isReoccurrence(stored, row('a', { title: 't', detail: 'd', occurrence: 'run:1' }))).toBe(
      false
    )
  })

  it('stored had an explicit occurrence and the fresh row drops it: falls back and can still register a change', () => {
    // The reverse direction is NOT special-cased — losing explicit identity
    // is unusual enough that comparing via the fallback (which will very
    // likely differ from the old explicit value) is the safer default.
    const stored = JSON.stringify(row('a', { occurrence: 'run:1', title: 'old' }))
    expect(isReoccurrence(stored, row('a', { title: 'new' }))).toBe(true)
  })

  it('an unparsable stored payload is never a re-occurrence', () => {
    expect(isReoccurrence('not json', row('a', { occurrence: 'run:1' }))).toBe(false)
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
