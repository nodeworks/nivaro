import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/telemetry-store.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/telemetry-store.js')>()),
  accessLogEnabled: () => true
}))
vi.mock('../../../services/pool-holders.js', () => ({ localSnapshot: vi.fn() }))

import { renderMetrics } from '../../../plugins/metrics.js'
import { heldByFeature, poolHistoryLine } from '../../../services/pool-history.js'
import type { NodeSnapshot } from '../../../services/pool-holders.js'

const row = (
  pool: 'main' | 'background',
  feature: string,
  person: string,
  state: 'holding' | 'waiting' = 'holding'
) => ({
  node: 'n1',
  pool,
  state,
  since: 0,
  person: { key: person, kind: 'person' as const, label: 'Some Name', user_id: null },
  feature: { key: feature, kind: 'route' as const, label: feature },
  request_id: null,
  read_gate: false
})

function snap(rows: ReturnType<typeof row>[], used = rows.length): NodeSnapshot {
  return {
    node: 'n1',
    host: 'h',
    pid: 1,
    role: 'web',
    at: 0,
    pools: [
      {
        name: 'main',
        max: 60,
        used,
        free: 60 - used,
        pending_acquires: rows.filter((r) => r.state === 'waiting').length,
        pending_creates: 0,
        holding: used,
        waiting: 0,
        wait_p95_ms: 0,
        saturated_pct: 0
      }
    ],
    rows,
    read_gate: { active: 0, queued: 0, limit: null, overflow_running: 0 },
    hogs: []
  } as unknown as NodeSnapshot
}

describe('connection history', () => {
  it('counts per feature, busiest 15 kept and the rest folded into "other"', () => {
    const rows = []
    for (let i = 0; i < 18; i++) rows.push(row('main', `GET /api/f${i}`, 'user:a'))
    rows.push(row('main', 'GET /api/f0', 'user:b'))
    rows.push(row('main', 'GET /api/f0', 'user:c', 'waiting'))
    const out = heldByFeature(snap(rows))
    expect(out).toHaveLength(16)
    expect(out.find((f) => f.feature === 'GET /api/f0')).toMatchObject({ held: 2, waiting: 1 })
    expect(out.find((f) => f.feature === 'other')?.held).toBe(3)
  })

  it('the 10 s line names holders by caller key, never by name, and is silent when idle', () => {
    const line = poolHistoryLine(
      snap([
        row('main', 'GET /api/items/:collection', 'user:42'),
        row('main', 'GET /api/x', 'user:42')
      ])
    )
    expect(line).toMatchObject({ nvr: 'pool', inst: 'n1', role: 'web', used: 2, max: 60 })
    expect(line?.people).toBe('user:42=2')
    expect(line?.features).toBe('GET /api/items/:collection=1; GET /api/x=1')
    expect(JSON.stringify(line)).not.toContain('Some Name')
    expect(poolHistoryLine(snap([], 0))).toBeNull()
  })

  it('the metrics feed carries held connections per feature', () => {
    const text = renderMetrics({
      poolFeatures: [{ pool: 'main', feature: 'GET /api/x', held: 3, waiting: 1 }],
      helperCheckMaxMs: 2500
    })
    expect(text).toContain(
      'nivaro_db_pool_held{pool="main",feature="GET /api/x",state="holding"} 3'
    )
    expect(text).toContain(
      'nivaro_db_pool_held{pool="main",feature="GET /api/x",state="waiting"} 1'
    )
    expect(text).toContain('nivaro_helper_threads_check_max_seconds 2.5')
  })
})
