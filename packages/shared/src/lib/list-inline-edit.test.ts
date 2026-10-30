import { describe, expect, it } from 'vitest'
import {
  type InlineFieldMeta,
  type InlineRelationMeta,
  inlineChoices,
  inlineEditCandidates,
  inlineEditFor,
  inlineEditForStorage,
  inlineEditorKind,
  inlineInputValue,
  inlineValueUnchanged,
  nextInlineKey,
  normalizeInlineEdit,
  parseInlineInput
} from './list-inline-edit'

const f = (field: string, type: string, extra: Partial<InlineFieldMeta> = {}): InlineFieldMeta => ({
  field,
  type,
  ...extra
})

const relations: InlineRelationMeta[] = [
  // projects.vendor → vendors (M2O)
  {
    many_collection: 'projects',
    many_field: 'vendor',
    one_collection: 'vendors',
    one_field: 'projects',
    junction_field: null
  },
  // projects.lines (O2M alias) — the one side
  {
    many_collection: 'project_lines',
    many_field: 'project',
    one_collection: 'projects',
    one_field: 'lines',
    junction_field: null
  },
  // projects.photo → nivaro_files
  {
    many_collection: 'projects',
    many_field: 'photo',
    one_collection: 'nivaro_files',
    junction_field: null
  },
  // projects.tags M2M through projects_tags
  {
    many_collection: 'projects_tags',
    many_field: 'projects_id',
    one_collection: 'projects',
    one_field: 'tags',
    junction_field: 'tags_id'
  }
]

describe('normalizeInlineEdit', () => {
  it('is off for garbage', () => {
    for (const raw of [null, undefined, 'on', 3, [], { enabled: 'yes' }])
      expect(normalizeInlineEdit(raw).enabled).toBe(false)
  })
  it('keeps plain field names only, once each', () => {
    expect(
      normalizeInlineEdit({
        enabled: true,
        fields: ['name', 'name', 'vendor.name', '__state__', 'id', 7, 'amount']
      })
    ).toEqual({ enabled: true, fields: ['name', 'amount'] })
  })
  it('stores nothing when off with no columns', () => {
    expect(inlineEditForStorage({ enabled: false, fields: [] })).toBeNull()
    expect(inlineEditForStorage({ enabled: false, fields: ['a'] })).toEqual({
      enabled: false,
      fields: ['a']
    })
  })
})

describe('inlineEditorKind', () => {
  it('picks an editor per field type', () => {
    expect(inlineEditorKind(f('name', 'string'), 'projects', relations)).toBe('text')
    expect(inlineEditorKind(f('notes', 'text'), 'projects', relations)).toBe('longtext')
    expect(inlineEditorKind(f('qty', 'integer'), 'projects', relations)).toBe('integer')
    expect(inlineEditorKind(f('amount', 'decimal'), 'projects', relations)).toBe('number')
    expect(inlineEditorKind(f('due', 'date'), 'projects', relations)).toBe('date')
    expect(inlineEditorKind(f('at', 'datetime'), 'projects', relations)).toBe('datetime')
    expect(
      inlineEditorKind(
        f('ship', 'datetime', { options: { date_mode: 'date' } }),
        'projects',
        relations
      )
    ).toBe('date')
    expect(inlineEditorKind(f('active', 'boolean'), 'projects', relations)).toBe('boolean')
    expect(
      inlineEditorKind(
        f('status', 'string', {
          interface: 'select-dropdown',
          options: JSON.stringify({ choices: [{ text: 'Open', value: 'open' }] })
        }),
        'projects',
        relations
      )
    ).toBe('choice')
    expect(inlineEditorKind(f('vendor', 'integer'), 'projects', relations)).toBe('m2o')
  })
  it('never offers computed, read-only, system, alias or relational-many fields', () => {
    expect(
      inlineEditorKind(
        f('total', 'decimal', { computed_formula: '{{a}}+1' }),
        'projects',
        relations
      )
    ).toBeNull()
    expect(
      inlineEditorKind(f('total', 'decimal', { computed_type: 'write' }), 'projects', relations)
    ).toBeNull()
    expect(
      inlineEditorKind(f('code', 'string', { readonly: true }), 'projects', relations)
    ).toBeNull()
    expect(inlineEditorKind(f('id', 'integer'), 'projects', relations)).toBeNull()
    expect(inlineEditorKind(f('date_created', 'datetime'), 'projects', relations)).toBeNull()
    expect(inlineEditorKind(f('lines', 'alias'), 'projects', relations)).toBeNull()
    // A legacy alias typed 'string' is caught by its relation, not its type.
    expect(inlineEditorKind(f('lines', 'string'), 'projects', relations)).toBeNull()
    expect(
      inlineEditorKind(f('tags', 'string', { special: ['m2m'] }), 'projects', relations)
    ).toBeNull()
    expect(inlineEditorKind(f('photo', 'uuid'), 'projects', relations)).toBeNull()
    expect(
      inlineEditorKind(
        f('body', 'text', { interface: 'input-rich-text-html' }),
        'projects',
        relations
      )
    ).toBeNull()
    expect(inlineEditorKind(f('meta', 'json'), 'projects', relations)).toBeNull()
    expect(inlineEditorKind(undefined, 'projects', relations)).toBeNull()
  })
})

