import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

// POST /field-config/:collection/project — the layout editor's canvas renders
// its unsaved DRAFT through it. It must answer exactly what GET answers once
// those placements are the saved layout: one formatter, never a client copy.

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u1', role: 'R' }
    req.isAdmin = false
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../services/rollups.js', () => ({ bustRollupContributorCache: vi.fn() }))

const FIELDS = [
  {
    field: 'title',
    type: 'string',
    label: 'Title',
    interface: 'input',
    options: '{"col_span":6,"trim":true}',
    hidden: 0,
    readonly: 0,
    required: 0,
    sort: 1
  },
  {
    field: 'amount',
    type: 'decimal',
    label: 'Amount',
    interface: 'input',
    options: null,
    hidden: 0,
    readonly: 0,
    required: 0,
    sort: 2
  },
  {
    field: 'total',
    type: 'decimal',
    label: 'Total',
    interface: 'input',
    options: null,
    hidden: 0,
    readonly: 0,
    required: 0,
    computed_type: 'rollup',
    sort: 3
  }
]

// Stored placements per layout id, as nivaro_layout_field_assignments returns
// them (overrides as JSON text, flags as bits).
const base = {
  label_override: null,
  is_visible: 1,
  default_expanded: null,
  show_row_revisions: null,
  show_approval_chain: null,
  col_span: null,
  overrides: null,
  widget_id: null,
  input_bindings: null,
  lock_conditions: null,
  allow_revision_restore: null
}
const PLACEMENTS = [
  // A field placed twice: body + header strip, each with its own settings.
  { ...base, field: 'title', group_key: 'main', sort: 0, col_span: 4 },
  { ...base, field: 'title', group_key: '__header__', sort: 0, label_override: 'Name' },
  {
    ...base,
    field: 'total',
    group_key: 'main',
    sort: 1,
    overrides: JSON.stringify({ editable_computed: true, interface: 'numeric' }),
    lock_conditions: '[{"type":"role","role_ids":["R"]}]',
    allow_revision_restore: 0,
    show_row_revisions: 1
  },
  // A virtual O2M grid with no nivaro_fields row.
  {
    ...base,
    field: 'lines',
    group_key: 'main',
    sort: 2,
    overrides: JSON.stringify({ label: 'Lines', options: { columns: ['sku'] } })
  },
  { ...base, field: '__ungrouped_pos__', group_key: null, sort: 5 }
]
const WITH_OVERRIDE = {
  ...base,
  field: 'amount',
  group_key: 'main',
  sort: 3,
  overrides: JSON.stringify({ label: 'Net', required: true, readonly: true })
}
const WITHOUT_OVERRIDE = { ...WITH_OVERRIDE, overrides: null }
const LAYOUTS: Record<number, Array<Record<string, unknown>>> = {
  1: [...PLACEMENTS, WITH_OVERRIDE],
  2: [...PLACEMENTS, WITHOUT_OVERRIDE]
}

vi.mock('../../../db/index.js', () => {
  const db = (table: string) => {
    let where: Record<string, unknown> = {}
    const b: Record<string, unknown> = {
      where: (w: Record<string, unknown>) => {
        where = w
        return b
      },
      select: () => b,
      orderBy: () => b,
      first: async () => null,
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        let rows: unknown[] = []
        if (table === 'nivaro_fields') rows = FIELDS.map((r) => ({ ...r }))
        if (table === 'nivaro_layout_field_assignments')
          rows = (LAYOUTS[Number(where.layout_id)] ?? []).map((r) => ({ ...r }))
        return Promise.resolve(rows).then(resolve, reject)
      }
    }
    return b
  }
  return { db }
})

import { fieldConfigRoutes } from '../../../routes/field-config.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(fieldConfigRoutes, { prefix: '/field-config' })
  return app
}

/** What the layout editor holds: the same placements, as the client keeps them. */
function draftOf(rows: Array<Record<string, unknown>>) {
  return rows.map((r) => ({
    ...r,
    overrides: typeof r.overrides === 'string' ? JSON.parse(r.overrides) : r.overrides
  }))
}

async function getRows(layoutId: number) {
  const app = buildApp()
  const res = await app.inject({ method: 'GET', url: `/field-config/orders?layout_id=${layoutId}` })
  expect(res.statusCode).toBe(200)
  return res.json()
}
async function projectRows(assignments: unknown) {
  const app = buildApp()
  return app.inject({
    method: 'POST',
    url: '/field-config/orders/project',
    payload: { assignments }
  })
}

afterEach(() => vi.clearAllMocks())

describe('POST /field-config/:collection/project', () => {
  it('answers exactly what GET answers for the same placements (twin, alias grid, overrides)', async () => {
    const saved = await getRows(1)
    const res = await projectRows(draftOf(LAYOUTS[1]))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(saved)

    const rows = saved.data as Array<Record<string, unknown>>
    // The twin keeps both placements, each with its own settings.
    const titles = rows.filter((r) => r.field === 'title')
    expect(titles.map((r) => r.group_key).sort()).toEqual(['__header__', 'main'])
    expect(titles.find((r) => r.group_key === 'main')?.options).toEqual({
      trim: true,
      col_span: 4
    })
    expect(titles.find((r) => r.group_key === '__header__')?.label_override).toBe('Name')
    // The alias grid renders from its placement alone.
    expect(rows.find((r) => r.field === 'lines')).toMatchObject({
      label: 'Lines',
      interface: 'o2m',
      layout_assigned: true,
      options: { columns: ['sku'] }
    })
    // editable_computed lifts the rollup's derived read-only; lock + restore carried.
    expect(rows.find((r) => r.field === 'total')).toMatchObject({
      readonly: false,
      interface: 'numeric',
      lock_conditions: '[{"type":"role","role_ids":["R"]}]',
      allow_revision_restore: false
    })
    expect(saved.ungrouped_sort).toBe(5)
  })

  it('a draft that removes an override shows the field without it', async () => {
    const withOverride = await getRows(1)
    const withoutOverride = await getRows(2)
    const res = await projectRows(draftOf(LAYOUTS[2]))
    expect(res.json()).toEqual(withoutOverride)
    expect(res.json()).not.toEqual(withOverride)
    const amount = (res.json().data as Array<Record<string, unknown>>).find(
      (r) => r.field === 'amount'
    )
    expect(amount).toMatchObject({ label: 'Amount', required: false, readonly: false })
  })

  it('unplaced fields come back unassigned', async () => {
    const res = await projectRows([{ field: 'title', group_key: 'main', sort: 0 }])
    const rows = res.json().data as Array<Record<string, unknown>>
    expect(rows.find((r) => r.field === 'amount')).toMatchObject({
      layout_assigned: false,
      group_key: null
    })
    expect(rows.some((r) => r.field === 'lines')).toBe(false)
  })

  it('rejects a body without an assignments array or with a nameless placement', async () => {
    expect((await projectRows(undefined)).statusCode).toBe(400)
    expect((await projectRows([{ group_key: 'main' }])).statusCode).toBe(400)
  })
})
