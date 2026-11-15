import { beforeEach, describe, expect, it, vi } from 'vitest'

// The record chat room's live state chip (step, owners, due) comes from roomRecordFacts. It is
// only for people who can see the room AND read the record: either gate failing answers null,
// and nothing about the record's step, owners or clock is read for them.

const h = vi.hoisted(() => ({
  canSee: true,
  readable: true,
  dbCalls: 0
}))

vi.mock('./chat.js', () => ({
  activeRoomTypeRows: async () => [
    {
      id: 1,
      prefix: 'wf',
      collection: 'workflows',
      match_field: 'id',
      label: 'Workflow',
      is_active: 1
    }
  ],
  canSeeRoom: async () => h.canSee,
  clearChatCaches: () => {},
  parseRoom: (room: string) => {
    const [prefix, token] = room.split(':')
    return { kind: 'entity', prefix, token }
  }
}))
vi.mock('./items.js', () => ({
  readItems: async () => ({ data: h.readable ? [{ id: 7 }] : [] })
}))
vi.mock('./queues.js', () => ({
  getLabels: async () => ({ 'workflows:7': 'CM26-7' })
}))
vi.mock('../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../db/index.js', () => {
  const chain = () => {
    h.dbCalls++
    const q: Record<string, unknown> = {}
    for (const m of ['join', 'where', 'orderByRaw']) q[m] = () => q
    q.first = async () => ({
      id: 3,
      current_state: 'S1',
      key: 'review',
      label: 'In review',
      color: '#0ea5e9'
    })
    return q
  }
  return { db: vi.fn(chain) }
})
vi.mock('./pipeline-engine.js', () => ({
  resolveStateOwners: async () => [{ id: 'U-BETH', first_name: 'Beth', last_name: 'Ames' }]
}))
vi.mock('../routes/sla.js', () => ({
  computeStatusBatch: async () => ({
    '7': {
      status: 'warning',
      elapsed_hours: 20,
      duration_hours: 24,
      remaining_hours: 4,
      business_hours_only: true,
      warning_at: '2026-11-15T10:00:00.000Z',
      due_at: '2026-11-15T14:00:00.000Z'
    }
  })
}))

import { roomRecordFacts } from './chat-records.js'

const BETH = { id: 'U-BETH', role: 'R' } as never

describe('record room state chip', () => {
  beforeEach(() => {
    h.canSee = true
    h.readable = true
    h.dbCalls = 0
  })

  it('gives a member who reads the record its step, owners and due time', async () => {
    const f = await roomRecordFacts(BETH, 'wf:7')
    expect(f?.state).toEqual({ key: 'review', label: 'In review', color: '#0ea5e9' })
    expect(f?.owners).toEqual([{ id: 'U-BETH', name: 'Beth Ames' }])
    expect(f?.sla).toEqual({
      status: 'warning',
      elapsed_hours: 20,
      due_hours: 24,
      remaining_hours: 4,
      business_hours: true,
      // The instants the record's SLA banner counts down to — the chip uses these, not hours.
      warning_at: '2026-11-15T10:00:00.000Z',
      due_at: '2026-11-15T14:00:00.000Z'
    })
  })

  it('shows nothing to someone who cannot see the room', async () => {
    h.canSee = false
    expect(await roomRecordFacts(BETH, 'wf:7')).toBeNull()
    expect(h.dbCalls).toBe(0)
  })

  it('shows nothing to a room member who cannot read the record', async () => {
    h.readable = false
    expect(await roomRecordFacts(BETH, 'wf:7')).toBeNull()
    expect(h.dbCalls).toBe(0)
  })
})
