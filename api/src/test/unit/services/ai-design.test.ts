import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiClient: vi.fn(),
  getAiModelSettings: vi.fn()
}))

import { parseHelpAnswer } from '../../../services/ai-design/help-text.js'
import {
  type LayoutModel,
  mergeAiFindings,
  parseLayoutAnswer,
  planLayoutFix,
  reviewLayout,
  reviewLayoutRules,
  STEP_FIELD_LIMIT
} from '../../../services/ai-design/layout-review.js'
import { parseJsonLoose } from '../../../services/ai-design/model.js'
import {
  normalizeRoleProposal,
  proposalHash,
  type RoleCatalog,
  relevantCollections,
  simulateRoleProposal
} from '../../../services/ai-design/role-design.js'
import {
  applyViewsAnswer,
  buildSuggestions,
  clusterRoleFilters,
  conditionSignature,
  dropCovered,
  type FilterUse,
  parseItemsRequest,
  type RoleViewContext,
  toActiveFilters
} from '../../../services/ai-design/role-views.js'

const field = (name: string, extra: Partial<LayoutModel['fields'][number]> = {}) => ({
  field: name,
  group_key: 'main',
  sort: 1,
  label: name.replace(/_/g, ' '),
  type: 'string',
  interface: null,
  required: false,
  hidden: false,
  readonly: false,
  has_help: true,
  has_rules: false,
  choices: [],
  derived: false,
  ...extra
})

function layout(fields: LayoutModel['fields'], groups?: LayoutModel['groups']): LayoutModel {
  return {
    layout: { id: 7, name: 'Default', collection: 'orders', layout_type: 'grouped' },
    groups: groups ?? [
      {
        id: 1,
        key: 'main',
        label: 'Main',
        type: 'section',
        is_collapsed: false,
        container_id: null,
        sort: 1,
        has_content: false
      },
      {
        id: 2,
        key: 'more',
        label: 'More',
        type: 'section',
        is_collapsed: true,
        container_id: null,
        sort: 2,
        has_content: false
      }
    ],
    fields
  }
}

