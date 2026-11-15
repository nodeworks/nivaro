import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/chat.js', () => ({
  canSeeRoom: vi.fn(),
  channelByKey: vi.fn(),
  newRoomVisibilityCache: () => new Map(),
  parseRoom: vi.fn()
}))
vi.mock('../../../services/chat-records.js', () => ({
  roomForRecord: vi.fn(),
  roomTypes: vi.fn()
}))
vi.mock('../../../services/record-events.js', () => ({ emitRecordEvent: vi.fn() }))

import {
  announceRecordMentions,
  groupMentions,
  likeLiteral,
  messageNamesToken,
  tokensIn
} from '../../../services/record-chat-mentions.js'

const msg = (id: number, room: string, text: string, at: string, sender: string | null = 'S') => ({
  id,
  room,
  sender,
  message: text,
  date_created: at
})

describe('record mentions in chat', () => {
  it('matches a whole token only, any case', () => {
    expect(messageNamesToken('check cm26-80332 please', 'CM26-80332')).toBe(true)
    expect(messageNamesToken('CM26-803321 is another', 'CM26-80332')).toBe(false)
    expect(messageNamesToken('XCM26-80332', 'CM26-80332')).toBe(false)
    expect(messageNamesToken(null, 'CM26-80332')).toBe(false)
  })

  it('escapes LIKE wildcards in a token', () => {
    expect(likeLiteral('A_B%C[1]')).toBe('A[_]B[%]C[[]1]')
  })

  it('finds candidate tokens, capped', () => {
    expect(tokensIn('see ab26-1 and AB26-2, ab26-1')).toEqual(['AB26-1', 'AB26-2'])
    expect(tokensIn('nothing here')).toEqual([])
    expect(tokensIn('ab26-1 ab26-2 ab26-3 ab26-4 ab26-5 ab26-6')).toHaveLength(5)
  })

  const visible = new Map([
    ['ch:ops', { kind: 'channel' as const, label: '#ops' }],
    ['dm:A:B', { kind: 'dm' as const, label: 'Beth' }]
  ])

  it('counts only rooms the viewer is in, with new = others after their watermark', () => {
    const ms = new Map([
      ['ch:ops', { room: 'ch:ops', last_read_at: '2026-11-14T10:00:00Z' }],
      ['ch:secret', { room: 'ch:secret', last_read_at: null }]
    ])
    const out = groupMentions(
      [
        msg(1, 'ch:ops', 'CM26-1 stuck', '2026-11-14T09:00:00Z'),
        msg(2, 'ch:ops', 'CM26-1 moved', '2026-11-14T11:00:00Z'),
        msg(3, 'ch:ops', 'me: CM26-1 looking', '2026-11-14T12:00:00Z', 'ME'),
        msg(4, 'ch:secret', 'CM26-1 hidden', '2026-11-14T12:00:00Z')
      ],
      'CM26-1',
      'me',
      ms,
      visible
    )
    expect(out.rooms).toHaveLength(1)
    expect(out.rooms[0]).toMatchObject({ room: 'ch:ops', count: 3, new_count: 1 })
    expect(out.total).toBe(3)
    expect(out.new_total).toBe(1)
  })

  it('a muted room or one with no read mark shows none as new', () => {
    const ms = new Map([['ch:ops', { room: 'ch:ops', last_read_at: null, is_muted: true }]])
    const out = groupMentions(
      [msg(1, 'ch:ops', 'CM26-1', '2026-11-14T09:00:00Z')],
      'CM26-1',
      'me',
      ms,
      visible
    )
    expect(out.new_total).toBe(0)
    const dm = groupMentions(
      [msg(1, 'dm:A:B', 'CM26-1', '2026-11-14T09:00:00Z')],
      'CM26-1',
      'me',
      new Map(),
      visible
    )
    expect(dm.rooms[0].new_count).toBe(0)
  })

  it('announces to the records a message names (ids only), skipping id-matched room types', async () => {
    const emit = vi.fn()
    await announceRecordMentions('look at CM26-5', {
      types: async () => [
        { collection: 'workflows', match_field: 'ref' },
        { collection: 'plain', match_field: 'id' }
      ],
      lookup: async (c, f, t) =>
        c === 'workflows' && f === 'ref' && t[0] === 'CM26-5' ? ['9'] : [],
      emit
    })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('workflows', '9')
  })
})
