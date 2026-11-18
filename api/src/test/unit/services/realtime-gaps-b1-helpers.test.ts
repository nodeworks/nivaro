import { AsyncLocalStorage } from 'node:async_hooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** A request-scoped store standing in for the request's own async context. */
const outerStore = new AsyncLocalStorage<string>()

// Realtime gaps 2026-11-17, batch B1 (server announcements): the helpers each pattern uses.

const h = vi.hoisted(() => ({
  raw: [] as Array<{ collection: string; ids: unknown; opts: Record<string, unknown> }>,
  aspects: [] as Array<{
    collection: unknown
    item: unknown
    aspects: unknown
    alsoFields?: unknown
  }>,
  addendums: [] as string[],
  queues: [] as string[],
  queueFails: false,
  reads: [] as unknown[],
  readTenants: [] as Array<string | undefined>,
  readOuter: [] as unknown[],
  stateField: null as string | null,
  tenant: ''
}))

vi.mock('../../../db/index.js', () => ({
  db: () => ({
    where: () => ({
      first: async () => (h.stateField ? { state_field: h.stateField } : undefined)
    })
  })
}))
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
  announceRecordAspect: (
    collection: unknown,
    item: unknown,
    aspects: unknown,
    alsoFields?: unknown
  ) => {
    h.aspects.push({ collection, item, aspects, ...(alsoFields ? { alsoFields } : {}) })
  },
  announceAddendumChange: async (id: string) => {
    h.addendums.push(id)
  }
}))
vi.mock('../../../services/tenant-rooms.js', async (orig) => {
  const real = (await orig()) as typeof import('../../../services/tenant-rooms.js')
  return { ...real, currentTenantKey: () => h.tenant || real.currentTenantKey() }
})
vi.mock('../../../services/queue-materialization.js', () => ({
  syncMaterializedQueueItem: async (c: string, id: string) => {
    if (h.queueFails) throw new Error('queue down')
    h.queues.push(`${c}:${id}`)
  }
}))
vi.mock('../../../services/user-sync.js', () => ({
  announceNotificationsRead: async (u: unknown) => {
    h.reads.push(u)
    const { getTenantId } = await import('../../../db/tenant-context.js')
    h.readTenants.push(getTenantId())
    h.readOuter.push(outerStore.getStore())
  },
  announceMineChanged: () => {}
}))

import type { Knex } from 'knex'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import { opsTopicGate } from '../../../services/ops-live.js'
import { QUEUE_SYNC_MAX, syncQueueRecords } from '../../../services/queue-sync-records.js'
import {
  clearSnoozeWakes,
  MAX_WAKE_MS,
  MAX_WAKES_PER_TENANT,
  planSnoozeWake,
  scheduleSnoozeWake,
  WAKE_SLACK_MS
} from '../../../services/snooze-wake.js'
import {
  announceStateMoved,
  announceStatesMoved,
  clearMirrorCache
} from '../../../services/state-moved.js'