describe('parseJsonLoose', () => {
  it('reads a fenced object and ignores prose', () => {
    expect(parseJsonLoose('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(parseJsonLoose('no json here')).toBeNull()
    expect(parseJsonLoose('[1,2]')).toBeNull()
  })
})

describe('layout review rules (#1920)', () => {
  it('flags required fields in collapsed sections, hidden required fields, and missing help', () => {
    const m = layout([
      field('po_number', { group_key: 'more', required: true, has_help: false }),
      field('vendor', { required: true, hidden: true }),
      field('notes')
    ])
    const kinds = reviewLayoutRules(m).map((f) => `${f.kind}:${f.field ?? f.group?.key}`)
    expect(kinds).toContain('required_in_collapsed:po_number')
    expect(kinds).toContain('required_hidden:vendor')
    expect(kinds).toContain('missing_help:po_number')
    const collapsed = reviewLayoutRules(m).find((f) => f.kind === 'required_in_collapsed')
    expect(collapsed?.fix).toEqual({ type: 'expand_section', group_id: 2 })
  })

  it('flags a crowded step and suggests moving the overflow to the emptiest sibling', () => {
    const groups: LayoutModel['groups'] = [
      {
        id: 1,
        key: 's1',
        label: 'Step 1',
        type: 'tab',
        is_collapsed: false,
        container_id: null,
        sort: 1,
        has_content: false
      },
      {
        id: 2,
        key: 's2',
        label: 'Step 2',
        type: 'tab',
        is_collapsed: false,
        container_id: null,
        sort: 2,
        has_content: false
      }
    ]
    const fs = Array.from({ length: STEP_FIELD_LIMIT + 2 }, (_, i) =>
      field(`f${i}`, { group_key: 's1', sort: i })
    )
    const f = reviewLayoutRules(layout(fs, groups)).find((x) => x.kind === 'too_many_fields')
    expect(f?.field).toBe(`f${STEP_FIELD_LIMIT}`)
    expect(f?.fix).toEqual({
      type: 'move_field',
      field: `f${STEP_FIELD_LIMIT}`,
      to_group_key: 's2'
    })
  })

  it('flags duplicate labels and empty sections', () => {
    const m = layout([field('a', { label: 'Date' }), field('b', { label: 'date' })])
    const kinds = reviewLayoutRules(m).map((f) => f.kind)
    expect(kinds).toContain('duplicate_label')
    expect(kinds).toContain('empty_section')
  })

  it('keeps only model answers that name fields on the layout', () => {
    const m = layout([
      field('po_number', { required: true, has_help: false }),
      field('amt', { label: 'Amt' })
    ])
    const wanted = [m.fields[0]]
    const answer = parseLayoutAnswer(
      JSON.stringify({
        help: [
          { field: 'po_number', text: 'The purchase order number from the supplier.' },
          { field: 'ghost', text: 'nope' }
        ],
        labels: [
          { field: 'amt', problem: 'Abbreviation', suggested_label: 'Amount' },
          { field: 'nope', problem: 'x', suggested_label: 'y' }
        ]
      }),
      m,
      wanted
    )
    expect([...answer.help.keys()]).toEqual(['po_number'])
    expect(answer.labels.map((l) => l.field)).toEqual(['amt'])
    const merged = mergeAiFindings(reviewLayoutRules(m), m, answer)
    expect(merged.find((f) => f.kind === 'missing_help')?.fix).toEqual({
      type: 'help_text',
      field: 'po_number',
      text: 'The purchase order number from the supplier.'
    })
    expect(merged.find((f) => f.kind === 'confusing_label')?.fix).toEqual({
      type: 'label',
      field: 'amt',
      text: 'Amount'
    })
  })

  it('falls back to the rule findings when the model throws', async () => {
    const m = layout([field('x', { required: true, has_help: false })])
    const r = await reviewLayout(m, async () => {
      throw new Error('gateway down')
    })
    expect(r.ai_used).toBe(false)
    expect(r.ai_error).toBe('gateway down')
    expect(r.findings.length).toBeGreaterThan(0)
  })
})

describe('applying a layout finding (#1964)', () => {
  const m = layout([
    field('po_number', { group_key: 'more', required: true }),
    field('vendor', { hidden: true })
  ])

  it('plans each fix against the layout as it is now', () => {
    const exp = planLayoutFix(m, { type: 'expand_section', group_id: 2 })
    expect(exp).toMatchObject({
      ok: true,
      op: { kind: 'group', group_id: 2, patch: { is_collapsed: 0 } }
    })
    const mv = planLayoutFix(m, { type: 'move_field', field: 'po_number', to_group_key: 'main' })
    expect(mv).toMatchObject({
      ok: true,
      op: { kind: 'assignment', field: 'po_number', patch: { group_key: 'main' } }
    })
    const help = planLayoutFix(m, { type: 'help_text', field: 'po_number', text: '  Hint  ' })
    expect(help).toMatchObject({ ok: true, op: { overrides: { note: 'Hint' } } })
    const show = planLayoutFix(m, { type: 'show_field', field: 'vendor' })
    expect(show).toMatchObject({
      ok: true,
      op: { patch: { is_visible: 1 }, overrides: { hidden: false } }
    })
  })

  it('refuses stale or unknown fixes', () => {
    expect(planLayoutFix(m, { type: 'expand_section', group_id: 1 }).ok).toBe(false)
    expect(planLayoutFix(m, { type: 'move_field', field: 'gone', to_group_key: 'main' }).ok).toBe(
      false
    )
    expect(
      planLayoutFix(m, { type: 'move_field', field: 'po_number', to_group_key: 'more' }).ok
    ).toBe(false)
    expect(planLayoutFix(m, { type: 'show_field', field: 'po_number' }).ok).toBe(false)
    expect(planLayoutFix(m, { type: 'drop_table' }).ok).toBe(false)
    expect(planLayoutFix(m, null).ok).toBe(false)
  })
})

describe('help text drafts (#1912)', () => {
  it('keeps one draft per known field and skips label echoes', () => {
    const fields = [
      {
        field: 'status',
        label: 'Status',
        type: 'string',
        interface: null,
        required: true,
        choices: ['Open'],
        validation: [],
        relation: null,
        field_rules: [],
        cascade_parents: [],
        formula: null
      },
      {
        field: 'qty',
        label: 'Qty',
        type: 'integer',
        interface: null,
        required: false,
        choices: [],
        validation: [],
        relation: null,
        field_rules: [],
        cascade_parents: [],
        formula: null
      }
    ]
    const drafts = parseHelpAnswer(
      JSON.stringify({
        drafts: [
          { field: 'status', text: 'Where the order is in its life cycle.', basis: 'choices' },
          { field: 'status', text: 'dup' },
          { field: 'qty', text: 'Qty' },
          { field: 'ghost', text: 'x' }
        ]
      }),
      fields
    )
    expect(drafts).toEqual([
      {
        field: 'status',
        label: 'Status',
        text: 'Where the order is in its life cycle.',
        basis: 'choices'
      }
    ])
  })
})

describe('role design (#2010)', () => {
  const catalog: RoleCatalog = {
    collections: new Map([
      [
        'invoices',
        {
          label: 'Invoices',
          fields: new Set(['id', 'amount', 'division']),
          columns: new Set(['id', 'amount', 'division']),
          links: new Map([['division', 'divisions']])
        }
      ],
      [
        'inventory_requests',
        {
          label: 'Inventory Requests',
          fields: new Set(['id', 'status']),
          columns: new Set(['id', 'status']),
          links: new Map()
        }
      ]
    ]),
    dimensions: [
      {
        name: 'zone',
        label: 'Zone',
        target_collection: 'divisions',
        values: [{ id: '3', label: 'Zone 3' }]
      }
    ],
    ui_routes: [{ path: '/exports', label: 'Exports' }]
  }

  it('finds the collections a description mentions', () => {
    expect(relevantCollections('Reads invoices, approves inventory requests', catalog)).toEqual(
      expect.arrayContaining(['invoices', 'inventory_requests'])
    )
  })

  it('keeps valid grants, drops unknown ones whole rather than widening', () => {
    const { proposal, dropped } = normalizeRoleProposal(
      {
        name: 'Zone 3 clerk',
        admin_access: true,
        policies: [
          {
            collection: 'invoices',
            action: 'read',
            row_filter: [{ field: 'division', op: 'eq', value: 3 }]
          },
          {
            collection: 'invoices',
            action: 'update',
            row_filter: [{ field: 'zone_name', op: 'eq', value: 'x' }]
          },
          { collection: 'inventory_requests', action: 'read' },
          { collection: 'inventory_requests', action: 'update', fields: ['status', 'nope'] },
          { collection: 'nivaro_users', action: 'read' },
          { collection: 'ghosts', action: 'read' },
          { collection: 'invoices', action: 'export' }
        ],
        ui_disabled: ['/exports', '/admin-only'],
        scopes: [{ dimension: 'zone', values: ['3', '9'] }]
      },
      catalog
    )
    expect(proposal.policies.map((p) => `${p.collection}:${p.action}`)).toEqual([
      'inventory_requests:read',
      'inventory_requests:update',
      'invoices:read'
    ])
    expect(proposal.policies.find((p) => p.action === 'update')?.fields).toEqual(['status'])
    expect(proposal.ui_disabled).toEqual(['/exports'])
    expect(proposal.scopes).toEqual([{ dimension: 'zone', values: ['3'], labels: ['Zone 3'] }])
    expect(dropped.join(' ')).toMatch(/zone_name/)
    expect(dropped.join(' ')).toMatch(/ghosts/)
    expect(dropped.join(' ')).toMatch(/nivaro_users/)
    expect(proposal).not.toHaveProperty('admin_access')
  })

  it('simulates exactly the proposal and the hash follows edits', () => {
    const { proposal } = normalizeRoleProposal(
      { name: 'R', policies: [{ collection: 'invoices', action: 'read' }] },
      catalog
    )
    const sim = simulateRoleProposal(proposal, catalog)
    expect(sim[0].actions.read.allowed).toBe(true)
    expect(sim[0].actions.delete.allowed).toBe(false)
    const h1 = proposalHash(proposal)
    const edited = {
      ...proposal,
      policies: [...proposal.policies, { ...proposal.policies[0], action: 'update' as const }]
    }
    expect(proposalHash(edited)).not.toBe(h1)
    expect(proposalHash(normalizeRoleProposal(proposal, catalog).proposal)).toBe(h1)
  })
})

describe('suggested role views (#1965)', () => {
  const q = (conds: unknown, sort = '-created') =>
    `limit=25&page=1&sort=${sort}&conditions=${encodeURIComponent(JSON.stringify(conds))}`

  it('parses list requests and skips item reads, $ fields and OR groups', () => {
    const c = [{ path: ['divisions'], op: '_in', value: [3, 2] }]
    expect(parseItemsRequest('/api/items/workflows', q(c))).toEqual({
      collection: 'workflows',
      conditions: c,
      sort: '-created'
    })
    expect(parseItemsRequest('/api/items/workflows/12', q(c))).toBeNull()
    expect(
      parseItemsRequest(
        '/api/items/workflows',
        q([{ path: ['$has_files'], op: '_eq', value: true }])
      )
    ).toBeNull()
    expect(parseItemsRequest('/api/items/workflows', q([{ or: [] }]))).toBeNull()
    expect(parseItemsRequest('/api/items/nivaro_users', q(c))).toBeNull()
  })

  it('signatures ignore condition and value order', () => {
    expect(
      conditionSignature([
        { path: ['a'], op: '_in', value: [2, 1] },
        { path: ['b'], op: '_eq', value: 'x' }
      ])
    ).toBe(
      conditionSignature([
        { path: ['b'], op: '_eq', value: 'x' },
        { path: ['a'], op: '_in', value: ['1', '2'] }
      ])
    )
  })

  const conds = [{ path: ['divisions'], op: '_in', value: [3] }]
  const use = (user: string, day: string): FilterUse => ({
    user,
    collection: 'workflows',
    conditions: conds,
    sort: '-created',
    day
  })
  const roleOf = new Map([
    ['U1', 'r-buyer'],
    ['U2', 'r-buyer'],
    ['U3', 'r-other']
  ])

  it('suggests a filter two members share, or one member repeats on 3 days', () => {
    const shared = clusterRoleFilters([use('u1', '2026-10-01'), use('u2', '2026-10-02')], roleOf)
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({ role: 'r-buyer', people: 2, uses: 2, sort: '-created' })
    const once = clusterRoleFilters([use('u3', '2026-10-01'), use('u3', '2026-10-01')], roleOf)
    expect(once).toHaveLength(0)
    const habit = clusterRoleFilters(
      ['2026-10-01', '2026-10-02', '2026-10-05'].map((d) => use('u3', d)),
      roleOf
    )
    expect(habit[0]).toMatchObject({ role: 'r-other', people: 1, uses: 3 })
  })

  it('drops filter sets a shared view for that role (or everyone) already holds', () => {
    const clusters = clusterRoleFilters([use('u1', 'd1'), use('u2', 'd2')], roleOf)
    const view = {
      collection: 'workflows',
      filters: [{ path: ['divisions'], op: '_in', value: [3] }]
    }
    expect(dropCovered(clusters, [{ ...view, role: null }])).toHaveLength(0)
    expect(dropCovered(clusters, [{ ...view, role: 'R-BUYER' }])).toHaveLength(0)
    expect(dropCovered(clusters, [{ ...view, role: 'r-other' }])).toHaveLength(1)
  })

  it('builds browser filter chips and keeps only known columns from the model', () => {
    const fields = new Map([
      ['divisions', { label: 'Division', type: 'integer', target: 'divisions' }],
      ['name', { label: 'Name', type: 'string', target: null }],
      ['status', { label: 'Status', type: 'string', target: null }]
    ])
    expect(toActiveFilters(conds, fields)[0]).toMatchObject({
      path: ['divisions'],
      pathLabels: ['Division'],
      fieldType: 'integer',
      op: '_in',
      value: [3],
      relTarget: 'divisions'
    })
    const ctx: RoleViewContext = {
      clusters: clusterRoleFilters([use('u1', 'd1'), use('u2', 'd2')], roleOf),
      roles: new Map([['R-BUYER', { id: 'r-buyer', name: 'Buyer', members: 5 }]]),
      collections: new Map([['workflows', { label: 'Workflows', fields }]])
    }
    const s = buildSuggestions(ctx)
    expect(s).toHaveLength(1)
    expect(s[0].name).toBe('Workflows: Division is one of 3')
    const named = applyViewsAnswer(
      JSON.stringify({
        views: [
          {
            id: s[0].id,
            name: 'My division',
            description: 'Open work',
            columns: ['name', 'ghost', 'status']
          }
        ]
      }),
      s,
      ctx
    )
    expect(named[0]).toMatchObject({ name: 'My division', columns: ['name', 'status'] })
  })
})
