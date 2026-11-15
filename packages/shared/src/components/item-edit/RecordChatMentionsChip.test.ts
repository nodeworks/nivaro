import { describe, expect, it } from 'vitest'
import { mentionsText } from './RecordChatMentionsChip'

const room = (label: string, count: number, new_count: number) => ({
  room: label,
  kind: 'channel' as const,
  label,
  count,
  new_count,
  last_at: null
})

describe('record chat mentions chip', () => {
  it('names the one room and the new count', () => {
    const rooms = [room('#ops', 5, 3)]
    expect(mentionsText({ rooms, total: 5, new_total: 3 })).toBe('Being discussed in #ops (3 new)')
  })
  it('quiet when nothing is new, and groups several rooms', () => {
    expect(mentionsText({ rooms: [room('#ops', 2, 0)], total: 2, new_total: 0 })).toBe(
      'Discussed in #ops'
    )
    expect(
      mentionsText({ rooms: [room('#a', 1, 1), room('Beth', 1, 0)], total: 2, new_total: 1 })
    ).toBe('Being discussed in 2 chats (1 new)')
    expect(mentionsText({ rooms: [], total: 0, new_total: 0 })).toBe('')
  })
})
