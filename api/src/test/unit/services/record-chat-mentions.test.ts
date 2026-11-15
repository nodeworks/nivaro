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
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn() }))
vi.mock('../../../services/record-events.js', () => ({ emitRecordEvent: vi.fn() }))
const gate = vi.hoisted(() => ({ labels: [] as string[] }))
vi.mock('../../../services/read-gate.js', () => ({
  withReadGate: async (_who: unknown, fn: () => Promise<unknown>, o?: { label?: string }) => {
    gate.labels.push(String(o?.label))
    return fn()
  }
}))

import {
  announceRecordMentions,
  groupMentions,
  likeLiteral,
  messageLinksRecord,
  messageNamesToken,
  recordMentionMessages,
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
      (t) => messageNamesToken(t, 'CM26-1'),
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
      (t) => messageNamesToken(t, 'CM26-1'),
      'me',
      ms,
      visible
    )
    expect(out.new_total).toBe(0)
    const dm = groupMentions(
      [msg(1, 'dm:A:B', 'CM26-1', '2026-11-14T09:00:00Z')],
      (t) => messageNamesToken(t, 'CM26-1'),
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

  it('counts pasted record links in the admin and portal shapes', () => {
    expect(messageLinksRecord('see https://x/collections/workflows/123', 'workflows', '123')).toBe(
      true
    )
    expect(messageLinksRecord('/records/workflows/123?tab=a', 'workflows', '123')).toBe(true)
    expect(messageLinksRecord('/records/workflows/1234', 'workflows', '123')).toBe(false)
    expect(messageLinksRecord('/records/other/123', 'workflows', '123')).toBe(false)
  })

  describe('messages naming a record (#132)', () => {
    it('hides a DM between two others and a private channel from a non-member, admin included', async () => {
      const { readOne } = await import('../../../services/items.js')
      const { roomForRecord } = await import('../../../services/chat-records.js')
      const { db } = await import('../../../db/index.js')
      vi.mocked(readOne).mockResolvedValue({ id: '1' } as never)
      vi.mocked(roomForRecord).mockResolvedValue({
        room: 'wf:CM26-1',
        type: { prefix: 'wf', match_field: 'ref' }
      } as never)
      const rows = [
        { id: 3, room: 'dm:A:B', message: 'CM26-1 secret', sender_name: 'A', date_created: 'x' },
        { id: 2, room: 'ch:priv', message: 'CM26-1 hush', sender_name: 'A', date_created: 'x' },
        { id: 1, room: 'ch:open', message: 'CM26-1 hello', sender_name: 'A', date_created: 'x' }
      ]
      const chain: Record<string, unknown> = {}
      const wheres: unknown[][] = []
      for (const k of ['whereNot', 'whereNull', 'orderBy', 'limit']) chain[k] = () => chain
      chain.where = (...a: unknown[]) => {
        wheres.push(a)
        return chain
      }
      chain.select = async () => rows
      gate.labels = []
      ;(db as unknown as ReturnType<typeof vi.fn>).mockReturnValue(chain)
      const canSee = async (_u: unknown, room: string) => room === 'ch:open'
      for (const viewer of [{ id: 'C' }, { id: 'ADMIN', role: 'admin' }]) {
        const out = await recordMentionMessages(viewer as never, 'workflows', '1', { canSee })
        expect(out?.map((r) => r.room)).toEqual(['ch:open'])
      }
      // Bounded: the last 14 days only, behind the read gate.
      const window = wheres.find((w) => w[0] === 'date_created') as [string, string, Date]
      expect(window?.[1]).toBe('>')
      expect(Date.now() - window[2].getTime()).toBeGreaterThan(13.9 * 86_400_000)
      expect(Date.now() - window[2].getTime()).toBeLessThan(14.1 * 86_400_000)
      expect(gate.labels).toContain('record-chat-mention-messages')
    })

    it('an unreadable record answers null (404)', async () => {
      const { readOne } = await import('../../../services/items.js')
      vi.mocked(readOne).mockResolvedValue(null as never)
      expect(
        await recordMentionMessages({ id: 'C' } as never, 'workflows', '1', {
          canSee: async () => true
        })
      ).toBeNull()
    })
  })
})
