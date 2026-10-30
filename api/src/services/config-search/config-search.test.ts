import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: {} }))

import {
  parseRewrite,
  type RewriteDeps,
  rewriteSystemPrompt,
  rewriteUserPrompt
} from './ai-rewrite.js'
import { acronym, buildConfigDocs, type ConfigDoc, type ConfigSources } from './builders.js'
import { forgetConfigIndex, searchConfig } from './index.js'
import { prepareIndex, queryTerms, rankConfig } from './rank.js'

const SOURCES: ConfigSources = {
  collections: [
    { collection: 'inventory_request', display_name: 'Inventory Request', note: null },
    { collection: 'purchase_orders', display_name: 'Purchase Orders' },
    { collection: 'nivaro_users', display_name: 'Users' }
  ],
  fields: [
    {
      collection: 'purchase_orders',
      field: 'zone',
      label: 'Zone',
      required: true,
      validation_rules: JSON.stringify([{ type: 'min_length', value: 1 }])
    },
    {
      collection: 'purchase_orders',
      field: 'division',
      label: 'Division',
      dependency_config: JSON.stringify({
        cascade_filters: [{ parent_field: 'zone', filter_column: 'zone_id' }]
      })
    },
    { collection: 'inventory_request', field: 'site', label: 'Site' },
    { collection: 'nivaro_users', field: 'email', label: 'Email' }
  ],
  layouts: [{ id: 7, collection: 'inventory_request', name: 'IR intake', is_active: true }],
  assignments: [
    { layout_id: 7, field: 'site', label_override: null, overrides: null, is_visible: true },
    {
      layout_id: 7,
      field: 'needed_by',
      label_override: 'Needed by',
      overrides: JSON.stringify({ required: true }),
      is_visible: true
    }
  ],
  groups: [{ layout_id: 7, label: 'Shipping' }],
  templates: [{ id: 'T1', name: 'IR approval' }],
  states: [{ id: 'S1', template: 'T1', key: 'review', label: 'Manager review' }],
  transitions: [{ template: 'T1', to_state: 'S1', label: 'Send for review' }],
  bindings: [{ template: 'T1', collection: 'inventory_request' }],
  flows: [
    {
      id: 'F1',
      name: 'Fusion push',
      status: 'active',
      trigger: 'event',
      trigger_options: JSON.stringify({ collections: ['inventory_request'] })
    }
  ],
  operations: [
    {
      flow: 'F1',
      name: 'Send to Fusion',
      type: 'external-api',
      options: JSON.stringify({
        mode: 'predefined',
        api_id: 3,
        endpoint: 'create-ir',
        body: '{"x":"{{secret}}"}'
      })
    }
  ],
  externalApis: [{ id: 3, name: 'Fusion', description: 'Oracle Fusion ERP' }],
  endpoints: [{ id: 11, api_id: 3, name: 'Create inventory request', slug: 'create-ir' }],
  fieldRules: [
    {
      id: 21,
      collection: 'purchase_orders',
      trigger_field: 'division',
      trigger_op: 'eq',
      target_field: 'zone',
      target_type: 'set',
      is_active: true
    }
  ],
  alerts: [
    { id: 31, name: 'Late POs', category: 'sla', collection: 'purchase_orders', field: 'due' }
  ],
  rules: [
    { id: 41, name: 'Escalate', collection: 'purchase_orders', trigger: 'update', actions: '[]' }
  ],
  queues: [{ id: 'Q1', name: 'Buyer queue' }],
  queueSources: [{ queue_id: 'Q1', collection: 'purchase_orders' }],
  dashboards: [{ id: 'D1', name: 'Ops board' }],
  widgets: [{ dashboard: 'D1', title: 'Open IRs', collection: 'inventory_request' }],
  reports: [{ id: 'R1', name: 'Spend report' }],
  customQueries: [{ id: 51, name: 'Open POs by buyer', slug: 'open-pos' }],
  payloadTemplates: [
    {
      key: 'fusion-ir',
      label: 'Fusion IR body',
      external_api: 'Fusion',
      collection: 'inventory_request'
    }
  ],
  importDefinitions: [{ key: 'po_lines', label: 'PO lines' }],
  webhooks: [{ id: 61, name: 'Notify vendor portal', collections: '["purchase_orders"]' }],
  roles: [{ id: 'RL1', name: 'Buyer', admin_access: false }],
  policies: [{ role: 'RL1', collection: 'purchase_orders', action: 'update' }]
}

const docs = buildConfigDocs(SOURCES)
const find = (kind: string, id: string) =>
  docs.find((d) => d.kind === kind && d.id === id) as ConfigDoc

