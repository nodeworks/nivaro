import { beforeEach, describe, expect, it, vi } from 'vitest'

// Army 5 b06-N3 / b16-N10: "Waiting on you" pings never cleared once the step moved on.

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  archived: [] as number[],
  emitted: [] as Array<{ room: string; event: string; payload: unknown }>
}))

vi.mock('../../../db/index.js', () => ({
  db: (_table: string) => {
    let ids: number[] | null = null
    const q: any = {
      where: () => q,
      whereNot: () => q,
      whereNull: () => q,
      whereIn: (_c: string, v: number[]) => {
        ids = v
        return q
      },
      select: () => q,
      limit: async () => store.rows,
      update: async (patch: Record<string, unknown>) => {
        if (patch.status === 'archived' && ids) store.archived.push(...ids)
        return ids?.length ?? 0
      }
    }
    return q
  }
}))
vi.mock('../../../services/io-holder.js', () => ({
  getIo: () => ({
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => store.emitted.push({ room, event, payload })
    })
  })
}))

import { isOwnerPing, pingsToRetire, retireWaitingPings } from '../../../services/waiting-pings.js'

const MOVED = new Date('2026-11-06T17:00:00Z')
const before = '2026-11-06T16:30:00Z'
const after = '2026-11-06T17:00:01Z'

describe('isOwnerPing', () => {
  it('matches the record’s own owner pings only', () => {
    expect(isOwnerPing('Waiting on you: CR26-81409', 'CR26-81409')).toBe(true)
    expect(isOwnerPing('Sent back: CR26-81409', 'CR26-81409')).toBe(true)
    expect(isOwnerPing('Sent back: CR26-81409 — Lee Herzog sent it back', 'CR26-81409')).toBe(true)
    // another record whose id starts the same
    expect(isOwnerPing('Waiting on you: CR26-814099', 'CR26-81409')).toBe(false)
    expect(isOwnerPing('Sent back: CR26-814099', 'CR26-81409')).toBe(false)
    // an addendum ping on the same parent
    expect(isOwnerPing('Waiting on you: Moving to 2027', 'CR26-81409')).toBe(false)
    expect(isOwnerPing('Comment on CR26-81409', 'CR26-81409')).toBe(false)
    expect(isOwnerPing(null, 'CR26-81409')).toBe(false)
  })
})

describe('pingsToRetire', () => {
  const rows = [
    {
      id: 1,
      recipient: 'U-LEE',
      subject: 'Waiting on you: CR26-81409',
      status: 'inbox',
      timestamp: before
    },
    {
      id: 2,
      recipient: 'U-LINDSEY',
      subject: 'Waiting on you: CR26-81409',
      status: 'inbox',
      timestamp: before
    },
    {
      id: 3,
      recipient: 'U-LEE',
      subject: 'Waiting on you: CR26-81409',
      status: 'archived',
      timestamp: before
    },
    {
      id: 4,
      recipient: 'U-BERNARD',
      subject: 'Waiting on you: CR26-81409',
      status: 'inbox',
      timestamp: after
    },
    {
      id: 5,
      recipient: 'U-LEE',
      subject: 'Mentioned you on CR26-81409',
      status: 'inbox',
      timestamp: before
    },
    {
      id: 6,
      recipient: 'U-KRISTINA',
      subject: 'Sent back: CR26-81409',
      status: 'read',
      timestamp: before
    }
  ]

  it('retires the old owner’s ping and keeps a remaining owner’s', () => {
    const out = pingsToRetire(rows, 'CR26-81409', ['u-lindsey'], MOVED)
    expect(out.map((r) => r.id)).toEqual([1, 6])
  })

  it('never touches pings the move itself sent, or other kinds of row', () => {
    const out = pingsToRetire(rows, 'CR26-81409', [], MOVED)
    expect(out.map((r) => r.id)).not.toContain(4)
    expect(out.map((r) => r.id)).not.toContain(5)
    expect(out.map((r) => r.id)).not.toContain(3)
  })
})

describe('retireWaitingPings', () => {
  beforeEach(() => {
    store.archived.length = 0
    store.emitted.length = 0
    store.rows = [
      {
        id: 11,
        recipient: 'U-LEE',
        subject: 'Waiting on you: CR26-81409',
        status: 'inbox',
        timestamp: before
      },
      {
        id: 12,
        recipient: 'U-LINDSEY',
        subject: 'Waiting on you: CR26-81409',
        status: 'inbox',
        timestamp: before
      }
    ]
  })

  it('archives the stale pings and tells the recipient’s tabs', async () => {
    const n = await retireWaitingPings({
      collection: 'workflows',
      item: '372960',
      friendlyId: 'CR26-81409',
      stillOwnerIds: ['U-LINDSEY'],
      movedAt: MOVED
    })
    expect(n).toBe(1)
    expect(store.archived).toEqual([11])
    expect(store.emitted).toEqual([
      {
        room: 'user:U-LEE',
        event: 'notification:retired',
        payload: { ids: [11], collection: 'workflows', item: '372960' }
      }
    ])
  })
})
