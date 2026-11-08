import { describe, expect, it, vi } from 'vitest'

// record-transition.ts imports the db and the engine; the pure helpers below need neither.
vi.mock('../db/index.js', () => ({ db: () => ({}) }))

import { lockAckFrom, lockActorFor, lockedMoveRefusal } from './record-transition.js'

describe('a move while someone else is editing (army 11 f4 M4)', () => {
  it('is refused with a plain reason naming the editor, and offers to move anyway', () => {
    const r = lockedMoveRefusal(
      { locked_by: 'U-BERNARD', locked_by_name: 'Bernard Kelly' },
      'Submit'
    )
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('RECORD_LOCKED')
    expect(r.body.move_anyway).toBe(true)
    expect(r.body.locked_by_name).toBe('Bernard Kelly')
    expect(String(r.body.error)).toContain('Bernard Kelly is editing this record right now')
    expect(String(r.body.error)).toContain('Submit anyway')
    // No internal ids in what a person reads.
    expect(String(r.body.error)).not.toContain('U-BERNARD')
  })

  it('a holder with no name still reads as a person', () => {
    const r = lockedMoveRefusal({ locked_by: 'X', locked_by_name: null }, 'Cancel Workflow')
    expect(String(r.body.error)).toMatch(/^Someone else is editing/)
  })

  it('only an explicit yes acknowledges the lock', () => {
    expect(lockAckFrom(true)).toBe(true)
    expect(lockAckFrom('1')).toBe(true)
    expect(lockAckFrom('true')).toBe(true)
    expect(lockAckFrom(undefined)).toBe(false)
    expect(lockAckFrom(false)).toBe(false)
    expect(lockAckFrom('yes')).toBe(false)
  })
})

describe('who the edit lock judges for a move', () => {
  const user = { id: 'U1' } as never
  it('the request when there is one', () => {
    const req = { user, authMethod: 'api_key' } as never
    expect(lockActorFor({ user, req })).toBe(req)
  })
  it('a Teams press (no request) as a signed-in person', () => {
    expect(lockActorFor({ user, lockAsPerson: true })).toEqual({ user, authMethod: 'session' })
  })
  it('server code with neither is not judged', () => {
    expect(lockActorFor({ user })).toBeNull()
  })
})