describe('config index builders', () => {
  it('links every kind to its exact screen', () => {
    expect(find('collection', 'purchase_orders').href).toBe(
      '/data-model/purchase_orders?tab=settings'
    )
    expect(find('field', 'purchase_orders.zone').href).toBe(
      '/data-model/purchase_orders?tab=fields&field=zone'
    )
    expect(find('validation', 'purchase_orders.zone').label).toBe('Zone is required')
    expect(find('cascade', 'purchase_orders.division').label).toBe('Division filtered by Zone')
    expect(find('layout', '7').href).toBe('/data-model/inventory_request?tab=groups&layout=7')
    expect(find('pipeline', 'T1').href).toBe('/pipelines/T1')
    expect(find('flow', 'F1').href).toBe('/flows/F1')
    expect(find('field_rule', '21').href).toBe('/data-model/purchase_orders?tab=rules')
    expect(find('alert', '31').href).toBe('/alerts/31')
    expect(find('rule', '41').href).toBe('/rules/41')
    expect(find('queue', 'Q1').href).toBe('/queues/Q1')
    expect(find('dashboard', 'D1').href).toBe('/dashboards/D1')
    expect(find('report', 'R1').href).toBe('/report-studio/R1')
    expect(find('custom_query', '51').href).toBe('/custom-queries/51')
    expect(find('external_api', '3').href).toBe('/external-apis/3')
    expect(find('payload_template', 'fusion-ir').href).toBe('/external-apis/3/payloads/fusion-ir')
    expect(find('import_definition', 'po_lines').href).toBe('/imports?definition=po_lines')
    expect(find('webhook', '61').href).toBe('/webhooks/61')
    expect(find('role', 'RL1').href).toBe('/roles?role=RL1')
    expect(find('setting', 'email').href).toBe('/settings?section=email')
  })

  it('names the parts: placements, states, steps with endpoint names, policies', () => {
    expect(find('layout', '7').details).toEqual(
      expect.arrayContaining(['Shipping', 'Site', 'Needed by (required on this form)'])
    )
    expect(find('pipeline', 'T1').details).toEqual([
      'Manager review',
      'Send for review → Manager review'
    ])
    expect(find('flow', 'F1').details).toContain('Fusion: Create inventory request')
    expect(find('flow', 'F1').snippet).toContain('event trigger on Inventory Request')
    expect(find('role', 'RL1').details).toEqual(['Purchase Orders: update'])
    expect(find('field_rule', '21').label).toBe('Sets Zone when Division is')
  })

  it('skips system collections and never carries a body, secret or value', () => {
    expect(docs.some((d) => d.collection === 'nivaro_users')).toBe(false)
    const text = JSON.stringify(docs)
    expect(text).not.toContain('{{secret}}')
    expect(text).not.toContain('predefined')
  })

  it('keeps every stored config admin-only; personal screens are for everyone', () => {
    expect(docs.filter((d) => !d.adminOnly).every((d) => d.kind === 'screen')).toBe(true)
    expect(docs.some((d) => d.kind === 'screen')).toBe(true)
  })

  it('makes acronyms of multi-word names', () => {
    expect(acronym('Inventory Request')).toBe('ir')
    expect(acronym('purchase_orders')).toBe('po')
    expect(acronym('Fusion')).toBeNull()
  })
})

describe('config ranking', () => {
  const index = prepareIndex(docs)

  it('drops question words and folds plurals', () => {
    expect(queryTerms('Where is the Fusion push for IRs set up?')).toEqual(['fusion', 'push', 'ir'])
  })

  it('finds the Fusion push for IRs', () => {
    const hits = rankConfig(index, 'where is the Fusion push for IRs set up', { isAdmin: true })
    expect(hits[0].doc.kind).toBe('flow')
    expect(hits[0].doc.href).toBe('/flows/F1')
    expect(hits.map((h) => h.doc.kind)).toContain('payload_template')
  })

  it('finds what makes Zone required on POs, one hit per screen', () => {
    const hits = rankConfig(index, 'which rule makes Zone required on POs', { isAdmin: true })
    expect(hits[0].doc.href).toBe('/data-model/purchase_orders?tab=fields&field=zone')
    expect(hits[0].doc.kind).toBe('validation')
    expect(new Set(hits.map((h) => h.doc.href)).size).toBe(hits.length)
  })

  it('names the matched parts in the hit', () => {
    const hits = rankConfig(index, 'needed by intake', { isAdmin: true })
    expect(hits[0].doc.kind).toBe('layout')
    expect(hits[0].matched).toContain('Needed by (required on this form)')
  })

  it('never answers admin-only config to a non-admin', () => {
    const asUser = rankConfig(index, 'fusion push', { isAdmin: false })
    expect(asUser.every((h) => !h.doc.adminOnly)).toBe(true)
    expect(asUser.some((h) => h.doc.kind === 'flow')).toBe(false)
    const mine = rankConfig(index, 'out of office delegate', { isAdmin: false })
    expect(mine.map((h) => h.doc.kind)).toEqual(['screen'])
  })

  it('narrows to the AI kinds / collection when that leaves hits', () => {
    const hits = rankConfig(index, 'zone', { isAdmin: true, kinds: ['field_rule'] })
    expect(hits.map((h) => h.doc.kind)).toEqual(['field_rule'])
  })
})

