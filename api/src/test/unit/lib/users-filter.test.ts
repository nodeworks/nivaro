import { describe, expect, it } from 'vitest'
import { readUsersFilter, UsersFilterError } from '../../../lib/users-filter.js'

// army 11 Q2-6 / f4 L6: GET /api/users read only filter=<JSON> and ignored the rest, so
// `filter[role][_eq]=…`, `filter[status]=suspended` and `filter[last_name][_in]=…` all
// answered 200 with the whole directory (1,087 people) as if filtered.
const cols = new Set(['role', 'status', 'last_name', 'email'])

describe('readUsersFilter', () => {
  it('folds the bracket form into the same filter as the JSON form', () => {
    expect(readUsersFilter({ 'filter[role][_eq]': 'R1' }, cols)).toEqual({ role: { _eq: 'R1' } })
    expect(readUsersFilter({ 'filter[status]': 'suspended' }, cols)).toEqual({
      status: { _eq: 'suspended' }
    })
    expect(readUsersFilter({ 'filter[last_name][_in]': 'Kelly,Kanniappan' }, cols)).toEqual({
      last_name: { _in: ['Kelly', 'Kanniappan'] }
    })
    expect(readUsersFilter({ filter: '{"role":{"_eq":"R1"}}' }, cols)).toEqual({
      role: { _eq: 'R1' }
    })
  })

  it('bracket + JSON together must both hold', () => {
    expect(
      readUsersFilter({ filter: '{"role":{"_in":["A"]}}', 'filter[status][_neq]': 'x' }, cols)
    ).toEqual({ role: { _in: ['A'] }, status: { _neq: 'x' } })
  })

  it('no filter = null', () => {
    expect(readUsersFilter({}, cols)).toBeNull()
    expect(readUsersFilter({ filter: '' }, cols)).toBeNull()
  })

  it('refuses out loud what the list cannot apply (never the whole directory)', () => {
    const bad: Array<Record<string, unknown>> = [
      { filter: '{not json' },
      { filter: '[1]' },
      { 'filter[static_token][_eq]': 'x' },
      { 'filter[nope][_eq]': 'x' },
      { 'filter[role][_contains]': 'x' },
      { 'filter[_or][0][role][_eq]': 'x' },
      { filter: '{"role":{"_in":"A"}}' },
      { filter: '{"role":{"_eq":{"x":1}}}' },
      { 'filter[__proto__][x]': '1' },
      { 'filter[role': 'x' }
    ]
    for (const q of bad)
      expect(() => readUsersFilter(q, cols), JSON.stringify(q)).toThrow(UsersFilterError)
  })

  it('an unknown column and a withheld one read the same (no oracle)', () => {
    const msg = (field: string) => {
      try {
        readUsersFilter({ [`filter[${field}][_eq]`]: 'x' }, cols)
      } catch (e) {
        return (e as Error).message.replace(field, 'F')
      }
      return null
    }
    expect(msg('static_token')).toBe(msg('does_not_exist'))
  })
})
