import { describe, expect, it } from 'vitest'
import {
  BINARY_COLLATION,
  fastLike,
  textKindOf,
  typedEquals
} from '../../../services/search-like.js'

describe('textKindOf', () => {
  it('reads information_schema type names', () => {
    expect(textKindOf('nvarchar')).toBe('unicode')
    expect(textKindOf('NCHAR')).toBe('unicode')
    expect(textKindOf('varchar')).toBe('ansi')
    expect(textKindOf('char')).toBe('ansi')
    expect(textKindOf('ntext')).toBe('other')
    expect(textKindOf(undefined)).toBe('other')
  })
})

describe('fastLike', () => {
  it('nvarchar + ASCII pattern: upper-cased, binary collation, pattern bound upper-case', () => {
    const l = fastLike('[name]', '%Reggie%', 'unicode', { escape: '\\' })
    expect(l.sql).toBe(`UPPER([name]) COLLATE ${BINARY_COLLATION} LIKE ? ESCAPE '\\'`)
    expect(l.bindings).toEqual(['%REGGIE%'])
  })

  it('keeps bracket and backslash escapes intact when upper-casing', () => {
    expect(fastLike('[n]', '%a[_]b\\%c%', 'unicode').bindings).toEqual(['%A[_]B\\%C%'])
  })

  it('varchar + ASCII pattern: the pattern bound as varchar (no row-by-row conversion)', () => {
    const l = fastLike('[workflow_id]', '%hn26%', 'ansi', { escape: '\\' })
    expect(l.sql).toBe(`[workflow_id] LIKE CAST(? AS varchar(4000)) ESCAPE '\\'`)
    expect(l.bindings).toEqual(['%hn26%'])
  })

  it('anything outside printable ASCII, unknown types and other dialects: plain LIKE', () => {
    expect(fastLike('[name]', '%Café%', 'unicode').sql).toBe('[name] LIKE ?')
    expect(fastLike('[name]', '%straße%', 'unicode').bindings).toEqual(['%straße%'])
    expect(fastLike('[name]', '%a\tb%', 'unicode').sql).toBe('[name] LIKE ?')
    expect(fastLike('[body]', '%x%', 'other').sql).toBe('[body] LIKE ?')
    expect(fastLike('[name]', '%x%', 'unicode', { mssql: false }).sql).toBe('[name] LIKE ?')
    expect(fastLike('[name]', `%${'x'.repeat(4001)}%`, 'unicode').sql).toBe('[name] LIKE ?')
  })

  it('never inlines the pattern', () => {
    const l = fastLike('[name]', "%'; drop table x --%", 'unicode')
    expect(l.sql).not.toContain('drop')
  })
})

describe('typedEquals', () => {
  it('binds a varchar value against a varchar column, so its index can be sought', () => {
    expect(typedEquals('[workflow_id]', 'HN26-80378', 'ansi')).toEqual({
      sql: '[workflow_id] = CAST(? AS varchar(4000))',
      bindings: ['HN26-80378']
    })
  })

  it('an indexed nvarchar column keeps the plain (seekable) equality', () => {
    expect(typedEquals('[mwf_id]', 'B1-2', 'unicode', { indexed: true })).toEqual({
      sql: '[mwf_id] = ?',
      bindings: ['B1-2']
    })
  })

  it('an unindexed nvarchar column compares in the binary collation', () => {
    expect(typedEquals('[nuvolo_id]', 'ab-1', 'unicode', { indexed: false })).toEqual({
      sql: `UPPER([nuvolo_id]) COLLATE ${BINARY_COLLATION} = ?`,
      bindings: ['AB-1']
    })
  })

  it('non-ASCII values and other dialects stay plain', () => {
    expect(typedEquals('[x]', 'é', 'ansi').sql).toBe('[x] = ?')
    expect(typedEquals('[x]', 'a', 'ansi', { mssql: false }).sql).toBe('[x] = ?')
  })
})

describe('withFastContains', () => {
  it('names a column only inside the search context, and only text kinds', async () => {
    const { withFastContains, fastContainsKind } = await import('../../../services/search-like.js')
    expect(fastContainsKind('workflows', 'title')).toBeNull()
    const kinds = new Map([
      ['workflows', { title: 'unicode' as const, code: 'ansi' as const, amount: 'other' as const }]
    ])
    await withFastContains(kinds, async () => {
      expect(fastContainsKind('workflows', 'title')).toBe('unicode')
      expect(fastContainsKind('workflows', 'workflows.code')).toBe('ansi')
      expect(fastContainsKind('workflows', 'amount')).toBeNull()
      expect(fastContainsKind('workflows', 'project.name')).toBeNull()
      expect(fastContainsKind('projects', 'title')).toBeNull()
      expect(fastContainsKind(null, 'title')).toBeNull()
    })
    expect(fastContainsKind('workflows', 'title')).toBeNull()
  })
})
