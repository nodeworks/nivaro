import { describe, expect, it } from 'vitest'
import { describeDbRefusal, isPoolBusy } from '../../../lib/db-refusal.js'

describe('isPoolBusy', () => {
  it('recognises knex giving up waiting for a connection', () => {
    const e = Object.assign(
      new Error(
        'Knex: Timeout acquiring a connection. The pool is probably full. Are you missing a .transacting(trx) call?'
      ),
      { name: 'KnexTimeoutError' }
    )
    expect(isPoolBusy(e)).toBe(true)
    expect(isPoolBusy({ message: e.message })).toBe(true)
  })

  it('is not a statement timeout, a refusal or anything else', () => {
    expect(isPoolBusy(new Error('Timeout: Request failed to complete in 15000ms'))).toBe(false)
    expect(isPoolBusy(new Error("Violation of PRIMARY KEY constraint 'pk'"))).toBe(false)
    expect(isPoolBusy(null)).toBe(false)
    // and a busy pool is never mistaken for a data refusal
    expect(
      describeDbRefusal(
        new Error('Knex: Timeout acquiring a connection. The pool is probably full.')
      )
    ).toBeNull()
  })
})
