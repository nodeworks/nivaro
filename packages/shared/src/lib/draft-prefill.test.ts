import { describe, expect, it } from 'vitest'
import { draftMatchesPrefill, prefillSignature } from './draft-store'

describe('new-form drafts and their prefill', () => {
  it('a blank form signs nothing, a prefilled one signs its values (key order free)', () => {
    expect(prefillSignature(null)).toBeNull()
    expect(prefillSignature({})).toBeNull()
    const a = prefillSignature({ v: { zone: 2, year: 2026 }, r: null })
    expect(a).toBe(prefillSignature({ r: null, v: { year: 2026, zone: 2 } }))
    expect(a).not.toBe(prefillSignature({ v: { zone: 1, year: 2027 }, r: null }))
  })

  it("a duplicate of B is never offered A's draft; a blank form keeps its own", () => {
    const sigB = prefillSignature({ v: { project: 'B' } })
    expect(draftMatchesPrefill({ prefill_sig: null }, sigB)).toBe(false)
    expect(draftMatchesPrefill({}, null)).toBe(true)
    expect(draftMatchesPrefill({ prefill_sig: sigB }, sigB)).toBe(true)
  })
})
