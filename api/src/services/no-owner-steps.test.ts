import { describe, expect, it } from 'vitest'
import type { User } from '../types.js'
import {
  computeNoOwnerSteps,
  type NoOwnerDeps,
  type NoOwnerInstanceRow,
  type NoOwnerMoveRow,
  type NoOwnerStateRow,
  type NoOwnerViewDeps,
  noOwnerReportFor,
  noOwnerSectionRows,
  ownerOnlySteps,
  viewGroups,
  withNoAssignedOwner
} from './no-owner-steps.js'
import { noOwnerLine } from './ops-report/run.js'

// Rob 2026-11-13: ~468 inventory requests sat in Warehouse Submission with no
// owner group, so only admins could Submit to Warehouse — the creator saw
// only Send Back and Cancel. These fakes model that pipeline.

const T = 'TPL-IR'
const states: NoOwnerStateRow[] = [
  { id: 'S-DRAFT', template: T, key: 'started', label: 'Started', owners_not_required: 1 },
  { id: 'S-WH', template: T, key: 'warehouse_submission', label: 'Warehouse Submission' },
  { id: 'S-APP', template: T, key: 'approval', label: 'Approval' },
  { id: 'S-DONE', template: T, key: 'done', label: 'Done', is_terminal: 1 }
]
const moves: NoOwnerMoveRow[] = [
  { id: 'M-SUBMIT', template: T, from_state: 'S-WH', label: 'Submit to Warehouse' },
  // Owner-or-creator moves never make a step count on their own.
  { id: 'M-CANCEL', template: T, from_state: null, label: 'Cancel', allow_creator: 1 },
  { id: 'M-APPROVE', template: T, from_state: 's-app', label: 'Approve' },
  { id: 'M-AUTO', template: T, from_state: 'S-DONE', label: 'Archive', auto_trigger: 1 }
]

const inst = (id: string, item: string, state: string, day: number): NoOwnerInstanceRow => ({
  id,
  template: T,
  collection: 'inventory_request',
  item,
  current_state: state,
  started_at: new Date(Date.UTC(2026, 10, day))
})

function fakeDeps(over: Partial<NoOwnerDeps> = {}): NoOwnerDeps & { asked: string[][] } {
  const asked: string[][] = []
  const instances = [
    inst('I1', '37713', 'S-WH', 3),
    inst('I2', '37714', 'S-WH', 1),
    inst('I3', '37715', 'S-WH', 2),
    inst('I4', '40001', 'S-APP', 1),
    inst('I5', '40002', 's-app', 2),
    inst('I6', '50000', 'S-DRAFT', 1)
  ]
  return {
    asked,
    loadMoves: async () => moves,
    loadStates: async () => states,
    loadInstances: async (ids) => {
      asked.push(ids)
      return instances
    },
    // I3 has a warehouse owner; Approval has owners for I4 only.
    resolveAssigned: async (reqs) =>
      new Map(
        reqs.map((r) => [
          r.key,
          r.key === 'I3' || r.key === 'I4'
            ? [{ id: 'U1', email: 'a@x', first_name: 'Ann', last_name: 'Lee' }]
            : []
        ])
      ),
    conditionRecords: async () => ({ rows: new Map(), unchecked: [] }),
    cluster: async (_t, _c, records) => ({
      clusters: [
        {
          key: 'S-WH|inventory_request|fre',
          state_id: 'S-WH',
          dims: [{ field: 'warehouse', label: 'Warehouse', value: 'FRE' }],
          uncovered: [{ field: 'warehouse', label: 'Warehouse', value: 'FRE' }],
          reason: 'No owner group covers Warehouse FRE.',
          suggestion: null
        },
        {
          key: 'S-APP|inventory_request|z1',
          state_id: 'S-APP',
          dims: [{ field: 'zone', label: 'Zone', value: 'Zone 1' }],
          uncovered: [],
          reason: '',
          suggestion: null
        }
      ],
      clusterOf: new Map(
        records.map((r) => [
          r.item,
          r.current_state.toUpperCase() === 'S-WH'
            ? 'S-WH|inventory_request|fre'
            : 'S-APP|inventory_request|z1'
        ])
      )
    }),
    names: async () => ({
      templates: new Map([[T, 'Inventory Request']]),
      collections: new Map([['inventory_request', 'Inventory Requests']])
    }),
    ...over
  }
}

