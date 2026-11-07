import { describe, expect, it } from 'vitest'
import { sweptByIntegrity } from '../../../services/config-conformance.js'

// army8 b02: an IR with every required field filled read "99% of required
// fields · 1 issue" — the one issue was Region's SOFT note "No warehouse
// serves this region yet; lines will be unpriced. You can still save."
describe('integrity sweep — soft rules are notes, not issues', () => {
  it('skips a soft rule', () => {
    expect(
      sweptByIntegrity({
        type: 'regex',
        value: '^(?:1|2)$',
        soft: true,
        message: 'No warehouse serves this region yet; lines will be unpriced. You can still save.'
      } as never)
    ).toBe(false)
  })

  it('still judges hard rules', () => {
    expect(sweptByIntegrity({ type: 'required' } as never)).toBe(true)
    expect(sweptByIntegrity({ type: 'min', value: 0 } as never)).toBe(true)
    expect(sweptByIntegrity(null)).toBe(false)
  })
})
