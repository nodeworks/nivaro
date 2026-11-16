import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime ideas 3 + 18 (2026-11-14): `$files` / `$related` notices ride other records' writes —
// coalesced per collection, capped, never values.

const h = vi.hoisted(() => ({
  emits: [] as Array<{ room: string; payload: Record<string, unknown> }>,
  mode: {} as Record<string, string>,
  rows: {} as Record<string, Array<Record<string, unknown>>>,
  queries: [] as Array<{ table: string; calls: Array<[string, unknown[]]> }>,
  columns: {} as Record<string, string[]>,
  relations: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../services/event-journal.js', () => ({
  journaledEmit: vi.fn(async (room: string, _event: string, payload: Record<string, unknown>) => {
    h.emits.push({ room, payload })
    return { seq: 1, path: 'adapter', room }
  })
}))
vi.mock('../../../services/collection-live-mode.js', () => ({
  liveModeNow: (c: string) => h.mode[c] ?? null
}))
vi.mock('../../../services/request-trace.js', () => ({ noteRealtimeEmit: () => {} }))
vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    const q = { table, calls: [] as Array<[string, unknown[]]> }
    h.queries.push(q)
    const builder: Record<string, unknown> = {}
    for (const m of [
      'distinct',
      'where',
      'whereNull',
      'whereNotNull',
      'whereIn',
      'whereRaw',
      'limit'
    ])
      builder[m] = (...args: unknown[]) => {
        q.calls.push([m, args])
        return builder
      }
    builder.catch = () => builder
    // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for a knex builder
    builder.then = (res: (v: unknown) => unknown) => Promise.resolve(h.rows[table] ?? []).then(res)
    return builder
  }
  return { db }
})
vi.mock('../../../services/items.js', () => ({
  getActualColumns: async (t: string) => new Set(h.columns[t] ?? [])
}))
vi.mock('../../../services/collections.js', () => ({
  getRelations: async () => h.relations
}))

import {
  announceJunctionLinkedParents,
  announceRelatedParents,
  fileFieldsOf,
  flushForeignAspects,
  junctionForwardsOf,
  junctionParentAspects,
  planNotice,
  queueForeignAspect,
  RELATED_ID_CAP,
  recordsCarryingFile,
  relatedParentsOf
} from '../../../services/related-announce.js'

// workflow_lines → workflows (M2O), workflows → projects (M2O), workflows ↔ divisions (junction),
// workflows ↔ files (file junction), workflows.cover (file field), created_by → users (system).
const RELS = [
  { many_collection: 'workflow_lines', many_field: 'workflow', one_collection: 'workflows' },
  { many_collection: 'workflow_lines', many_field: 'user_created', one_collection: 'nivaro_users' },
  { many_collection: 'workflows', many_field: 'project', one_collection: 'projects' },
  { many_collection: 'workflows', many_field: 'cover', one_collection: 'nivaro_files' },
  {
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'zones',
    junction_field: 'divisions_id'
  },
  {
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    one_field: null,
    junction_field: 'workflows_id'
  },
  {
    many_collection: 'workflows_files',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'files',
    junction_field: 'directus_files_id'
  },
  {
    many_collection: 'workflows_files',
    many_field: 'directus_files_id',
    one_collection: 'directus_files',
    one_field: null,
    junction_field: 'workflows_id'
  }
]

beforeEach(() => {
  vi.useFakeTimers()
  h.emits = []
  h.mode = {}
  h.rows = {}
  h.queries = []
  h.columns = {}
  h.relations = RELS
})
afterEach(() => {
  flushForeignAspects()
  vi.useRealTimers()
})

