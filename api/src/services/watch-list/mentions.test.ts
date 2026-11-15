import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: () => ({}) }))

import { previewLine, repliesFrom } from './mentions.js'

describe('mentions & replies', () => {
  const mine = [
    { collection: 'orders', item: '1', field: null, at: '2026-11-14T10:00:00Z' },
    { collection: 'orders', item: '1', field: 'total', at: '2026-11-14T09:00:00Z' }
  ]
  const c = (id: string, field: string | null, user: string, at: string) => ({
    id,
    collection: 'orders',
    item: '1',
    field,
    user,
    created_at: at,
    text: 'x'
  })

  it('a reply is someone else’s comment after mine on the same thread', () => {
    const out = repliesFrom(
      mine,
      [
        c('a', null, 'beth', '2026-11-14T11:00:00Z'), // after mine: reply
        c('b', null, 'beth', '2026-11-14T09:30:00Z'), // before my last: not a reply
        c('c', null, 'ME', '2026-11-14T12:00:00Z'), // mine
        c('d', 'total', 'beth', '2026-11-14T09:30:00Z'), // after my field comment: reply
        c('e', 'vendor', 'beth', '2026-11-14T12:00:00Z') // a thread I never wrote on
      ],
      'me'
    )
    expect(out.map((r) => r.id)).toEqual(['a', 'd'])
  })

  it('reads a comment as one plain line', () => {
    expect(
      previewLine('Hi <b>there</b>\n\n![shot.png](/api/files/0b5c6a3e-1111-4222-8333-444455556666)')
    ).toBe('Hi there [image: shot.png]')
    expect(previewLine('x'.repeat(200), 10)).toHaveLength(10)
  })
})
