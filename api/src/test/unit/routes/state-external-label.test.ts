import { describe, expect, it } from 'vitest'
import { normalizeExternalLabel } from '../../../routes/pipelines.js'

describe('normalizeExternalLabel', () => {
  it('trims and caps at 255', () => {
    expect(normalizeExternalLabel('  Waiting On PO  ')).toBe('Waiting On PO')
    expect(normalizeExternalLabel('x'.repeat(300))).toHaveLength(255)
  })
  it('blank and undefined store NULL', () => {
    expect(normalizeExternalLabel('')).toBeNull()
    expect(normalizeExternalLabel('   ')).toBeNull()
    expect(normalizeExternalLabel(undefined)).toBeNull()
    expect(normalizeExternalLabel(null)).toBeNull()
  })
})
