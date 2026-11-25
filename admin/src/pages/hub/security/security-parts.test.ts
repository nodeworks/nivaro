import { describe, expect, it } from 'vitest'
import { codeWords, untilWords } from './security-parts'

describe('security tab words', () => {
  it('says how long until a grant ends', () => {
    const now = Date.parse('2026-11-25T12:00:00Z')
    expect(untilWords('2026-11-25T12:40:00Z', now)).toBe('in 40 min')
    expect(untilWords('2026-11-25T15:10:00Z', now)).toBe('in 3 h 10 min')
    expect(untilWords('2026-11-25T14:00:00Z', now)).toBe('in 2 h')
    expect(untilWords('2026-11-29T12:00:00Z', now)).toBe('in 4 days')
    expect(untilWords('2026-11-25T11:00:00Z', now)).toBe('now')
  })

  it('turns check and link codes into words, never a raw unknown code', () => {
    expect(codeWords('ENOTFOUND')).toBe('No DNS record')
    expect(codeWords('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('Certificate is for another name')
    expect(codeWords('SOMETHING_ELSE', 'it did not answer')).toBe('it did not answer')
    expect(codeWords(null)).toBe('error')
  })
})
