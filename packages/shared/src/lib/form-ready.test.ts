import { describe, expect, it } from 'vitest'
import { formReadyToSave } from './form-ready'

describe('formReadyToSave', () => {
  it('refuses while the form has no fields (still loading or failed to load)', () => {
    // INV-37593: Create pressed before the fields loaded saved a blank request.
    expect(formReadyToSave([])).toBe(false)
    expect(formReadyToSave(undefined)).toBe(false)
    expect(formReadyToSave(null)).toBe(false)
  })

  it('allows once fields are there (the required checks then judge them)', () => {
    expect(formReadyToSave([{ field: 'division', required: true }])).toBe(true)
  })
})
