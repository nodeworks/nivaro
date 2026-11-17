import { beforeEach, describe, expect, it, vi } from 'vitest'

// The upload answers 202 without reading the file (EFP prod 2026-11-16: reading and validating
// a 30 MB CSV in the request held a web process for 17 s). The worker now reads the file once,
// validates it — a file-derived hard error fails the run with the same message the upload used
// to answer 422 with — and hands the same rows to the run.

const state = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  queued: [] as Array<Record<string, unknown>>,
  errors: [] as Array<{ code: string; message: string }>
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const where: Record<string, unknown> = {}
    const q: Record<string, unknown> = {
      where: (k: string | Record<string, unknown>, v?: unknown) => {
        if (typeof k === 'string') where[k] = v
        else Object.assign(where, k)
        return q
      },
      select: async () => [],
      orderBy: () => q,
      limit: async () =>
        table === 'nivaro_import_queue' && where.status === 'queued' ? state.queued : [],
      update: async (patch: Record<string, unknown>) => {
        state.updates.push({ table, ...where, ...patch })
        return 1
      }
    }
    return q
  }
  return { db: builder }
})
vi.mock('../../../services/files.js', () => ({
  getFile: vi.fn(async () => ({ id: 'f1' })),
  readFileBuffer: vi.fn(async () => Buffer.from('invoice_id,amount\n1,2\n'))
}))
vi.mock('../../../services/import-collection-runs.js', () => ({
  announceCollectionImportRun: vi.fn(async () => {})
}))
vi.mock('../../../services/import-queue-standing.js', () => ({
  loadQueueStanding: vi.fn(async () => ({ entries: [], standing: new Map() })),
  publishQueueStanding: vi.fn()
}))
vi.mock('../../../services/live-progress.js', () => ({
  emitImportProgress: vi.fn(),
  emitJobProgress: vi.fn()
}))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn(async () => {}) }))
vi.mock('../../../services/traffic-taps/sources.js', () => ({ noteImportRun: vi.fn() }))
vi.mock('../../../services/staged-import-validation.js', () => ({
  validateStagedRows: vi.fn(async () => ({ errors: state.errors, warnings: [], stats: {} }))
}))
vi.mock('../../../services/staged-imports.js', async (orig) => ({
  ...(await orig<object>()),
  listImportDefinitions: vi.fn(async () => [
    { key: 'invoices', staging_table: 'staging_invoices' }
  ]),
  getImportDefinition: vi.fn(async () => ({
    id: 3,
    key: 'invoices',
    label: 'Invoices',
    is_active: true
  })),
  parseImportFileAsync: vi.fn(async () => [{ invoice_id: '1', amount: '2' }]),
  runStagedImport: vi.fn(async () => ({ rowCount: 1, durationSeconds: 0 }))
}))

import { validateStagedRows } from '../../../services/staged-import-validation.js'
import { registerStagedImportWorker } from '../../../services/staged-import-worker.js'
import { parseImportFileAsync, runStagedImport } from '../../../services/staged-imports.js'

async function tick() {
  const jobs = new Map<string, () => Promise<void>>()
  const app = {
    cron: { schedule: (name: string, _at: string, fn: () => Promise<void>) => jobs.set(name, fn) },
    log: { error: vi.fn(), info: vi.fn() }
  }
  registerStagedImportWorker(app as never)
  await jobs.get('staged-imports')?.()
  // runOne is fired without await by the drain: let it settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

beforeEach(() => {
  state.updates.length = 0
  state.errors = []
  state.queued = [{ id: 9, import_key: 'invoices', file: 'f1', created_by: null }]
  vi.mocked(runStagedImport).mockClear()
  vi.mocked(parseImportFileAsync).mockClear()
  vi.mocked(validateStagedRows).mockClear()
})

describe('staged import worker validates the file it runs', () => {
  it('a file that fails validation fails the run with the reason and never loads', async () => {
    state.errors = [{ code: 'duplicate_keys', message: '3 row(s) repeat an earlier row' }]
    await tick()
    expect(runStagedImport).not.toHaveBeenCalled()
    const failed = state.updates.find((u) => u.status === 'error')
    expect(failed).toMatchObject({ id: 9 })
    expect(String(failed?.logs)).toMatch(/^That file fails validation: 3 row\(s\) repeat/)
  })

  it('a clean file is read once and its rows handed to the run', async () => {
    await tick()
    expect(parseImportFileAsync).toHaveBeenCalledTimes(1)
    expect(validateStagedRows).toHaveBeenCalledTimes(1)
    expect(runStagedImport).toHaveBeenCalledWith(
      expect.objectContaining({ rows: [{ invoice_id: '1', amount: '2' }] })
    )
    expect(state.updates.some((u) => u.status === 'completed')).toBe(true)
  })
})
