import { describe, expect, it } from 'vitest'
import { sendCurrentWarning } from './SendCurrentData'

describe('sendCurrentWarning', () => {
  it('says plainly that the current data goes out, not the original request', () => {
    expect(
      sendCurrentWarning('LinX', 'Waiting on Level 3 Approval, requisition PW27-81371, no PO')
    ).toBe(
      "This sends the record's current data (Waiting on Level 3 Approval, requisition PW27-81371, no PO) to LinX now — not the original request."
    )
  })

  it('still reads without a summary', () => {
    expect(sendCurrentWarning('LinX', null)).toBe(
      "This sends the record's current data to LinX now — not the original request."
    )
  })
})
