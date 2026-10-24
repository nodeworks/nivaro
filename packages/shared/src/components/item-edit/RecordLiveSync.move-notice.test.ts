import { describe, expect, it, vi } from 'vitest'
import { moveNotice } from './RecordLiveSync'

describe('move notice', () => {
  it('the record on screen is "this"', () => {
    expect(moveNotice('Tim', 'Oracle Submission', { active: true })).toEqual({
      text: 'Tim moved this to Oracle Submission'
    })
    expect(moveNotice(null, 'Completed', { active: true }).text).toBe(
      'This record moved to Completed'
    )
  })

  it('a record kept open in a background tab is named, with Open', () => {
    const open = vi.fn()
    const n = moveNotice('Tim', 'Oracle Submission', { active: false, label: 'MM26-80762', open })
    expect(n.text).toBe('Tim moved MM26-80762 to Oracle Submission')
    n.open?.()
    expect(open).toHaveBeenCalledOnce()
  })

  it('falls back to a plain name when the tab label is not known yet', () => {
    expect(moveNotice(null, 'Completed', { active: false, label: '  ' }).text).toBe(
      'A record in your tabs moved to Completed'
    )
  })
})