describe('ownerOnlySteps', () => {
  it('counts steps with an owner-only move the creator cannot make', () => {
    const steps = ownerOnlySteps(states, moves)
    expect([...steps.keys()].sort()).toEqual(['S-APP', 'S-WH'])
    const wh = steps.get('S-WH')
    expect(wh?.blocking.map((m) => m.id)).toEqual(['M-SUBMIT'])
    // Every owner-only move out of the step is listed, the creator one marked.
    expect(wh?.moves).toEqual([
      { id: 'M-SUBMIT', label: 'Submit to Warehouse', allow_creator: false, conditional: false },
      { id: 'M-CANCEL', label: 'Cancel', allow_creator: true, conditional: false }
    ])
  })

  it('skips terminal, owners-not-required and auto-only steps', () => {
    const steps = ownerOnlySteps(states, moves)
    expect(steps.has('S-DRAFT')).toBe(false)
    expect(steps.has('S-DONE')).toBe(false)
  })

  it('a step whose only owner-only move allows the creator does not count', () => {
    const steps = ownerOnlySteps(states, [moves[1]])
    expect(steps.size).toBe(0)
  })
})

describe('withNoAssignedOwner', () => {
  it('keeps only instances that resolved nobody', () => {
    const owners = new Map([
      ['A', []],
      ['B', [{ id: 'U', email: 'u@x', first_name: null, last_name: null }]]
    ])
    expect(withNoAssignedOwner([{ id: 'A' }, { id: 'B' }, { id: 'C' }], owners)).toEqual([
      { id: 'A' },
      { id: 'C' }
    ])
  })
})

describe('computeNoOwnerSteps', () => {
  it('groups unowned records by step, oldest first, with the uncovered values', async () => {
    const deps = fakeDeps()
    const r = await computeNoOwnerSteps(deps)
    // Only the counting steps' instances are read.
    expect(deps.asked[0].sort()).toEqual(['S-APP', 'S-WH'])
    expect(r.checked).toBe(5)
    expect(r.groups.map((g) => [g.state_label, g.records.length])).toEqual([
      ['Warehouse Submission', 2],
      ['Approval', 1]
    ])
    const wh = r.groups[0]
    expect(wh.template_name).toBe('Inventory Request')
    expect(wh.collection_label).toBe('Inventory Requests')
    expect(wh.records.map((x) => x.item)).toEqual(['37714', '37713'])
    expect(wh.clusters).toHaveLength(1)
    expect(wh.clusters[0].uncovered[0].value).toBe('FRE')
    // A mixed-case state id still lands in its step.
    expect(r.groups[1].records.map((x) => x.item)).toEqual(['40002'])
  })

  it('applies move conditions: records no blocking move applies to drop out', async () => {
    const conditional = moves.map((m) =>
      m.id === 'M-SUBMIT'
        ? {
            ...m,
            condition_rules: JSON.stringify([{ field: 'source', op: 'eq', value: 'MDSi' }])
          }
        : m
    )
    const deps = fakeDeps({
      loadMoves: async () => conditional,
      conditionRecords: async (_c, items) => ({
        rows: new Map(
          items
            .filter((i) => i !== '37714')
            .map((i) => [i, { id: i, source: i === '37713' ? 'MDSi' : 'Fusion' }])
        ),
        // 37714 could not be read: counted, flagged.
        unchecked: ['37714']
      })
    })
    const r = await computeNoOwnerSteps(deps)
    const wh = r.groups.find((g) => g.state_key === 'warehouse_submission')
    expect(wh?.records.map((x) => x.item).sort()).toEqual(['37713', '37714'])
    expect(wh?.conditions_unchecked).toBe(1)
  })

  // Prod 2026-11-14: 3 Workflows instances whose records were deleted showed as bare ids.
  it('leaves out instances whose record no longer exists', async () => {
    const deps = fakeDeps({
      existingItems: async (_c, ids) => new Set(ids.filter((id) => id !== '37713'))
    })
    const r = await computeNoOwnerSteps(deps)
    const wh = r.groups.find((g) => g.state_key === 'warehouse_submission')
    expect(wh?.records.map((x) => x.item)).toEqual(['37714'])
    expect(r.checked).toBe(4)
  })

  it('answers empty when no move is owner-only', async () => {
    const r = await computeNoOwnerSteps(fakeDeps({ loadMoves: async () => [] }))
    expect(r.groups).toEqual([])
    expect(r.checked).toBe(0)
  })
})

