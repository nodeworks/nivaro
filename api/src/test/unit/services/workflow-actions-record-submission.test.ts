import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))

import { db } from '../../../db/index.js'
import { resetRequesterColumnProbe } from '../../../services/erp-requester-columns.js'
import { recordSubmission } from '../../../services/workflow-actions.js'

type SchemaDb = { schema: { hasColumn: ReturnType<typeof vi.fn> } }

function fakeSubmissionsTable() {
  const insert = vi.fn((row: Record<string, unknown>) => ({
    row,
    returning: vi.fn().mockResolvedValue([{ id: 42 }])
  }))
  return { insert }
}

afterEach(() => {
  resetRequesterColumnProbe()
  vi.clearAllMocks()
})

describe('recordSubmission — the row must never be lost to a missing column (Task 15d fix)', () => {
  it('drops requested_by/requested_via but still records the row when this database lacks the columns', async () => {
    ;(db as unknown as SchemaDb).schema = { hasColumn: vi.fn().mockResolvedValue(false) }
    const table = fakeSubmissionsTable()
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)

    const id = await recordSubmission(
      'workflows',
      '1001',
      9,
      '/update_workflow.php',
      { a: 1 },
      'pending',
      null,
      { ok: true },
      null,
      200,
      { by: 'USER-1', via: 'transition' }
    )

    // The row still landed (an id came back) — the two columns were simply
    // never named, never the whole insert.
    expect(id).toBe(42)
    expect(table.insert).toHaveBeenCalledTimes(1)
    const row = table.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row).not.toHaveProperty('requested_by')
    expect(row).not.toHaveProperty('requested_via')
    expect(row.collection).toBe('workflows')
    expect(row.status).toBe('pending')
  })

  it('stamps the requester once this database has run migration 350', async () => {
    ;(db as unknown as SchemaDb).schema = { hasColumn: vi.fn().mockResolvedValue(true) }
    const table = fakeSubmissionsTable()
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)

    await recordSubmission(
      'workflows',
      '1001',
      9,
      '/update_workflow.php',
      { a: 1 },
      'pending',
      null,
      { ok: true },
      null,
      200,
      { by: 'USER-1', via: 'transition' }
    )

    const row = table.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row.requested_by).toBe('USER-1')
    expect(row.requested_via).toBe('transition')
  })

  it('still records the row when the probe itself throws (no db.schema at all)', async () => {
    const table = fakeSubmissionsTable()
    vi.mocked(db).mockReturnValue(table as unknown as ReturnType<typeof db>)
    // No .schema on this fake db — the probe must degrade to "missing",
    // never throw out of recordSubmission's own try/catch and lose the row.
    delete (db as unknown as { schema?: unknown }).schema

    const id = await recordSubmission(
      'workflows',
      '1002',
      9,
      '/update_workflow.php',
      {},
      'failed',
      'HTTP 500',
      null,
      null,
      500,
      { by: 'USER-2', via: 'auto-transition' }
    )

    expect(id).toBe(42)
    const row = table.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row).not.toHaveProperty('requested_by')
    expect(row).not.toHaveProperty('requested_via')
  })
})
