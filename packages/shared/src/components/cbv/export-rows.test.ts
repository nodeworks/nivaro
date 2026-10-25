import { describe, expect, it, vi } from 'vitest'
import {
  m2oLabel,
  m2oLabelPaths,
  readExportRows,
  resolveAllPaths,
  stableSort,
  userLabel
} from './export-rows'

const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: from + i }))

describe('readExportRows', () => {
  it('pages past the 1,000-row server cap until a short page', async () => {
    const fetchPage = vi.fn(async (offset: number) =>
      offset < 2000 ? { data: rows(1000, offset) } : { data: rows(39, offset) }
    )
    const { rows: out, truncated } = await readExportRows(fetchPage)
    expect(out).toHaveLength(2039)
    expect(truncated).toBe(false)
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 1000, 2000])
  })

  it('follows a lower served limit instead of stopping at the first page', async () => {
    const fetchPage = vi.fn(async (offset: number) => ({
      data: offset < 500 ? rows(500, offset) : rows(3, offset),
      applied_limit: 500
    }))
    expect((await readExportRows(fetchPage)).rows).toHaveLength(503)
  })

  it('says when rows remain past the stated ceiling', async () => {
    const fetchPage = vi.fn(async (offset: number, limit: number) => ({
      data: rows(limit, offset)
    }))
    const { rows: out, truncated } = await readExportRows(fetchPage, 2500)
    expect(out).toHaveLength(2500)
    expect(truncated).toBe(true)
  })
})

describe('resolveAllPaths', () => {
  it('resolves every id, not just the first 500, and splits paths by 20', async () => {
    const ids = rows(1300).map((r) => String(r.id))
    const paths = Array.from({ length: 25 }, (_, i) => `p${i}.name`)
    const fetchChunk = vi.fn(async (chunkIds: string[], chunkPaths: string[]) =>
      Object.fromEntries(
        chunkIds.map((id) => [id, Object.fromEntries(chunkPaths.map((p) => [p, { value: id }]))])
      )
    )
    const out = await resolveAllPaths(ids, paths, fetchChunk)
    // 3 id chunks (500/500/300) × 2 path chunks (20/5)
    expect(fetchChunk).toHaveBeenCalledTimes(6)
    expect(Object.keys(out)).toHaveLength(1300)
    expect(out['1299']['p24.name'].value).toBe('1299')
    expect(out['600']['p0.name'].value).toBe('600')
  })

  it('leaves a failed chunk blank and keeps the rest', async () => {
    const fetchChunk = vi.fn(async (chunkIds: string[]) => {
      if (chunkIds[0] === '0') throw new Error('boom')
      return { [chunkIds[0]]: { 'a.b': { value: 'x' } } }
    })
    const out = await resolveAllPaths(
      rows(600).map((r) => String(r.id)),
      ['a.b'],
      fetchChunk
    )
    expect(out['500']['a.b'].value).toBe('x')
    expect(out['0']).toBeUndefined()
  })
})

describe('M2O labels', () => {
  it('renders the target display template from resolved paths', () => {
    const spec = { column: 'vendor', template: '{{name}} ({{code}})', labelField: 'name' }
    expect(m2oLabelPaths(spec)).toEqual(['vendor.name', 'vendor.code'])
    expect(
      m2oLabel(spec, { 'vendor.name': { value: 'WAECO' }, 'vendor.code': { value: 'W1' } })
    ).toBe('WAECO (W1)')
  })

  it('falls back to the label field without a template', () => {
    const spec = { column: 'project_type', template: null, labelField: 'name' }
    expect(m2oLabelPaths(spec)).toEqual(['project_type.name'])
    expect(m2oLabel(spec, { 'project_type.name': { value: 'CMTS' } })).toBe('CMTS')
    expect(m2oLabel(spec, undefined)).toBe('')
  })

  it('names a person, else their email, else the id', () => {
    expect(userLabel({ first_name: 'Ann', last_name: 'Lee', email: 'a@x' }, 'U1')).toBe('Ann Lee')
    expect(userLabel({ first_name: null, last_name: null, email: 'a@x' }, 'U1')).toBe('a@x')
    expect(userLabel(null, 'U1')).toBe('U1')
  })
})

describe('stableSort', () => {
  it('adds id as the tie-breaker once', () => {
    expect(stableSort('')).toBe('id')
    expect(stableSort('-created')).toBe('-created,id')
    expect(stableSort('name,-id')).toBe('name,-id')
  })
})