describe('relatedParentsOf — who a child row points at', () => {
  it('follows many-to-one legs, skips junction legs and system tables', () => {
    const out = relatedParentsOf('workflow_lines', RELS, [
      { id: 5, workflow: 77, user_created: 'u-1' }
    ])
    expect(out).toEqual([{ collection: 'workflows', id: '77' }])
  })

  it('names both parents when the row moved, once each, reading expanded objects', () => {
    const out = relatedParentsOf('workflow_lines', RELS, [
      { id: 5, workflow: 1 },
      { id: 5, workflow: { id: 2 } },
      { id: 5, workflow: 2 }
    ])
    expect(out.map((p) => p.id).sort()).toEqual(['1', '2'])
  })

  it('never names the row itself (self reference)', () => {
    const rels = [{ many_collection: 'tasks', many_field: 'parent', one_collection: 'tasks' }]
    expect(relatedParentsOf('tasks', rels, [{ id: 3, parent: 3 }])).toEqual([])
    expect(relatedParentsOf('tasks', rels, [{ id: 3, parent: 4 }])).toEqual([
      { collection: 'tasks', id: '4' }
    ])
  })
})

describe('file aspects', () => {
  it('knows a record’s own file fields', () => {
    expect([...fileFieldsOf('workflows', RELS)]).toEqual(['cover'])
  })

  it('a file junction adds $files to the parent’s notice; any junction adds $related', () => {
    const fileLeg = RELS[6]
    const zoneLeg = RELS[4]
    expect(junctionParentAspects('workflows_files', fileLeg, RELS)).toEqual(['$related', '$files'])
    expect(junctionParentAspects('workflows_divisions', zoneLeg, RELS)).toEqual(['$related'])
  })
})

describe('coalescing + cap', () => {
  it('a burst of child writes on one parent is ONE notice after the window', async () => {
    for (let i = 0; i < 500; i++)
      announceRelatedParents('workflow_lines', RELS, [{ id: i, workflow: 77 }])
    expect(h.emits).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].room).toBe('collection:workflows')
    expect(h.emits[0].payload).toEqual({
      collection: 'workflows',
      item: '77',
      changed_fields: ['$related']
    })
    // Never an action (not a write of the parent's own columns) and never a value.
    expect(h.emits[0].payload).not.toHaveProperty('action')
  })

  it('several parents in a window go out as one id list', async () => {
    for (const p of [1, 2, 3]) announceRelatedParents('workflow_lines', RELS, [{ workflow: p }])
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].payload).toMatchObject({
      collection: 'workflows',
      items: ['1', '2', '3'],
      coalesced: true,
      changed_fields: ['$related']
    })
  })

  it('past the cap a window becomes one collection-wide notice', async () => {
    for (let p = 0; p <= RELATED_ID_CAP; p++)
      announceRelatedParents('workflow_lines', RELS, [{ workflow: p }])
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].payload).toMatchObject({ many: true, items: null, coalesced: true })
    // Thousands: ids stop being kept at all.
    for (let p = 0; p < 5000; p++) queueForeignAspect('workflows', p, '$related')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits[1].payload).toEqual({
      collection: 'workflows',
      item: '*',
      changed_fields: ['$related']
    })
  })

  it('aspects keep separate windows; a collection switched off hears nothing', async () => {
    queueForeignAspect('workflows', 1, '$related')
    queueForeignAspect('workflows', 1, '$files')
    h.mode.staging = 'off'
    queueForeignAspect('staging', 1, '$related')
    queueForeignAspect('nivaro_users', 1, '$related')
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits.map((e) => e.payload.changed_fields)).toEqual([['$related'], ['$files']])
  })

  it('planNotice: single, list, whole', () => {
    expect(planNotice('a', '$files', [])).toBeNull()
    expect(planNotice('a', '$files', ['1'])).toEqual({
      collection: 'a',
      item: '1',
      changed_fields: ['$files']
    })
    expect(planNotice('a', '$files', [], true)).toMatchObject({ item: '*' })
  })
})

