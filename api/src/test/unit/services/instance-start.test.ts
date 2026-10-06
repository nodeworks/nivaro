import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  backfillBatchSql,
  isStartRow,
  planBackfillStartRow,
  startHistoryRow,
  startOrigin
} from '../../../services/instance-start.js'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

describe('isStartRow', () => {
  it('is a start only with no from_state AND no transition', () => {
    expect(isStartRow({ from_state: null, transition: null })).toBe(true)
    expect(isStartRow({ from_state: 'x', transition: null })).toBe(false)
    expect(isStartRow({ from_state: null, transition: 't' })).toBe(false)
  })
})

describe('startOrigin', () => {
  it('reads person / machine / import', () => {
    expect(startOrigin('u1')).toBe('person')
    expect(startOrigin(null)).toBe('machine')
    expect(startOrigin('u1', 'import:po:1')).toBe('import')
  })
})

describe('startHistoryRow', () => {
  it('writes a from-nowhere row into the start state', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(startHistoryRow({ instanceId: 'i', stateId: 's', userId: 'u', timestamp: at })).toEqual({
      instance: 'i',
      transition: null,
      from_state: null,
      to_state: 's',
      user: 'u',
      comment: null,
      timestamp: at
    })
  })
})

describe('planBackfillStartRow', () => {
  const started = '2026-01-01T10:00:00Z'
  it('uses the state before the first move, at started_at', () => {
    const p = planBackfillStartRow({
      id: 'i',
      current_state: 'c',
      started_at: started,
      first_from_state: 'a',
      first_at: '2026-01-02T00:00:00Z'
    })
    expect(p).toEqual({ instance: 'i', to_state: 'a', timestamp: new Date(started) })
  })
  it('uses the current state when there is no history', () => {
    const p = planBackfillStartRow({
      id: 'i',
      current_state: 'c',
      started_at: started,
      first_from_state: null,
      first_at: null
    })
    expect(p?.to_state).toBe('c')
  })
  it('sorts strictly before a first move that shares or precedes started_at', () => {
    const p = planBackfillStartRow({
      id: 'i',
      current_state: 'c',
      started_at: started,
      first_from_state: 'a',
      first_at: started
    })
    expect(p?.timestamp.getTime()).toBe(new Date(started).getTime() - 1000)
  })
  it('writes nothing when the first move has no from_state', () => {
    expect(
      planBackfillStartRow({
        id: 'i',
        current_state: 'c',
        started_at: started,
        first_from_state: null,
        first_at: started
      })
    ).toBeNull()
  })
  it('writes nothing without any time to stamp', () => {
    expect(
      planBackfillStartRow({
        id: 'i',
        current_state: 'c',
        started_at: null,
        first_from_state: null,
        first_at: null
      })
    ).toBeNull()
  })
})

describe('backfillBatchSql', () => {
  it('refuses bounds that are not uuids', () => {
    expect(() =>
      backfillBatchSql("x'; DROP TABLE t; --", B, { execute: false, withOrigin: true })
    ).toThrow()
  })
  it('dry run selects counts and writes nothing', () => {
    const sql = backfillBatchSql(A, B, { execute: false, withOrigin: true })
    expect(sql).toContain('SELECT COUNT(*) AS candidates')
    expect(sql).not.toContain('INSERT')
    expect(sql).toContain(`i.id >= '${A}' AND i.id <= '${B}'`)
  })
  it('execute inserts idempotently, with origin only when the column exists', () => {
    const withO = backfillBatchSql(A, B, { execute: true, withOrigin: true })
    expect(withO).toContain('INSERT INTO nivaro_workflow_history')
    expect(withO).toContain("'machine'")
    expect(withO).toContain('NOT EXISTS')
    const without = backfillBatchSql(A, B, { execute: true, withOrigin: false })
    expect(without).not.toContain('origin')
  })
})
