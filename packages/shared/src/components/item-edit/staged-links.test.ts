import { describe, expect, it } from 'vitest'
import { foldStagedLinks, foldStagedRows } from './staged-links'
import type { CMSRelation } from './types'

// The record form sends every staged relation in the record's own write
// (2026-10-23: a Zone-scoped user's new workflow lost its Zone / Region /
// Sub-type because they were left for a step after the create).

let nextId = 1
const rel = (r: Partial<CMSRelation>): CMSRelation =>
  ({
    id: nextId++,
    many_collection: null,
    many_field: null,
    one_collection: null,
    one_field: null,
    junction_field: null,
    ...r
  }) as CMSRelation

// workflows ⇄ divisions (M2M), workflows ⇄ owners (M2A), workflows → lines (O2M)
const RELS: CMSRelation[] = [
  rel({
    many_collection: 'workflows_divisions',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'divisions',
    junction_field: 'divisions_id'
  }),
  rel({
    many_collection: 'workflows_divisions',
    many_field: 'divisions_id',
    one_collection: 'divisions',
    junction_field: 'workflows_id'
  }),
  rel({
    many_collection: 'workflows_contacts',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'contacts',
    junction_field: 'item'
  }),
  {
    ...rel({
      many_collection: 'workflows_contacts',
      many_field: 'item',
      one_collection: null,
      junction_field: 'workflows_id'
    }),
    one_allowed_collections: 'nivaro_users',
    one_collection_field: 'collection'
  } as CMSRelation,
  rel({
    many_collection: 'workflow_lines',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: 'lines'
  })
]

describe('foldStagedLinks', () => {
  it('create: every staged pick goes in the body (M2M ids, M2A {collection,id})', () => {
    const payload: Record<string, unknown> = { project: 8170 }
    const folded = foldStagedLinks({
      collection: 'workflows',
      relations: RELS,
      links: new Map<string, unknown[]>([
        ['divisions', ['2']],
        ['contacts', ['U1']]
      ]),
      unlinks: new Map(),
      payload,
      isNew: true
    })
    expect([...folded].sort()).toEqual(['contacts', 'divisions'])
    expect(payload).toEqual({
      project: 8170,
      divisions: ['2'],
      contacts: [{ collection: 'nivaro_users', id: 'U1' }]
    })
  })

  it('create: merges with a value the draft already carried, without duplicates', () => {
    const payload: Record<string, unknown> = { divisions: ['1'] }
    foldStagedLinks({
      collection: 'workflows',
      relations: RELS,
      links: new Map([['divisions', ['1', '3']]]),
      unlinks: new Map(),
      payload,
      isNew: true
    })
    expect(payload.divisions).toEqual(['1', '3'])
  })

  it('a key no alias on this collection names stays for the follow-up step', () => {
    const payload: Record<string, unknown> = {}
    const folded = foldStagedLinks({
      collection: 'workflows',
      relations: RELS,
      links: new Map([['other_junction.thing_id', ['9']]]),
      unlinks: new Map(),
      payload,
      isNew: true
    })
    expect(folded.size).toBe(0)
    expect(payload).toEqual({})
  })

  it('update: adds + removals by related id, kept links ride along', () => {
    const payload: Record<string, unknown> = {}
    const folded = foldStagedLinks({
      collection: 'workflows',
      relations: RELS,
      links: new Map([['divisions', ['3']]]),
      unlinks: new Map([['divisions', new Set<unknown>([11])]]),
      payload,
      isNew: false,
      committed: () => [
        { id: 11, divisions_id: 1 },
        { id: 12, divisions_id: 2 }
      ]
    })
    expect(folded.has('divisions')).toBe(true)
    expect(payload.divisions).toEqual({ create: [2, '3'], delete: [1] })
  })

  it('update: an unlink whose junction row is unknown stays for the step', () => {
    const payload: Record<string, unknown> = {}
    const folded = foldStagedLinks({
      collection: 'workflows',
      relations: RELS,
      links: new Map(),
      unlinks: new Map([['divisions', new Set<unknown>([99])]]),
      payload,
      isNew: false,
      committed: () => [{ id: 11, divisions_id: 1 }]
    })
    expect(folded.size).toBe(0)
    expect(payload).toEqual({})
  })
})

describe('foldStagedRows', () => {
  it('a new record carries its staged child rows as a nested set', () => {
    const payload: Record<string, unknown> = {}
    const folded = foldStagedRows({
      collection: 'workflows',
      relations: RELS,
      rows: new Map([['workflow_lines.workflow', [{ qty: 1 }, { qty: 2, id: null }]]]),
      payload
    })
    expect(folded.has('workflow_lines.workflow')).toBe(true)
    expect(payload.lines).toEqual([{ qty: 1 }, { qty: 2 }])
  })

  it('rows with their own staged children, or a skipped key, stay for the step', () => {
    const payload: Record<string, unknown> = {}
    const folded = foldStagedRows({
      collection: 'workflows',
      relations: RELS,
      rows: new Map([['workflow_lines.workflow', [{ qty: 1, __o2m_splits: [{ a: 1 }] }]]]),
      payload
    })
    expect(folded.size).toBe(0)
    const skipped = foldStagedRows({
      collection: 'workflows',
      relations: RELS,
      rows: new Map([['workflow_lines.workflow', [{ qty: 1 }]]]),
      payload,
      skip: new Set(['workflow_lines.workflow'])
    })
    expect(skipped.size).toBe(0)
    expect(payload).toEqual({})
  })
})
