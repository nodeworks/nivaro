import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeQuery } from '../../fake-sql.js'

// #17 — the log retention inventory: every log, its window, where it is set, size, oldest
// row and next purge — from cheap reads only (sys.partitions, first row by primary key).

const state = vi.hoisted(() => ({ ran: [] as FakeQuery[] }))

vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  const fake = makeFakeDb((q) => {
    state.ran.push(q)
    if (q.sql.includes('sys.partitions'))
      return [
        { t: 'nivaro_activity', n: 12_000_000 },
        { t: 'nivaro_api_logs', n: 450 }
      ]
    if (q.sql.includes('[nivaro_settings]'))
      return { activity_retention_days: 365, revision_retention_count: 20 }
    if (q.sql.includes('count(*)')) return { n: 2 }
    if (q.method === 'first') return { t: new Date('2025-01-02T03:04:05Z') }
    return []
  })
  const db = new Proxy(fake, {
    get(target, prop, receiver) {
      if (prop === 'schema')
        return { hasTable: async (t: string) => t !== 'nivaro_agent_trigger_deliveries' }
      return Reflect.get(target, prop, receiver)
    }
  })
  return { db }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

import { trailStateOf } from '../../../services/activity-trail/status.js'
import { LOG_KINDS, logRetentionInventory, purgeText } from '../../../services/log-retention.js'
import {
  noteRetentionPassScheduled,
  noteRetentionPassStarted
} from '../../../services/retention-schedule.js'

beforeEach(() => {
  state.ran = []
})

describe('log retention inventory', () => {
  it('lists every log once, with the fields the page reads', async () => {
    noteRetentionPassStarted(new Date('2026-10-29T01:00:00Z'))
    noteRetentionPassScheduled(new Date('2026-10-30T01:00:00Z'))
    const inv = await logRetentionInventory()
    const keys = inv.entries.map((e) => e.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of [
      'activity',
      'revisions',
      'trash',
      'api_logs',
      'search_log',
      'job_runs',
      'ai_calls',
      'chat_history',
      'session_recordings',
      'notifications',
      'slow_traces'
    ])
      expect(keys).toContain(k)
    for (const e of inv.entries) {
      expect(e).toEqual(
        expect.objectContaining({
          key: expect.any(String),
          label: expect.any(String),
          keep: expect.any(String),
          setting: expect.any(String),
          purge: expect.objectContaining({ how: expect.any(String) }),
          legal_holds: expect.any(Boolean),
          present: expect.any(Boolean)
        })
      )
    }
    const activity = inv.entries.find((e) => e.key === 'activity')!
    expect(activity.rows).toBe(12_000_000)
    expect(activity.keep).toMatch(/^365 days · 2 collections with their own window/)
    expect(activity.oldest_at).toBe('2025-01-02T03:04:05.000Z')
    expect(activity.legal_holds).toBe(true)
    expect(activity.purge.next_run_at).toBe('2026-10-30T01:00:00.000Z')
    expect(inv.entries.find((e) => e.key === 'revisions')!.keep).toBe('Newest 20 per record')
    // a table this database does not have is listed, marked absent, never read
    const missing = inv.entries.find((e) => e.key === 'agent_trigger_deliveries')!
    expect(missing.present).toBe(false)
    expect(missing.rows).toBeNull()
    // not a table: no row count, says where it lives
    expect(inv.entries.find((e) => e.key === 'slow_traces')!.table).toBeNull()
  })

  it('reads no table in full (no COUNT over a log table)', async () => {
    await logRetentionInventory()
    const counts = state.ran.filter((q) => /count\(\*\)/i.test(q.sql))
    for (const c of counts) expect(c.sql).toMatch(/\[nivaro_collections\]/)
  })

  it('every purge has a plain description', () => {
    for (const k of LOG_KINDS) expect(purgeText(k.purge).length).toBeGreaterThan(5)
  })
})

describe('trail state', () => {
  const cp = (over: Record<string, unknown>) =>
    ({
      id: 1,
      verified_ok: true,
      acknowledged_at: null,
      ...over
    }) as unknown as Parameters<typeof trailStateOf>[0]
  it('maps checkpoints to the strip state', () => {
    expect(trailStateOf(null, null)).toBe('not_verified')
    expect(trailStateOf(cp({}), null)).toBe('intact')
    expect(trailStateOf(cp({ verified_ok: false }), cp({ verified_ok: false }))).toBe('broken')
    expect(
      trailStateOf(cp({ verified_ok: false, acknowledged_at: '2026-10-29T00:00:00Z' }), null)
    ).toBe('acknowledged')
  })
})
