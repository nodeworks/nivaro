import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('./approval-brief.js', () => ({ isDerivedField: () => false }))
vi.mock('./ai-link-labels.js', () => ({
  linkLabelsAsUser: vi.fn(async () => ({})),
  linkLabelKey: (c: string, id: unknown) => `${c}:${String(id)}`
}))
vi.mock('./file-access.js', () => ({ readableFileIdList: vi.fn(async () => new Set()) }))
vi.mock('./permissions.js', () => ({ getAllowedFields: vi.fn(async () => null) }))
vi.mock('./record-access.js', () => ({
  compileAccessGates: vi.fn(),
  visibleIds: vi.fn(async () => new Set())
}))

import {
  type ChildEvent,
  changedFields,
  type HistRow,
  lineChanges,
  resubmissionWindow,
  type StateRow,
  shortValue,
  snapshotLabel
} from './resubmission-diff.js'

const states: StateRow[] = [
  { id: 'req', sort: 1, label: 'Requester' },
  { id: 'l1', sort: 2, label: 'Level 1' },
  { id: 'l2', sort: 3, label: 'Level 2' },
  { id: 'done', sort: 9, label: 'Completed', is_terminal: true },
  { id: 'cancel', sort: 0, label: 'Cancelled', is_terminal: 1 }
]
const h = (
  id: number,
  from: string | null,
  to: string,
  at: string,
  user = 'u1',
  comment: string | null = null
): HistRow => ({ id, from_state: from, to_state: to, user, comment, timestamp: at })

describe('resubmission window (rt8 #12)', () => {
  it('finds the latest send back from the step the record is back in', () => {
    const hist = [
      h(1, 'req', 'l1', '2026-11-01T10:00:00Z'),
      h(2, 'l1', 'req', '2026-11-02T10:00:00Z', 'beth', 'Need the quote'),
      h(3, 'req', 'l1', '2026-11-03T10:00:00Z', 'rob')
    ]
    const w = resubmissionWindow(hist, states, 'L1')
    expect(w?.sentBack.id).toBe(2)
    expect(w?.returned.id).toBe(3)
  })

  it('is null for a first arrival, a forward-only record or a different step', () => {
    expect(resubmissionWindow([h(1, 'req', 'l1', '2026-11-01T10:00:00Z')], states, 'l1')).toBe(null)
    // Sent back from Level 2, now at Level 1: Level 1 never sent it back.
    const hist = [
      h(1, 'req', 'l1', '2026-11-01T10:00:00Z'),
      h(2, 'l1', 'l2', '2026-11-02T10:00:00Z'),
      h(3, 'l2', 'req', '2026-11-03T10:00:00Z'),
      h(4, 'req', 'l1', '2026-11-04T10:00:00Z')
    ]
    expect(resubmissionWindow(hist, states, 'l1')).toBe(null)
    // …but Level 2 did, once it gets back there.
    const back = [...hist, h(5, 'l1', 'l2', '2026-11-05T10:00:00Z')]
    expect(resubmissionWindow(back, states, 'l2')?.sentBack.id).toBe(3)
    expect(resubmissionWindow(back, states, null)).toBe(null)
  })

  it('never counts a move to a finished step as a send back', () => {
    const hist = [
      h(1, 'req', 'l1', '2026-11-01T10:00:00Z'),
      h(2, 'l1', 'cancel', '2026-11-02T10:00:00Z'),
      h(3, 'cancel', 'l1', '2026-11-03T10:00:00Z')
    ]
    expect(resubmissionWindow(hist, states, 'l1')).toBe(null)
  })

  it('uses the newest send back when it bounced more than once', () => {
    const hist = [
      h(1, 'req', 'l1', '2026-11-01T10:00:00Z'),
      h(2, 'l1', 'req', '2026-11-02T10:00:00Z'),
      h(3, 'req', 'l1', '2026-11-03T10:00:00Z'),
      h(4, 'l1', 'req', '2026-11-04T10:00:00Z'),
      h(5, 'req', 'l1', '2026-11-05T10:00:00Z')
    ]
    expect(resubmissionWindow(hist, states, 'l1')?.sentBack.id).toBe(4)
  })
})

describe('changed fields as the viewer', () => {
  it('keeps the last value per field, drops unreadable, system and secret fields', () => {
    const out = changedFields(
      [
        { delta: { amount: 10, notes: 'a' }, user: 'u1', timestamp: '2026-11-02T10:00:00Z' },
        {
          delta: JSON.stringify({ amount: 12, cost_center: 'X', date_updated: 'x', api_key: 'k' }),
          user: 'u2',
          timestamp: '2026-11-03T10:00:00Z'
        }
      ],
      ['amount', 'notes', 'api_key', 'date_updated']
    )
    expect([...out.keys()].sort()).toEqual(['amount', 'notes'])
    expect(out.get('amount')).toMatchObject({ value: 12, by: 'u2' })
  })
})

describe('line changes', () => {
  const ev = (
    item: string,
    action: ChildEvent['action'],
    at: string,
    extra: Partial<ChildEvent> = {}
  ): ChildEvent => ({ item, action, delta: null, data: null, user: 'u1', timestamp: at, ...extra })

  it('says added, changed (readable fields only) and removed; add+remove says nothing', () => {
    const out = lineChanges(
      [
        ev('1', 'create', '2026-11-02T10:00:00Z'),
        ev('2', 'update', '2026-11-02T11:00:00Z', {
          delta: { qty: 3, secret_cost: 9, workflow: 7 }
        }),
        ev('3', 'delete', '2026-11-02T12:00:00Z', { data: { id: 3, name: 'Cable' } }),
        ev('4', 'create', '2026-11-02T13:00:00Z'),
        ev('4', 'delete', '2026-11-02T14:00:00Z'),
        ev('5', 'update', '2026-11-02T15:00:00Z', { delta: { secret_cost: 1 } })
      ],
      ['qty', 'name'],
      'workflow'
    )
    const byId = Object.fromEntries(out.map((c) => [c.id, c]))
    expect(byId['1'].kind).toBe('added')
    expect(byId['2']).toMatchObject({ kind: 'changed', fields: ['qty'] })
    expect(byId['3'].kind).toBe('removed')
    expect(byId['3'].snapshot).toEqual({ id: 3, name: 'Cable' })
    expect(byId['4']).toBeUndefined()
    // Only an unreadable field changed: nothing to show.
    expect(byId['5']).toBeUndefined()
  })
})

describe('labels and values', () => {
  it('names a removed line from readable template fields only', () => {
    expect(snapshotLabel({ name: 'Cable', cost: 4 }, '{{name}} ({{cost}})', ['name'])).toBe('Cable')
    expect(snapshotLabel({ cost: 4 }, '{{cost}}', ['name'])).toBe(null)
    expect(snapshotLabel({ title: 'T' }, null, null)).toBe('T')
    expect(snapshotLabel(null, '{{name}}', null)).toBe(null)
  })
  it('shortens values', () => {
    expect(shortValue(null)).toBe('(empty)')
    expect(shortValue(1234.5)).toBe('1,234.5')
    expect(shortValue('<p>Hi   there</p>')).toBe('Hi there')
    expect(shortValue(true)).toBe('Yes')
  })
})
