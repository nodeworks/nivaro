import { describe, expect, it } from 'vitest'
import { dropUnknownField, isFilterRefusal, unknownFieldsOf } from './unknown-fields'

const f = (path: string[]) => ({
  id: path.join('.'),
  path,
  pathLabels: path,
  fieldType: 'string',
  op: '_eq',
  value: 'x'
})

describe('unknown-field refusals', () => {
  it('reads the field names off a 400 UNKNOWN_FIELD (SDK or axios shape)', () => {
    const sdk = { status: 400, response: { code: 'UNKNOWN_FIELD', fields: ['old_zone'] } }
    const axios = { response: { data: { code: 'UNKNOWN_FIELD', fields: ['a', 'b'] } } }
    expect(unknownFieldsOf(sdk)).toEqual(['old_zone'])
    expect(unknownFieldsOf(axios)).toEqual(['a', 'b'])
    expect(unknownFieldsOf({ response: { code: 'FORBIDDEN' } })).toEqual([])
    expect(unknownFieldsOf(null)).toEqual([])
  })

  it('a path the list cannot follow (403 FIELD_NOT_READABLE) is a filter refusal, not an access wall', () => {
    const err = { status: 403, response: { code: 'FIELD_NOT_READABLE', fields: ['zone'] } }
    expect(unknownFieldsOf(err)).toEqual(['zone'])
    expect(isFilterRefusal(err)).toBe(true)
    // A real permission wall still offers Request access.
    expect(isFilterRefusal({ status: 403, response: { code: 'FORBIDDEN' } })).toBe(false)
    expect(isFilterRefusal({ status: 403, response: {} })).toBe(false)
  })

  it('takes the field out of filters, sort and column filters only', () => {
    const out = dropUnknownField('old_zone', {
      filters: [f(['old_zone']), f(['project', 'old_zone']), f(['status'])],
      sort: '-Old_Zone,created',
      colFilters: { old_zone: 1, region: 2 }
    })
    expect(out.filters.map((x) => x.id)).toEqual(['status'])
    expect(out.sort).toBe('created')
    expect(out.colFilters).toEqual({ region: 2 })
  })
})
