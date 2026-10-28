import { beforeEach, describe, expect, it, vi } from 'vitest'

// Search item 24: full-text availability (catalog read once per tenant per
// 5 minutes), the CONTAINS clause (phrase only ever bound, never inlined) and
// the per-person global-search answer cache.

const raw = vi.fn()
let tenant = ''
vi.mock('../../../db/index.js', () => ({ db: { raw: (...a: unknown[]) => raw(...a) } }))
vi.mock('../../../services/tenant-rooms.js', () => ({ currentTenantKey: () => tenant }))

import {
  forgetFtsCatalog,
  ftsAvailable,
  ftsColumns,
  ftsCondition,
  ftsSearchCondition,
  normalizeSearchQuery,
  searchAnswerCache,
  searchAnswerKey
} from '../../../services/search-fts.js'

beforeEach(() => {
  raw.mockReset()
  forgetFtsCatalog()
  searchAnswerCache.forget()
  tenant = ''
})

describe('ftsAvailable', () => {
  it('reads the catalog once and answers per table and column', async () => {
    raw.mockResolvedValue([
      { table_name: 'Workflows', column_name: 'Name' },
      { table_name: 'Workflows', column_name: 'objective' }
    ])
    expect(await ftsAvailable('workflows')).toBe(true)
    expect(await ftsAvailable('workflows', 'name')).toBe(true)
    expect(await ftsAvailable('workflows', ['name', 'objective'])).toBe(true)
    expect(await ftsAvailable('workflows', ['name', 'risks'])).toBe(false)
    expect(await ftsAvailable('units')).toBe(false)
    expect(await ftsColumns('workflows', ['risks', 'objective', 'name'])).toEqual([
      'objective',
      'name'
    ])
    expect(raw).toHaveBeenCalledTimes(1)
    expect(String(raw.mock.calls[0][0])).toMatch(/has_crawl_completed = 1/)
  })

  it('is cached per tenant', async () => {
    raw.mockResolvedValueOnce([{ table_name: 'a', column_name: 'x' }]).mockResolvedValueOnce([])
    tenant = 't1'
    expect(await ftsAvailable('a')).toBe(true)
    tenant = 't2'
    expect(await ftsAvailable('a')).toBe(false)
    tenant = 't1'
    expect(await ftsAvailable('a')).toBe(true)
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('a server without full-text (or catalog permission) means LIKE, remembered', async () => {
    raw.mockRejectedValue(new Error("Invalid object name 'sys.fulltext_indexes'"))
    expect(await ftsAvailable('workflows')).toBe(false)
    expect(await ftsAvailable('workflows', 'name')).toBe(false)
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('never looks up an unsafe table name', async () => {
    expect(await ftsAvailable('x; DROP TABLE y')).toBe(false)
    expect(await ftsColumns('a b', ['x'])).toEqual([])
    expect(raw).not.toHaveBeenCalled()
  })
})

describe('ftsSearchCondition / ftsCondition', () => {
  it('turns each word into a quoted prefix term joined with AND', () => {
    expect(ftsSearchCondition('budget review')).toBe('"budget*" AND "review*"')
    expect(ftsSearchCondition('  Budget   budget ')).toBe('"budget*"')
  })

  it('strips quotes and drops punctuation-only words, so it is never a syntax error', () => {
    expect(ftsSearchCondition('say "hello" - & world')).toBe('"say*" AND "hello*" AND "world*"')
    expect(ftsSearchCondition('“smart” quotes')).toBe('"smart*" AND "quotes*"')
    expect(ftsSearchCondition('x" OR 1=1 --')).toBe('"x*" AND "or*" AND "1=1*"')
    expect(ftsSearchCondition('ab***')).toBe('"ab*"')
    expect(ftsSearchCondition('" - & ;')).toBeNull()
    expect(ftsSearchCondition('')).toBeNull()
  })

  it('caps the number of terms and their length', () => {
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    expect(ftsSearchCondition(many)?.split(' AND ')).toHaveLength(8)
    const long = 'a'.repeat(500)
    expect(ftsSearchCondition(long)).toBe(`"${'a'.repeat(100)}*"`)
  })

  it('binds the phrase and brackets the columns', () => {
    const one = ftsCondition(['name'], "O'Brien's ?plan")
    expect(one).toEqual({ sql: 'CONTAINS([name], ?)', bindings: [`"o'brien's*" AND "?plan*"`] })
    // The phrase never reaches the SQL text.
    expect(one?.sql).not.toMatch(/brien/i)
    expect(ftsCondition(['name', 'objective', 'name'], 'x', { alias: 'w' })).toEqual({
      sql: 'CONTAINS(([w].[name], [w].[objective]), ?)',
      bindings: ['"x*"']
    })
  })

  it('null without columns or words; throws on an unsafe column or alias', () => {
    expect(ftsCondition([], 'x')).toBeNull()
    expect(ftsCondition(['name'], '--')).toBeNull()
    expect(() => ftsCondition(['name]); DROP TABLE x; --'], 'x')).toThrow(/Unsafe column/)
    expect(() => ftsCondition(['name'], 'x', { alias: 'a b' })).toThrow(/Unsafe table alias/)
  })
})

describe('searchAnswerCache', () => {
  const ann = { id: 'aaa-1', role: 'r1' }

  it('normalizes the query', () => {
    expect(normalizeSearchQuery('  PO   12 ')).toBe('po 12')
  })

  it('keys on tenant, person, access, workspace, variant and the query', () => {
    const base = searchAnswerKey({ user: ann, q: 'Pump' })
    expect(searchAnswerKey({ user: { ...ann, id: 'AAA-1' }, q: ' pump ' })).toBe(base)
    expect(searchAnswerKey({ user: { id: 'bbb', role: 'r1' }, q: 'pump' })).not.toBe(base)
    expect(searchAnswerKey({ user: { ...ann, role: 'r2' }, q: 'pump' })).not.toBe(base)
    expect(
      searchAnswerKey({ user: { ...ann, api_key_scopes: [{ collection: 'po' }] }, q: 'pump' })
    ).not.toBe(base)
    expect(searchAnswerKey({ user: ann, q: 'pump', variant: 'labels' })).not.toBe(base)
    expect(searchAnswerKey({ user: ann, q: 'pump', workspace: 'w2' })).not.toBe(base)
    tenant = 'acme'
    expect(searchAnswerKey({ user: ann, q: 'pump' })).not.toBe(base)
  })

  it('reuses one answer for the same person and shares concurrent runs', async () => {
    const load = vi.fn(async () => ({ records: [1] }))
    const [a, b] = await Promise.all([
      searchAnswerCache.get({ user: ann, q: 'pump' }, load),
      searchAnswerCache.get({ user: ann, q: 'PUMP' }, load)
    ])
    expect(a).toEqual({ records: [1] })
    expect(b).toBe(a)
    await searchAnswerCache.get({ user: ann, q: 'pump ' }, load)
    expect(load).toHaveBeenCalledTimes(1)
    await searchAnswerCache.get({ user: { id: 'other', role: 'r1' }, q: 'pump' }, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('never remembers a failed search', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue('ok')
    await expect(searchAnswerCache.get({ user: ann, q: 'x' }, load)).rejects.toThrow('timeout')
    expect(await searchAnswerCache.get({ user: ann, q: 'x' }, load)).toBe('ok')
  })
})
