import { describe, expect, it } from 'vitest'
import { plainDetail } from './tone'

// army 8 b14: problem lines printed raw ISO stamps, a JSON error wrapper and a partner
// error's request-type UUID.
describe('plainDetail', () => {
  it('turns ISO stamps into a readable date', () => {
    const out = plainDetail('No activity since 2025-01-06T19:24:11.000Z (over 3h ago)')
    expect(out).not.toMatch(/T19:24|\.000Z/)
    expect(out).toMatch(/2025/)
    expect(out).toMatch(/^No activity since .+ \(over 3h ago\)$/)
  })
  it('unwraps a JSON error message', () => {
    expect(plainDetail('{"message":"import_forecasts - "}')).toBe('import_forecasts')
  })
  it('drops UUIDs from a partner error', () => {
    expect(
      plainDetail(
        'HTTP 400: "A deploymentRequestTypeId:f4757bc3-1a2b-4c3d-8e9f-0123456789ab was not found for divisionErpId:COMC120."'
      )
    ).toBe('HTTP 400: "A deploymentRequestTypeId was not found for divisionErpId:COMC120."')
  })
  it('leaves plain text alone', () => {
    expect(plainDetail('3 of 40 calls in the last hour')).toBe('3 of 40 calls in the last hour')
    expect(plainDetail(null)).toBe('')
  })
})
