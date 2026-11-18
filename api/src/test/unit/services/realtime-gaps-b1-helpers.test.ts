import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime gaps 2026-11-17, batch B1 (server announcements): the helpers each pattern uses.

const h = vi.hoisted(() => ({
  raw: [] as Array<{ collection: string; ids: unknown; opts: Record<string, unknown> }>,
  aspects: [] as Array<{ collection: unknown; item: unknown; aspects: unknown }>,
  addendums: [] as string[],
  queues: [] as string[],
  queueFails: false,
  reads: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/raw-write-announcer.js', () => ({
  announceRawWrites: async (
    collection: string,
    ids: unknown,
    opts: Record<string, unknown> = {}
  ) => {
    h.raw.push({ collection, ids, opts })
  }
}))
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: (collection: unknown, item: unknown, aspects: unknown) => {
    h.aspects.push({ collection, item, aspects })
  },
  announceAddendumChange: async (id: string) => {
    h.addendums.push(id)
  }
}))
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: async (c: string, id: string) => {
    if (h.queueFails) throw new Error('queue down')
    h.queues.push(`${c}:${id}`)
  }
}))
vi.mock('../../../services/user-sync.js', () => ({
  announceNotificationsRead: (u: unknown) => {
    h.reads.push(u)
  },
  announceMineChanged: () => {}
}))

import { opsTopicGate } from '../../../services/ops-live.js'
import {
  clearSnoozeWakes,
  MAX_WAKE_MS,
  planSnoozeWake,
  scheduleSnoozeWake,
  WAKE_SLACK_MS
} from '../../../services/snooze-wake.js'
import { announceStateMoved, announceStatesMoved } from '../../../services/state-moved.js'

beforeEach(() => {
  h.raw.length = 0
  h.aspects.length = 0
  h.addendums.length = 0
  h.queues.length = 0
  h.queueFails = false
  h.reads.length = 0
  clearSnoozeWakes()
})

describe('S4/S5/S6 — announceStateMoved', () => {
  it('syncs materialized queue rows, then announces $state', async () => {
    await announceStateMoved('workflows', 12)
    expect(h.queues).toEqual(['workflows:12'])
    expect(h.aspects).toEqual([{ collection: 'workflows', item: 12, aspects: '$state' }])
    expect(h.addendums).toEqual([])
  })
  it('an addendum move also tells its parent', async () => {
    await announceStateMoved('nivaro_addendums', 'ad-1')
    expect(h.addendums).toEqual(['ad-1'])
  })
  it('a queue failure still announces; no record = nothing', async () => {
    h.queueFails = true
    await announceStateMoved('workflows', 3)
    expect(h.aspects).toHaveLength(1)
    await announceStateMoved(null, 3)
    await announceStateMoved('workflows', '')
    expect(h.aspects).toHaveLength(1)
  })
  it('syncQueues: false skips the queue sync', async () => {
    await announceStateMoved('workflows', 3, { syncQueues: false })
    expect(h.queues).toEqual([])
  })
  it('bulk moves: one coalesced $state announcement per collection', () => {
    announceStatesMoved(
      [
        { collection: 'workflows', item: '1' },
        { collection: 'pos', item: 2 },
        { collection: 'workflows', item: '3' },
        { collection: '', item: '4' }
      ],
      'instance-migration:t1'
    )
    expect(h.raw).toEqual([
      {
        collection: 'workflows',
        ids: ['1', '3'],
        opts: { changed_fields: ['$state'], source: 'instance-migration:t1' }
      },
      {
        collection: 'pos',
        ids: [2],
        opts: { changed_fields: ['$state'], source: 'instance-migration:t1' }
      }
    ])
  })
})

describe('minor — snooze wake', () => {
  it('plans one wake per person per minute, just after the snooze ends', () => {
    const now = Date.parse('2026-11-17T12:00:00Z')
    const p = planSnoozeWake('', 'u1', new Date(now + 60_000), now)
    expect(p?.delayMs).toBe(60_000 + WAKE_SLACK_MS)
    // 12:01:20 and 12:01:50 share the wake at 12:02:00 (+ slack): both are awake by then.
    const q = planSnoozeWake('', 'U1', new Date(now + 80_000), now)
    const r = planSnoozeWake('', 'u1', new Date(now + 110_000), now)
    expect(q?.key).toBe(r?.key)
    expect(q?.delayMs).toBe(120_000 + WAKE_SLACK_MS)
    expect(q?.key).not.toBe(p?.key)
    expect(planSnoozeWake('t2', 'u1', new Date(now + 60_000), now)?.key).not.toBe(p?.key)
  })
  it('no wake for a past, unparsable, missing or far-off time', () => {
    const now = Date.now()
    expect(planSnoozeWake('', 'u1', new Date(now - 10_000), now)).toBeNull()
    expect(planSnoozeWake('', 'u1', 'nope', now)).toBeNull()
    expect(planSnoozeWake('', null, new Date(now + 1000), now)).toBeNull()
    expect(planSnoozeWake('', 'u1', new Date(now + MAX_WAKE_MS + 1), now)).toBeNull()
  })
  it('fires read:changed to the person when the snooze ends', () => {
    vi.useFakeTimers()
    try {
      scheduleSnoozeWake('u1', new Date(Date.now() + 30_000))
      scheduleSnoozeWake('u1', new Date(Date.now() + 30_000))
      vi.advanceTimersByTime(25_000)
      expect(h.reads).toEqual([])
      vi.advanceTimersByTime(95_000 + WAKE_SLACK_MS)
      expect(h.reads).toEqual(['u1'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('minor — submissions ops topic', () => {
  it('is an admin-only poke topic', () => {
    expect(opsTopicGate('submissions')).toEqual({ topic: 'submissions', gate: 'admin' })
  })
})
