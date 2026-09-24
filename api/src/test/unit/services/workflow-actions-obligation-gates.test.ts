import { afterEach, describe, expect, it, vi } from 'vitest'

// An erp_submit action that does not APPLY to a record (its skip_when_empty /
// skip_unless_any gate says so) must open no obligation: several partners'
// actions share one transition, and a partner that was never supposed to be
// told has nothing to be "skipped" on. A guard refusal or a misconfigured
// action still records its no.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))
vi.mock('../../../services/external-apis.js', () => ({
  callExternalApi: vi.fn(async () => ({ status: 200, body: { status: 'SUCCESS' }, ok: true }))
}))
vi.mock('../../../services/integration-obligations.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../services/integration-obligations.js')>()
  return {
    ...actual,
    openObligationForTrigger: vi.fn(async () => 77),
    resolveObligation: vi.fn(async () => undefined)
  }
})

import { db } from '../../../db/index.js'
import {
  openObligationForTrigger,
  resolveObligation
} from '../../../services/integration-obligations.js'
import { runTransitionActions } from '../../../services/workflow-actions.js'

/** Minimal knex stand-in: per-table rows; every chain method returns the
 *  builder; select/first/await resolve the rows; inserts/updates resolve. */
function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'orWhere'])
      b[m] = vi.fn(() => b)
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    b.insert = vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([{ id: 1 }])) }))
    b.update = vi.fn(() => Promise.resolve(1))
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return b
  })
  ;(fn as unknown as { schema: unknown }).schema = { hasColumn: vi.fn().mockResolvedValue(false) }
  return fn
}

afterEach(() => vi.clearAllMocks())

const baseAction = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/orders',
  payload_template: '{"ok": true}'
}

async function run(
  action: Record<string, unknown>,
  tables: Record<string, Array<Record<string, unknown>>>
) {
  const fake = fakeDb({
    nivaro_external_apis: [{ id: 5, name: 'Partner' }],
    nivaro_action_journal: [],
    orders: [{ id: 'o1', status: 'open', link_id: null }],
    ...tables
  })
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
  return runTransitionActions({
    transition: { id: 't1', label: 'Submit', actions: JSON.stringify([action]) } as never,
    instance: { collection: 'orders', item: 'o1' },
    newStateObj: { key: 'submitted', label: 'Submitted' },
    userId: null
  })
}

describe('erp_submit obligations open only for actions that apply to the record', () => {
  it('skip_when_empty: no lines for this partner → no obligation, action skipped', async () => {
    const res = await run(
      {
        ...baseAction,
        context: { lines: { collection: 'order_lines', filter: { order: '$id' } } },
        skip_when_empty: 'lines'
      },
      { order_lines: [] }
    )
    expect(res.skippedReason).toBe('skip_when_empty: lines empty')
    expect(openObligationForTrigger).not.toHaveBeenCalled()
    expect(resolveObligation).not.toHaveBeenCalled()
  })

  it('skip_unless_any: no link to this system → no obligation, action skipped', async () => {
    const res = await run({ ...baseAction, skip_unless_any: ['record.link_id'] }, {})
    expect(res.skippedReason).toBe('skip_unless_any: none of record.link_id is set')
    expect(openObligationForTrigger).not.toHaveBeenCalled()
  })

  it('guard unmet on an action that applies → obligation opened and resolved skipped', async () => {
    const res = await run(
      { ...baseAction, guard: [{ field: 'status', op: 'eq', value: 'approved' }] },
      {}
    )
    expect(res.skippedReason).toBe('guard unmet: status eq "approved"')
    expect(openObligationForTrigger).toHaveBeenCalledTimes(1)
    expect(resolveObligation).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ outcome: 'skipped', reason: 'guard unmet: status eq "approved"' })
    )
  })

  it('not configured → obligation opened and resolved skipped (someone must fix it)', async () => {
    const res = await run({ ...baseAction, payload_template: '' }, {})
    expect(res.skippedReason).toBe('not configured: payload_template missing on the action')
    expect(openObligationForTrigger).toHaveBeenCalledTimes(1)
    expect(resolveObligation).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ outcome: 'skipped' })
    )
  })

  it('an action that applies and pushes → obligation opened once, resolved sent', async () => {
    const res = await run(
      {
        ...baseAction,
        context: { lines: { collection: 'order_lines', filter: { order: '$id' } } },
        skip_when_empty: 'lines'
      },
      { order_lines: [{ id: 1 }], nivaro_erp_submissions: [] }
    )
    expect(res.blockedError).toBeNull()
    expect(openObligationForTrigger).toHaveBeenCalledTimes(1)
    expect(resolveObligation).toHaveBeenCalledWith(77, expect.objectContaining({ outcome: 'sent' }))
  })
})