describe('AI rewrite', () => {
  it('parses strict JSON and drops unknown kinds and collections', () => {
    expect(
      parseRewrite(
        'Sure: {"keywords":["fusion","inventory request"],"kinds":["flow","bogus"],"collection":"INVENTORY_REQUEST"}',
        ['inventory_request']
      )
    ).toEqual({
      keywords: ['fusion', 'inventory request'],
      kinds: ['flow'],
      collection: 'inventory_request'
    })
    expect(
      parseRewrite('{"keywords":["x"],"collection":"secret_table"}', ['a'])?.collection
    ).toBeNull()
    expect(parseRewrite('no json here', [])).toBeNull()
    expect(parseRewrite('{"keywords":[]}', [])).toBeNull()
  })

  it('sends kinds and collection names only — never config rows', () => {
    const user = rewriteUserPrompt('where is it', [
      { collection: 'purchase_orders', display: 'Purchase Orders' }
    ])
    expect(user).toContain('purchase_orders (Purchase Orders)')
    expect(user).not.toContain('Fusion')
    expect(rewriteSystemPrompt()).toContain('payload_template')
  })
})

describe('searchConfig', () => {
  const load = async () => SOURCES
  beforeEach(() => forgetConfigIndex())

  it('keyword answers need no AI', async () => {
    const complete = vi.fn(async () => '{}')
    const out = await searchConfig('Fusion push IR', {
      isAdmin: true,
      ai: true,
      load,
      deps: { complete }
    })
    expect(out.hits[0].href).toBe('/flows/F1')
    expect(out.hits[0].id).toBe('flow:F1')
    expect(out.ai).toBe('not_needed')
    expect(complete).not.toHaveBeenCalled()
  })

  it('rewrites a thin plain-words question once and caches it', async () => {
    const complete = vi.fn(
      async () => '{"keywords":["fusion","push"],"kinds":["flow"],"collection":"inventory_request"}'
    )
    const deps: RewriteDeps = { complete }
    const q = 'how do requisitions get to the ERP'
    const out = await searchConfig(q, { isAdmin: true, ai: true, load, deps })
    expect(out.ai).toBe('used')
    expect(out.rewrite?.kinds).toEqual(['flow'])
    expect(out.hits[0].href).toBe('/flows/F1')
    const prompt = (complete.mock.calls[0] as unknown as [string, string])[1]
    expect(prompt).not.toContain('Fusion push')
    await searchConfig(q, { isAdmin: true, ai: true, load, deps })
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('AI off = keyword answer only', async () => {
    const out = await searchConfig('how do requisitions get to the ERP', {
      isAdmin: true,
      ai: true,
      load,
      deps: { complete: async () => null }
    })
    expect(out.ai).toBe('off')
    expect(out.rewrite).toBeNull()
  })

  it('a failing call falls back to the keywords', async () => {
    const out = await searchConfig('how do requisitions get to the ERP', {
      isAdmin: true,
      ai: true,
      load,
      deps: {
        complete: async () => {
          throw new Error('gateway down')
        }
      }
    })
    expect(out.ai).toBe('failed')
  })

  it('never calls the AI for a non-admin and never shows them admin config', async () => {
    const complete = vi.fn(async () => '{"keywords":["fusion"]}')
    const spyLoad = vi.fn(load)
    const out = await searchConfig('how do requisitions get to the ERP fusion', {
      isAdmin: false,
      ai: true,
      load: spyLoad,
      deps: { complete }
    })
    expect(out.ai).toBe('admin_only')
    expect(out.hits).toEqual([])
    expect(complete).not.toHaveBeenCalled()
    // A non-admin search never loads the config tables at all.
    expect(spyLoad).not.toHaveBeenCalled()
    const mine = await searchConfig('my out of office delegate', {
      isAdmin: false,
      ai: false,
      load: spyLoad
    })
    expect(mine.hits.map((h) => h.href)).toEqual(['/profile'])
  })
})
