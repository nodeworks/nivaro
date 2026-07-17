import { describe, expect, it } from 'vitest'
import { findM2MRelation } from '../../../services/items.js'

// Mirrors the live workflows/files landscape: a legacy alias field named after the
// junction TABLE ('workflows_files') alongside the relation's real one_field ('files').
const rels = [
  {
    id: 82,
    many_collection: 'workflows_files',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'files',
    junction_field: 'directus_files_id'
  },
  {
    id: 81,
    many_collection: 'workflows_files',
    many_field: 'directus_files_id',
    one_collection: 'nivaro_files',
    one_field: null,
    junction_field: 'workflows_id'
  },
  {
    id: 545,
    many_collection: 'workflows_nivaro_files',
    many_field: 'workflows_id',
    one_collection: 'workflows',
    one_field: 'nivaro_files',
    junction_field: 'nivaro_files_id'
  },
  {
    id: 546,
    many_collection: 'workflows_nivaro_files',
    many_field: 'nivaro_files_id',
    one_collection: 'nivaro_files',
    one_field: null,
    junction_field: 'workflows_id'
  }
  // biome-ignore lint/suspicious/noExplicitAny: minimal relation fixtures
] as any[]

describe('findM2MRelation', () => {
  it('resolves an exact one_field alias', () => {
    expect(findM2MRelation('nivaro_files', 'workflows', rels)).toEqual({
      junction: 'workflows_nivaro_files',
      fkToParent: 'workflows_id',
      fkToOther: 'nivaro_files_id',
      otherCollection: 'nivaro_files'
    })
  })

  it('resolves a junction-table-name fallback alias (legacy naming)', () => {
    expect(findM2MRelation('workflows_files', 'workflows', rels)).toEqual({
      junction: 'workflows_files',
      fkToParent: 'workflows_id',
      fkToOther: 'directus_files_id',
      otherCollection: 'nivaro_files'
    })
  })

  it('prefers the exact one_field match over the fallback', () => {
    // 'files' matches rel 82's one_field directly — same junction either way here,
    // but the exact pass must win before any fallback scan runs.
    expect(findM2MRelation('files', 'workflows', rels)?.junction).toBe('workflows_files')
  })

  it('returns null when no companion relation completes the pair', () => {
    const broken = rels.filter((r) => r.id !== 81)
    expect(findM2MRelation('workflows_files', 'workflows', broken)).toBeNull()
    expect(findM2MRelation('files', 'workflows', broken)).toBeNull()
  })

  it('returns null for unknown keys', () => {
    expect(findM2MRelation('nope', 'workflows', rels)).toBeNull()
  })
})
