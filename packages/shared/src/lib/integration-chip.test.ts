import { describe, expect, it } from 'vitest'
import { externalRequestsShown } from './integration-chip'

// The header "External requests" chip shows only where a partner integration exists
// (Rob 2026-11-13: "No external requests" on a collection nothing is ever sent from).
describe('externalRequestsShown', () => {
  const none = { partnerIntegration: false, obligations: 0, submissions: 0, layoutOn: true }

  it('hides the chip on a collection with no partner integration and nothing sent', () => {
    expect(externalRequestsShown(none)).toBe(false)
  })

  it('shows it when the collection has a partner integration', () => {
    expect(externalRequestsShown({ ...none, partnerIntegration: true })).toBe(true)
  })

  it('shows it when the record already has obligations or requests sent', () => {
    expect(externalRequestsShown({ ...none, obligations: 1 })).toBe(true)
    expect(externalRequestsShown({ ...none, submissions: 2 })).toBe(true)
  })

  it('a server that does not say (older API) keeps the chip', () => {
    expect(externalRequestsShown({ ...none, partnerIntegration: undefined })).toBe(true)
  })

  it('is unknown until both reads answered', () => {
    expect(externalRequestsShown({ ...none, obligations: null })).toBeNull()
    expect(externalRequestsShown({ ...none, submissions: null })).toBeNull()
  })

  it('the form setting turns it off whatever the record has', () => {
    expect(
      externalRequestsShown({
        partnerIntegration: true,
        obligations: 3,
        submissions: 3,
        layoutOn: false
      })
    ).toBe(false)
  })
})
