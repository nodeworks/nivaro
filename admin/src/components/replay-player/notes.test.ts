import { describe, expect, it } from 'vitest'
import { splitReplayLink } from '../issue-comments'
import { noteMarkers, type ReplayNote } from './notes'

const note = (id: string, at_ms: number): ReplayNote => ({
  id,
  recording: 'r',
  at_ms,
  text: `note ${id}`,
  user: null,
  user_name: null,
  created_at: '',
  updated_at: ''
})

describe('noteMarkers (#1363)', () => {
  it('places notes by offset, earliest first', () => {
    const m = noteMarkers([note('b', 50_000), note('a', 10_000)], 100_000, 1000)
    expect(m.map((g) => [g.offset, g.left, g.notes.map((n) => n.id)])).toEqual([
      [10_000, 0.1, ['a']],
      [50_000, 0.5, ['b']]
    ])
  })

  it('merges notes a few pixels apart and clamps past-the-end notes', () => {
    const m = noteMarkers([note('a', 1000), note('b', 1200), note('c', 500_000)], 100_000, 600)
    expect(m).toHaveLength(2)
    expect(m[0].notes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(m[1]).toMatchObject({ offset: 100_000, left: 1 })
  })

  it('has nothing to place before the length is known', () => {
    expect(noteMarkers([note('a', 1)], 0, 600)).toEqual([])
  })
})

describe('splitReplayLink', () => {
  it('pulls the deep link out of a copied note', () => {
    const r = splitReplayLink(
      'Replay note at 1:23: Save greys out\nWatch: /session-replays?recording=6f1c2b3a-1234-4abc-9def-0123456789ab&t=83400'
    )
    expect(r.body).toBe('Replay note at 1:23: Save greys out')
    expect(r.link).toEqual({
      href: '/session-replays?recording=6f1c2b3a-1234-4abc-9def-0123456789ab&t=83400',
      at: 83400
    })
  })

  it('leaves plain comments alone', () => {
    expect(splitReplayLink('just text')).toEqual({ body: 'just text', link: null })
  })
})
