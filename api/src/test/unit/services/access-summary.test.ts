import { beforeEach, describe, expect, it, vi } from 'vitest'

// #12 Permission summary in words. The summary is built from the REAL
// enforcement functions (can / getAllowedFields / getRowFilter in
// permissions.ts and routeScopeGates in record-access.ts) running over one
// in-memory fixture; the parity tests ask those same functions directly and
// require the summary to agree for every collection and action.

type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()

function builder(table: string) {
  let rows: Row[] = [...(tables[table] ?? [])]
  let selected: unknown[] = []
  const matchObj = (o: Row) => (r: Row) => Object.entries(o).every(([k, v]) => same(r[k], v))
  const b: Record<string, unknown> = {
    where(a: unknown, v?: unknown) {
      if (typeof a === 'function') {
        const preds: Array<(r: Row) => boolean> = []
        const sub = {
          where(o: Row) {
            preds.push(matchObj(o))
            return sub
          },
          orWhere(o: Row) {
            preds.push(matchObj(o))
            return sub
          }
        }
        ;(a as (q: typeof sub) => void)(sub)
        rows = rows.filter((r) => preds.some((p) => p(r)))
      } else if (typeof a === 'object' && a) rows = rows.filter(matchObj(a as Row))
      else rows = rows.filter((r) => same(r[a as string], v))
      return b
    },
    whereIn(c: string, vals: unknown[]) {
      rows = rows.filter((r) => vals.some((v) => same(r[c], v)))
      return b
    },
    whereNotNull(c: string) {
      rows = rows.filter((r) => r[c] != null)
      return b
    },
    orderByRaw(sql: string) {
      if (/collection = '\*'/.test(sql))
        rows.sort((x, z) => Number(x.collection === '*') - Number(z.collection === '*'))
      return b
    },
    orderBy: () => b,
    select(...cols: unknown[]) {
      selected = cols
      return b
    },
    first: () => Promise.resolve(materialize()[0]),
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenable
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(materialize()).then(res, rej),
    catch: () => Promise.resolve(materialize())
  }
  function materialize(): Row[] {
    const raw = selected.find(
      (s): s is { sql: string; bindings: string[] } => typeof s === 'object' && !!s
    )
    return raw ? rows.map((r) => ({ ...r, label: r[raw.bindings[0]] })) : rows
  }
  return b
}

vi.mock('../../../db/index.js', () => ({
  db: Object.assign((t: string) => builder(t), {
    raw: (sql: string, bindings: string[]) => ({ sql, bindings })
  })
}))
vi.mock('../../../services/permission-cache.js', () => ({
  cachedAccess: (_u: unknown, _o: unknown, _q: unknown, compute: (c: unknown) => unknown) =>
    compute({ degraded() {} })
}))
vi.mock('../../../services/role-change-impact.js', () => ({
  approxRows: async (cols: string[]) => new Map(cols.map((c) => [c, c === 'docs' ? 5000 : 10]))
}))
const ZONE = {
  id: 1,
  name: 'zone',
  label: 'Zone',
  target_collection: 'zones',
  display_field: 'name',
  options_sort: null,
  overrides: null,
  exclusions: null,
  strict: false,
  is_active: true
}
vi.mock('../../../services/user-scopes.js', () => ({
  listScopeDimensions: async () => [ZONE],
  getUserScopes: async (id: string) =>
    (tables.nivaro_user_scopes ?? [])
      .filter((s) => same(s.user, id))
      .map((s) => ({ ...s, values: JSON.parse(String(s.values)) })),
  scopeHopsFor: async (_d: unknown, c: string) =>
    c === 'po' ? [{ kind: 'm2o', from: 'po', to: 'zones', fk: 'zone' }] : c === 'zones' ? [] : null,
  applyScopeHops: vi.fn(),
  resolveRecordDimensionIds: vi.fn()
}))

import { summarizeAccess } from '../../../services/access-summary.js'
import { can, getAllowedFields, getRowFilter } from '../../../services/permissions.js'
import type { User } from '../../../types.js'

const BUYER = '11111111-1111-1111-1111-111111111111'
const ADMIN = '22222222-2222-2222-2222-222222222222'
const VIEWER = '33333333-3333-3333-3333-333333333333'
const BETH = 'b0000000-0000-0000-0000-000000000001'
const KIM = 'b0000000-0000-0000-0000-000000000002'
const ALL = ['read', 'create', 'update', 'delete'] as const

