import { describe, expect, it } from 'vitest'
import { isAiEligible } from './FieldRow'

// army 8 b14: every forecast month showed an "AI" button (decimal fields on the input).
describe('isAiEligible — which fields get the AI button', () => {
  it('never a number, whatever input draws it', () => {
    expect(isAiEligible({ type: 'decimal', interface: 'input' })).toBe(false)
    expect(isAiEligible({ type: 'integer', interface: null })).toBe(false)
  })
  it('text still qualifies; relations never', () => {
    expect(isAiEligible({ type: 'string', interface: 'input' })).toBe(true)
    expect(isAiEligible({ type: 'text', interface: 'textarea' })).toBe(true)
    expect(isAiEligible({ type: 'integer', interface: 'select-dropdown-m2o' })).toBe(false)
  })
})
