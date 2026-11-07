import { describe, expect, it } from 'vitest'
import { relatedMissing, retryRelatedRead } from './related-missing'

// army8 review M8: every unreadable link said "Not available to you", so a
// deleted record or a failed read looked like a permissions problem.
describe('relatedMissing', () => {
  const err = (status: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
      response: { status, data: { error: 'x' } }
    })

  it('words a refusal or an empty answer as access', () => {
    expect(relatedMissing(null).text).toBe('Not available to you')
    expect(relatedMissing(err(403)).text).toBe('Not available to you')
  })

  it('words a 404 as not found, never as access', () => {
    const m = relatedMissing(err(404))
    expect(m.kind).toBe('not-found')
    expect(m.text).toBe('Record not found')
  })

  it('words any other failure as a load failure, without raw text', () => {
    for (const e of [err(500), new TypeError('Failed to fetch')]) {
      const m = relatedMissing(e)
      expect(m.kind).toBe('failed')
      expect(`${m.text} ${m.tip}`).not.toMatch(/status code|fetch|500/i)
    }
  })

  it('retries only reads that may answer differently', () => {
    expect(retryRelatedRead(0, err(404))).toBe(false)
    expect(retryRelatedRead(0, err(403))).toBe(false)
    expect(retryRelatedRead(0, err(503))).toBe(true)
    expect(retryRelatedRead(2, err(503))).toBe(false)
  })
})
