import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  fingerprintOf,
  parseRow,
  upsertDecision,
  upsertProposal
} from '../../../../services/db-tuning/ledger.js'
import type { Candidate, ProofResult } from '../../../../services/db-tuning/types.js'

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
  it('upsertDecision: rolled_back twin quiet inside 90 days, insert outside', () => {
    const now = new Date()
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000)
    expect(upsertDecision({ open: null, recent: { status: 'rolled_back', at: at(10) } }, now)).toBe(
      'quiet'
    )
    expect(
      upsertDecision({ open: null, recent: { status: 'rolled_back', at: at(100) } }, now)
    ).toBe('insert')
  })
  it('upsertDecision: stale updates, applied is quiet', () => {
    const now = new Date()
    expect(upsertDecision({ open: { status: 'stale' }, recent: null }, now)).toBe('update')
    expect(upsertDecision({ open: { status: 'applied' }, recent: null }, now)).toBe('quiet')
  })
})

describe('upsertProposal', () => {
  afterEach(() => vi.clearAllMocks())

  const cand: Candidate = {
    kind: 'index_create',
    target: 'workflows.project_type',
    change_key: 'project_type',
    title: 't',
    evidence: {},
    estimate_ms_per_day: 10,
    risk: 'reversible',
    apply: { type: 'sql', statements: [] },
    undo: { type: 'sql', statements: [] }
  }
  const proof = (passed: boolean): ProofResult => ({
    passed,
    method: 'hypothetical',
    before: {},
    after: {},
    detail: ''
  })

  // One chainable builder per db(T) call: open lookup, then twin lookup (if reached), then write.
  function stub(firsts: unknown[]) {
    const insert = vi.fn().mockResolvedValue(undefined)
    const update = vi.fn().mockResolvedValue(1)
    const queue = [...firsts]
    const builder: Record<string, unknown> = {
      insert,
      update,
      first: vi.fn(async () => queue.shift())
    }
    for (const m of ['where', 'whereIn', 'orderBy']) builder[m] = vi.fn(() => builder)
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(builder)
    return { insert, update }
  }

  it('inserts when there is no open row and no recent twin', async () => {
    const { insert, update } = stub([undefined, undefined])
    const r = await upsertProposal(cand, proof(true), 7)
    expect(r.action).toBe('inserted')
    expect(r.id).toEqual(expect.any(String))
    expect(insert).toHaveBeenCalledOnce()
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'proposed', run_id: 7 })
    expect(update).not.toHaveBeenCalled()
  })

  it('updates an open proposed row, rejected_by_proof when the proof failed', async () => {
    const { insert, update } = stub([{ id: 'abc', status: 'proposed' }])
    const r = await upsertProposal(cand, proof(false), null)
    expect(r).toEqual({ id: 'abc', action: 'updated' })
    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0][0]).toMatchObject({ status: 'rejected_by_proof' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('stays quiet for a watching row', async () => {
    const { insert, update } = stub([{ id: 'abc', status: 'watching' }])
    const r = await upsertProposal(cand, proof(true), null)
    expect(r).toEqual({ id: 'abc', action: 'quiet' })
    expect(insert).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('quiet with null id for a young dismissed twin', async () => {
    const { insert } = stub([
      undefined,
      { status: 'dismissed', dismissed_at: new Date(), rolled_back_at: null }
    ])
    const r = await upsertProposal(cand, proof(true), null)
    expect(r).toEqual({ id: null, action: 'quiet' })
    expect(insert).not.toHaveBeenCalled()
  })
})
