import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import {
  pruneObligations,
  summariseObligations
} from '../../../services/integration-obligations.js'

const d = (s: string) => new Date(s)

describe('summariseObligations', () => {
  it('groups counts per api and keeps the outcome order the strip reads in', () => {
    const out = summariseObligations(
      [
        { api: 'A', outcome: 'sent', c: 10, oldest: d('2026-09-01T00:00:00Z') },
        { api: 'A', outcome: 'overdue', c: 2, oldest: d('2026-09-20T00:00:00Z') },
        { api: 'B', outcome: 'failed', c: 1, oldest: d('2026-09-21T00:00:00Z') }
      ],
      { A: 'user-1', B: null }
    )
    expect(out.map((a) => a.api)).toEqual(['A', 'B'])
    expect(out[0].tiles.map((t) => t.outcome)).toEqual([
      'overdue',
      'failed',
      'pending',
      'skipped',
      'sent',
      'missing'
    ])
    expect(out[0].tiles.find((t) => t.outcome === 'overdue')?.count).toBe(2)
    expect(out[0].owner_user).toBe('user-1')
  })

  it('reports zero rather than omitting an outcome, so the strip never reflows', () => {
    const out = summariseObligations([{ api: 'A', outcome: 'sent', c: 1, oldest: null }], {})
    expect(out[0].tiles).toHaveLength(6)
    expect(out[0].tiles.find((t) => t.outcome === 'failed')?.count).toBe(0)
  })

  it('takes oldest_unmet from the unmet outcomes only — a year-old sent row is not a problem', () => {
    const out = summariseObligations(
      [
        { api: 'A', outcome: 'sent', c: 1, oldest: d('2020-01-01T00:00:00Z') },
        { api: 'A', outcome: 'missing', c: 1, oldest: d('2026-09-20T00:00:00Z') }
      ],
      {}
    )
    expect(out[0].oldest_unmet).toBe('2026-09-20T00:00:00.000Z')
  })

  it('is null for oldest_unmet when nothing is unmet', () => {
    const out = summariseObligations(
      [{ api: 'A', outcome: 'sent', c: 3, oldest: d('2026-01-01T00:00:00Z') }],
      {}
    )
    expect(out[0].oldest_unmet).toBeNull()
  })

  it('returns an empty list rather than throwing on no rows', () => {
    expect(summariseObligations([], {})).toEqual([])
  })
})

// ─── pruneObligations — the db-writing surface ─────────────────────────────
// db is already mocked in src/test/setup.ts; db.raw is itself a vi.fn(). Each
// test below replaces it with a fresh mock so its calls can be inspected,
// same idiom as test/unit/routes/health.test.ts.

function mockRaw(fn: ReturnType<typeof vi.fn>): void {
  vi.mocked(db as unknown as { raw: typeof fn }).raw = fn
}

describe('pruneObligations', () => {
  afterEach(() => vi.clearAllMocks())

  it('deletes only sent/superseded rows — the WHERE never names an open outcome', async () => {
    const raw = vi.fn().mockResolvedValueOnce([0])
    mockRaw(raw)

    await pruneObligations()

    const [sql] = raw.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain("outcome IN ('sent', 'superseded')")
    for (const open of ['pending', 'failed', 'overdue', 'missing']) {
      expect(sql).not.toContain(`'${open}'`)
    }
  })

  it('filters on the given retention window (default 180 days)', async () => {
    const raw = vi.fn().mockResolvedValueOnce([0])
    mockRaw(raw)

    const before = Date.now() - 180 * 86_400_000

    await pruneObligations()

    const [, bindings] = raw.mock.calls[0] as [string, unknown[]]
    const cutoff = bindings[0] as Date
    expect(cutoff).toBeInstanceOf(Date)
    // Allow a few seconds of slack for however long the call itself took.
    expect(Math.abs(cutoff.getTime() - before)).toBeLessThan(5_000)
  })

  it('honors a caller-supplied retention window', async () => {
    const raw = vi.fn().mockResolvedValueOnce([0])
    mockRaw(raw)

    const before = Date.now() - 30 * 86_400_000
    await pruneObligations(30)

    const [, bindings] = raw.mock.calls[0] as [string, unknown[]]
    const cutoff = bindings[0] as Date
    expect(Math.abs(cutoff.getTime() - before)).toBeLessThan(5_000)
  })

  it('sums every batch and keeps going while a batch is full', async () => {
    const raw = vi.fn().mockResolvedValueOnce([5000]).mockResolvedValueOnce([3])
    mockRaw(raw)

    const total = await pruneObligations()

    expect(total).toBe(5003)
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('stops on the first batch that comes back under the batch size', async () => {
    const raw = vi.fn().mockResolvedValueOnce([42])
    mockRaw(raw)

    const total = await pruneObligations()

    expect(total).toBe(42)
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('returns what was already committed, and never throws, when a later batch fails', async () => {
    const raw = vi
      .fn()
      .mockResolvedValueOnce([5000])
      .mockRejectedValueOnce(new Error('lock timeout'))
    mockRaw(raw)

    await expect(pruneObligations()).resolves.toBe(5000)
    expect(raw).toHaveBeenCalledTimes(2)
  })

  it('returns 0 without throwing when the very first batch fails', async () => {
    const raw = vi.fn().mockRejectedValueOnce(new Error('lock timeout'))
    mockRaw(raw)

    await expect(pruneObligations()).resolves.toBe(0)
  })
})
