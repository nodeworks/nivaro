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

// Rob 2026-11-10: MWF gets ONLY markets B1020, B1021, B1313 and B1028 — an
// allow list instead of excluding markets one by one (B254 …).
const ONLY = [
  {
    field: 'workflow_id',
    not_starts_with_any: ['B1020-', 'B1021-', 'B1313-', 'B1028-'],
    reason: 'MWF only takes markets B1020, B1021, B1313 and B1028'
  }
]

describe('matchSendSkip — allow list (not_starts_with_any)', () => {
  it('sends the listed markets, any case', () => {
    for (const id of ['B1020-123456', 'B1021-1', 'b1313-6087324', 'B1028-9'])
      expect(matchSendSkip(ONLY, { workflow_id: id })).toBeNull()
  })

  it('skips every other market, B254 included, with the reason', () => {
    expect(matchSendSkip(ONLY, { workflow_id: 'B254-6079697' })).toBe(
      'not sent: workflow_id B254-6079697 — MWF only takes markets B1020, B1021, B1313 and B1028'
    )
    expect(matchSendSkip(ONLY, { workflow_id: 'B10200-1' })).toMatch(/^not sent/)
    expect(matchSendSkip(ONLY, { workflow_id: 'X1313-1' })).toMatch(/^not sent/)
  })

  it('a body without the field, or a blank value, is not judged; an empty list skips nothing', () => {
    expect(matchSendSkip(ONLY, { requisition_id: 'X' })).toBeNull()
    expect(matchSendSkip(ONLY, { workflow_id: '' })).toBeNull()
    expect(
      matchSendSkip([{ field: 'workflow_id', not_starts_with_any: [] }], { workflow_id: 'B254-1' })
    ).toBeNull()
  })
})
