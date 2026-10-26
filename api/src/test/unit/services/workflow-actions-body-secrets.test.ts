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
  callExternalApi: vi.fn(async () => ({ status: 200, body: { status: 'SUCCESS' }, ok: true })),
  // The response scrub resolves the API's instance row (no overrides in these tests).
  resolveInstanceRow: vi.fn((row: unknown) => row)
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
  restrictPlaceholders,
  SCRUB_FAILED_TEXT,
  secretPathsOf,
  substituteBodySecrets
} from '../../../services/body-secrets.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { resolveObligation } from '../../../services/integration-obligations.js'
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

function wire(apiRow: Record<string, unknown> = { id: 5, name: 'Partner' }) {
  inserts = []
  const fake = fakeDb({
    nivaro_external_apis: [apiRow],
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

describe('erp_submit — the stored response fails closed when the secrets cannot be read', () => {
  const run = () =>
    runTransitionActions({
      transition: { id: 't1', label: 'Submit', actions: JSON.stringify([action]) } as never,
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: { key: 'submitted', label: 'Submitted' },
      userId: null
    })
  const storedResponse = () =>
    inserts.find((i) => i.table === 'nivaro_erp_submissions')?.row.response as string | null
  const storedError = () =>
    inserts.find((i) => i.table === 'nivaro_erp_submissions')?.row.last_error as string | null
  const obligationReason = () =>
    (vi.mocked(resolveObligation).mock.calls.at(-1)?.[1] as { reason?: string | null }).reason
  const withSecret = {
    id: 5,
    name: 'Partner',
    auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET' } })
  }

  it('a 4xx echoing the token: last_error and the obligation reason carry the placeholder', async () => {
    wire(withSecret)
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 400,
      body: { error: 'bad', echo: 'S3CRET' }
    } as never)
    await run()
    expect(storedError()).toContain(REAL)
    expect(storedError()).not.toContain('S3CRET')
    expect(obligationReason()).toContain(REAL)
    expect(obligationReason()).not.toContain('S3CRET')
  })

  it('a 2xx refusal quoting the token: the stored message is built from the scrubbed body', async () => {
    wire(withSecret)
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 200,
      body: { status: 'ERROR', message: 'token S3CRET rejected' }
    } as never)
    await run()
    expect(storedError()).toBe(`token ${REAL} rejected`)
    expect(obligationReason()).toBe(`token ${REAL} rejected`)
  })

  it('an unreadable auth_config: last_error and the reason are the marker text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wire({ id: 5, name: 'Partner', auth_config: '{"body_secrets":' })
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 400,
      body: { echo: 'S3CRET' }
    } as never)
    await run()
    expect(storedError()).toBe(`HTTP 400: ${SCRUB_FAILED_TEXT}`)
    expect(obligationReason()).toBe(`HTTP 400: ${SCRUB_FAILED_TEXT}`)
    warn.mockRestore()
  })

  it('an unreadable auth_config stores the marker, never the echoed secret', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wire({ id: 5, name: 'Partner', auth_config: '{"body_secrets":' })
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 200,
      body: { status: 'SUCCESS', echo: 'S3CRET' }
    } as never)
    await run()
    expect(storedResponse()).toBe(SCRUB_FAILED_TEXT)
    warn.mockRestore()
  })

  it('readable with the secret: the echo is stored as its placeholder', async () => {
    wire({
      id: 5,
      name: 'Partner',
      auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET' } })
    })
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 200,
      body: { status: 'SUCCESS', echo: 'S3CRET' }
    } as never)
    await run()
    expect(storedResponse()).toContain(REAL)
    expect(storedResponse()).not.toContain('S3CRET')
  })
})

describe('erp_submit — the stored REQUEST is scrubbed too (army v3 round 2)', () => {
  // An admin re-inlined the token VALUE into the template instead of its placeholder.
  const inlined = {
    ...action,
    payload_template: '{"auth":"S3CRET","note":"{{ record.status }}"}'
  }
  const withSecret = {
    id: 5,
    name: 'Partner',
    auth_config: JSON.stringify({ body_secrets: { token: 'S3CRET' } })
  }
  const run = (a: Record<string, unknown> = inlined) =>
    runTransitionActions({
      transition: { id: 't1', label: 'Submit', actions: JSON.stringify([a]) } as never,
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: { key: 'submitted', label: 'Submitted' },
      userId: null
    })
  const storedPayload = () =>
    JSON.parse(String(inserts.find((i) => i.table === 'nivaro_erp_submissions')?.row.payload)) as {
      body: Record<string, unknown> | null
      secret_paths: string[]
    }

  it('an inlined secret value is stored as its placeholder, at a recorded secret path', async () => {
    wire(withSecret)
    await run()
    // Sent as authored (the partner gets what the template says) …
    const sent = vi.mocked(callExternalApi).mock.calls[0][1] as { body: Record<string, unknown> }
    expect(sent.body.auth).toBe('S3CRET')
    // … but never stored as the value.
    const stored = storedPayload()
    expect(JSON.stringify(stored)).not.toContain('S3CRET')
    expect(stored.body).toEqual({ auth: REAL, note: 'open' })
    expect(stored.secret_paths).toEqual(['/auth'])
    // A resend substitutes it back exactly where the first send carried it.
    const resent = substituteBodySecrets(
      restrictPlaceholders(stored.body, stored.secret_paths),
      { token: 'S3CRET' },
      'Partner'
    )
    expect(resent).toEqual(sent.body)
  })

  it('a record field echoing a forged placeholder stays inert in the stored body', async () => {
    wire(withSecret)
    await run(action)
    const stored = storedPayload()
    expect(stored.secret_paths).toEqual(['/auth'])
    expect(stored.body?.plain).toBe(`x ${NEUTRAL} y`)
  })

  it('an API without body secrets stores the body unchanged', async () => {
    wire()
    await run()
    expect(storedPayload()).toEqual({
      endpoint_path: '/orders',
      body: { auth: 'S3CRET', note: 'open' },
      secret_paths: []
    })
  })

  it('secrets that cannot be read: no body is stored (never the value, never a resendable stand-in)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    wire({ id: 5, name: 'Partner', auth_config: '{"body_secrets":' })
    await run()
    const stored = storedPayload()
    expect(stored.body).toBeNull()
    expect(stored.secret_paths).toEqual([])
    warn.mockRestore()
  })

  it('the preview shows the scrubbed body, matching what was stored', async () => {
    wire(withSecret)
    const out = await previewErpActions({
      transition: { id: 't1', label: 'Submit', actions: JSON.stringify([inlined]) },
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: { key: 'submitted', label: 'Submitted' },
      userId: null
    })
    expect(out[0].body).toEqual({ auth: REAL, note: 'open' })
  })
})
