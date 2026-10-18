import { describe, expect, it } from 'vitest'
import { clientIpOf } from '../../../services/traffic-taps/req-facts.js'

describe('clientIpOf', () => {
  it('uses the TRUST_PROXY-resolved address, never a client-sent x-forwarded-for', () => {
    const r = { ip: '203.0.113.7', headers: { 'x-forwarded-for': '10.0.0.1, 198.51.100.2' } }
    expect(clientIpOf(r as never)).toBe('203.0.113.7')
    expect(clientIpOf({ headers: {} } as never)).toBeNull()
  })
})
