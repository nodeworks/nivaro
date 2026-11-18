import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AT_RISK_FIELD_REF_RE, atRiskReferencedFields } from './at-risk-fields'

describe('atRiskReferencedFields', () => {
  it('reads condition fields and {{field}} references in values', () => {
    expect(
      atRiskReferencedFields([
        { field: 'spent', value: '{{budget}} * 1.1' },
        { field: 'status', value: 'open' },
        { field: 'due', value: '{{ planned_end }}' }
      ])
    ).toEqual(['spent', 'budget', 'status', 'due', 'planned_end'])
  })

  it('is the twin of the server rule (api/src/routes/at-risk.ts FIELD_REF_RE)', () => {
    const api = readFileSync(
      join(import.meta.dirname, '../../../../api/src/routes/at-risk.ts'),
      'utf8'
    )
    const m = /const FIELD_REF_RE = (\/.+\/)\n/.exec(api)
    expect(m?.[1]).toBe(String(AT_RISK_FIELD_REF_RE))
  })
})
