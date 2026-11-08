import { describe, expect, it, vi } from 'vitest'

// Army 11 a1 F-13 / a2 F4: a person's note on a move (Send Back reason) is the
// newest comment on the record; the mail's own quoted comment is skipped.

const rows = vi.hoisted(() => ({
  comments: [] as Array<Record<string, unknown>>,
  history: [] as Array<Record<string, unknown>>
}))
vi.mock('../../../services/note-authorship.js', () => ({
  originSelect: async () => ['h.origin'],
  originOfRow: (r: { origin?: unknown }) => (r.origin ? r.origin : 'person')
}))
vi.mock('../../../extensions/related-notes.js', () => ({
  relatedNoteRegistry: { isMachineComment: () => false }
}))
vi.mock('../../../db/index.js', () => {
  const db = vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of [
      'leftJoin',
      'join',
      'where',
      'whereNull',
      'whereNotNull',
      'orderBy',
      'limit',
      'select'
    ])
      c[m] = vi.fn(() => c)
    c.first = vi.fn(async () => undefined)
    const data =
      t === 'nivaro_comments as c'
        ? rows.comments
        : t === 'nivaro_workflow_history as h'
          ? rows.history
          : []
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(data).then(res, rej)
    return c
  })
  return { db }
})

import { latestPeopleComment } from '../../../services/latest-comment.js'

describe('latestPeopleComment — transition notes', () => {
  it('a send-back note newer than the hold comment wins', async () => {
    rows.comments = [
      {
        text: 'waiting on vendor quote',
        created_at: '2026-11-08T20:11:00Z',
        first_name: 'Kristina',
        last_name: 'Davison'
      }
    ]
    rows.history = [
      {
        comment: 'not funded this year',
        timestamp: '2026-11-08T20:33:00Z',
        user: 'u-tim',
        first_name: 'Timothy',
        last_name: 'Desrosiers'
      },
      {
        comment: 'please re-check the vendor',
        timestamp: '2026-11-08T20:23:00Z',
        user: 'u-tim',
        first_name: 'Timothy',
        last_name: 'Desrosiers'
      }
    ]
    // The cancel mail quotes "not funded this year" itself — skip it.
    const r = await latestPeopleComment('workflows', '372993', {
      skipText: 'not funded this year'
    })
    expect(r?.text).toBe('please re-check the vendor')
    expect(r?.source).toBe('transition')
    expect(r?.author_name).toBe('Timothy Desrosiers')
  })

  it('machine stamps on moves never count', async () => {
    rows.comments = []
    rows.history = [{ comment: 'auto: PO Received', timestamp: '2026-11-08T20:33:00Z' }]
    expect(await latestPeopleComment('workflows', '1')).toBeNull()
  })
})

describe("review #2 / LOW: engine rows and a delegate's own note", () => {
  it('engine comments never count, even with a person on the row', async () => {
    rows.comments = []
    rows.history = [
      {
        comment: 'Auto-advanced via skip criteria',
        timestamp: '2026-11-08T20:33:00Z',
        user: 'u-lee',
        origin: 'machine'
      },
      { comment: 'bulk-start', timestamp: '2026-11-08T20:32:00Z', user: null }
    ]
    expect(await latestPeopleComment('workflows', '1')).toBeNull()
  })
  it("a delegate's annotated note is the mail's own note", async () => {
    rows.comments = []
    rows.history = [
      {
        comment: 'looks good (for Beth Ross, out of office)',
        timestamp: '2026-11-08T20:33:00Z',
        user: 'u-kim',
        origin: 'person'
      }
    ]
    expect(await latestPeopleComment('workflows', '1', { skipText: 'looks good' })).toBeNull()
  })
})
