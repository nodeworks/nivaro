import { describe, expect, it } from 'vitest'
import { explainedMissing, relatedMissing, retryRelatedRead } from './related-missing'

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

// Production review 2026-11-12: a unit type hidden by the reader's access read
// "Record not found". Once the server says which it was, the label says that.
describe('explainedMissing', () => {
  it('a record a gate hides is an access matter, in the server’s words', () => {
    const m = explainedMissing({
      access: false,
      reasons: [{ type: 'scope', message: 'Your Zone access covers Zone 1.' }]
    })
    expect(m).toEqual({
      kind: 'no-access',
      text: 'Not available to you',
      tip: 'Your Zone access covers Zone 1.'
    })
  })

  it('a record that does not exist stays not found, never an access matter', () => {
    const m = explainedMissing({
      access: false,
      reasons: [{ type: 'not_found', message: 'This record does not exist.' }]
    })
    expect(m?.kind).toBe('not-found')
    expect(m?.text).toBe('Record not found')
  })

  // Design review 2026-11-12: the server says when it was deleted, by whom and
  // that it can be restored; the label dropped all of it for "was removed".
  it('a removed record keeps the server’s sentence as its hint', () => {
    const said =
      'This record was deleted 11/3/2026 by Jane Doe. It sits in the trash for 30 days and can be restored.'
    expect(
      explainedMissing({ access: false, reasons: [{ type: 'not_found', message: `  ${said} ` }] })
    ).toEqual({ kind: 'not-found', text: 'Record not found', tip: said })
  })

  it('a removed record with no sentence says it was removed', () => {
    expect(explainedMissing({ access: false, reasons: [{ type: 'not_found' }] })?.tip).toBe(
      'This record was removed.'
    )
  })

  it('settles nothing without an answer or without a reason', () => {
    expect(explainedMissing(null)).toBeNull()
    expect(explainedMissing({ access: true, reasons: [] })).toBeNull()
  })

  it('falls back to plain words when a reason carries no sentence', () => {
    expect(explainedMissing({ access: false, reasons: [{ type: 'row_filter' }] })?.tip).toBe(
      'Your access does not include this record.'
    )
  })
})
