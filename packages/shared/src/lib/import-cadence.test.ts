import { describe, expect, it } from 'vitest'
import { bulkCadenceBody } from './import-cadence'

describe('bulkCadenceBody', () => {
  it('sets the same hours on every selected import, once per key', () => {
    expect(bulkCadenceBody(['a', 'b', 'a'], 'hours', 6)).toEqual({
      'cadence_hours:a': 6,
      'cadence_hours:b': 6
    })
  })
  it('back to default writes null, stop monitoring writes 0', () => {
    expect(bulkCadenceBody(['a'], 'default')).toEqual({ 'cadence_hours:a': null })
    expect(bulkCadenceBody(['a'], 'off')).toEqual({ 'cadence_hours:a': 0 })
  })
  it('an empty selection is an empty body', () => {
    expect(bulkCadenceBody([], 'hours', 6)).toEqual({})
  })
})
