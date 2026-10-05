import { describe, expect, it } from 'vitest'
import {
  KIND_RISK,
  OPEN_STATUSES,
  TUNING_KINDS,
  TUNING_STATUSES
} from '../../../../services/db-tuning/types.js'

describe('db-tuning types', () => {
  it('every kind has a risk', () => {
    for (const k of TUNING_KINDS) expect(KIND_RISK[k]).toMatch(/^(reversible|review)$/)
  })
  it('open statuses are real statuses', () => {
    for (const s of OPEN_STATUSES) expect(TUNING_STATUSES).toContain(s)
  })
  it('proc rewrites are review risk, everything else reversible', () => {
    expect(KIND_RISK.proc_rewrite).toBe('review')
    expect(KIND_RISK.index_create).toBe('reversible')
  })
})
