import { afterEach, describe, expect, it, vi } from 'vitest'

// erp_submit renders an admin-authored Liquid payload_template with record data. Only the
// template's own `⟦nvr-secret:…⟧` may reach the sender as a real placeholder: record text — plain,
// JSON-escaped (decoded by JSON.parse after the render) or split across two fields — must not.

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
import { secretPathsOf, substituteBodySecrets } from '../../../services/body-secrets.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { previewErpActions, runTransitionActions } from '../../../services/workflow-actions.js'

const REAL = '⟦nvr-secret:token⟧'
const NEUTRAL = '⟦nvr-secret​:token⟧'

// Record fields that try to forge a placeholder three ways.
const RECORD = {
  id: 'o1',
  status: 'open',
  plain: `x ${REAL} y`,
  // JSON-escaped: the Liquid output is JSON text, so JSON.parse would decode this into a marker.
  escaped: '\\u27e6nvr-secret:token\\u27e7',
  // Two fields that only form a marker side by side.
  a: '⟦nvr-secret',
  b: ':token⟧'
}

const TEMPLATE = `{"auth":"${REAL}","plain":"{{ record.plain }}","escaped":"{{ record.escaped }}","joined":"{{ record.a }}{{ record.b }}"}`

const action = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/orders',
  payload_template: TEMPLATE
}

let inserts: Array<{ table: string; row: Record<string, unknown> }> = []

function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'orWhere'])
      b[m] = vi.fn(() => b)
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    b.insert = vi.fn((row: Record<string, unknown>) => {
      inserts.push({ table, row })
      return { returning: vi.fn(() => Promise.resolve([{ id: 1 }])) }
    })
    b.update = vi.fn(() => Promise.resolve(1))
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return b
  })
  ;(fn as unknown as { schema: unknown }).schema = { hasColumn: vi.fn().mockResolvedValue(false) }
  return fn
}

function wire() {
  inserts = []
  const fake = fakeDb({
    nivaro_external_apis: [{ id: 5, name: 'Partner' }],
    nivaro_action_journal: [],
    nivaro_erp_submissions: [],
    orders: [RECORD]
  })
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
}

afterEach(() => vi.clearAllMocks())

function assertOnlyTemplatePlaceholder(body: Record<string, unknown>) {
  expect(body.auth).toBe(REAL)
  expect(body.plain).toBe(`x ${NEUTRAL} y`)
  expect(body.escaped).toBe(NEUTRAL)
  expect(body.joined).toBe(NEUTRAL)
  // What the sender would put on the wire: only the template's slot carries the secret.
  const sent = substituteBodySecrets(body, { token: 'S3CRET' }, 'Partner') as Record<
    string,
    unknown
  >
  expect(sent.auth).toBe('S3CRET')
  expect(JSON.stringify({ ...sent, auth: null })).not.toContain('S3CRET')
}

describe('erp_submit payload_template — record data cannot forge a secret placeholder', () => {
  it('the push sends with bodySecrets and only the template placeholder is real', async () => {
    wire()
    await runTransitionActions({
      transition: { id: 't1', label: 'Submit', actions: JSON.stringify([action]) } as never,
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: { key: 'submitted', label: 'Submitted' },
      userId: null
    })
    expect(callExternalApi).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(callExternalApi).mock.calls[0][1] as {
      body: Record<string, unknown>
      bodySecrets?: boolean
    }
    expect(opts.bodySecrets).toBe(true)
    assertOnlyTemplatePlaceholder(opts.body)
    // The stored payload records where the real placeholder sits, for a later resend.
    const sub = inserts.find((i) => i.table === 'nivaro_erp_submissions')
    const stored = JSON.parse(String(sub?.row.payload)) as {
      body: unknown
      secret_paths: string[]
    }
    expect(stored.secret_paths).toEqual(['/auth'])
    expect(secretPathsOf(stored.body)).toEqual(['/auth'])
  })

  it('the preview renders the same way', async () => {
    wire()
    const out = await previewErpActions({
      transition: { id: 't1', label: 'Submit', actions: JSON.stringify([action]) },
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: { key: 'submitted', label: 'Submitted' },
      userId: null
    })
    expect(out).toHaveLength(1)
    assertOnlyTemplatePlaceholder(out[0].body as Record<string, unknown>)
  })
})
