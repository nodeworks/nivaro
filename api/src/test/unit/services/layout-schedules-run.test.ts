import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The layout-schedules cron (#2590): the stuck sweep's conditional update is its claim (one
// report per failure, however many processes sweep), and a long apply keeps its row alive
// with a heartbeat so the sweep never fails it mid-run.

const f = vi.hoisted(() => {
  const rows: Array<Record<string, unknown>> = []
  const notified: string[] = []
  let release: (() => void) | null = null
  const gate = { wait: false }
  type Pred = (r: Record<string, unknown>) => boolean
  const db = Object.assign(
    (_table: string) => {
      const preds: Pred[] = []
      const api: Record<string, unknown> = {
        where(a: unknown, op?: string, v?: unknown) {
          if (typeof a === 'object' && a) {
            const o = a as Record<string, unknown>
            preds.push((r) => Object.entries(o).every(([k, x]) => r[k] === x))
          } else if (op === '<') preds.push((r) => new Date(r[a as string] as Date) < (v as Date))
          else if (op === '<=') preds.push((r) => new Date(r[a as string] as Date) <= (v as Date))
          return api
        },
        orderBy: () => api,
        limit: () => api,
        // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return Promise.resolve(rows.filter((r) => preds.every((p) => p(r)))).then(res, rej)
        },
        async update(patch: Record<string, unknown>) {
          const hit = rows.filter((r) => preds.every((p) => p(r)))
          for (const r of hit) Object.assign(r, patch)
          return hit.length
        },
        async first() {
          return rows.find((r) => preds.every((p) => p(r)))
        }
      }
      return api
    },
    { schema: { hasTable: async () => true } }
  )
  return {
    rows,
    notified,
    db,
    gate,
    setRelease: (fn: (() => void) | null) => {
      release = fn
    },
    release: () => release?.()
  }
})

vi.mock('../../../db/index.js', () => ({ db: f.db }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => null }))
vi.mock('../../../middleware/authenticate.js', () => ({ isActiveAdmin: async () => true }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/collections.js', () => ({ clearMetadataCache: vi.fn() }))
vi.mock('../../../services/config-live.js', () => ({ announceConfigChanged: vi.fn() }))
vi.mock('../../../services/layout-references.js', () => ({ bustLayoutReferences: vi.fn() }))
vi.mock('../../../services/section-locks.js', () => ({ bustSectionLockCache: vi.fn() }))
vi.mock('../../../services/io-holder.js', () => ({ getApp: () => ({ log: {} }) }))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, to: string) => {
    f.notified.push(to)
  })
}))
vi.mock('../../../services/layout-ops.js', () => ({
  applyLayoutOps: vi.fn(),
  loadLayoutBundle: vi.fn(async () => ({ layout: { name: 'PO' }, rev: 'r1' })),
  runLayoutOps: vi.fn(
    () =>
      new Promise((resolve) => {
        const done = () => resolve({ status: 200, changed: false })
        if (f.gate.wait) f.setRelease(done)
        else done()
      })
  )
}))

const { runDueSchedules, HEARTBEAT_MS } = await import('../../../services/layout-schedules.js')

const row = (over: Record<string, unknown>) => ({
  id: 1,
  layout_id: 5,
  collection: 'orders',
  ops: '[]',
  base_rev: 'r1',
  note: null,
  created_by: 'admin1',
  ...over
})

beforeEach(() => {
  f.rows.length = 0
  f.notified.length = 0
  f.gate.wait = false
  f.setRelease(null)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('stuck sweep', () => {
  it('reports an interrupted row once, however many processes sweep', async () => {
    const now = new Date('2026-10-21T12:00:00Z')
    f.rows.push(
      row({ status: 'running', updated_at: new Date(now.getTime() - 30 * 60_000), run_at: now })
    )
    await Promise.all([runDueSchedules(now), runDueSchedules(now), runDueSchedules(now)])
    expect(f.rows[0].status).toBe('failed')
    expect(f.notified).toEqual(['admin1'])
  })
  it('leaves a running row that is still beating', async () => {
    const now = new Date('2026-10-21T12:00:00Z')
    f.rows.push(
      row({ status: 'running', updated_at: new Date(now.getTime() - 60_000), run_at: now })
    )
    await runDueSchedules(now)
    expect(f.rows[0].status).toBe('running')
    expect(f.notified).toEqual([])
  })
})

describe('heartbeat', () => {
  it('keeps a long apply alive past the stuck cutoff, then applies it', async () => {
    vi.useFakeTimers()
    const start = new Date('2026-10-21T12:00:00Z')
    vi.setSystemTime(start)
    f.gate.wait = true
    f.rows.push(row({ status: 'pending', run_at: start, updated_at: start }))
    const run = runDueSchedules(start)
    // Let the claim and the reads settle, then run the apply for 15 minutes.
    await vi.advanceTimersByTimeAsync(10)
    expect(f.rows[0].status).toBe('running')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    const later = new Date(start.getTime() + 15 * 60_000)
    expect(new Date(f.rows[0].updated_at as Date).getTime()).toBeGreaterThan(
      later.getTime() - 2 * HEARTBEAT_MS
    )
    // Another process sweeps now: the row is not stuck.
    await runDueSchedules(later)
    expect(f.rows[0].status).toBe('running')
    f.release()
    await vi.advanceTimersByTimeAsync(10)
    await run
    expect(f.rows[0].status).toBe('applied')
    expect(f.notified).toEqual([])
  })
})
