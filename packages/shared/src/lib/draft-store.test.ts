// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { draftCreatedAs, markDraftCreated } from './draft-store'

const KEY = 'workflows:new:u1'

afterEach(() => localStorage.clear())

describe('draft created markers', () => {
  it('names the record a draft captured before its create became', () => {
    markDraftCreated(KEY, '372797', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:13Z', new Date('2026-10-24T22:20:00Z'))).toEqual({
      id: '372797',
      at: '2026-10-24T22:14:20.000Z'
    })
  })

  it('leaves a draft captured after the create alone (new work)', () => {
    markDraftCreated(KEY, '372797', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:15:00Z', new Date('2026-10-24T22:20:00Z'))).toBeNull()
  })

  it('is per draft key, and forgets after a week', () => {
    markDraftCreated(KEY, '1', new Date('2026-10-01T00:00:00Z'))
    expect(draftCreatedAs('workflows:new:u2', '2026-09-30T00:00:00Z')).toBeNull()
    expect(draftCreatedAs(KEY, '2026-09-30T00:00:00Z', new Date('2026-10-09T00:00:00Z'))).toBeNull()
    expect(localStorage.getItem(`nvr:draft-created:${KEY}`)).toBeNull()
  })

  it('keeps an unknown id as "" and ignores junk', () => {
    markDraftCreated(KEY, '', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:00Z', new Date('2026-10-24T22:15:00Z'))?.id).toBe(
      ''
    )
    localStorage.setItem(`nvr:draft-created:${KEY}`, '{nope')
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:00Z')).toBeNull()
    expect(draftCreatedAs(KEY, null)).toBeNull()
  })
})
