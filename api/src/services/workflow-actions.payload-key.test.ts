import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// erp_submit actions may name a saved payload template (`payload_template_key`, spec 2026-10-22
// §6.2). The key wins over the inline Liquid `payload_template`; the template's `lookups` are
// context query defs merged under the action's own `context` (action keys win). Every gate and
// side effect matches the inline path: a render failure is a recorded failed submission and a
// failed obligation, and nothing is sent. Runs the real template service over a fake db.

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('./activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('./integration-remediation.js', () => ({ classifyError: vi.fn(() => 'unknown') }))
vi.mock('./external-apis.js', () => ({
  callExternalApi: vi.fn(async () => ({ status: 200, body: { status: 'SUCCESS' }, ok: true }))
}))
vi.mock('./integration-obligations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./integration-obligations.js')>()
  return {
    ...actual,
    openObligationForTrigger: vi.fn(async () => 77),
    resolveObligation: vi.fn(async () => undefined)
  }
})

// The record-form preview (integration-preview) reads the record for conditions this way.
vi.mock('./workflow-conditions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workflow-conditions.js')>()),
  fetchRecordForConditions: vi.fn(async () => ({ ...RECORD }))
}))

import { db } from '../db/index.js'
import { callExternalApi } from './external-apis.js'
import { resolveObligation } from './integration-obligations.js'
import { outboundPreview } from './integration-preview.js'
import { bustPayloadTemplateCache } from './payload-templates/index.js'
import { previewErpActions, runTransitionActions } from './workflow-actions.js'

const KEY = 'mwf-workflow-status'
const REAL = '⟦nvr-secret:token⟧'
const NEUTRAL = '⟦nvr-secret​:token⟧'

const RECORD = { id: 'o1', status: 'open', title: `x ${REAL} y`, code: 'TOOLONG' }

const field = (id: string, key: string, value: Record<string, unknown>, extra = {}) => ({
  id,
  key,
  type: 'text',
  value,
  include: 'always',
  ...extra
})

/** A published map: the state, a lookup row, an action-context row, a record field, a secret. */
const MAP = {
  v: 1,
  fields: [
    field('f1', 'efp_state', { source: 'path', path: 'state.key' }),
    field('f2', 'warehouse', { source: 'path', path: 'context.wh[0].code' }),
    field('f3', 'shared', { source: 'path', path: 'context.shared[0].code' }),
    field('f4', 'title', { source: 'path', path: 'record.title' }),
    field('f5', 'auth', { source: 'secret', name: 'token' })
  ]
}

const LOOKUPS = {
  wh: { collection: 'warehouses' },
  // The action's own `shared` context def wins over this one.
  shared: { collection: 'warehouses' }
}

type TemplateRow = Record<string, unknown>

const published = (body: unknown, extra: TemplateRow = {}): TemplateRow => ({
  id: 9,
  key: KEY,
  label: 'MWF workflow status',
  collection: 'orders',
  external_api: null,
  locked_keys: '["efp_state"]',
  lookups: JSON.stringify(LOOKUPS),
  published_mode: 'map',
  published_body: JSON.stringify(body),
  published_version: 7,
  ...extra
})

const INLINE = '{"inline":true,"title":"{{ record.title }}"}'

const keyAction = (extra: Record<string, unknown> = {}) => ({
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/workflow-status',
  context: { shared: { collection: 'regions' } },
  payload_template_key: KEY,
  ...extra
})

let inserts: Array<{ table: string; row: Record<string, unknown> }> = []
let reads: string[] = []

