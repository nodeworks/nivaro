import { describe, expect, it } from 'vitest'
import { coversEveryone } from '../../../services/hub/providers/cidr.js'

describe('coversEveryone: IPv4 carried in IPv6 (security review)', () => {
  it('counts ranges overlapping ::ffff:0:0/96 or 64:ff9b::/96 as everyone', () => {
    expect(coversEveryone(['::ffff:0:0/96'])).toBe(true)
    expect(coversEveryone(['::fffe:0:0/95'])).toBe(true)
    expect(coversEveryone(['64:ff9b::/96'])).toBe(true)
    expect(coversEveryone(['2001:db8::/32'])).toBe(false)
    expect(coversEveryone(['10.0.0.0/8'])).toBe(false)
  })
})
