import { describe, expect, it } from 'vitest'
import { alertFilterLabel, alertScopeText } from './AlertManagerView'

// The filter bar of the EFP "Workflow Executive Dashboard" (dev, 2026-11-06).
const BAR = [
  {
    field: 'funding_year',
    label: 'Funding Year',
    options: { collection: 'funding_years' }
  },
  { field: 'division', label: 'Zone', options: { collection: 'divisions' } },
  { field: 'region', label: 'Region', options: { collection: 'regions' } }
]

describe('widget alert scope (no-internal-ids #25)', () => {
  it('names a filter the way the report does, by field or by collection', () => {
    expect(alertFilterLabel('divisions', BAR)).toBe('Zone')
    expect(alertFilterLabel('funding_years', BAR)).toBe('Funding Year')
    expect(alertFilterLabel('region', BAR)).toBe('Region')
  })

  it('falls back to the key in words, never the raw key', () => {
    expect(alertFilterLabel('funding_years', null)).toBe('Funding years')
    expect(alertFilterLabel('project_type', [])).toBe('Project type')
  })

  it('reads the whole scope', () => {
    expect(
      alertScopeText(
        [
          { field: 'divisions', values: ['MM'], labels: ['Zone 1'] },
          { field: 'funding_years', values: [2026], labels: ['2026'] }
        ],
        BAR
      )
    ).toBe('Zone: Zone 1 · Funding Year: 2026')
    expect(alertScopeText([], BAR)).toBe('All data')
    expect(alertScopeText(null, null)).toBe('All data')
  })
})
