import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  countMissing,
  lengthStats,
  type OrphanContext,
  orphanReason,
  percentile,
  readI18n,
  type TranslatableText
} from '../../../services/layout-inspect.js'

describe('percentile / lengthStats', () => {
  it('uses the nearest rank', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(s, 95)).toBe(95)
    expect(percentile(s, 50)).toBe(50)
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([], 95)).toBe(0)
  })

  it('reports filled, max and whether the sample hit the cap', () => {
    const st = lengthStats([3, 40, 12, 12], 10, 10)
    expect(st).toEqual({ sampled: 10, filled: 4, p50: 12, p95: 40, max: 40, capped: true })
    expect(lengthStats([], 3, 5000).capped).toBe(false)
  })
})

const ctx = (over: Partial<OrphanContext> = {}): OrphanContext => ({
  collection: 'orders',
  columns: new Map([
    ['orders', new Set(['id', 'title', 'customer'])],
    ['customers', new Set(['id', 'name'])],
    ['order_lines', new Set(['id', 'order'])]
  ]),
  virtualFields: new Set(['total_virtual']),
  relations: [
    {
      many_collection: 'orders',
      many_field: 'customer',
      one_collection: 'customers',
      one_field: null,
      junction_field: null
    },
    {
      many_collection: 'order_lines',
      many_field: 'order',
      one_collection: 'orders',
      one_field: 'lines',
      junction_field: null
    },
    {
      many_collection: 'order_tags',
      many_field: 'orders_id',
      one_collection: 'orders',
      one_field: 'tags',
      junction_field: 'tags_id'
    }
  ],
  widgetIds: new Set([7]),
  groupKeys: new Set(['main']),
  ...over
})

describe('orphanReason', () => {
  it('keeps columns, virtual fields, slots and live widgets', () => {
    const c = ctx()
    expect(orphanReason({ field: 'title', group_key: 'main' }, c)).toBeNull()
    expect(orphanReason({ field: 'TITLE', group_key: null }, c)).toBeNull()
    expect(orphanReason({ field: 'total_virtual', group_key: null }, c)).toBeNull()
    expect(orphanReason({ field: '__pipeline__', group_key: null }, c)).toBeNull()
    expect(orphanReason({ field: '__ext_notes__', group_key: null }, c)).toBeNull()
    expect(orphanReason({ field: '__widget_7__', group_key: 'main', widget_id: 7 }, c)).toBeNull()
    expect(orphanReason({ field: 'title', group_key: '__header__' }, c)).toBeNull()
    expect(orphanReason({ field: 'title', group_key: '__apply_values__' }, c)).toBeNull()
  })

  it('flags a dropped column and a deleted widget', () => {
    const c = ctx()
    expect(orphanReason({ field: 'old_code', group_key: 'main' }, c)).toBe('column_dropped')
    expect(orphanReason({ field: '__widget_9__', group_key: 'main', widget_id: 9 }, c)).toBe(
      'widget_deleted'
    )
    expect(orphanReason({ field: '__widget_9__', group_key: 'main' }, c)).toBe('widget_deleted')
  })

  it('judges grids by their table and column, not by the relation alone', () => {
    expect(orphanReason({ field: 'lines', group_key: 'main' }, ctx())).toBeNull()
    // order_tags has no table: the relation is a claim, not truth.
    expect(orphanReason({ field: 'tags', group_key: 'main' }, ctx())).toBe('grid_missing')
    const gone = ctx({
      columns: new Map([
        ['orders', new Set(['id'])],
        ['order_lines', new Set(['id'])]
      ])
    })
    expect(orphanReason({ field: 'lines', group_key: 'main' }, gone)).toBe('grid_missing')
  })

  it('walks relation paths hop by hop', () => {
    expect(orphanReason({ field: 'customer.name', group_key: 'main' }, ctx())).toBeNull()
    expect(orphanReason({ field: 'customer.email', group_key: 'main' }, ctx())).toBe(
      'column_dropped'
    )
    expect(orphanReason({ field: 'nothing.name', group_key: 'main' }, ctx())).toBe('column_dropped')
  })

  it('reads aliases and to-many hops the way the record form does', () => {
    // An alias named after the related table, as the form also matches it.
    expect(orphanReason({ field: 'order_lines', group_key: 'main' }, ctx())).toBeNull()
    // One-to-many hop, then a column of the related table.
    expect(orphanReason({ field: 'lines.order', group_key: 'main' }, ctx())).toBeNull()
    expect(orphanReason({ field: 'lines.gone', group_key: 'main' }, ctx())).toBe('column_dropped')
    // A declared alias with no relation left: its grid is gone.
    expect(
      orphanReason({ field: 'ghost', group_key: 'main' }, ctx({ aliasFields: new Set(['ghost']) }))
    ).toBe('grid_missing')
  })

  it('flags a placement in a section that no longer exists', () => {
    expect(orphanReason({ field: 'title', group_key: 'gone' }, ctx())).toBe('section_missing')
  })
})

describe('translations', () => {
  it('reads only well-formed locale maps', () => {
    expect(readI18n('{"es":{"label":"Título","note":""},"x":3}')).toEqual({
      es: { label: 'Título' }
    })
    expect(readI18n('not json')).toEqual({})
    expect(readI18n(null)).toEqual({})
    expect(readI18n(['es'])).toEqual({})
  })

  it('counts one missing per text, key and locale', () => {
    const texts: TranslatableText[] = [
      { keys: ['label', 'note'], i18n: { es: { label: 'Título' } } },
      { keys: ['label'], i18n: {} }
    ]
    expect(countMissing(texts, ['es', 'fr'])).toEqual({ missing: 5, total: 6 })
    expect(countMissing(texts, [])).toEqual({ missing: 0, total: 0 })
  })
})
