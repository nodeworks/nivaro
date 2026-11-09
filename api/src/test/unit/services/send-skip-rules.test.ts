import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import { matchSendSkip } from '../../../services/send-skip-rules.js'

const B254 = [
  { field: 'workflow_id', starts_with: 'B254-', reason: 'MWF does not support market B254 yet' }
]

describe('matchSendSkip', () => {
  it('skips a body whose field starts with the prefix (any case)', () => {
    expect(matchSendSkip(B254, { workflow_id: 'B254-6079697' })).toBe(
      'not sent: workflow_id B254-6079697 — MWF does not support market B254 yet'
    )
    expect(matchSendSkip(B254, { workflow_id: 'b254-1' })).toMatch(/^not sent/)
  })

  it('sends everything else, and ignores missing fields and bad rules', () => {
    expect(matchSendSkip(B254, { workflow_id: 'B1313-6087324' })).toBeNull()
    expect(matchSendSkip(B254, { requisition_id: 'X' })).toBeNull()
    expect(matchSendSkip([{ starts_with: 'B254-' }], { workflow_id: 'B254-1' })).toBeNull()
    expect(matchSendSkip(null, { workflow_id: 'B254-1' })).toBeNull()
    expect(matchSendSkip(B254, null)).toBeNull()
  })

  it('reads dotted paths and exact matches', () => {
    expect(matchSendSkip([{ field: 'a.b', equals: 'x' }], { a: { b: 'X' } })).toBe(
      'not sent: a.b X'
    )
  })
})
