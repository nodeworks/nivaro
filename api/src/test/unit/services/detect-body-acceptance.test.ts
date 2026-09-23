import { describe, expect, it } from 'vitest'
import { detectBodyAcceptance } from '../../../services/workflow-actions.js'

describe('detectBodyAcceptance — did the partner say yes in the body?', () => {
  it('accepts the string acknowledgements', () => {
    expect(detectBodyAcceptance(null, { api_status: 'OK' })).toBe(true)
    expect(detectBodyAcceptance(null, { status: ' success ' })).toBe(true)
    expect(detectBodyAcceptance(null, { result: 'ACCEPTED' })).toBe(true)
  })

  it('accepts a boolean acknowledgement — {"status": true} is a yes, not a maybe', () => {
    // The shape a partner answered on a successful update (2026-09-23);
    // string-only matching parked the submission at `pending`.
    expect(detectBodyAcceptance(null, { status: true, message: 'updated records: 0' })).toBe(true)
    expect(detectBodyAcceptance(null, { success: true })).toBe(true)
    expect(detectBodyAcceptance(null, { ok: true })).toBe(true)
  })

  it('never reads a false, a truthy string or a nested flag as acceptance', () => {
    expect(detectBodyAcceptance(null, { status: false })).toBe(false)
    expect(detectBodyAcceptance(null, { status: 'true' })).toBe(false)
    expect(detectBodyAcceptance(null, { status: 1 })).toBe(false)
    expect(detectBodyAcceptance(null, { data: { status: true } })).toBe(false)
    expect(detectBodyAcceptance(null, { status: 'ERROR' })).toBe(false)
    expect(detectBodyAcceptance(null, [{ status: true }])).toBe(false)
    expect(detectBodyAcceptance(null, null)).toBe(false)
  })

  it('an explicit response_success config replaces the heuristic entirely', () => {
    const cfg = { when: [{ path: 'outcome', in: ['DONE'] }] }
    expect(detectBodyAcceptance(cfg, { outcome: 'done' })).toBe(true)
    // The heuristic would say yes here; the configured rule does not.
    expect(detectBodyAcceptance(cfg, { status: true })).toBe(false)
  })
})
