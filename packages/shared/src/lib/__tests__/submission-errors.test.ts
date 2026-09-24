import { describe, expect, it } from 'vitest'
import { normalizeIdent, submissionLineErrors } from '../submission-errors'

describe('submissionLineErrors', () => {
  it('flags every submitted row with the whole error when nothing names a line (MDSi shape)', () => {
    const r = submissionLineErrors(
      {
        products: [
          { cifaNumber: '105608', lineNumber: 1 },
          { productNumber: 'NTK890DC', lineNumber: 2 }
        ]
      },
      'HTTP 400: "The projectId:US137014 is not valid"'
    )!
    expect(r.reasonFor(['105608'])).toMatch(/projectId/)
    expect(r.reasonFor(['NTK890DC'])).toMatch(/projectId/)
    expect(r.reasonFor(['999'])).toBeNull()
  })

  it('maps "LineNumber N:" segments to the Nth payload line, zero-padded ids and all (Fusion shape)', () => {
    const r = submissionLineErrors(
      {
        consumer: 'FUSION',
        orderDetails: [
          { orderLineNumber: 1, cifaItemNumber: '000105608' },
          { orderLineNumber: 2, cifaItemNumber: '000103233' },
          { orderLineNumber: 3, cifaItemNumber: '000102309' }
        ]
      },
      'LineNumber 2: When the source type is Inventory, you must provide SourceOrganizationCode. (POR-2011121) · LineNumber 3: Item not active'
    )!
    expect(r.reasonFor([normalizeIdent('105608')])).toBeNull()
    expect(r.reasonFor([normalizeIdent('103233')])).toMatch(/SourceOrganizationCode/)
    expect(r.reasonFor([normalizeIdent('102309')])).toBe('Item not active')
  })

  it('a general segment beside line segments reaches every row; a line segment wins for its row', () => {
    const r = submissionLineErrors(
      { orderDetails: [{ cifaItemNumber: '000000001' }, { cifaItemNumber: '000000002' }] },
      'Order header rejected · Line 2: bad quantity'
    )!
    expect(r.reasonFor(['1'])).toBe('Order header rejected')
    expect(r.reasonFor(['2'])).toBe('bad quantity')
  })

  it('returns null when the payload has no line items to match against', () => {
    expect(submissionLineErrors({ consumer: 'FUSION' }, 'x')).toBeNull()
    expect(submissionLineErrors(null, 'x')).toBeNull()
  })

  it('normalizes digit-only identifiers only', () => {
    expect(normalizeIdent('000105608')).toBe('105608')
    expect(normalizeIdent(' 42 ')).toBe('42')
    expect(normalizeIdent('NTK890DC')).toBe('NTK890DC')
    expect(normalizeIdent('0A1')).toBe('0A1')
  })
})
