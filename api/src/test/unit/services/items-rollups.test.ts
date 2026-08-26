import { describe, expect, it } from 'vitest'
import { parseRollupFormula } from '../../../services/items.js'

describe('parseRollupFormula', () => {
  it('accepts legacy single-source objects', () => {
    expect(
      parseRollupFormula(
        JSON.stringify({
          related_collection: 'unit_workflows',
          fk_field: 'unit',
          aggregate: 'sum',
          value_field: 'allocated_amount'
        })
      )
    ).toEqual({
      sources: [
        {
          related_collection: 'unit_workflows',
          fk_field: 'unit',
          aggregate: 'sum',
          value_field: 'allocated_amount'
        }
      ]
    })
  })
  it('accepts multi-source arrays', () => {
    const cfg = parseRollupFormula(
      JSON.stringify({
        sources: [
          {
            related_collection: 'unit_workflows',
            fk_field: 'unit',
            aggregate: 'sum',
            value_field: 'allocated_amount'
          },
          {
            related_collection: 'unit_materials',
            fk_field: 'unit',
            aggregate: 'sum',
            value_field: 'total'
          }
        ]
      })
    )
    expect(cfg?.sources).toHaveLength(2)
  })
  it('rejects invalid aggregates and missing fields', () => {
    expect(
      parseRollupFormula(
        JSON.stringify({
          related_collection: 'x',
          fk_field: 'y',
          aggregate: 'bogus',
          value_field: 'z'
        })
      )
    ).toBeNull()
    expect(
      parseRollupFormula(
        JSON.stringify({
          sources: [{ related_collection: '', fk_field: 'y', aggregate: 'sum', value_field: 'z' }]
        })
      )
    ).toBeNull()
    expect(parseRollupFormula(null)).toBeNull()
  })
  it('allows empty value_field only for count', () => {
    expect(
      parseRollupFormula(
        JSON.stringify({
          related_collection: 'a',
          fk_field: 'b',
          aggregate: 'count',
          value_field: ''
        })
      )
    ).not.toBeNull()
    expect(
      parseRollupFormula(
        JSON.stringify({
          related_collection: 'a',
          fk_field: 'b',
          aggregate: 'sum',
          value_field: ''
        })
      )
    ).toBeNull()
  })
})