function seed() {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_roles = [
    {
      id: BUYER,
      name: 'Buyer',
      admin_access: 0,
      app_access: 1,
      ui_permissions: '["/flows","/reports/throughput"]'
    },
    { id: ADMIN, name: 'Admin', admin_access: 1, app_access: 1 },
    { id: VIEWER, name: 'Viewer', admin_access: 0, app_access: 0 }
  ]
  const pol = (role: string, collection: string, action: string, extra: Row = {}) => ({
    role,
    collection,
    action,
    fields: null,
    row_filter: null,
    ...extra
  })
  tables.nivaro_policies = [
    pol(BUYER, 'po', 'read', { fields: '["id","number","vendor","status","zone"]' }),
    pol(BUYER, 'po', 'create'),
    pol(BUYER, 'po', 'update'),
    pol(BUYER, 'invoices', 'read', {
      row_filter: '[{"field":"status","op":"eq","value":"Approved"}]'
    }),
    ...ALL.map((a) => pol(BUYER, 'notes', a)),
    pol(BUYER, 'docs', 'read'),
    pol(VIEWER, '*', 'read'),
    pol(VIEWER, 'invoices', 'update', { fields: '["status"]' })
  ]
  tables.nivaro_collections = [
    { collection: 'po', display_name: 'Purchase Orders', hidden: 0 },
    { collection: 'invoices', display_name: 'Invoices', hidden: 0 },
    { collection: 'notes', display_name: null, hidden: 0 },
    { collection: 'docs', display_name: null, hidden: 0 },
    { collection: 'vendors', display_name: null, hidden: 0 },
    { collection: 'po_tags', display_name: null, hidden: 0 },
    { collection: 'secret_hidden', display_name: null, hidden: 1 },
    { collection: 'nivaro_users', display_name: 'Users', hidden: 0 }
  ]
  tables.nivaro_relations = [{ many_collection: 'po_tags', junction_field: 'tags_id' }]
  tables.nivaro_workflow_bindings = [{ collection: 'po' }]
  tables.nivaro_fields = [
    ...['id', 'number', 'vendor', 'status', 'zone', 'cost', 'price'].map((f) => ({
      collection: 'po',
      field: f,
      label: f === 'cost' ? 'Cost' : f === 'price' ? 'Price' : null
    })),
    { collection: 'invoices', field: 'id', label: null },
    { collection: 'invoices', field: 'status', label: 'Status' },
    { collection: 'invoices', field: 'amount', label: 'Amount' }
  ]
  tables.nivaro_users = [
    { id: BETH, role: BUYER, first_name: 'Beth', last_name: 'Ray', email: 'beth@x' },
    { id: KIM, role: BUYER, first_name: 'Kim', last_name: 'Lo', email: 'kim@x' }
  ]
  tables.nivaro_user_scopes = [{ user: BETH, dimension: 'zone', mode: 'restrict', values: '[1,4]' }]
  tables.zones = [
    { id: 1, name: 'Zone 1' },
    { id: 4, name: 'Zone 4' }
  ]
}

beforeEach(seed)

const sim = (role: string) => ({ id: '00000000-0000-0000-0000-000000000000', role }) as User

