import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { counted } = vi.hoisted(() => ({ counted: { n: 0 } }))

vi.mock('../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'whereNotNull']) chain[m] = () => chain
  chain.count = async () => [{ n: counted.n }]
  return { db: () => chain }
})
vi.mock('./record-events.js', () => ({
  announceRecordAspect: () => {},
  emitToTenant: () => {}
}))
vi.mock('./tenant-rooms.js', () => ({ currentTenantKey: () => '' }))

import {
  announceOwnerChange,
  changedOwnerRecords,
  OPEN_CAP,
  type OpenRecord,
  type OwnerLiveDeps,
  ownerChangeBaseline,
  ownerFingerprint,
  recordKey,
  resetOwnerLiveForTests,
  runOwnerAnnouncement,
  setOwnerLiveDepsForTests,
  sweepEndedDelegations
} from './owner-change-live.js'

function harness(open: OpenRecord[], owners: Record<string, string[]>) {
  const told: OpenRecord[] = []
  const tenantNotices: Array<Record<string, unknown>> = []
  const resolved: OpenRecord[][] = []
  const deps: OwnerLiveDeps = {
    openRecords: () => open,
    resolve: async (records) => {
      resolved.push(records)
      const out = new Map<string, string>()
      for (const r of records)
        out.set(recordKey(r.collection, r.item), ownerFingerprint(owners[r.item] ?? []))
      return out
    },
    announceRecord: (collection, item) => told.push({ collection, item }),
    announceTenant: (_t, p) => tenantNotices.push(p),
    bust: () => {}
  }
  setOwnerLiveDepsForTests(deps)
  return { told, tenantNotices, resolved, owners }
}

beforeEach(() => resetOwnerLiveForTests())
afterEach(() => {
  setOwnerLiveDepsForTests(null)
  vi.useRealTimers()
})

describe('ownerFingerprint / changedOwnerRecords', () => {
  it('is order- and case-insensitive', () => {
    expect(ownerFingerprint(['b', 'A', 'a', null])).toBe(ownerFingerprint(['a', 'B']))
  })
  it('tells records whose owners moved, or that nobody remembered', () => {
    const recs = [
      { collection: 'w', item: '1' },
      { collection: 'w', item: '2' },
      { collection: 'w', item: '3' }
    ]
    const before = new Map([
      [recordKey('w', '1'), 'A'],
      [recordKey('w', '2'), 'A']
    ])
    const after = new Map([
      [recordKey('w', '1'), 'A'],
      [recordKey('w', '2'), 'B'],
      [recordKey('w', '3'), 'A']
    ])
    expect(changedOwnerRecords(recs, (k) => before.get(k), after).map((r) => r.item)).toEqual([
      '2',
      '3'
    ])
  })
})

describe('owner-change scoping', () => {
  it('resolves only the records somebody has open, and tells only those whose owners moved', async () => {
    const open = [
      { collection: 'workflows', item: '1' },
      { collection: 'workflows', item: '2' },
      { collection: 'orders', item: '9' }
    ]
    const h = harness(open, { '1': ['u1'], '2': ['u2'], '9': ['u3'] })
    // Baseline before the change: all three remembered.
    expect(await ownerChangeBaseline()).toBe(3)
    // The matrix edit moves record 2 only.
    h.owners['2'] = ['u4']
    const out = await runOwnerAnnouncement('', {})
    expect(out.checked).toBe(true)
    expect(h.told).toEqual([{ collection: 'workflows', item: '2' }])
    // Never more records than were open.
    expect(h.resolved.every((batch) => batch.length <= open.length)).toBe(true)
    expect(h.tenantNotices).toEqual([expect.objectContaining({ checked: true })])
  })

  it('narrows to the collections named and says so to lists', async () => {
    const h = harness(
      [
        { collection: 'workflows', item: '1' },
        { collection: 'orders', item: '9' }
      ],
      { '1': ['u1'], '9': ['u3'] }
    )
    await runOwnerAnnouncement('', { collections: ['orders'] })
    expect(h.resolved[0]).toEqual([{ collection: 'orders', item: '9' }])
    expect(h.tenantNotices[0]).toMatchObject({ collections: ['orders'], checked: true })
  })

  it('too many open records: no per-record resolution, an unchecked tenant notice', async () => {
    const open = Array.from({ length: OPEN_CAP + 1 }, (_, i) => ({
      collection: 'w',
      item: String(i)
    }))
    const h = harness(open, {})
    const out = await runOwnerAnnouncement('', {})
    expect(out.checked).toBe(false)
    expect(h.resolved).toHaveLength(0)
    expect(h.told).toHaveLength(0)
    expect(h.tenantNotices[0].checked).toBeUndefined()
  })

  it('a burst of owner writes is one run', async () => {
    vi.useFakeTimers()
    const h = harness([{ collection: 'w', item: '1' }], { '1': ['u1'] })
    for (let i = 0; i < 20; i++) announceOwnerChange()
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.tenantNotices).toHaveLength(1)
    expect(h.resolved).toHaveLength(1)
  })

  it('a delegation that ran out announces; none ran out, nothing', async () => {
    vi.useFakeTimers()
    const h = harness([], {})
    counted.n = 0
    expect(await sweepEndedDelegations(new Date(0))).toBe(0)
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.tenantNotices).toHaveLength(0)
    counted.n = 2
    expect(await sweepEndedDelegations(new Date(0))).toBe(2)
    await vi.advanceTimersByTimeAsync(6000)
    expect(h.tenantNotices).toHaveLength(1)
  })
})
