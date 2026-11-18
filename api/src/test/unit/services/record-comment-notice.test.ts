import { describe, expect, it, vi } from 'vitest'

/**
 * Realtime gaps B4 review: `record:comment` goes to the whole record room, machine and API-key
 * sockets included — it carries ids only, never who wrote a note or who opened the record.
 */
const io = vi.hoisted(() => {
  const sent: Array<{ room: string; event: string; payload: Record<string, unknown> }> = []
  return {
    sent,
    io: {
      to: (room: string) => ({
        emit: (event: string, payload: Record<string, unknown>) =>
          sent.push({ room, event, payload })
      })
    }
  }
})
vi.mock('../../../services/io-holder.js', () => ({ getIo: () => io.io }))
vi.mock('../../../db/index.js', () => {
  const chain: Record<string, unknown> = {}
  for (const m of ['where', 'whereNull', 'whereNot', 'orWhereNull']) chain[m] = () => chain
  chain.first = async () => ({ id: 1 })
  return { db: () => chain }
})

import { announceMentionSeen } from '../../../services/mention-receipts.js'
import { emitRecordEvent } from '../../../services/record-events.js'

describe('record:comment carries no user', () => {
  it('a mention seen pokes the room with ids only (not who opened it)', async () => {
    await announceMentionSeen('orders', '7', 'U-READER', null)
    const hit = io.sent.find((s) => s.event === 'record:comment')
    expect(hit).toEqual({
      room: 'record:orders:7',
      event: 'record:comment',
      payload: { collection: 'orders', item: '7' }
    })
  })

  it('the comment / chat-to-notes paths use the same ids-only notice', () => {
    io.sent.length = 0
    emitRecordEvent('orders', 7, 'record:comment')
    expect(io.sent[0].payload).toEqual({ collection: 'orders', item: '7' })
    expect(io.sent[0].payload).not.toHaveProperty('user')
  })
})
