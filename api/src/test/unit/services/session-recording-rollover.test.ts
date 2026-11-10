import { gunzipSync, gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * rollOver: ends the full part (only if nobody else did), starts the next part
 * linked to the chain, opens it with the last snapshot and what followed, and
 * counts the parts on the first part. A failure reopens the full part.
 */

const H = '11111111-1111-4111-8111-111111111111'

const enc = (v: unknown) => `gz:${gzipSync(Buffer.from(JSON.stringify(v))).toString('base64')}`
const dec = (s: string) => JSON.parse(gunzipSync(Buffer.from(s.slice(3), 'base64')).toString())

const h = vi.hoisted(() => ({
  claimRows: 1,
  chunks: [] as Array<{ seq: number; events: string }>,
  headMeta: null as string | null,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  updates: [] as Array<{ where: Record<string, unknown>; patch: Record<string, unknown> }>,
  failInsert: false
}))

vi.mock('../../../services/session-replay-storage.js', () => ({
  ensureRecordingHot: vi.fn(async () => ({ state: 'hot' }))
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    let nullEnded = false
    const q: Record<string, unknown> = {}
    q.where = vi.fn((w: unknown) => {
      if (w && typeof w === 'object') Object.assign(where, w)
      return q
    })
    q.whereNull = vi.fn(() => {
      nullEnded = true
      return q
    })
    q.orderBy = vi.fn(() => q)
    q.select = vi.fn(async (...cols: string[]) => {
      if (table === 'nivaro_session_events' && cols.includes('seq')) {
        return [...h.chunks].sort((a, b) => b.seq - a.seq).map((c) => ({ seq: c.seq }))
      }
      return []
    })
    q.first = vi.fn(async () => {
      if (table === 'nivaro_session_events') {
        return h.chunks.find((c) => c.seq === where.seq)
      }
      if (table === 'nivaro_session_recordings' && where.id === H) return { meta: h.headMeta }
      return undefined
    })
    q.update = vi.fn(async (patch: Record<string, unknown>) => {
      h.updates.push({ where: { ...where, ...(nullEnded ? { ended_at: null } : {}) }, patch })
      return nullEnded ? h.claimRows : 1
    })
    q.insert = vi.fn(async (row: Record<string, unknown>) => {
      if (h.failInsert) throw new Error('insert failed')
      h.inserts.push({ table, row })
    })
    return q
  }
  const db = vi.fn((table: string) => builder(table))
  ;(db as unknown as Record<string, unknown>).transaction = vi.fn(
    async (cb: (trx: unknown) => unknown) => cb((table: string) => builder(table))
  )
  return { db }
})

import { CARRIED_SEQ, rollOver } from '../../../services/session-recording-chain.js'

const part = {
  id: H,
  user: 'U1',
  app: 'efp',
  origin: 'https://efp',
  meta: JSON.stringify({ user_agent: 'UA' }),
  masquerade_admin: null,
  started_at: new Date('2026-11-09T10:00:00Z'),
  ended_at: null,
  last_event_at: null,
  event_count: 100,
  byte_size: 14_999_000,
  truncated: false
}

beforeEach(() => {
  h.claimRows = 1
  h.headMeta = JSON.stringify({ user_agent: 'UA' })
  h.inserts = []
  h.updates = []
  h.failInsert = false
  h.chunks = [
    {
      seq: 0,
      events: enc([
        { type: 4, timestamp: 1 },
        { type: 2, timestamp: 2 },
        { type: 3, timestamp: 3 }
      ])
    },
    {
      seq: 1,
      events: enc([
        { type: 4, timestamp: 50 },
        { type: 2, timestamp: 51 }
      ])
    },
    {
      seq: 2,
      events: enc([
        { type: 3, timestamp: 60 },
        { type: 3, timestamp: 61 }
      ])
    }
  ]
})

describe('rollOver', () => {
  it('starts the linked next part, opened with the last snapshot and what followed', async () => {
    const next = await rollOver(part, { maxRawBytes: 8_000_000 })
    expect(next).not.toBeNull()
    const rec = h.inserts.find((i) => i.table === 'nivaro_session_recordings')?.row
    expect(rec).toMatchObject({ id: next?.id, user: 'U1', app: 'efp', origin: 'https://efp' })
    expect(JSON.parse(String(rec?.meta))).toEqual({
      user_agent: 'UA',
      chain: H,
      continues: H,
      part: 2
    })
    const opening = h.inserts.find((i) => i.table === 'nivaro_session_events')?.row
    expect(opening?.seq).toBe(CARRIED_SEQ)
    expect(opening?.recording).toBe(next?.id)
    expect(dec(String(opening?.events)).map((e: { timestamp: number }) => e.timestamp)).toEqual([
      50, 51, 60, 61
    ])
    // The first part counts the parts.
    const headUpdate = h.updates.find((u) => u.where.id === H && 'meta' in u.patch)
    expect(JSON.parse(String(headUpdate?.patch.meta))).toEqual({ user_agent: 'UA', parts: 2 })
  })

  it('does nothing when another request ended the part first', async () => {
    h.claimRows = 0
    expect(await rollOver(part, { maxRawBytes: 8_000_000 })).toBeNull()
    expect(h.inserts).toEqual([])
  })

  it('keeps only the snapshot when what followed is too big to copy', async () => {
    await rollOver(part, { maxRawBytes: 60 })
    const opening = h.inserts.find((i) => i.table === 'nivaro_session_events')?.row
    expect(dec(String(opening?.events)).map((e: { type: number }) => e.type)).toEqual([4, 2])
  })

  it('reopens the full part when the next part cannot be created', async () => {
    h.failInsert = true
    await expect(rollOver(part, { maxRawBytes: 8_000_000 })).rejects.toThrow('insert failed')
    expect(h.updates.some((u) => u.where.id === H && u.patch.ended_at === null)).toBe(true)
  })
})