beforeEach(() => {
  h.raw.length = 0
  h.aspects.length = 0
  h.addendums.length = 0
  h.queues.length = 0
  h.queueFails = false
  h.reads.length = 0
  h.readTenants.length = 0
  h.readOuter.length = 0
  h.stateField = null
  h.tenant = ''
  clearMirrorCache()
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
  it('names the mirrored state column in the same $state notice', async () => {
    h.stateField = 'request_state'
    await announceStateMoved('workflows', 12)
    expect(h.aspects).toEqual([
      { collection: 'workflows', item: 12, aspects: '$state', alsoFields: 'request_state' }
    ])
  })
  it('the mirrored-column cache is per tenant, not shared across them', async () => {
    h.tenant = 'a'
    h.stateField = 'request_state'
    await announceStateMoved('workflows', 1)
    h.tenant = 'b'
    h.stateField = 'status_code'
    await announceStateMoved('workflows', 2)
    expect(h.aspects.map((a) => a.alsoFields)).toEqual(['request_state', 'status_code'])
  })
  it('bulk moves: one coalesced $state announcement per collection', async () => {
    announceStatesMoved(
      [
        { collection: 'workflows', item: '1' },
        { collection: 'pos', item: 2 },
        { collection: 'workflows', item: '3' },
        { collection: '', item: '4' }
      ],
      'instance-migration:t1'
    )
    await new Promise((r) => setTimeout(r, 0))
    const opts = { changed_fields: ['$state'], source: 'instance-migration:t1', noticeOnly: true }
    expect(h.raw).toEqual([
      { collection: 'workflows', ids: ['1', '3'], opts },
      { collection: 'pos', ids: [2], opts }
    ])
  })
  it('bulk moves carry the mirrored column as a notice, never an outside write', async () => {
    h.stateField = 'request_state'
    announceStatesMoved([{ collection: 'workflows', item: '1' }], 'start-missing:1')
    await new Promise((r) => setTimeout(r, 0))
    expect(h.raw[0].opts).toEqual({
      changed_fields: ['$state', 'request_state'],
      source: 'start-missing:1',
      noticeOnly: true
    })
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

describe('snooze wake — tenant and request context (B1 review)', () => {
  it('fires in the arming tenant, outside the request that armed it', async () => {
    // Real timers (fake ones drop async context, which is what this checks): the clock sits
    // 100 ms before a minute boundary, so the wake fires ~1.6 s later.
    const boundary = Math.ceil(Date.now() / 60_000) * 60_000 + 60_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(boundary - 100)
    try {
      runWithTenantDb(
        {} as Knex,
        'acme',
        () => outerStore.run('request-1', () => scheduleSnoozeWake('u7', new Date(boundary - 50))),
        'tenant-acme'
      )
      await vi.waitFor(() => expect(h.readTenants).toHaveLength(1), {
        timeout: 4000,
        interval: 50
      })
      expect(h.reads).toEqual(['u7'])
      expect(h.readTenants).toEqual(['tenant-acme'])
      // The request's own store did not ride along on the timer.
      expect(h.readOuter).toEqual([undefined])
    } finally {
      vi.useRealTimers()
    }
  })
  it('caps the wakes one tenant may hold', () => {
    vi.useFakeTimers()
    try {
      const base = Date.now() + 60_000
      runWithTenantDb(
        {} as Knex,
        'acme',
        () => {
          for (let i = 0; i < MAX_WAKES_PER_TENANT + 20; i++)
            scheduleSnoozeWake(`u${i}`, new Date(base))
        },
        'tenant-acme'
      )
      // Another tenant still gets its wake.
      runWithTenantDb(
        {} as Knex,
        'beta',
        () => scheduleSnoozeWake('b1', new Date(base)),
        'tenant-beta'
      )
      expect(clearSnoozeWakes()).toBe(MAX_WAKES_PER_TENANT + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('snooze wake — self-hosted cap', () => {
  it('self-hosted (no tenant key) is bound by the process cap, not the per-tenant one', () => {
    vi.useFakeTimers()
    try {
      const base = Date.now() + 120_000
      for (let i = 0; i < MAX_WAKES_PER_TENANT + 20; i++)
        scheduleSnoozeWake(`s${i}`, new Date(base))
      expect(clearSnoozeWakes()).toBe(MAX_WAKES_PER_TENANT + 20)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ctx.queues.syncRecord — syncQueueRecords (B1 review, for efp-ops E1)', () => {
  it('syncs each distinct record, logging failures without throwing', async () => {
    const logs: string[] = []
    const r = await syncQueueRecords('workflows', [1, '2', 1, ''], (m) => logs.push(m))
    expect(r).toEqual({ synced: 2, failed: 0, skipped: 0 })
    expect(h.queues.sort()).toEqual(['workflows:1', 'workflows:2'])
    h.queueFails = true
    const f = await syncQueueRecords('workflows', 3, (m) => logs.push(m))
    expect(f).toEqual({ synced: 0, failed: 1, skipped: 0 })
    expect(logs.some((l) => l.includes('workflows/3 failed'))).toBe(true)
  })
  it('is bounded', async () => {
    const ids = Array.from({ length: QUEUE_SYNC_MAX + 5 }, (_, i) => i + 1)
    const r = await syncQueueRecords('workflows', ids, () => {})
    expect(r).toEqual({ synced: QUEUE_SYNC_MAX, failed: 0, skipped: 5 })
  })
  it('runs in the caller tenant', async () => {
    let seen: string | undefined
    const { syncMaterializedQueueItem } = await import('../../../services/queue-materialization.js')
    void syncMaterializedQueueItem
    await new Promise<void>((resolve) =>
      runWithTenantDb(
        {} as Knex,
        'acme',
        () => {
          void syncQueueRecords('workflows', [9], () => {}).then(async () => {
            const { getTenantId } = await import('../../../db/tenant-context.js')
            seen = getTenantId()
            resolve()
          })
        },
        'tenant-acme'
      )
    )
    expect(seen).toBe('tenant-acme')
    expect(h.queues).toContain('workflows:9')
  })
})
