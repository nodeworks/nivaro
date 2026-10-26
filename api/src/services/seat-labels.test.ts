import { describe, expect, it } from 'vitest'
import { fallbackFieldLabel, labelSeatFilters } from './seat-labels.js'

describe('labelSeatFilters', () => {
  const dims = new Map([
    ['regions.short_name', 'Region'],
    ['divisions.short_name', 'Zone']
  ])

  it('names each filter by its pipeline dimension label', () => {
    const out = labelSeatFilters(
      [
        { field: 'regions.short_name', op: 'eq', value: 'KEY', id_value: 4 },
        { field: 'divisions.short_name', op: 'eq', value: 'Zone 1' }
      ],
      dims
    )
    expect(out?.map((f) => `${f.label}: ${f.value}`)).toEqual(['Region: KEY', 'Zone: Zone 1'])
    expect(out?.[0].id_value).toBe(4)
  })

  it('falls back to a readable name when no dimension names the path', () => {
    expect(fallbackFieldLabel('project.project_type.name')).toBe('Project type')
    expect(fallbackFieldLabel('project.project_id')).toBe('Project')
    expect(fallbackFieldLabel('cost_center')).toBe('Cost center')
  })

  it('passes non-arrays through as null and drops malformed entries', () => {
    expect(labelSeatFilters(null, dims)).toBeNull()
    expect(labelSeatFilters([null, { value: 1 }, { field: 'x', value: 2 }], dims)).toEqual([
      { field: 'x', value: 2, label: 'X' }
    ])
  })
})
