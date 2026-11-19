import { afterEach, describe, expect, it, vi } from 'vitest'

// "What goes out next" (#615) and the push pre-flight (#616) judge the integration's own send
// rules (integration_config.skip_sends) the way the real run does: an IR in a market MWF does
// not take must read "MWF will not receive this record", never "the next push is its first"
// (Rob 2026-11-18, IR 38241, workflow_id B143-4985935).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))
vi.mock('../../../services/external-apis.js', () => ({
  callExternalApi: vi.fn(async () => ({ status: 200, body: {}, ok: true })),
  resolveInstanceRow: vi.fn((row: unknown) => row)
}))

import { db } from '../../../db/index.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { notSending } from '../../../services/integration-preview.js'
import { previewErpActions } from '../../../services/workflow-actions.js'

const ONLY = {
  field: 'workflow_id',
  not_starts_with_any: ['B1020-', 'B1021-', 'B1313-', 'B1028-'],
  reason: 'MWF only takes markets B1020, B1021, B1313 and B1028'
}
const MWF = { id: 7, name: 'MWF', integration_config: JSON.stringify({ skip_sends: [ONLY] }) }
const action = {
  type: 'erp_submit',
  external_api: 'MWF',
  endpoint_path: '/workflow',
  payload_template: '{"workflow_id":"{{ record.workflow_id }}","order":"{{ record.order_number }}"}'
}

function wire(record: Record<string, unknown>) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    nivaro_external_apis: [MWF],
    nivaro_erp_submissions: [],
    inventory_request: [record]
  }
  const fake = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'orWhere'])
      b[m] = vi.fn(() => b)
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return b
  })
  ;(fake as unknown as { schema: unknown }).schema = {
    hasColumn: vi.fn().mockResolvedValue(false)
  }
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
}

const preview = () =>
  previewErpActions({
    transition: { id: 't1', label: 'Auto-complete', actions: JSON.stringify([action]) },
    instance: { collection: 'inventory_request', item: '38241' },
    newStateObj: { key: 'completed', label: 'Completed' },
    userId: null
  })

afterEach(() => vi.clearAllMocks())

describe('previewErpActions — the integration’s own send rule', () => {
  it('a market the partner does not take reads send_skip with the rule’s sentence, no body', async () => {
    wire({ id: 38241, workflow_id: 'B143-4985935', order_number: 'SO1' })
    const [p] = await preview()
    expect(p.status).toBe('send_skip')
    expect(p.reason).toBe(
      'not sent: workflow_id B143-4985935 — MWF only takes markets B1020, B1021, B1313 and B1028'
    )
    expect(p.body).toBeNull()
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('a market it takes still previews as a push', async () => {
    wire({ id: 1, workflow_id: 'B1020-123456', order_number: 'SO1' })
    const [p] = await preview()
    expect(p.status).toBe('would_push')
    expect(p.body).toMatchObject({ workflow_id: 'B1020-123456' })
  })
})

describe('notSending — "What goes out next" says the partner will not receive the record', () => {
  const skip = {
    status: 'send_skip' as const,
    reason:
      'not sent: workflow_id B143-4985935 — MWF only takes markets B1020, B1021, B1313 and B1028'
  }
  it('every trigger left out by the send rule → the rule in a person’s words', () => {
    expect(notSending([skip, skip])).toBe(
      'MWF only takes markets B1020, B1021, B1313 and B1028 (Workflow ID B143-4985935)'
    )
  })
  it('one trigger that would send → null (a push is coming)', () => {
    expect(notSending([skip, { status: 'would_push', reason: null }])).toBeNull()
    expect(notSending([])).toBeNull()
  })
})
