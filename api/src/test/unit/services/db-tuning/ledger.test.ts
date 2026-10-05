import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import { fingerprintOf, parseRow, upsertDecision } from '../../../../services/db-tuning/ledger.js'

describe('ledger', () => {
  afterEach(() => vi.clearAllMocks())

  it('fingerprint depends on kind, target and change_key only', () => {
    const a = fingerprintOf({
      kind: 'index_create',
      target: 'workflows.project_type',
      change_key: 'project_type'
    })
    const b = fingerprintOf({
      kind: 'index_create',
      target: 'workflows.project_type',
      change_key: 'project_type'
    })
    const c = fingerprintOf({
      kind: 'index_create',
      target: 'workflows.project_type',
      change_key: 'project_type,id'
    })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toHaveLength(40)
  })

  it('parseRow decodes JSON columns and tolerates garbage', () => {
    const row = parseRow({
      id: 'x',
      kind: 'query_cache',
      target: 's',
      fingerprint: 'f',
      status: 'proposed',
      title: 't',
      evidence: '{"runs":3}',
      proof: 'not json',
      estimate_ms_per_day: '1200',
      risk: 'reversible',
      replicated: 0,
      apply: '{"type":"sql","statements":[]}',
      undo: '{"type":"sql","statements":[]}',
      first_seen: new Date('2026-10-01T00:00:00Z'),
      last_seen: new Date('2026-10-02T00:00:00Z')
    })
    expect(row.evidence).toEqual({ runs: 3 })
    expect(row.proof).toBeNull()
    expect(row.estimate_ms_per_day).toBe(1200)
    expect(row.replicated).toBe(false)
    expect(row.first_seen).toBe('2026-10-01T00:00:00.000Z')
  })

  it('upsertDecision: quiet when a dismissed twin is younger than 90 days', () => {
    const d = upsertDecision(
      { open: null, recent: { status: 'dismissed', at: new Date() } },
      new Date()
    )
    expect(d).toBe('quiet')
  })
  it('upsertDecision: inserts when the dismissed twin is older than 90 days', () => {
    const old = new Date(Date.now() - 91 * 86_400_000)
    expect(
      upsertDecision({ open: null, recent: { status: 'dismissed', at: old } }, new Date())
    ).toBe('insert')
  })
  it('upsertDecision: updates an open row, never a watching one', () => {
    expect(upsertDecision({ open: { status: 'proposed' }, recent: null }, new Date())).toBe(
      'update'
    )
    expect(upsertDecision({ open: { status: 'watching' }, recent: null }, new Date())).toBe('quiet')
  })
  it('db mock is present', () => {
    expect(db).toBeDefined()
  })
})
