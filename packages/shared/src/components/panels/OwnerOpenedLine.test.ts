import { describe, expect, it } from 'vitest'
import { ownerOpenedWords } from './OwnerOpenedLine'

const rel = () => '2h ago'
const state = { id: 's1', label: 'Finance approval' }

describe('ownerOpenedWords', () => {
  it('names the opener and their group', () => {
    expect(
      ownerOpenedWords(
        {
          status: 'opened',
          state,
          entered_at: '2026-11-14T10:00:00Z',
          opened_at: '2026-11-14T12:00:00Z',
          by: { id: 'u1', name: 'Jane Smith', group: 'Finance' },
          others: 0
        },
        rel
      )
    ).toEqual({ lead: null, name: 'Jane Smith', group: 'Finance', tail: ' opened this 2h ago' })
  })

  it('an unlisted opener stays unnamed; other openers are counted', () => {
    expect(
      ownerOpenedWords(
        {
          status: 'opened',
          state,
          entered_at: '2026-11-14T10:00:00Z',
          opened_at: '2026-11-14T12:00:00Z',
          by: null,
          others: 2
        },
        rel
      )
    ).toEqual({
      lead: 'An owner of this step',
      name: null,
      group: null,
      tail: ' opened this 2h ago · 2 other owners too'
    })
  })

  it('not opened yet says when it arrived', () => {
    expect(
      ownerOpenedWords({ status: 'not_opened', state, entered_at: '2026-11-14T10:00:00Z' }, rel)
        ?.lead
    ).toBe('Not opened yet by the owners of this step')
  })

  it('owners and records with no owners get nothing', () => {
    expect(ownerOpenedWords({ status: 'owner' }, rel)).toBeNull()
    expect(ownerOpenedWords({ status: 'none' }, rel)).toBeNull()
  })
})
