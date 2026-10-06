import { describe, expect, it } from 'vitest'
import { ownerRouteFor } from '../../../routes/owner-matrix-versions.js'
import {
  COMPRESS_OVER_BYTES,
  decodeSnapshot,
  diffOwnerMatrix,
  encodeSnapshot,
  normalizeSnapshot,
  type OwnerMatrixSnapshot,
  snapshotHash
} from '../../../services/owner-matrix-versions.js'

const G1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const G2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const G3 = 'aaaaaaaa-0000-0000-0000-000000000003'
const S = 'bbbbbbbb-0000-0000-0000-000000000001'
const U1 = 'cccccccc-0000-0000-0000-000000000001'
const U2 = 'cccccccc-0000-0000-0000-000000000002'

function group(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    template: 'T',
    state: S,
    name: null,
    filters: '[{"field":"region","op":"eq","value":"BLT"}]',
    sort: 0,
    is_default: false,
    priority: 0,
    max_wip: null,
    ...over
  }
}

function snap(over: Partial<OwnerMatrixSnapshot> = {}): OwnerMatrixSnapshot {
  return {
    dimensions: [{ id: 1, binding: 9, field: 'region', label: 'Region', sort: 0 }],
    groups: [group(G1), group(G2)],
    members: [
      { group: G1, user: U1 },
      { group: G2, user: U2 }
    ],
    teams: [{ group: G1, team_id: 4 }],
    ...over
  }
}

describe('normalizeSnapshot', () => {
  it('serializes the same matrix the same way whatever the case or order', () => {
    const a = snap()
    const b = snap({
      groups: [group(G2.toUpperCase()), group(G1)],
      members: [
        { group: G2, user: U2.toUpperCase() },
        { group: G1.toUpperCase(), user: U1 }
      ]
    })
    expect(snapshotHash(JSON.stringify(normalizeSnapshot(a)))).toBe(
      snapshotHash(JSON.stringify(normalizeSnapshot(b)))
    )
  })
})

describe('encodeSnapshot / decodeSnapshot', () => {
  it('stores small snapshots as plain JSON and big ones gzip+base64', () => {
    const small = JSON.stringify(snap())
    expect(encodeSnapshot(small)).toBe(small)
    const many = snap({
      groups: Array.from({ length: 2000 }, (_, i) =>
        group(`aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`)
      )
    })
    const json = JSON.stringify(many)
    expect(json.length).toBeGreaterThan(COMPRESS_OVER_BYTES)
    const stored = encodeSnapshot(json)
    expect(stored.startsWith('gz:')).toBe(true)
    expect(stored.length).toBeLessThan(json.length / 5)
    expect(decodeSnapshot(stored).groups).toHaveLength(2000)
  })
})

describe('diffOwnerMatrix', () => {
  it('reports nothing for an identical matrix (filter whitespace is not a change)', () => {
    const b = snap({
      groups: [
        group(G1, { filters: '[ { "field": "region", "op": "eq", "value": "BLT" } ]' }),
        group(G2)
      ]
    })
    const d = diffOwnerMatrix(snap(), b)
    expect(d.totals).toMatchObject({ groups_added: 0, groups_removed: 0, groups_changed: 0 })
  })

  it('names cells added, removed and changed — filters, members, teams', () => {
    const to = snap({
      groups: [
        group(G1, { filters: '[{"field":"region","op":"eq","value":"HRT"}]', priority: 5 }),
        group(G3)
      ],
      members: [
        { group: G1, user: U2 },
        { group: G3, user: U1 }
      ],
      teams: []
    })
    const d = diffOwnerMatrix(snap(), to)
    expect(d.groups.added.map((g) => g.id)).toEqual([G3.toUpperCase()])
    expect(d.groups.added[0].members_added).toEqual([U1.toUpperCase()])
    expect(d.groups.removed.map((g) => g.id)).toEqual([G2.toUpperCase()])
    const changed = d.groups.changed[0]
    expect(changed.id).toBe(G1.toUpperCase())
    expect(changed.fields.map((f) => f.field).sort()).toEqual(['filters', 'priority'])
    expect(changed.fields.find((f) => f.field === 'filters')?.to).toEqual([
      { field: 'region', op: 'eq', value: 'HRT' }
    ])
    expect(changed.members_added).toEqual([U2.toUpperCase()])
    expect(changed.members_removed).toEqual([U1.toUpperCase()])
    expect(changed.teams_removed).toEqual([4])
    expect(d.totals).toMatchObject({
      groups_added: 1,
      groups_removed: 1,
      groups_changed: 1,
      members_added: 2,
      members_removed: 2,
      teams_removed: 1
    })
  })

  it('diffs dimensions by id', () => {
    const to = snap({
      dimensions: [
        { id: 1, binding: 9, field: 'region', label: 'Region (row)', sort: 0 },
        { id: 2, binding: 9, field: 'division', label: 'Zone', sort: 1 }
      ]
    })
    const d = diffOwnerMatrix(snap(), to)
    expect(d.dimensions.added.map((x) => x.id)).toEqual([2])
    expect(d.dimensions.changed[0].fields).toEqual([
      { field: 'label', from: 'Region', to: 'Region (row)' }
    ])
  })
})

describe('ownerRouteFor', () => {
  it('matches owner mutation routes and leaves everything else alone', () => {
    expect(ownerRouteFor('PATCH', '/api/pipelines/owner-groups/:groupId')?.note).toBe(
      'before owner group update'
    )
    expect(ownerRouteFor('POST', '/api/pipelines/:id/owner-groups/bulk-add')).toBeTruthy()
    expect(ownerRouteFor('DELETE', '/api/pipelines/owner-group-users/:id')).toBeTruthy()
    expect(ownerRouteFor('GET', '/api/pipelines/owner-groups/:groupId')).toBeUndefined()
    expect(ownerRouteFor('PATCH', '/api/pipelines/states/:stateId')).toBeUndefined()
    expect(ownerRouteFor('POST', '/api/pipelines/:id/transitions')).toBeUndefined()
  })
})