describe('summarizeAccess — role', () => {
  it('phrases the Buyer role from its policies, field list, row rule, scopes and pages', async () => {
    const s = (await summarizeAccess({ role: BUYER }, { viewerIsAdmin: true, self: false }))!
    expect(s.headline).toBe('What Buyer can do (2 people):')
    // pipeline-bound first
    expect(s.lines[0].collections).toEqual(['po'])
    expect(s.lines[0].sentence).toBe(
      "Buyers can see, add and edit purchase orders in their own Zones (for 1 of 2 people), can't delete, can't see the Cost and Price fields."
    )
    const text = s.sentences.join('\n')
    expect(text).toContain(
      "Buyers can see invoices, only where Status is Approved, can't add, edit or delete."
    )
    expect(text).toContain('Buyers have full access to notes: see, add, edit and delete.')
    expect(text).toContain('Buyers can only see docs, not change them.')
    // vendors has no policy; the junction, hidden and system tables are never counted
    expect(s.closed_line).toBe("Buyers can't open the other 1 collection.")
    expect(s.ui_line).toBe('Pages turned off: Flows and Reports throughput.')
    expect(s.collections.find((c) => c.collection === 'po')?.hidden_fields).toEqual([
      'cost',
      'price'
    ])
  })

  it('collapses a wildcard role into one line and names the explicit exception', async () => {
    const s = (await summarizeAccess({ role: VIEWER }, { viewerIsAdmin: true, self: false }))!
    const ro = s.lines.find((l) => l.kind === 'read_only')!
    expect(ro.collections.sort()).toEqual(['docs', 'notes', 'po', 'vendors'])
    expect(s.sentences.join(' ')).toContain(
      "can see and edit invoices, can't add or delete, can't edit the Amount field."
    )
    expect(s.sentences.join(' ')).toContain("can't sign in to the app")
    expect(s.collections.map((c) => c.collection)).not.toContain('nivaro_users')
    expect(s.collections.map((c) => c.collection)).not.toContain('po_tags')
  })

  it('an administrator role is one sentence', async () => {
    const s = (await summarizeAccess({ role: ADMIN }, { viewerIsAdmin: true, self: false }))!
    expect(s.subject.admin).toBe(true)
    expect(s.headline).toMatch(/administrator role/)
    expect(s.lines).toEqual([])
  })

  it('an unknown role is null', async () => {
    expect(
      await summarizeAccess(
        { role: '99999999-9999-9999-9999-999999999999' },
        { viewerIsAdmin: true, self: false }
      )
    ).toBeNull()
  })

  it.each([
    BUYER,
    VIEWER
  ])('agrees with can/getAllowedFields/getRowFilter for role %s', async (role) => {
    const s = (await summarizeAccess({ role }, { viewerIsAdmin: true, self: false }))!
    const listed = new Map(s.collections.map((c) => [c.collection, c]))
    for (const c of ['po', 'invoices', 'notes', 'docs', 'vendors']) {
      const u = sim(role)
      const truth = Object.fromEntries(
        await Promise.all(ALL.map(async (a) => [a, await can(u, a, c)]))
      )
      const row = listed.get(c)
      if (!Object.values(truth).some(Boolean)) {
        expect(row).toBeUndefined()
        continue
      }
      expect({
        read: row!.read,
        create: row!.create,
        update: row!.update,
        delete: row!.delete
      }).toEqual(truth)
      if (truth.read) {
        expect(row!.read_fields).toEqual(await getAllowedFields(u, 'read', c))
        expect(row!.row_filter.read).toEqual(await getRowFilter(u, 'read', c))
      }
      if (truth.update) expect(row!.update_fields).toEqual(await getAllowedFields(u, 'update', c))
    }
  })
})

describe('summarizeAccess — person', () => {
  it('an administrator reading Beth gets her own zone names', async () => {
    const s = (await summarizeAccess({ user: BETH }, { viewerIsAdmin: true, self: false }))!
    expect(s.headline).toBe('Beth has the Buyer role.')
    expect(s.lines[0].sentence).toBe(
      "Beth can see, add and edit purchase orders in their own Zones (Zone 1 or Zone 4), can't delete, can't see the Cost and Price fields."
    )
  })

  it('Kim holds no scope, so POs are not narrowed for her', async () => {
    const s = (await summarizeAccess({ user: KIM }, { viewerIsAdmin: true, self: false }))!
    expect(s.lines[0].sentence).not.toContain('Zones')
  })

  it("Beth reading her own access never hears the hidden fields' names or the closed count", async () => {
    const s = (await summarizeAccess({ user: BETH }, { viewerIsAdmin: false, self: true }))!
    expect(s.lines[0].sentence).toBe(
      "You can see, add and edit purchase orders in your own Zones (Zone 1 or Zone 4), can't delete, some fields are hidden from you."
    )
    const json = JSON.stringify(s)
    expect(json).not.toMatch(/cost|price/i)
    expect(s.closed_line).toBe('Everything else is closed to you.')
    expect(s.closed_count).toBe(0)
  })

  it('an unknown person is null', async () => {
    expect(
      await summarizeAccess(
        { user: 'c0000000-0000-0000-0000-000000000009' },
        { viewerIsAdmin: true, self: false }
      )
    ).toBeNull()
  })
})
