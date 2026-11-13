import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// Rob 2026-11-13: a collection import of Unit Types with a "Project Type" column of
// "Cran, HQ Funded" links each unit type to both project types — names, not ids, and
// several in one cell.
const PROJECT_TYPES = [
  { id: 12, name: 'CRAN' },
  { id: 20, name: 'HQ Funded' },
  { id: 35, name: 'HQ NFE Projects' },
  { id: 40, name: 'Smith, John' },
  { id: 41, name: 'Twin' },
  { id: 42, name: 'twin' }
]
const h = vi.hoisted(() => ({ seen: [] as FakeQuery[] }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb((q) => {
      h.seen.push(q)
      if (!q.sql.includes('[project_types]')) return []
      if (q.sql.includes('UPPER(LTRIM(RTRIM(')) {
        const wanted = q.bindings.filter((b) => typeof b === 'string').map(String)
        return PROJECT_TYPES.filter((r) => wanted.includes(r.name.toUpperCase())).map((r) => ({
          id: r.id,
          label: r.name
        }))
      }
      // the id fallback: `where [id] = @p0` (a text value against an int id never matches)
      const v = String(q.bindings[q.bindings.length - 1])
      const row = PROJECT_TYPES.find((r) => String(r.id) === v)
      return row ? { id: row.id } : undefined
    })
  }
})
vi.mock('../../../services/collections.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/collections.js')>()),
  getCollection: vi.fn(async () => ({ display_template: '{{name}}' })),
  getPhysicalColumns: vi.fn(async () => new Set(['id', 'name'])),
  getRelations: vi.fn(async (c: string) =>
    c === 'deployment_part_types'
      ? [
          {
            many_collection: 'deployment_part_types_project_types',
            many_field: 'deployment_part_types_id',
            one_collection: 'deployment_part_types',
            one_field: 'project_types',
            junction_field: 'project_types_id'
          },
          {
            many_collection: 'deployment_part_types',
            many_field: 'main_type',
            one_collection: 'project_types',
            one_field: null,
            junction_field: null
          }
        ]
      : [
          {
            many_collection: 'deployment_part_types_project_types',
            many_field: 'project_types_id',
            one_collection: 'project_types',
            one_field: 'deployment_part_types',
            junction_field: 'deployment_part_types_id'
          }
        ]
  )
}))

import {
  ImportLinkError,
  ImportLinkResolver,
  importLinkFields,
  sameLinks,
  splitLinkCell
} from '../../../services/import-links.js'

beforeEach(() => {
  h.seen.length = 0
})

describe('collection import relation cells', () => {
  it('finds the M2M and M2O fields among the mapped ones', async () => {
    const lf = await importLinkFields('deployment_part_types', [
      'name',
      'project_types',
      'main_type'
    ])
    expect([...lf.keys()].sort()).toEqual(['main_type', 'project_types'])
    expect(lf.get('project_types')).toMatchObject({
      kind: 'm2m',
      related: 'project_types',
      labelColumn: 'name',
      junction: 'deployment_part_types_project_types',
      fkToParent: 'deployment_part_types_id',
      fkToOther: 'project_types_id'
    })
    expect(lf.get('main_type')).toMatchObject({ kind: 'm2o', related: 'project_types' })
  })

  it('splits a cell on commas, trimmed, without empties or repeats', () => {
    expect(splitLinkCell('Cran, HQ Funded')).toEqual(['Cran', 'HQ Funded'])
    expect(splitLinkCell(' a ,, A , b,')).toEqual(['a', 'b'])
    expect(splitLinkCell(null)).toEqual([])
  })

  it('links several records by name, case-insensitively, reading each name once', async () => {
    const lf = (await importLinkFields('deployment_part_types', ['project_types'])).get(
      'project_types'
    )!
    const r = new ImportLinkResolver()
    expect(await r.resolve(lf, 'Cran, HQ Funded', 'Project Type')).toEqual(['12', '20'])
    const reads = h.seen.length
    expect(await r.resolve(lf, 'hq funded', 'Project Type')).toEqual(['20'])
    expect(await r.resolve(lf, 'cran', 'Project Type')).toEqual(['12'])
    expect(h.seen.length).toBe(reads)
    expect(await r.resolve(lf, 'hq funded,CRAN', 'Project Type')).toEqual(['20', '12'])
    expect(await r.resolve(lf, '', 'Project Type')).toEqual([])
  })

  it('takes ids too, and keeps a cell whole when it is one record’s name', async () => {
    const lf = (await importLinkFields('deployment_part_types', ['project_types'])).get(
      'project_types'
    )!
    const r = new ImportLinkResolver()
    expect(await r.resolve(lf, '12, 35')).toEqual(['12', '35'])
    expect(await r.resolve(lf, 'Smith, John')).toEqual(['40'])
  })

  it('refuses the row naming what matched nothing or more than one record', async () => {
    const lf = (await importLinkFields('deployment_part_types', ['project_types'])).get(
      'project_types'
    )!
    const r = new ImportLinkResolver()
    await expect(r.resolve(lf, 'Cran, Nope', 'Project Type')).rejects.toThrow(
      new ImportLinkError('Project Type: no project types named "Nope"')
    )
    await expect(r.resolve(lf, 'Twin', 'Project Type')).rejects.toThrow(
      'Project Type: more than one project types named "Twin"'
    )
  })

  it('an M2O cell is one record by id or name', async () => {
    const lf = (await importLinkFields('deployment_part_types', ['main_type'])).get('main_type')!
    const r = new ImportLinkResolver()
    expect(await r.resolve(lf, 'hq funded')).toBe('20')
    expect(await r.resolve(lf, '35')).toBe('35')
    expect(await r.resolve(lf, '  ')).toBeNull()
    await expect(r.resolve(lf, 'Cran, HQ Funded', 'Main type')).rejects.toThrow(
      'Main type: no project types named "Cran, HQ Funded"'
    )
  })

  it('compares link sets regardless of order', () => {
    expect(sameLinks(['1', '2'], ['2', '1'])).toBe(true)
    expect(sameLinks(['1'], ['1', '2'])).toBe(false)
  })
})
