import { describe, expect, it } from 'vitest'
import { pickBestLayoutTraced } from '../../../routes/collection-layouts.js'
import {
  checkColumns,
  draftCandidates,
  parseCheckBody,
  ruleFields,
  shownConditions
} from '../../../services/layout-testing.js'

const row = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `L${id}`,
  layout_type: 'grouped',
  is_active: false,
  sort: id,
  conditions: null,
  record_conditions: null,
  ...extra
})

describe('parseCheckBody', () => {
  it('accepts records with optional roles and field names', () => {
    const b = parseCheckBody({
      records: [{ item: 7 }, { item: 'a1', role_id: 'R1' }],
      fields: ['zone', 'zone'],
      draft: { record_conditions: [], name: 'ignored' }
    })
    expect(b).toEqual({
      records: [
        { item: '7', role_id: null },
        { item: 'a1', role_id: 'R1' }
      ],
      fields: ['zone'],
      draft: { record_conditions: [] }
    })
  })

  it('refuses empty, oversized and malformed bodies', () => {
    expect(parseCheckBody({ records: [] })).toHaveProperty('error')
    expect(
      parseCheckBody({ records: Array.from({ length: 11 }, (_, i) => ({ item: i })) })
    ).toHaveProperty('error')
    expect(parseCheckBody({ records: [{}] })).toHaveProperty('error')
    expect(parseCheckBody({ records: [{ item: 1 }], fields: ['a b'] })).toHaveProperty('error')
    expect(parseCheckBody({ records: [{ item: 1, role_id: 5 }] })).toHaveProperty('error')
  })
})

describe('draftCandidates', () => {
  const stored = [
    row(1, { is_active: true }),
    row(2, { record_conditions: '[{"field":"kind","op":"eq","value":"car"}]' })
  ]

  it('replaces this layout with its draft settings and keeps /active order', () => {
    const out = draftCandidates(stored, stored[1], { record_conditions: null, sort: 0 })
    expect(out.map((r) => r.id)).toEqual([1, 2])
    expect(out[1].record_conditions).toBeNull()
  })

  it('a draft that makes this layout the default steps the old default down', () => {
    const out = draftCandidates(stored, stored[1], { is_active: true })
    expect(out[0].id).toBe(2)
    expect(out.find((r) => r.id === 1)?.is_active).toBe(false)
  })

  it('drops the layout when the draft makes it another kind, adds it when it becomes a form', () => {
    expect(draftCandidates(stored, stored[1], { layout_type: 'detail' }).map((r) => r.id)).toEqual([
      1
    ])
    const detail = row(3, { layout_type: 'detail' })
    expect(draftCandidates(stored, detail, { layout_type: 'grouped' }).map((r) => r.id)).toEqual([
      1, 2, 3
    ])
  })

  it('feeds the live resolver: a record moves to the default when its rule is removed', () => {
    const record = { id: 9, kind: 'car' }
    expect(pickBestLayoutTraced(stored, null, record, true).row?.id).toBe(2)
    const drafted = draftCandidates(stored, stored[1], {
      record_conditions: [{ field: 'kind', op: 'eq', value: 'other' }]
    })
    expect(pickBestLayoutTraced(drafted, null, record, true).row?.id).toBe(1)
  })
})

describe('columns', () => {
  it('collects rule fields and reads only real columns, id first', () => {
    expect(ruleFields([row(1, { record_conditions: [{ field: 'zone', op: 'nnull' }] })])).toEqual([
      'zone'
    ])
    expect(checkColumns(['Zone', 'missing', 'zone'], ['ID', 'zone'])).toEqual(['ID', 'zone'])
  })
})

describe('shownConditions', () => {
  it('keeps the role list and drops testing for non-admins', () => {
    const c = { role_ids: ['a'], testing: { records: [{ item: '1' }] } }
    expect(shownConditions(c, true)).toBe(c)
    expect(shownConditions(c, false)).toEqual({ role_ids: ['a'] })
    expect(shownConditions({ testing: {} }, false)).toBeNull()
    expect(shownConditions(null, false)).toBeNull()
  })
})
