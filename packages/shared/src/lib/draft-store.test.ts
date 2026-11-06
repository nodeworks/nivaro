// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { draftCreatedAs, keepDraftSavedAt, markDraftCreated, type StoredDraft } from './draft-store'

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

// army5 b09-N3b: a restored-then-left draft said "from just now" minutes later.
describe('keepDraftSavedAt', () => {
  const d = (saved_at: string, fields: Record<string, unknown>): StoredDraft => ({
    key: 'workflows:1:u1',
    collection: 'workflows',
    item_id: '1',
    user_id: 'u1',
    saved_at,
    fields,
    base: {},
    base_updated_at: null,
    pending_rows: {},
    pending_edits: {},
    pending_deletes: {},
    m2m_links: {},
    m2m_unlinks: {}
  })
  it('the same work keeps its original time', () => {
    const prev = d('2026-11-06T16:46:31Z', { description: 'S3' })
    const next = d('2026-11-06T16:48:20Z', { description: 'S3' })
    expect(keepDraftSavedAt(next, prev).saved_at).toBe('2026-11-06T16:46:31Z')
  })
  it('changed work is stamped anew', () => {
    const prev = d('2026-11-06T16:46:31Z', { description: 'S3' })
    const next = d('2026-11-06T16:48:20Z', { description: 'S4' })
    expect(keepDraftSavedAt(next, prev).saved_at).toBe('2026-11-06T16:48:20Z')
    expect(keepDraftSavedAt(next, null).saved_at).toBe('2026-11-06T16:48:20Z')
  })
})
