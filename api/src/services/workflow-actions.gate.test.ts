import { afterEach, describe, expect, it, vi } from 'vitest'

// The one gate the push and the preview share (erpActionGate), and the system-table refusal in
// context queries (buildContext).

vi.mock('../db/index.js', () => ({ db: vi.fn() }))

import { db } from '../db/index.js'
import { buildContext, erpActionGate, erpActionGateDetail } from './workflow-actions.js'

afterEach(() => vi.clearAllMocks())

const base = {
  type: 'erp_submit',
  external_api: 'Partner',
  endpoint_path: '/x',
  payload_template_key: 'mwf-workflow-status'
}

describe('erpActionGate', () => {
  it('passes a configured action whose gates all hold', () => {
    expect(erpActionGate(base, { status: 'open' }, {})).toBeNull()
  })

  it('not_configured accepts a template key or inline Liquid, names the first missing field', () => {
    expect(erpActionGate({ ...base, payload_template_key: '' }, {}, {})).toBe(
      'not configured: payload_template missing on the action'
    )
    expect(
      erpActionGate({ ...base, payload_template_key: undefined, payload_template: '{}' }, {}, {})
    ).toBeNull()
    expect(erpActionGate({ ...base, endpoint_path: '' }, {}, {})).toBe(
      'not configured: endpoint_path missing on the action'
    )
    // A resolved api id judges the api (a name that did not resolve = not configured).
    expect(erpActionGate(base, {}, {}, { apiId: null })).toBe(
      'not configured: external_api missing on the action'
    )
    expect(erpActionGate(base, {}, {}, { apiId: 5 })).toBeNull()
  })

  it('checks in the push order and returns the recorded reason text', () => {
    const action = {
      ...base,
      skip_when_empty: 'lines',
      skip_unless_any: ['record.ext_id', 'context.link.0.ext_id'],
      guard: [{ field: 'status', op: 'eq', value: 'open' }]
    }
    // Missing api beats every other gate.
    expect(erpActionGateDetail({ ...action, external_api: '' }, {}, {})?.kind).toBe(
      'not_configured'
    )
    expect(erpActionGate(action, {}, { lines: [] })).toBe('skip_when_empty: lines empty')
    expect(erpActionGate(action, { ext_id: ' ' }, { lines: [1] })).toBe(
      'skip_unless_any: none of record.ext_id, context.link.0.ext_id is set'
    )
    const guard = erpActionGateDetail(
      action,
      { status: 'closed' },
      { lines: [1], link: [{ ext_id: 'E' }] }
    )
    expect(guard).toMatchObject({ kind: 'guard', reason: 'guard unmet: status eq "open"' })
    expect(guard?.rule?.field).toBe('status')
    expect(erpActionGate(action, { status: 'open', ext_id: 'X' }, { lines: [1] })).toBeNull()
  })
})

describe('buildContext', () => {
  it('refuses nivaro_* and directus_* collections except nivaro_users', async () => {
    const rows = [{ id: 1 }]
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereNull', 'whereIn', 'orderBy']) b[m] = vi.fn(() => b)
    b.limit = vi.fn(() => Promise.resolve(rows))
    vi.mocked(db).mockImplementation((() => b) as never)
    const out = await buildContext(
      {
        a: { collection: 'directus_users' },
        b: { collection: 'DIRECTUS_files' },
        c: { collection: 'nivaro_settings' },
        d: { collection: 'nivaro_users' },
        e: { collection: 'orders' }
      },
      'o1',
      {}
    )
    expect(Object.keys(out).sort()).toEqual(['d', 'e'])
    expect(vi.mocked(db).mock.calls.map((c) => c[0])).toEqual(['nivaro_users', 'orders'])
  })
})
