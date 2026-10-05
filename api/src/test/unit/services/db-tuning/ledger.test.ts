import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../../db/index.js'
import {
  fingerprintOf,
  ledgerDecision,
  parseRow,
  touchSeen,
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
  it('upsertDecision: a proof rejection is quiet for 7 days, then proved again', () => {
    const now = new Date()
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000)
    const rejected = (d: number) => ({ open: { status: 'rejected_by_proof' as const, at: at(d) } })
    expect(upsertDecision({ ...rejected(1), recent: null }, now)).toBe('quiet')
    expect(upsertDecision({ ...rejected(6.9), recent: null }, now)).toBe('quiet')
    expect(upsertDecision({ ...rejected(7.1), recent: null }, now)).toBe('update')
    // dismissed and rolled back keep their 90 days
    expect(upsertDecision({ open: null, recent: { status: 'dismissed', at: at(30) } }, now)).toBe(
      'quiet'
    )
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

  it('an errored proof keeps a proposed row proposed and only bumps last_seen', async () => {
    const { insert, update } = stub([{ id: 'abc', status: 'proposed' }])
    const errored: ProofResult = {
      ...proof(false),
      method: 'refused',
      detail: 'error: proof could not run: timeout'
    }
    const r = await upsertProposal(cand, errored, 9)
    expect(r).toEqual({ id: 'abc', action: 'kept' })
    expect(update).toHaveBeenCalledOnce()
    expect(update.mock.calls[0][0]).toEqual({ last_seen: expect.any(Date), run_id: 9 })
    expect(insert).not.toHaveBeenCalled()
  })

  it('a policy refusal still rejects a proposed row', async () => {
    const { update } = stub([{ id: 'abc', status: 'proposed' }])
    const policy: ProofResult = { ...proof(false), method: 'refused', detail: 'rewrite writes' }
    expect((await upsertProposal(cand, policy, null)).action).toBe('updated')
    expect(update.mock.calls[0][0]).toMatchObject({ status: 'rejected_by_proof' })
  })

  it('an errored proof on a new fingerprint is still stored, as rejected_by_proof', async () => {
    const { insert } = stub([undefined, undefined])
    const errored: ProofResult = { ...proof(false), method: 'refused', detail: 'error: x' }
    expect((await upsertProposal(cand, errored, null)).action).toBe('inserted')
    expect(insert.mock.calls[0][0]).toMatchObject({ status: 'rejected_by_proof' })
  })

  it('ledgerDecision is quiet for an in-flight row and for a young dismissed twin', async () => {
    stub([{ id: 'abc', status: 'applying' }])
    expect(await ledgerDecision('f')).toBe('quiet')
    stub([undefined, { status: 'dismissed', dismissed_at: new Date(), rolled_back_at: null }])
    expect(await ledgerDecision('f')).toBe('quiet')
    stub([{ id: 'abc', status: 'proposed' }])
    expect(await ledgerDecision('f')).toBe('update')
    stub([{ id: 'abc', status: 'rejected_by_proof', last_seen: new Date() }])
    expect(await ledgerDecision('f')).toBe('quiet')
  })

  it('touchSeen bumps last_seen on open rows only, in chunks', async () => {
    const whereIn = vi.fn()
    const update = vi.fn().mockResolvedValue(2)
    const builder: Record<string, unknown> = { update }
    builder.whereIn = whereIn.mockImplementation(() => builder)
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue(builder)
    const fps = Array.from({ length: 501 }, (_, i) => `f${i}`)
    expect(await touchSeen([...fps, 'f0'])).toBe(4)
    expect(update).toHaveBeenCalledTimes(2)
    expect(update.mock.calls[0][0]).toEqual({ last_seen: expect.any(Date) })
    expect(whereIn.mock.calls[0]).toEqual(['fingerprint', fps.slice(0, 500)])
    // a rejected row's last_seen is when it was last proved (its 7 quiet days count from there)
    expect(whereIn.mock.calls[1]).toEqual(['status', ['proposed', 'stale']])
    expect(whereIn.mock.calls[2]).toEqual(['fingerprint', ['f500']])
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
