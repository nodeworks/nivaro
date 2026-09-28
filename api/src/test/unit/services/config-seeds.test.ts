import { beforeEach, describe, expect, it, vi } from 'vitest'

const store: Record<string, Array<Record<string, unknown>>> = { warehouses: [] }
const writes: Array<{ op: string; body: Record<string, unknown>; id?: unknown }> = []
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(
    async (
      _u: unknown,
      collection: string,
      q: { filter: Record<string, { _eq?: unknown; _null?: boolean }> }
    ) => ({
      data: (store[collection] ?? []).filter((r) =>
        Object.entries(q.filter).every(([k, v]) =>
          v._null ? r[k] == null : String(r[k]) === String(v._eq)
        )
      )
    })
  ),
  createOne: vi.fn(async (_u: unknown, collection: string, body: Record<string, unknown>) => {
    const { _change_reason, ...row } = body
    const created = { id: 100 + store[collection].length, ...row }
    store[collection].push(created)
    writes.push({ op: 'create', body })
    return created
  }),
  updateOne: vi.fn(
    async (_u: unknown, collection: string, id: unknown, body: Record<string, unknown>) => {
      const { _change_reason, ...patch } = body
      Object.assign(store[collection].find((r) => r.id === id)!, patch)
      writes.push({ op: 'update', id, body })
    }
  )
}))
vi.mock('../../../services/users.js', () => ({
  getUser: vi.fn(async (id: string) => ({ id, email: 'a@b' }))
}))
vi.mock('../../../services/ops-tasks.js', () => ({ registerOpsTask: vi.fn() }))
vi.mock('../../../db/index.js', () => ({
  db: () => ({
    leftJoin: () => ({
      where: () => ({
        whereIn: () => ({
          orderBy: () => ({
            first: async () => ({
              timestamp: '2026-09-20T00:00:00Z',
              first_name: 'Kim',
              last_name: 'Lee'
            })
          })
        })
      })
    })
  })
}))

import {
  applySeed,
  clearConfigSeeds,
  registerConfigSeed,
  seedDrift
} from '../../../services/config-seeds.js'
import { registerOpsTask } from '../../../services/ops-tasks.js'

const rc = {
  log: vi.fn(),
  progress: vi.fn(),
  cancelled: () => false,
  userId: 'admin',
  dryRun: false
}

describe('config seeds (#828)', () => {
  beforeEach(() => {
    clearConfigSeeds()
    store.warehouses = [
      { id: 1, name: 'PAE77', ordering_system: 'mdsi', note: 'edited by hand' },
      { id: 2, name: 'WAPUY', ordering_system: null, note: null }
    ]
    writes.length = 0
    vi.mocked(registerOpsTask).mockClear()
  })

  it('refuses a system table, an id match, and a seed with no rows', () => {
    const base = {
      key: 'x:y',
      collection: 'warehouses',
      match_by: ['name'],
      rows: [],
      mode: 'fill-only' as const
    }
    expect(() => registerConfigSeed({ ...base, collection: 'nivaro_users' })).toThrow(
      /business collection/
    )
    expect(() => registerConfigSeed({ ...base, match_by: ['id'] })).toThrow(/never id/)
    expect(() => registerConfigSeed({ ...base, rows: undefined })).toThrow(/rows or file/)
  })

  it('registers the seed as an operational task', () => {
    registerConfigSeed(
      { key: 'x:wh', collection: 'warehouses', match_by: ['name'], rows: [], mode: 'fill-only' },
      'x'
    )
    expect(vi.mocked(registerOpsTask).mock.calls[0][0]).toMatchObject({
      key: 'seed:x:wh',
      group: 'Config seeds'
    })
  })

  it('reports drift per row with who changed it, and fill-only writes only empty columns', async () => {
    registerConfigSeed(
      {
        key: 'x:wh',
        collection: 'warehouses',
        match_by: ['name'],
        rows: [
          { name: 'PAE77', ordering_system: 'mdsi', note: 'from the file' },
          { name: 'WAPUY', ordering_system: 'fusion_transfer', note: 'new' },
          { name: 'ORTIG', ordering_system: 'fusion_transfer' }
        ],
        mode: 'fill-only'
      },
      'x'
    )
    const d = await seedDrift('x:wh', 'admin')
    expect(d).toMatchObject({ rows: 3, missing: 1, differs: 2, same: 0, fillable: 2 })
    expect(d.details[0]).toMatchObject({
      key: 'name=PAE77',
      status: 'differs',
      changed_by: 'Kim Lee',
      fields: [{ field: 'note', empty_in_db: false }]
    })
    expect(d.details[2]).toMatchObject({ key: 'name=ORTIG', status: 'missing' })

    const out = await applySeed('x:wh', rc)
    expect(out.counts).toEqual({ created: 1, updated: 1, unchanged: 1, ambiguous: 0 })
    // PAE77's hand-edited note stays; WAPUY's empty columns are filled; ORTIG is created with the reason
    expect(store.warehouses.find((r) => r.name === 'PAE77')?.note).toBe('edited by hand')
    expect(store.warehouses.find((r) => r.name === 'WAPUY')).toMatchObject({
      ordering_system: 'fusion_transfer',
      note: 'new'
    })
    expect(writes.find((w) => w.op === 'create')?.body).toMatchObject({
      name: 'ORTIG',
      _change_reason: 'seed:x:wh'
    })
  })

  it('authoritative overwrites a differing value', async () => {
    registerConfigSeed(
      {
        key: 'x:auth',
        collection: 'warehouses',
        match_by: ['name'],
        rows: [{ name: 'PAE77', note: 'the file wins' }],
        mode: 'authoritative'
      },
      'x'
    )
    const out = await applySeed('x:auth', rc)
    expect(out.counts).toMatchObject({ updated: 1 })
    expect(store.warehouses[0].note).toBe('the file wins')
  })
})
