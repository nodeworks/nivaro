import { describe, expect, it } from 'vitest'
import {
  buildLookups,
  describeLookups,
  emptyLookupRow,
  findErpAction,
  rowsFromLookups
} from './lookups'

describe('describeLookups', () => {
  it('describes filters, sort, limit and expansions in plain words', () => {
    const out = describeLookups({
      lines: {
        collection: 'materials',
        filter: { workflow: '$id', site: '$record.site', kind: 'goods', who: '$user' },
        sort: '-id',
        limit: 5000,
        expand: { item: { collection: 'items', fields: ['code', 'name'] } }
      }
    })
    expect(out).toEqual([
      {
        name: 'lines',
        collection: 'materials',
        details: [
          'where workflow = this record, site = its site, kind = "goods", who = the person who moved it',
          'newest id first',
          'up to 2000 rows',
          'adds item_data from items (code, name)'
        ]
      }
    ])
  })

  it('skips junk and handles junction filters', () => {
    expect(describeLookups(null)).toEqual([])
    expect(describeLookups({ x: 'nope' })).toEqual([])
    const [l] = describeLookups({
      w: {
        collection: 'materials',
        junction_filter: { junction: 'mw', fk_to_row: 'm', field: 'warehouse', value: 3 },
        sort: 'line'
      }
    })
    expect(l.details).toEqual([
      'linked through mw where warehouse = 3',
      'sorted by line',
      'up to 500 rows'
    ])
  })
})

describe('findErpAction', () => {
  it('finds the erp_submit action naming the key', () => {
    const actions = [
      { type: 'set_field' },
      { type: 'erp_submit', payload_template_key: 'other' },
      { type: 'erp_submit', payload_template_key: 'k', context: { a: {} } }
    ]
    expect(findErpAction(actions, 'k')).toEqual(actions[2])
    expect(findErpAction(actions, 'none')).toBeNull()
    expect(findErpAction(null, 'k')).toBeNull()
  })
})

describe('lookup editor rows', () => {
  it('round-trips lookups through rows, keeping settings it has no input for', () => {
    const raw = {
      lines: {
        collection: 'materials',
        filter: { workflow: '$id' },
        junction_filter: { junction: 'mw', fk_to_row: 'm', field: 'w', value: 1 },
        sort: '-id',
        limit: 50,
        expand: { item: { collection: 'items', fields: ['code'] } }
      }
    }
    const built = buildLookups(rowsFromLookups(raw))
    expect(built.errors).toEqual({})
    expect(built.value).toEqual(raw)
    expect(buildLookups([]).value).toBeNull()
  })

  it('names what is wrong with each row', () => {
    const a = { ...emptyLookupRow(), name: '1x', filterText: '[1]', limit: '0', sort: 'a b' }
    const b = { ...emptyLookupRow(), name: 'ok', collection: 'items', expandText: '{bad' }
    const c = { ...emptyLookupRow(), name: 'ok', collection: 'items' }
    const { errors } = buildLookups([a, b, c])
    expect(errors[a.uid]).toEqual([
      'Name: letters, digits and _, not starting with a digit',
      'Pick the collection it reads',
      'Filter must be a JSON object',
      "Sort: a field name, '-' first for newest first",
      'Limit: a whole number from 1 to 2000'
    ])
    expect(errors[b.uid]?.[0]).toMatch(/^Expand isn't valid JSON/)
    expect(errors[c.uid]).toEqual(['Another lookup is already named ok'])
  })
})
