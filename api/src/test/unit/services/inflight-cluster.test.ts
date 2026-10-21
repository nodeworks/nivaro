import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  attachWaits,
  type ClusterInflightRow,
  mergeInflight,
  type WaitCandidate
} from '../../../services/inflight-cluster.js'
import type { InflightRow } from '../../../services/traffic-inflight.js'

const row = (id: string, age: number, sql?: string): InflightRow => ({
  id,
  method: 'GET',
  route: '/items/:c',
  caller: 'uX',
  started_at: 0,
  age_ms: age,
  queries: 0,
  sql_ms: 0,
  rows: 0,
  running: sql ? [{ sql, age_ms: 1000 }] : [],
  user_id: null,
  phase: sql ? 'sql' : 'handler'
})
const cr = (r: InflightRow, node: string): ClusterInflightRow => ({ ...r, node, wait: null })

describe('attachWaits', () => {
  it('matches the session running the statement and carries its wait', () => {
    const cands: WaitCandidate[] = [
      {
        session_id: 77,
        age_ms: 1100,
        text: 'SELECT * FROM big',
        wait_type: 'LCK_M_S',
        wait_ms: 900,
        blocking_session_id: 61
      }
    ]
    const out = attachWaits([row('a', 5000, 'SELECT * FROM big'), row('b', 10)], cands)
    expect(out[0]).toEqual({ session_id: 77, wait_type: 'LCK_M_S', wait_ms: 900, blocked_by: 61 })
    expect(out[1]).toBeNull()
  })
  it('gives null on no match', () => {
    expect(attachWaits([row('a', 1, 'SELECT 1')], [])).toEqual([null])
  })
})

describe('mergeInflight', () => {
  it('merges nodes oldest first, drops stale nodes and duplicates', () => {
    const now = 100_000
    const out = mergeInflight(
      [
        { node: 'n1', at: now, total: 1, rows: [cr(row('a', 10), 'n1')] },
        { node: 'n2', at: now - 1000, total: 2, rows: [cr(row('b', 900), 'n2')] },
        { node: 'n3', at: now - 60_000, total: 5, rows: [cr(row('c', 5000), 'n3')] },
        { node: 'n2', at: now, total: 9, rows: [] }
      ],
      now
    )
    expect(out.rows.map((r) => r.id)).toEqual(['b', 'a'])
    expect(out.total).toBe(3)
    expect(out.nodes.map((n) => n.node)).toEqual(['n1', 'n2'])
  })
})
