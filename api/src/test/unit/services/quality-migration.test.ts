import { describe, expect, it } from 'vitest'
import { CONFIG_TABLES, RUNTIME_TABLES } from '../../../services/config-inventory.js'

describe('quality tables classification', () => {
  it('classifies the four quality tables', () => {
    for (const t of ['nivaro_quality_runs', 'nivaro_quality_rows', 'nivaro_quality_results'])
      expect(RUNTIME_TABLES).toContain(t)
    expect(CONFIG_TABLES).toContain('nivaro_quality_known')
  })
})
