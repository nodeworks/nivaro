import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryKnex } from '../../fixtures/memory-knex.js'

// applyOwnerSheetOps: one transaction, refused (nothing written) when the
// matrix no longer hashes to what the preview read.

const live = vi.hoisted(() => ({
  snapshot: { dimensions: [], groups: [], members: [], teams: [] }
}))
vi.mock('../../../services/owner-matrix-versions.js', () => ({
  readOwnerMatrix: vi.fn(async () => live.snapshot),
  snapshotHash: (json: string) => `hash:${json.length}:${json}`
}))
vi.mock('../../../db/index.js', () => ({ db: {} }))

import type { SheetOps } from '../../../services/owner-matrix-sheet.js'
import {
  applyOwnerSheetOps,
  OwnerSheetStaleError
} from '../../../services/owner-matrix-sheet-db.js'

const G1 = 'G1'
const G2 = 'G2'

function tables() {
  return {
    nivaro_pipeline_owner_groups: [
      { id: G1, template: 'T', state: 'S1', name: null, filters: null, is_default: 0, priority: 0 },
      { id: G2, template: 'T', state: 'S1', name: null, filters: null, is_default: 0, priority: 0 }
    ],
    nivaro_pipeline_owner_group_users: [
      { group: G1, user: 'U1' },
      { group: G1, user: 'U2' },
      { group: G2, user: 'U1' }
    ],
    nivaro_pipeline_owner_group_teams: [{ group: G2, team_id: 7 }]
  }
}

function knexWithTrx(t: ReturnType<typeof tables>) {
  const k = memoryKnex(t) as ReturnType<typeof memoryKnex> & {
    transaction: (fn: (trx: unknown) => Promise<void>) => Promise<void>
  }
  k.transaction = async (fn) => fn(k)
  return k
}

const ops: SheetOps = {
  deletes: [G2],
  inserts: [
    {
      row: 4,
      state: 'S2',
      name: 'New',
      filters: [{ field: 'regions.short_name', op: 'eq', value: 'East', id_value: 1 }],
      is_default: false,
      priority: 3,
      users: ['U3'],
      teams: [9]
    }
  ],
  updates: [
    {
      id: G1,
      set: { priority: 2, state: 'S3' },
      add_users: ['U3'],
      remove_users: ['U2'],
      add_teams: [],
      remove_teams: []
    }
  ]
}

const HASH = `hash:${JSON.stringify(live.snapshot).length}:${JSON.stringify(live.snapshot)}`

beforeEach(() => {
  live.snapshot = { dimensions: [], groups: [], members: [], teams: [] }
})

describe('applyOwnerSheetOps', () => {
  it('writes every op: removed group with its links, new group with people + teams, updates', async () => {
    const t = tables()
    const k = knexWithTrx(t)
    const r = await applyOwnerSheetOps('T', HASH, ops, k as never)
    expect(r).toMatchObject({
      groups_added: 1,
      groups_removed: 1,
      groups_changed: 1,
      people_added: 2,
      people_removed: 2,
      teams_added: 1,
      teams_removed: 1
    })
    const newId = r.inserted[0].id
    expect(t.nivaro_pipeline_owner_groups.map((g) => [g.id, g.state, g.priority])).toEqual([
      [G1, 'S3', 2],
      [newId, 'S2', 3]
    ])
    const created = t.nivaro_pipeline_owner_groups[1] as Record<string, unknown>
    expect(JSON.parse(String(created.filters))).toEqual(ops.inserts[0].filters)
    const links = (rows: Array<Record<string, unknown>>) => rows.map(({ id: _id, ...rest }) => rest)
    expect(links(t.nivaro_pipeline_owner_group_users)).toEqual([
      { group: G1, user: 'U1' },
      { group: newId, user: 'U3' },
      { group: G1, user: 'U3' }
    ])
    expect(links(t.nivaro_pipeline_owner_group_teams)).toEqual([{ group: newId, team_id: 9 }])
  })

  it('stale: the matrix changed since the preview — throws and writes nothing', async () => {
    const t = tables()
    const before = JSON.stringify(t)
    live.snapshot = {
      dimensions: [],
      groups: [{ id: 'G9' }],
      members: [],
      teams: []
    } as never
    await expect(
      applyOwnerSheetOps('T', HASH, ops, knexWithTrx(t) as never)
    ).rejects.toBeInstanceOf(OwnerSheetStaleError)
    expect(JSON.stringify(t)).toBe(before)
  })
})
