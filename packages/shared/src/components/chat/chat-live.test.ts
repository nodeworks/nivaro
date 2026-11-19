import { describe, expect, it } from 'vitest'
import {
  CHAT_LIST_LISTEN_MAX,
  chatInvalidationKeys,
  chatListListenRooms,
  patchRoomsForMessage
} from './chat-core'

// Realtime fixes 2026-11-19 (area B): chat refetches narrow to the rooms a burst named, and the
// rooms list counts channel messages in place instead of re-reading per message.

const room = (r: Record<string, unknown>) =>
  ({ unread: 0, joined: true, muted: false, archived: false, kind: 'channel', ...r }) as never

describe('chatInvalidationKeys', () => {
  it('narrows room-keyed heads to the named rooms and keeps the rest', () => {
    expect(
      chatInvalidationKeys(
        [['nvr-chat'], ['nvr-chat-rooms'], ['nvr-chat-thread']],
        new Set(['ch:ops', 'dm:a:b'])
      )
    ).toEqual([
      ['nvr-chat', 'ch:ops'],
      ['nvr-chat', 'dm:a:b'],
      ['nvr-chat-rooms'],
      ['nvr-chat-thread', 'ch:ops'],
      ['nvr-chat-thread', 'dm:a:b']
    ])
  })
  it('a message that named no room re-reads every room', () => {
    expect(chatInvalidationKeys([['nvr-chat'], ['nvr-chat-pins']], null)).toEqual([
      ['nvr-chat'],
      ['nvr-chat-pins']
    ])
  })
})

describe('chatListListenRooms', () => {
  it('listens to joined, live General and channels only, bounded', () => {
    const rows = [
      room({ room: 'global', kind: 'global' }),
      room({ room: 'ch:b' }),
      room({ room: 'ch:left', joined: false }),
      room({ room: 'ch:old', archived: true }),
      room({ room: 'dm:a:b', kind: 'dm' })
    ]
    expect(chatListListenRooms(rows)).toEqual(['ch:b', 'global'])
    const many = Array.from({ length: 60 }, (_, i) => room({ room: `ch:${i}` }))
    expect(chatListListenRooms(many)).toHaveLength(CHAT_LIST_LISTEN_MAX)
  })
})

describe('patchRoomsForMessage', () => {
  const rows = [room({ room: 'ch:ops', unread: 2 }), room({ room: 'ch:x', unread: 0 })]
  it('counts someone else’s top-level message and shows it as the latest', () => {
    const next = patchRoomsForMessage(
      rows,
      { id: 9, room: 'ch:ops', sender: 'B' },
      'a'
    ) as never as Array<{
      unread: number
      last_message: { id: number } | null
    }>
    expect(next[0].unread).toBe(3)
    expect(next[0].last_message?.id).toBe(9)
    expect(next[1]).toBe(rows[1])
  })
  it('leaves my own messages, thread replies and unknown rooms alone', () => {
    expect(patchRoomsForMessage(rows, { id: 1, room: 'ch:ops', sender: 'A' }, 'a')).toBe(rows)
    expect(
      patchRoomsForMessage(rows, { id: 2, room: 'ch:ops', sender: 'b', parent_id: 5 }, 'a')
    ).toBe(rows)
    expect(patchRoomsForMessage(rows, { id: 3, room: 'ch:none', sender: 'b' }, 'a')).toBe(rows)
  })
})
