import { describe, expect, it } from 'vitest'
import type { Requester } from '../types'
import { sameRequester } from './SubmissionDrill'

function requester(over: Partial<Requester>): Requester {
  return {
    kind: 'person',
    basis: 'inferred',
    label: 'Dana Reyes',
    user: null,
    via: null,
    how: null,
    ...over
  }
}

describe('sameRequester (Task 15d fix — "Retried by" must compare identity, not label)', () => {
  it('two different people who happen to share a display label are NOT the same', () => {
    const a = requester({
      label: 'Dana Reyes',
      user: { id: 'U1', name: 'Dana Reyes', email: null, inactive: null, account_kind: null }
    })
    const b = requester({
      label: 'Dana Reyes',
      user: { id: 'U2', name: 'Dana Reyes', email: null, inactive: null, account_kind: null }
    })
    expect(sameRequester(a, b)).toBe(false)
  })

  it('the same person is the same requester regardless of via/how wording', () => {
    const a = requester({
      label: 'Dana Reyes',
      via: 'transition',
      how: 'Made the transition moments before.',
      user: { id: 'U1', name: 'Dana Reyes', email: null, inactive: null, account_kind: null }
    })
    const b = requester({
      label: 'Dana Reyes',
      via: 'retry',
      how: null,
      user: { id: 'U1', name: 'Dana Reyes', email: null, inactive: null, account_kind: null }
    })
    expect(sameRequester(a, b)).toBe(true)
  })

  it('an identified user is never "the same" as an unidentified automatic one', () => {
    const a = requester({ label: 'Scheduled', user: null, kind: 'scheduled' })
    const b = requester({
      label: 'Scheduled',
      kind: 'scheduled',
      user: { id: 'U1', name: 'Someone', email: null, inactive: null, account_kind: null }
    })
    expect(sameRequester(a, b)).toBe(false)
  })

  it('two automatic (no-user) requesters fall back to kind + label — the retry ladder reads as different', () => {
    const original = requester({ kind: 'scheduled', label: 'Scheduled — nightly-sync', user: null })
    const retryLadder = requester({
      kind: 'scheduled',
      label: 'Scheduled — the retry ladder',
      user: null
    })
    expect(sameRequester(original, retryLadder)).toBe(false)
  })

  it('two automatic requesters with the identical kind + label are the same', () => {
    const a = requester({ kind: 'scheduled', label: 'Scheduled — nightly-sync', user: null })
    const b = requester({ kind: 'scheduled', label: 'Scheduled — nightly-sync', user: null })
    expect(sameRequester(a, b)).toBe(true)
  })
})
