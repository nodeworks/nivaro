import { describe, expect, it } from 'vitest'
import { flowHaltReason } from '../../../services/integration-obligations.js'

describe('flowHaltReason', () => {
  it('names the op that halted the chain', () => {
    expect(flowHaltReason('Check PO linked')).toBe('flow condition rejected at "Check PO linked"')
  })

  it('is null when the flow ran to the end — nothing to explain', () => {
    expect(flowHaltReason(null)).toBeNull()
  })

  it('is null for an empty halt marker rather than an empty quote', () => {
    expect(flowHaltReason('')).toBeNull()
  })
})