describe('inlineEditFor (the editable-column decision)', () => {
  const field = f('name', 'string')
  const base = {
    config: { enabled: true, fields: ['name'] },
    key: 'name',
    field,
    collection: 'projects',
    relations,
    mayUpdate: true
  }
  it('edits a switched-on, named, editable column', () => {
    expect(inlineEditFor(base)).toBe('text')
  })
  it('is off by default', () => {
    expect(inlineEditFor({ ...base, config: normalizeInlineEdit(undefined) })).toBeNull()
  })
  it('needs the column named by the admin', () => {
    expect(inlineEditFor({ ...base, config: { enabled: true, fields: ['other'] } })).toBeNull()
  })
  it('needs the list switched on even when columns are named', () => {
    expect(inlineEditFor({ ...base, config: { enabled: false, fields: ['name'] } })).toBeNull()
  })
  it('needs update rights on the collection', () => {
    expect(inlineEditFor({ ...base, mayUpdate: false })).toBeNull()
  })
  it('never offers a computed field even when an admin named it', () => {
    expect(
      inlineEditFor({
        ...base,
        key: 'total',
        field: f('total', 'decimal', { computed_formula: 'x' }),
        config: { enabled: true, fields: ['total'] }
      })
    ).toBeNull()
  })
})

describe('inlineEditCandidates', () => {
  it('lists visible editable fields with their editor', () => {
    const out = inlineEditCandidates(
      [
        f('name', 'string', { label: 'Name' }),
        f('secret', 'string', { hidden: true }),
        f('lines', 'alias'),
        f('vendor', 'integer')
      ],
      'projects',
      relations
    )
    expect(out).toEqual([
      { field: 'name', kind: 'text', label: 'Name' },
      { field: 'vendor', kind: 'm2o', label: 'vendor' }
    ])
  })
})

describe('parseInlineInput / inlineInputValue', () => {
  it('blank clears to null', () => {
    for (const k of ['text', 'integer', 'number', 'date', 'datetime', 'choice'] as const)
      expect(parseInlineInput(k, '  ')).toEqual({ ok: true, value: null })
  })
  it('numbers', () => {
    expect(parseInlineInput('integer', '1,200')).toEqual({ ok: true, value: 1200 })
    expect(parseInlineInput('integer', '1.5').ok).toBe(false)
    expect(parseInlineInput('number', '$1,234.50')).toEqual({ ok: true, value: 1234.5 })
    expect(parseInlineInput('number', 'abc').ok).toBe(false)
  })
  it('dates', () => {
    expect(parseInlineInput('date', '2026-10-29')).toEqual({ ok: true, value: '2026-10-29' })
    expect(parseInlineInput('date', '10/29/2026').ok).toBe(false)
    expect(inlineInputValue('date', '2026-10-29T00:00:00.000Z')).toBe('2026-10-29')
  })
  it('datetime round-trips through the local wall clock', () => {
    const iso = '2026-10-29T14:30:00.000Z'
    const local = inlineInputValue('datetime', iso)
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(parseInlineInput('datetime', local)).toEqual({ ok: true, value: iso })
  })
  it('booleans', () => {
    expect(inlineInputValue('boolean', 1)).toBe('true')
    expect(parseInlineInput('boolean', 'false')).toEqual({ ok: true, value: false })
  })
})

describe('inlineValueUnchanged', () => {
  it('compares by kind', () => {
    expect(inlineValueUnchanged('integer', '5', 5)).toBe(true)
    expect(inlineValueUnchanged('boolean', 1, true)).toBe(true)
    expect(inlineValueUnchanged('date', '2026-10-29T00:00:00Z', '2026-10-29')).toBe(true)
    expect(inlineValueUnchanged('text', 'a', 'b')).toBe(false)
    expect(inlineValueUnchanged('text', null, 'b')).toBe(false)
    expect(inlineValueUnchanged('text', null, null)).toBe(true)
  })
})

describe('inlineChoices / nextInlineKey', () => {
  it('reads choices from object or JSON text', () => {
    expect(
      inlineChoices(
        f('s', 'string', { options: { choices: [{ text: 'A', value: 'a' }, { value: '' }] } })
      )
    ).toEqual([{ value: 'a', label: 'A' }])
  })
  it('Tab walks the editable columns and stops at the ends', () => {
    expect(nextInlineKey(['a', 'b', 'c'], 'b', 1)).toBe('c')
    expect(nextInlineKey(['a', 'b', 'c'], 'b', -1)).toBe('a')
    expect(nextInlineKey(['a', 'b', 'c'], 'c', 1)).toBeNull()
    expect(nextInlineKey(['a'], 'zz', 1)).toBeNull()
  })
})
