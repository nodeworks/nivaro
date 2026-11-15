import { describe, expect, it } from 'vitest'
import { sharedTextUnderLock } from './context'

const base = {
  sharedFields: new Set(['considerations', 'scope']),
  unsavedFields: ['considerations'],
  otherChanges: 0,
  heldByOther: true,
  stepLocked: false,
  recordGone: false
}

describe('shared text on a record someone else holds the lock on', () => {
  it('stays open, and a save of shared text alone goes through', () => {
    expect(sharedTextUnderLock(base)).toEqual({ onlySharedUnsaved: true, open: true, saveOk: true })
  })
  it('any other change in the same save follows the lock', () => {
    expect(
      sharedTextUnderLock({ ...base, unsavedFields: ['considerations', 'amount'] }).saveOk
    ).toBe(false)
    expect(sharedTextUnderLock({ ...base, otherChanges: 1 }).saveOk).toBe(false)
  })
  it('a step lock (post-approval, admin-only) wins', () => {
    expect(sharedTextUnderLock({ ...base, stepLocked: true })).toMatchObject({
      open: false,
      saveOk: false
    })
  })
  it('nothing to open without a held lock, shared fields or a record', () => {
    expect(sharedTextUnderLock({ ...base, heldByOther: false }).open).toBe(false)
    expect(sharedTextUnderLock({ ...base, sharedFields: new Set() }).open).toBe(false)
    expect(sharedTextUnderLock({ ...base, recordGone: true }).open).toBe(false)
  })
})
