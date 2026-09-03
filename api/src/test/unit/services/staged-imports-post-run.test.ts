import { describe, expect, it } from 'vitest'
import { parsePostRunFlows } from '../../../services/staged-imports.js'

const A = '3a5f1c2e-1111-4222-8333-444455556666'
const B = '9B9B9B9B-2222-4333-8444-555566667777'

describe('parsePostRunFlows', () => {
  it('accepts arrays and JSON strings, upper-cases and de-duplicates ids', () => {
    expect(parsePostRunFlows([A, a(A), B])).toEqual([A.toUpperCase(), B])
    expect(parsePostRunFlows(JSON.stringify([B]))).toEqual([B])
  })
  it('drops anything that is not a uuid-shaped id', () => {
    expect(parsePostRunFlows([A, 'DROP TABLE', 42, null, ''])).toEqual([A.toUpperCase()])
  })
  it('is empty for null, malformed JSON, or non-array shapes', () => {
    expect(parsePostRunFlows(null)).toEqual([])
    expect(parsePostRunFlows('{bad')).toEqual([])
    expect(parsePostRunFlows({ id: A })).toEqual([])
  })
})

function a(s: string) {
  return s.toUpperCase()
}