function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((spec: string) => {
    const table = spec.split(/\s+as\s+/)[0]
    reads.push(table)
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit', 'orWhere', 'leftJoin'])
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

function wire(
  template: TemplateRow | null,
  extra: Record<string, Array<Record<string, unknown>>> = {}
) {
  inserts = []
  reads = []
  const fake = fakeDb({
    nivaro_external_apis: [{ id: 5, name: 'Partner' }],
    nivaro_users: [
      {
        id: 'u1',
        email: 'ada@example.com',
        first_name: 'Ada',
        last_name: 'Lovelace',
        employee_id: 'E1'
      }
    ],
    nivaro_action_journal: [],
    nivaro_erp_submissions: [],
    nivaro_payload_templates: template ? [template] : [],
    orders: [RECORD],
    warehouses: [{ id: 1, code: 'W1' }],
    regions: [{ id: 2, code: 'R2' }],
    ...extra
  })
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
}

const transition = (actions: unknown[]) => ({
  id: 't1',
  label: 'Submit',
  actions: JSON.stringify(actions)
})

const run = (actions: unknown[]) =>
  runTransitionActions({
    transition: transition(actions),
    instance: { collection: 'orders', item: 'o1' },
    newStateObj: { key: 'submitted', label: 'Submitted' },
    userId: null
  })

const preview = (actions: unknown[]) =>
  previewErpActions({
    transition: transition(actions),
    instance: { collection: 'orders', item: 'o1' },
    newStateObj: { key: 'submitted', label: 'Submitted' },
    userId: null
  })

const submission = () => {
  const sub = inserts.find((i) => i.table === 'nivaro_erp_submissions')
  expect(sub).toBeDefined()
  return {
    row: sub?.row as Record<string, unknown>,
    payload: JSON.parse(String(sub?.row.payload)) as {
      endpoint_path: string
      body: Record<string, unknown> | null
      secret_paths: string[]
    }
  }
}

const EXPECTED_BODY = {
  efp_state: 'submitted',
  warehouse: 'W1',
  shared: 'R2',
  title: `x ${NEUTRAL} y`,
  auth: REAL
}

beforeEach(() => bustPayloadTemplateCache())
afterEach(() => vi.clearAllMocks())

describe('erp_submit payload_template_key', () => {
  it('key wins over inline template', async () => {
    wire(published(MAP))
    await run([keyAction({ payload_template: INLINE })])

    expect(callExternalApi).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(callExternalApi).mock.calls[0][1] as {
      path: string
      body: Record<string, unknown>
      bodySecrets?: boolean
    }
    expect(opts.path).toBe('/workflow-status')
    expect(opts.bodySecrets).toBe(true)
    // Template lookups feed `context`; the action's own `shared` def wins; record text cannot
    // forge a placeholder; only the template's secret slot is real.
    expect(opts.body).toEqual(EXPECTED_BODY)

    const { row, payload } = submission()
    expect(row.status).toBe('accepted')
    expect(payload.endpoint_path).toBe('/workflow-status')
    expect(payload.body).toEqual(EXPECTED_BODY)
    expect(payload.secret_paths).toEqual(['/auth'])
    expect(vi.mocked(resolveObligation).mock.calls.at(-1)?.[1]).toMatchObject({ outcome: 'sent' })
  })

  it('preview renders the published template', async () => {
    wire(published(MAP))
    const out = await preview([keyAction()])
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('would_push')
    expect(out[0].body).toEqual(EXPECTED_BODY)
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('unpublished template key fails the push with a recorded reason', async () => {
    wire(
      published(MAP, {
        published_mode: null,
        published_body: null,
        published_version: null
      })
    )
    await run([keyAction()])

    expect(callExternalApi).not.toHaveBeenCalled()
    const { row, payload } = submission()
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe("Payload template 'mwf-workflow-status' has no published version")
    expect(payload.body).toBeNull()
    expect(payload.endpoint_path).toBe('/workflow-status')
    const resolved = vi.mocked(resolveObligation).mock.calls.at(-1)
    expect(resolved?.[0]).toBe(77)
    expect(resolved?.[1]).toMatchObject({
      outcome: 'failed',
      reason:
        "payload template error: Payload template 'mwf-workflow-status' has no published version"
    })
  })

  it('rule failure fails the push and names the key', async () => {
    const withRule = {
      v: 1,
      fields: [
        field('f1', 'efp_state', { source: 'path', path: 'state.key' }),
        field('f2', 'code', { source: 'path', path: 'record.code' }, { rules: { max_length: 3 } })
      ]
    }
    wire(published(withRule))
    await run([keyAction()])

    expect(callExternalApi).not.toHaveBeenCalled()
    const { row } = submission()
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe(
      "Payload template 'mwf-workflow-status' v7 cannot be sent: code: code is 7 characters; the most allowed is 3"
    )
    expect(vi.mocked(resolveObligation).mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: 'failed'
    })

    // The preview reports the same failure instead of a body.
    vi.clearAllMocks()
    wire(published(withRule))
    const out = await preview([keyAction()])
    expect(out[0].status).toBe('template_error')
    expect(out[0].reason).toContain("Payload template 'mwf-workflow-status' v7 cannot be sent")
    expect(out[0].body).toBeNull()
  })

  it('an unknown key fails the push the same way', async () => {
    wire(null)
    await run([keyAction()])
    expect(callExternalApi).not.toHaveBeenCalled()
    const { row } = submission()
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe("Payload template 'mwf-workflow-status' does not exist")
  })

  it('the not_configured gate accepts either; neither is still not configured', async () => {
    wire(published(MAP))
    const res = await run([keyAction({ payload_template_key: '  ' })])
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(res.skippedReason).toBe('not configured: payload_template missing on the action')
    const out = await preview([keyAction({ payload_template_key: undefined })])
    expect(out[0].status).toBe('not_configured')
  })

  it('the push scope carries the acting user and the state external label', async () => {
    const who = {
      v: 1,
      fields: [
        field('f0', 'efp_state', { source: 'path', path: 'state.key' }),
        field('f1', 'by', { source: 'builtin', name: 'acting_user.name' }),
        field('f2', 'email', { source: 'builtin', name: 'acting_user.email' }),
        field('f3', 'emp', { source: 'builtin', name: 'acting_user.employee_id' }),
        field('f4', 'ext', { source: 'builtin', name: 'state.external_label' })
      ]
    }
    const state = { key: 'submitted', label: 'Submitted', external_label: 'SUBMITTED_EXT' }
    wire(published(who))
    await runTransitionActions({
      transition: transition([keyAction()]),
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: state,
      userId: 'u1'
    })
    const body = (vi.mocked(callExternalApi).mock.calls[0][1] as { body: unknown }).body
    expect(body).toEqual({
      efp_state: 'submitted',
      by: 'Ada Lovelace',
      email: 'ada@example.com',
      emp: 'E1',
      ext: 'SUBMITTED_EXT'
    })

    // The preview builds the same scope.
    const out = await previewErpActions({
      transition: transition([keyAction()]),
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: state,
      userId: 'u1'
    })
    expect(out[0].body).toEqual(body)

    // An automatic transition has no acting user.
    vi.clearAllMocks()
    bustPayloadTemplateCache()
    wire(
      published({
        v: 1,
        fields: [
          field('f1', 'efp_state', { source: 'path', path: 'state.key' }),
          field(
            'f2',
            'by',
            { source: 'builtin', name: 'acting_user.email' },
            { include: 'not_empty' }
          )
        ]
      })
    )
    await run([keyAction()])
    expect((vi.mocked(callExternalApi).mock.calls[0][1] as { body: unknown }).body).toEqual({
      efp_state: 'submitted'
    })
    expect(reads).not.toContain('nivaro_users')
  })

  it('inline-only action unchanged', async () => {
    wire(published(MAP))
    const inline = { ...keyAction({ payload_template: INLINE }), payload_template_key: undefined }
    await run([inline])

    expect(callExternalApi).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(callExternalApi).mock.calls[0][1] as {
      body: Record<string, unknown>
      bodySecrets?: boolean
    }
    expect(opts.bodySecrets).toBe(true)
    expect(opts.body).toEqual({ inline: true, title: `x ${NEUTRAL} y` })
    // The template service is never consulted for an inline action.
    expect(reads).not.toContain('nivaro_payload_templates')

    const out = await preview([inline])
    expect(out[0].body).toEqual({ inline: true, title: `x ${NEUTRAL} y` })
  })
})

describe('template API and the record-form preview', () => {
  const STATE = { id: 's1', key: 'submitted', label: 'Submitted', external_label: 'SUBMITTED_EXT' }
  const EXT_MAP = {
    v: 1,
    fields: [
      field('f1', 'efp_state', { source: 'path', path: 'state.key' }),
      field('f2', 'ext', { source: 'builtin', name: 'state.external_label' })
    ]
  }

  it('the record-form preview renders with the state external label, like the push', async () => {
    wire(published(EXT_MAP), {
      nivaro_workflow_instances: [
        { id: 'i1', template: 'p1', current_state: 's0', completed_at: null }
      ],
      nivaro_workflow_states: [STATE],
      nivaro_workflow_transitions: [
        {
          id: 't1',
          label: 'Submit',
          from_state: null,
          to_state: 's1',
          actions: JSON.stringify([keyAction()]),
          auto_trigger: false,
          condition_rules: null,
          requirements: null,
          sort: 1
        }
      ]
    })
    // The push gets the full state row (workflow-transitions.ts passes it as loaded).
    await runTransitionActions({
      transition: transition([keyAction()]),
      instance: { collection: 'orders', item: 'o1' },
      newStateObj: STATE,
      userId: null
    })
    const pushed = (
      vi.mocked(callExternalApi).mock.calls[0][1] as { body: Record<string, unknown> }
    ).body
    expect(pushed).toEqual({ efp_state: 'submitted', ext: 'SUBMITTED_EXT' })

    const preview = await outboundPreview('orders', 'o1', null)
    expect(preview.integrations).toHaveLength(1)
    const shown = Object.fromEntries(
      preview.integrations[0].changes.map((c) => [c.path, c.to] as const)
    )
    expect(shown).toEqual(pushed)
  })

  it('a template for another API fails the push and the preview says the same', async () => {
    const msg =
      "Payload template 'mwf-workflow-status' is for MWF, but this action sends to Partner"
    wire(published(MAP, { external_api: 'MWF' }))
    await run([keyAction()])
    expect(callExternalApi).not.toHaveBeenCalled()
    const { row } = submission()
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe(msg)
    expect(vi.mocked(resolveObligation).mock.calls.at(-1)?.[1]).toMatchObject({
      outcome: 'failed',
      reason: `payload template error: ${msg}`
    })

    const out = await preview([keyAction()])
    expect(out[0].status).toBe('template_error')
    expect(out[0].reason).toBe(`payload template error: ${msg}`)
    expect(out[0].body).toBeNull()
  })

  it('the API names compare case-insensitively', async () => {
    wire(published(MAP, { external_api: ' partner ' }))
    await run([keyAction()])
    expect(callExternalApi).toHaveBeenCalledTimes(1)
  })
})