describe('the administrator view', () => {
  const viewDeps = (visible: Record<string, string[]>): NoOwnerViewDeps => ({
    visible: async (_u, collection) => new Set(visible[collection] ?? []),
    labels: async (_c, ids) => new Map(ids.map((id) => [id, `FDX25INV-${id}`])),
    creators: async (_c, ids) => new Map(ids.map((id) => [id, { id: 'U-DP', name: 'David Pry' }])),
    standIns: async (reqs) => new Map(reqs.map((r) => [r.key, ['David Pry']])),
    entered: async (list) =>
      new Map(list.map((l) => [l.instance.toUpperCase(), '2026-11-05T14:00:00.000Z']))
  })

  it('keeps only records the administrator may read and labels the sample', async () => {
    const shared = await computeNoOwnerSteps(fakeDeps())
    const r = await noOwnerReportFor(
      { id: 'ADMIN' } as User,
      shared,
      { sample: 5 },
      viewDeps({ inventory_request: ['37713', '40002'] })
    )
    expect(r.total).toBe(2)
    const wh = r.groups.find((g) => g.state_key === 'warehouse_submission')
    expect(wh?.count).toBe(1)
    expect(wh?.matrix_href).toBe('/pipelines/TPL-IR#owner-matrix')
    expect(wh?.clusters.map((c) => c.count)).toEqual([1])
    expect(wh?.sample).toEqual([
      {
        item: '37713',
        label: 'FDX25INV-37713',
        creator: { id: 'U-DP', name: 'David Pry' },
        stand_in: ['David Pry'],
        since: '2026-11-05T14:00:00.000Z',
        cluster: 'S-WH|inventory_request|fre'
      }
    ])
  })

  it('drops a step whose records the administrator cannot read', () => {
    const shared = {
      computed_at: '',
      checked: 1,
      groups: [
        {
          template_id: T,
          template_name: 'IR',
          state_id: 'S-WH',
          state_key: 'wh',
          state_label: 'WH',
          collection: 'inventory_request',
          collection_label: 'IR',
          moves: [],
          records: [{ item: '1', instance: 'I1', started_at: null, cluster: null }],
          clusters: [],
          conditions_unchecked: 0
        }
      ]
    }
    expect(viewGroups(shared, new Map())).toEqual([])
    const v = viewGroups(shared, new Map([['inventory_request', new Set(['1'])]]))
    expect(v[0].ungrouped).toBe(1)
  })
})

describe('daily report', () => {
  it('section rows: total first, then each step with what no group covers', async () => {
    const rows = noOwnerSectionRows(await computeNoOwnerSteps(fakeDeps()))
    expect(rows[0]).toMatchObject({ key: 'records', value: 3, better: 'down' })
    expect(rows[1]).toMatchObject({
      key: 'warehouse_submission_inventory_request',
      label: 'Inventory Request · Warehouse Submission',
      value: 2,
      note: 'No group covers Warehouse FRE'
    })
    for (const r of rows) expect(r.key).toMatch(/^[a-z][a-z0-9_]{0,40}$/)
  })

  it('email line links Coverage › No owner on the report origin, none at zero', () => {
    expect(noOwnerLine(0, 'https://x.test/health/daily-report?id=4')).toBeNull()
    expect(noOwnerLine(undefined, 'https://x.test/health/daily-report?id=4')).toBeNull()
    expect(noOwnerLine(468, 'https://x.test/health/daily-report?id=4')).toEqual({
      count: '468',
      text: 'records sit on steps nobody owns — only an administrator can move them.',
      url: 'https://x.test/coverage/no-owner'
    })
  })
})
