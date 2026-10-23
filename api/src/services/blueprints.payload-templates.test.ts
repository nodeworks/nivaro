import { afterEach, describe, expect, it, vi } from 'vitest'

// Blueprints carry the payload templates their transitions reference (payload_template_key):
// export bundles each one's PUBLISHED body + metadata; install brings them in as drafts only
// (services/payload-templates installTemplateDraft) — never a published version.

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('./payload-templates/index.js', () => ({
  getTemplate: vi.fn(),
  installTemplateDraft: vi.fn()
}))

import { db } from '../db/index.js'
import { exportBlueprint, installBlueprint } from './blueprints.js'
import { getTemplate, installTemplateDraft } from './payload-templates/index.js'

let inserts: Array<{ table: string; row: Record<string, unknown> }> = []

function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'orWhereIn', 'orderBy']) b[m] = vi.fn(() => b)
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    b.insert = vi.fn((row: Record<string, unknown>) => {
      inserts.push({ table, row })
      return Promise.resolve([1])
    })
    // biome-ignore lint/suspicious/noThenProperty: deliberately thenable
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(res, rej)
    return b
  })
  return fn
}

const TEMPLATE_ROW = {
  id: 3,
  key: 'mwf-workflow-status',
  label: 'MWF workflow status',
  description: 'Status pushes',
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  collection: 'workflows',
  owner: 'efp-ops',
  draft_mode: 'map',
  draft_body: '{"v":1,"fields":[{"draft":true}]}',
  draft_rev: 4,
  published_mode: 'map',
  published_body: '{"v":1,"fields":[]}',
  published_version: 7,
  locked_keys: ['efp_state'],
  lookups: { wh: { collection: 'warehouses' } }
}

const BUNDLE = {
  key: 'mwf-workflow-status',
  label: 'MWF workflow status',
  description: 'Status pushes',
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  collection: 'workflows',
  mode: 'map',
  body: '{"v":1,"fields":[]}',
  locked_keys: ['efp_state'],
  lookups: { wh: { collection: 'warehouses' } }
}

afterEach(() => vi.clearAllMocks())

describe('blueprint payload templates', () => {
  it('export bundles the published body of every referenced template once', async () => {
    const actions = (key: string | null) =>
      JSON.stringify([
        { type: 'erp_submit', payload_template_key: key, endpoint_path: '/x' },
        { type: 'erp_submit', payload_template: '{}' }
      ])
    vi.mocked(db).mockImplementation(
      fakeDb({
        nivaro_collections: [{ collection: 'workflows' }],
        nivaro_workflow_bindings: [{ id: 1, template: 'tpl-1', collection: 'workflows' }],
        nivaro_workflow_templates: [{ id: 'tpl-1', name: 'Flow' }],
        nivaro_workflow_transitions: [
          { id: 'a', actions: actions('mwf-workflow-status') },
          { id: 'b', actions: actions('mwf-workflow-status') },
          { id: 'c', actions: actions('never-published') },
          { id: 'd', actions: 'not json' }
        ]
      }) as never
    )
    vi.mocked(getTemplate).mockImplementation(async (key: string) =>
      key === 'mwf-workflow-status'
        ? (TEMPLATE_ROW as never)
        : ({ ...TEMPLATE_ROW, key, published_body: null, published_mode: null } as never)
    )
    const bp = await exportBlueprint('X', ['workflows'])
    // The transition's action JSON rides untouched, payload_template_key included.
    expect(String(bp.workflows[0].transitions[0].actions)).toContain('mwf-workflow-status')
    expect(bp.payload_templates).toEqual([BUNDLE])
    expect(vi.mocked(getTemplate)).toHaveBeenCalledTimes(2)
  })

  it('install upserts templates as drafts before the workflows and reports each', async () => {
    inserts = []
    vi.mocked(db).mockImplementation(fakeDb({}) as never)
    const order: string[] = []
    vi.mocked(installTemplateDraft).mockImplementation(async (b) => {
      order.push(`template:${b.key}`)
      if (b.key === 'bad') throw new Error('Mode can only change through Convert to Liquid')
      return b.key === 'new-one' ? 'created' : b.key === 'same' ? 'unchanged' : 'drafted'
    })
    vi.mocked(db).mockImplementation(((table: string) => {
      if (table === 'nivaro_workflow_templates') order.push('workflow')
      return fakeDb({})(table)
    }) as never)
    const report = await installBlueprint(
      {
        type: 'nivaro-blueprint',
        version: 1,
        name: 'X',
        exported_at: '2026-10-22T00:00:00.000Z',
        collections: [],
        relations: [],
        workflows: [
          {
            template: { id: 'tpl-1' },
            states: [],
            transitions: [{ id: 'a', actions: '[{"payload_template_key":"new-one"}]' }],
            bindings: []
          }
        ],
        layouts: [],
        queues: [],
        rules: [],
        payload_templates: [
          { ...BUNDLE, key: 'new-one' },
          { ...BUNDLE, key: 'mwf-workflow-status' },
          { ...BUNDLE, key: 'same' },
          { ...BUNDLE, key: 'bad' }
        ] as never
      },
      'user-1'
    )
    expect(order.indexOf('template:bad')).toBeLessThan(order.indexOf('workflow'))
    expect(vi.mocked(installTemplateDraft).mock.calls[0][1]).toBe('user-1')
    expect(vi.mocked(installTemplateDraft).mock.calls[0][2]).toBe(
      'Draft installed from blueprint X'
    )
    expect(report.payload_templates).toEqual({ created: 1, drafted: 1, skipped: 1 })
    expect(report.errors).toEqual([
      'payload template bad: Mode can only change through Convert to Liquid'
    ])
  })

  it('a blueprint without payload templates installs as before', async () => {
    vi.mocked(db).mockImplementation(fakeDb({}) as never)
    const report = await installBlueprint(
      {
        type: 'nivaro-blueprint',
        version: 1,
        name: 'Old',
        exported_at: '2026-01-01T00:00:00.000Z',
        collections: [],
        relations: [],
        workflows: [],
        layouts: [],
        queues: [],
        rules: []
      },
      null
    )
    expect(installTemplateDraft).not.toHaveBeenCalled()
    expect(report.payload_templates).toEqual({ created: 0, drafted: 0, skipped: 0 })
    expect(report.errors).toEqual([])
  })
})