describe('junction forwards — a changed record tells the records it is linked to', () => {
  it('only junctions whose parent side shows the link', () => {
    expect(junctionForwardsOf('divisions', RELS)).toEqual([
      {
        junction: 'workflows_divisions',
        childFk: 'divisions_id',
        parentFk: 'workflows_id',
        parent: 'workflows'
      }
    ])
    // workflows' leg into the junction points at divisions, whose side has no one_field.
    expect(junctionForwardsOf('workflows', RELS)).toEqual([])
  })

  it('one read per junction per window, then $related to each linked parent', async () => {
    h.columns.workflows_divisions = ['id', 'workflows_id', 'divisions_id']
    h.rows.workflows_divisions = [{ workflows_id: 10 }, { workflows_id: 11 }]
    announceJunctionLinkedParents('divisions', RELS, [3])
    announceJunctionLinkedParents('divisions', RELS, [4])
    await vi.advanceTimersByTimeAsync(1100)
    const reads = h.queries.filter((q) => q.table === 'workflows_divisions')
    expect(reads).toHaveLength(1)
    expect(reads[0].calls.find((c) => c[0] === 'whereIn')?.[1]).toEqual([
      'divisions_id',
      ['3', '4']
    ])
    expect(reads[0].calls.find((c) => c[0] === 'limit')?.[1]).toEqual([RELATED_ID_CAP + 1])
    await vi.advanceTimersByTimeAsync(1100)
    expect(h.emits[0].payload).toMatchObject({ collection: 'workflows', items: ['10', '11'] })
  })

  it('a record linked to more parents than the cap announces collection-wide', async () => {
    h.columns.workflows_divisions = ['id', 'workflows_id', 'divisions_id']
    h.rows.workflows_divisions = Array.from({ length: RELATED_ID_CAP + 1 }, (_, i) => ({
      workflows_id: i
    }))
    announceJunctionLinkedParents('divisions', RELS, [3])
    await vi.advanceTimersByTimeAsync(2300)
    expect(h.emits).toHaveLength(1)
    expect(h.emits[0].payload).toMatchObject({ collection: 'workflows', item: '*' })
  })

  it('a junction whose table or columns do not exist is never read (relations are a claim)', async () => {
    h.columns.workflows_divisions = ['id', 'workflows_id']
    announceJunctionLinkedParents('divisions', RELS, [3])
    await vi.advanceTimersByTimeAsync(2300)
    expect(h.queries.filter((q) => q.table === 'workflows_divisions')).toHaveLength(0)
    expect(h.emits).toHaveLength(0)
  })
})

describe('recordsCarryingFile — rename / replace / delete reach the records showing the file', () => {
  it('direct file fields and file junctions, capped', async () => {
    h.columns.workflows = ['id', 'cover']
    h.columns.workflows_files = ['id', 'workflows_id', 'directus_files_id']
    h.rows.workflows = [{ id: 1 }]
    h.rows.workflows_files = [{ workflows_id: 2 }, { workflows_id: 3 }]
    const out = await recordsCarryingFile('f-1')
    expect(out).toEqual([
      { collection: 'workflows', id: '1' },
      { collection: 'workflows', id: '2' },
      { collection: 'workflows', id: '3' }
    ])
    h.rows.workflows_files = Array.from({ length: RELATED_ID_CAP + 1 }, (_, i) => ({
      workflows_id: i
    }))
    expect(await recordsCarryingFile('f-1')).toContainEqual({ collection: 'workflows', id: '*' })
  })

  it('a record whose comment shows the file (a pasted image) hears it too, once', async () => {
    const file = '539abe70-b2f5-4c06-8f19-195bb6ca37e3'
    h.columns.workflows = ['id', 'cover']
    h.rows.workflows = [{ id: 7 }]
    h.rows.workflows_files = []
    h.rows.nivaro_comments = [
      { collection: 'workflows', item: 7 },
      { collection: 'workflows', item: 8 },
      { collection: 'nivaro_users', item: 'x' }
    ]
    expect(await recordsCarryingFile(file)).toEqual([
      { collection: 'workflows', id: '7' },
      { collection: 'workflows', id: '8' }
    ])
    const q = [...h.queries].reverse().find((x) => x.table === 'nivaro_comments')
    expect(q?.calls).toContainEqual(['where', ['text', 'like', `%${file}%`]])
  })
})
