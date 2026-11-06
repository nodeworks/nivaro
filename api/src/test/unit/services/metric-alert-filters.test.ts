import { describe, expect, it, vi } from 'vitest'

// Army 4 (2026-11-05): a rule stored as a list of {key, values} applied no
// filter — "Workflows on hold — Zone 1" mailed the all-divisions count.

const runCustomQueryBySlug = vi.fn(async (_slug: string, _params: Record<string, unknown>) => [
  { val: 58 }
])
vi.mock('../../../services/custom-query-exec.js', () => ({
  runCustomQueryBySlug: (slug: string, params: Record<string, unknown>) =>
    runCustomQueryBySlug(slug, params),
  runCustomQueryAsUser: vi.fn()
}))

import { normalizeMetricFilters, resolveMetricValue } from '../../../services/metric-alerts.js'

describe('normalizeMetricFilters', () => {
  it('reads the list shape as the object shape', () => {
    expect(normalizeMetricFilters('[{"key":"divisions","values":["Zone 1"]}]')).toEqual({
      divisions: ['Zone 1']
    })
    expect(
      normalizeMetricFilters([
        { key: 'divisions', values: ['Zone 1'] },
        { key: 'divisions', values: ['Zone 2', 'Zone 1'] },
        { field: 'funding_years', value: 2026 }
      ])
    ).toEqual({ divisions: ['Zone 1', 'Zone 2'], funding_years: [2026] })
  })

  it('keeps the object shape and drops list-index keys', () => {
    expect(normalizeMetricFilters('{"divisions":["Zone 1"]}')).toEqual({ divisions: ['Zone 1'] })
    expect(normalizeMetricFilters({ 0: { key: 'x' }, divisions: ['A'] })).toEqual({
      divisions: ['A']
    })
  })

  it('treats empty and malformed filters as no filter', () => {
    for (const raw of [null, undefined, '', '[]', '{}', 'not json', '[{"key":""}]', 5])
      expect(normalizeMetricFilters(raw)).toBeNull()
  })
})

describe('resolveMetricValue with a list-shaped rule', () => {
  it('passes the division to the query', async () => {
    runCustomQueryBySlug.mockClear()
    const v = await resolveMetricValue(
      {
        type: 'custom_query',
        slug: 'efp-alert-workflows-on-hold',
        value_field: 'val',
        param_map: { divisions: 'divisions' }
      },
      [{ key: 'divisions', values: ['Zone 1'] }] as unknown as Record<string, unknown>
    )
    expect(v).toBe(58)
    expect(runCustomQueryBySlug).toHaveBeenCalledWith('efp-alert-workflows-on-hold', {
      divisions: 'Zone 1'
    })
  })
})
