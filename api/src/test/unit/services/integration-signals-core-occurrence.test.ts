import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A signal's `occurrence` must mark the START of a problem, not its newest
 * event — otherwise every cycle of a steady outage reads as "it happened
 * again" and a Dismiss never sticks. These tests drive the real evaluate()
 * of each core signal over a fake db.
 */

type Row = Record<string, unknown>
const state: {
  outbound: Row[]
  raw: (sql: string, bindings?: unknown[]) => Row[]
} = { outbound: [], raw: () => [] }

vi.mock('../../../db/index.js', () => {
  const chain = (rows: () => Row[]) => {
    const api: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'orderBy', 'limit', 'whereNull']) {
      api[m] = () => api
    }
    api.select = async () => rows()
    return api
  }
  const db = ((table: string) =>
    chain(() => (table === 'nivaro_outbound_log' ? state.outbound : []))) as unknown as {
    raw: (sql: string, bindings?: unknown[]) => Promise<Row[]>
  }
  db.raw = async (sql: string, bindings?: unknown[]) => state.raw(sql, bindings)
  return { db }
})

import { getIntegrationSignal, type SignalRow } from '../../../services/integration-signals.js'
import { registerCoreIntegrationSignals } from '../../../services/integration-signals-core.js'

registerCoreIntegrationSignals()

const ctx = (thresholds: Record<string, number>) => ({
  thresholds,
  businessDaysAgo: async () => new Date()
})

const call = (id: number, ok: boolean, minutesAgo = id) => ({
  id,
  api_id: 7,
  api_name: 'Partner',
  ok,
  status: ok ? 200 : 500,
  error: ok ? null : 'boom',
  created_at: new Date(Date.now() - minutesAgo * 60_000)
})

async function partnerRows(): Promise<SignalRow[]> {
  const def = getIntegrationSignal('core:partner-failing')!
  return (await def.evaluate(ctx({ streak: 3, window_minutes: 60 }))).rows
}

describe('core:partner-failing occurrence', () => {
  beforeEach(() => {
    state.outbound = []
    state.raw = () => []
  })

  it('is the first failing call of the streak, and stays put while the outage continues', async () => {
    // Cycle 1: a success still in the window — the streak starts at call 10.
    state.outbound = [call(12, false), call(11, false), call(10, false), call(9, true)]
    const c1 = await partnerRows()
    expect(c1[0].occurrence).toBe('call:10')

    // Cycles 2 and 3: the window has slid past the last success — every call
    // in it failed. The streak START is found in the database, not assumed to
    // be the oldest call the window still holds.
    state.raw = (sql) =>
      /MAX\(s\.id\)/.test(sql)
        ? [{ api_id: 7, first_id: 10, first_at: new Date(Date.now() - 70 * 60_000) }]
        : []
    state.outbound = [call(14, false), call(13, false), call(12, false), call(11, false)]
    const c2 = await partnerRows()
    state.outbound = [call(16, false), call(15, false), call(14, false), call(13, false)]
    const c3 = await partnerRows()
    expect(c2[0].occurrence).toBe('call:10')
    expect(c3[0].occurrence).toBe('call:10')
  })

  it('a recovery then a new failure is a new occurrence', async () => {
    state.outbound = [call(17, true), call(16, false)]
    expect(await partnerRows()).toEqual([])
    state.outbound = [call(20, false), call(19, false), call(18, false), call(17, true)]
    expect((await partnerRows())[0].occurrence).toBe('call:18')
  })
})

describe('core:inbound-errors occurrence', () => {
  it('is the first error after a quiet spell, not the newest error', async () => {
    const start = new Date('2026-09-24T09:00:00Z')
    const newest = new Date('2026-09-24T11:55:00Z')
    state.raw = (sql) => {
      if (/LAG\(/.test(sql)) return [{ user_id: null, api_key_id: 5, episode_start: start }]
      if (/GROUP BY l\.\[user\], l\.api_key_id/.test(sql))
        return [{ user_id: null, api_key_id: 5, calls: 20, errors: 10, last_error_at: newest }]
      return []
    }
    const def = getIntegrationSignal('core:inbound-errors')!
    const { rows } = await def.evaluate(ctx({ error_pct: 20, min_calls: 10 }))
    expect(rows[0].occurrence).toBe(start.toISOString())
  })
})

describe('core:flow-failed occurrence', () => {
  it('is the first failing run since the last successful run', async () => {
    state.raw = () => [
      {
        id: 'F1',
        name: 'Sync',
        run_id: 'B7E1C0DE-0000-4000-8000-000000000030',
        error_message: 'boom',
        started_at: new Date(),
        errors: 3,
        first_fail_run_id: 'B7E1C0DE-0000-4000-8000-000000000021',
        first_fail_at: new Date(Date.now() - 3600_000)
      }
    ]
    const def = getIntegrationSignal('core:flow-failed')!
    const { rows } = await def.evaluate(ctx({ window_hours: 24 }))
    expect(rows[0].occurrence).toBe('run:B7E1C0DE-0000-4000-8000-000000000021')
  })
})

describe('core:import-failed occurrence', () => {
  it('is the first failed run since the last completed run; the drill stays on the newest', async () => {
    state.raw = () => [
      {
        import_key: 'orders',
        label: 'Orders',
        id: 90,
        finished_at: new Date(),
        logs: 'x',
        first_fail_run_id: 84
      }
    ]
    const def = getIntegrationSignal('core:import-failed')!
    const { rows } = await def.evaluate(ctx({}))
    expect(rows[0].occurrence).toBe('run:84')
    expect(rows[0].drill).toEqual({ kind: 'import_run', id: '90' })
  })
})
