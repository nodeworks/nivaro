import { beforeEach, describe, expect, it, vi } from 'vitest'

const H = vi.hoisted(() => {
  // ─── a tiny in-memory knex: just what the service, the gates and buildContext call ───
  const tables: Record<string, Row[]> = {}
  const same = (a: unknown, b: unknown) =>
    String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase() && (a == null) === (b == null)

  function builder(table: string) {
    const preds: Array<(r: Row) => boolean> = []
    let limit = Number.POSITIVE_INFINITY
    let cols: string[] | null = null
    const rows = () =>
      (tables[table] ?? [])
        .filter((r) => preds.every((p) => p(r)))
        .slice(0, limit)
        .map((r) =>
          cols && !cols.includes('*') ? Object.fromEntries(cols.map((c) => [c, r[c]])) : { ...r }
        )
    const b: Record<string, unknown> = {
      where(a: unknown, v?: unknown) {
        if (a && typeof a === 'object')
          for (const [k, x] of Object.entries(a as Row)) preds.push((r) => same(r[k], x))
        else preds.push((r) => same(r[String(a)], v))
        return b
      },
      whereNull(c: string) {
        preds.push((r) => r[c] == null)
        return b
      },
      whereNotNull(c: string) {
        preds.push((r) => r[c] != null)
        return b
      },
      whereIn(c: string, list: unknown) {
        const vals = Array.isArray(list)
          ? list
          : ((list as { __rows: () => Row[] })
              .__rows()
              .map((r) => Object.values(r)[0]) as unknown[])
        preds.push((r) => vals.some((v) => same(r[c], v)))
        return b
      },
      orderBy: () => b,
      limit(n: number) {
        limit = n
        return b
      },
      select(...c: unknown[]) {
        cols = c.flat().filter((x) => typeof x === 'string') as string[]
        return b
      },
      first: async () => rows()[0],
      columnInfo: async () => ({}),
      __rows: rows,
      // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
      then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(res, rej),
      catch: (fn: (e: unknown) => unknown) => Promise.resolve(rows()).catch(fn)
    }
    return b
  }
  const fakeDb = Object.assign((t: string) => builder(t), { raw: (s: string) => s })
  return { tables, fakeDb }
})
type Row = Record<string, unknown>
const tables = H.tables
vi.mock('../../db/index.js', () => ({ db: H.fakeDb }))

const M = vi.hoisted(() => {
  // ─── metadata, permissions, the published template ───
  const fieldsOf: Record<string, string[]> = {
    orders: ['id', 'ref', 'depot', 'site', 'due_date', 'contacts', 'lines', 'order_no'],
    order_lines: ['id', 'order', 'sku', 'bin', 'depot', 'qty']
  }
  const relations = [
    {
      id: 1,
      many_collection: 'order_lines',
      many_field: 'order',
      one_collection: 'orders',
      one_field: 'lines',
      junction_field: null
    },
    {
      id: 2,
      many_collection: 'order_contacts',
      many_field: 'orders_id',
      one_collection: 'orders',
      one_field: 'contacts',
      junction_field: 'people_id'
    },
    {
      id: 3,
      many_collection: 'order_lines_depots',
      many_field: 'order_lines_id',
      one_collection: 'order_lines',
      one_field: 'depots',
      junction_field: 'depots_id'
    }
  ]
  const perm: { allowed: Record<string, string[] | null>; hidden: Set<string> } = {
    allowed: {},
    hidden: new Set()
  }
  return { fieldsOf, relations, perm }
})
const perm = M.perm
vi.mock('../collections.js', async (orig) => ({
  ...((await orig()) as object),
  getCollection: async (c: string) => ({ collection: c, browser_config: { partner_badges: true } }),
  getPhysicalColumns: async (c: string) => new Set(M.fieldsOf[c] ?? []),
  getFields: async (c: string) =>
    (M.fieldsOf[c] ?? []).map((field) => ({
      field,
      label: field === 'depot' ? 'Depot' : null,
      readonly: field === 'order_no',
      special: null,
      options: null,
      computed_formula: null
    })),
  getRelations: async (c: string) =>
    M.relations.filter((r) => r.many_collection === c || r.one_collection === c)
}))
// The record and lookups are read AS THE CALLER: field policy (perm.allowed) and rows the
// caller cannot see (perm.hidden, `<collection>:<id>`) apply, like readOne / readItems.
vi.mock('../items.js', async (orig) => {
  type R = Record<string, unknown>
  const pick = (c: string, row: R, fields?: string[]) => {
    const allowed = M.perm.allowed[c]
    const out: R = {}
    for (const [k, v] of Object.entries(row)) {
      if (allowed && !allowed.includes(k)) continue
      if (fields && !fields.includes(k)) continue
      out[k] = v
    }
    return out
  }
  const seen = (c: string, r: R) => !M.perm.hidden.has(`${c}:${r.id}`)
  const eq = (a: unknown, b: unknown) =>
    String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()
  return {
    ...((await orig()) as object),
    readOne: async (_u: unknown, c: string, id: unknown) => {
      const row = (H.tables[c] ?? []).find((r) => eq(r.id, id))
      return row && seen(c, row) ? pick(c, row) : null
    },
    readItems: async (
      _u: unknown,
      c: string,
      q: { filter?: R; fields?: string[]; limit?: number }
    ) => {
      const rows = (H.tables[c] ?? []).filter((r) => {
        if (!seen(c, r)) return false
        for (const [f, cond] of Object.entries(q.filter ?? {})) {
          const op = cond as R
          if ('_eq' in op && !eq(r[f], op._eq)) return false
          if ('_null' in op && r[f] != null) return false
          if ('_in' in op && !(op._in as unknown[]).some((x) => eq(r[f], x))) return false
        }
        return true
      })
      return { data: rows.slice(0, q.limit ?? 1000).map((r) => pick(c, r, q.fields)) }
    }
  }
})
vi.mock('../permissions.js', async (orig) => ({
  ...((await orig()) as object),
  can: async () => true,
  getAllowedFields: async (_u: unknown, _a: unknown, c: string) => M.perm.allowed[c] ?? null
}))

const alphaSpec = vi.hoisted(() => {
  return {
    v: 1,
    fields: [
      {
        id: 'a',
        key: 'ref',
        type: 'text',
        value: { source: 'path', path: 'record.ref' },
        include: 'always'
      },
      {
        id: 'n',
        key: 'no',
        type: 'text',
        value: { source: 'path', path: 'record.order_no' },
        include: 'always'
      },
      {
        id: 'b',
        key: 'site',
        type: 'text',
        value: { source: 'path', path: 'context.site[0].code' },
        include: 'always'
      },
      {
        id: 'c',
        key: 'contact',
        type: 'text',
        value: { source: 'path', path: 'context.contacts[0].people_id_data.email' },
        include: 'always'
      },
      {
        id: 'l',
        key: 'lines',
        type: 'list',
        list: {
          source: 'context.lines',
          item: 'line',
          where: [{ field: 'line.qty', op: 'gt', value: 0 }]
        },
        include: 'always',
        children: [
          {
            id: 's',
            key: 'sku',
            type: 'text',
            value: { source: 'path', path: 'line.sku' },
            include: 'always'
          }
        ]
      }
    ]
  }
})
vi.mock('../payload-templates/index.js', async (orig) => ({
  ...((await orig()) as object),
  publishedTemplateInfo: async () => null,
  publishedTemplateBody: async (key: string) =>
    key === 'alpha-order' ? { mode: 'map', body: JSON.stringify(alphaSpec) } : null
}))

import { type PartnerNeedsAnswer, partnerNeeds as partnerNeedsOrNull } from './index.js'

// Null only for a record the caller cannot read (its own test checks that); typed as an answer.
const partnerNeeds = async (...args: Parameters<typeof partnerNeedsOrNull>) =>
  (await partnerNeedsOrNull(...args)) as PartnerNeedsAnswer

const T = 'TPL-1'
const S = { draft: 'S-DRAFT', review: 'S-REVIEW', ready: 'S-READY', sent: 'S-SENT' }

function seed() {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_workflow_bindings = [
    { collection: 'orders', template: T, auto_start: true, auto_start_state: null }
  ]
  tables.nivaro_workflow_instances = []
  tables.nivaro_workflow_states = [
    { id: S.draft, template: T, key: 'draft', label: 'Draft', sort: 1, is_initial: true },
    { id: S.review, template: T, key: 'review', label: 'Review', sort: 2, is_initial: false },
    { id: S.ready, template: T, key: 'ready', label: 'Ready', sort: 3, is_initial: false },
    { id: S.sent, template: T, key: 'sent', label: 'Sent', sort: 4, is_initial: false }
  ]
  const alpha = {
    type: 'erp_submit',
    external_api: 'Alpha',
    endpoint_path: '/orders',
    payload_template_key: 'alpha-order',
    skip_when_empty: 'alpha_depot',
    context: {
      alpha_depot: {
        collection: 'depots',
        filter: { id: '$record.depot', system: 'alpha' },
        limit: 1
      },
      site: { collection: 'sites', filter: { id: '$record.site' }, limit: 1 },
      contacts: {
        collection: 'order_contacts',
        filter: { orders_id: '$id' },
        expand: { people_id: { collection: 'people', fields: ['email'] } }
      },
      // Per line: only lines whose depot junction carries depot 1.
      lines: {
        collection: 'order_lines',
        filter: { order: '$id' },
        junction_filter: {
          junction: 'order_lines_depots',
          fk_to_row: 'order_lines_id',
          field: 'depots_id',
          value: 1
        }
      }
    }
  }
  const beta = {
    type: 'erp_submit',
    external_api: 'Beta',
    endpoint_path: '/b',
    skip_when_empty: 'beta_depot',
    context: {
      beta_depot: {
        collection: 'depots',
        filter: { id: '$record.depot', system: 'beta' },
        limit: 1
      }
    },
    payload_template: '{"due":"{{ record.due_date }}"}'
  }
  const gamma = {
    type: 'erp_submit',
    external_api: 'Gamma',
    endpoint_path: '/g',
    skip_when_empty: 'gamma_lines',
    context: { gamma_lines: { collection: 'order_lines', filter: { order: '$id', depot: 3 } } },
    payload_template: '[{% for l in context.gamma_lines %}"{{ l.bin }}"{% endfor %}]'
  }
  tables.nivaro_workflow_transitions = [
    {
      id: 'T1',
      template: T,
      label: 'Submit',
      from_state: S.draft,
      to_state: S.review,
      actions: null,
      auto_trigger: false
    },
    {
      id: 'T2',
      template: T,
      label: 'Approve',
      from_state: S.review,
      to_state: S.ready,
      actions: null,
      auto_trigger: false
    },
    {
      id: 'T3',
      template: T,
      label: 'Send to depot',
      from_state: S.ready,
      to_state: S.sent,
      actions: JSON.stringify([alpha, beta, gamma]),
      auto_trigger: false
    },
    // Automatic pushes never count.
    {
      id: 'T4',
      template: T,
      label: 'Auto resend',
      from_state: S.ready,
      to_state: S.sent,
      actions: JSON.stringify([
        { ...beta, skip_when_empty: undefined, payload_template: '{"x":"{{ record.ref }}"}' }
      ]),
      auto_trigger: true
    }
  ]
  tables.nivaro_external_apis = [
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
    { id: 3, name: 'Gamma' }
  ]
  tables.depots = [
    { id: 1, system: 'alpha' },
    { id: 2, system: 'beta' },
    { id: 3, system: 'gamma' }
  ]
  tables.sites = [{ id: 7, code: 'S7' }]
  tables.order_lines = []
  tables.order_lines_depots = []
  tables.order_contacts = []
}

const admin = { user: { id: 'U1', role: 'R' } as never, isAdmin: true }

describe('partnerNeeds', () => {
  beforeEach(() => {
    seed()
    perm.allowed = {}
    perm.hidden = new Set()
  })

  it('badges follow the deciding field: depot 1 → Alpha fields, depot 2 → Beta fields', async () => {
    const a = await partnerNeeds({ collection: 'orders', item: null, values: { depot: 1 } }, admin)
    expect(a.enabled).toBe(true)
    expect(a.depth).toBe('forward')
    expect(a.state?.key).toBe('draft')
    expect(Object.keys(a.fields).sort()).toEqual(['contacts', 'ref', 'site'])
    expect(a.fields.ref).toEqual({ partners: ['Alpha'], steps: ['Send to depot'] })
    // An M2M field says whether links are saved (a new record has none).
    expect(a.fields.contacts.filled).toBe(false)
    // The read-only order_no is never a person's to fill.
    expect(a.fields.order_no).toBeUndefined()
    expect(a.hints).toEqual({})
    expect(a.inputs.record).toContain('depot')

    const b = await partnerNeeds({ collection: 'orders', item: null, values: { depot: 2 } }, admin)
    expect(Object.keys(b.fields)).toEqual(['due_date'])
    expect(b.fields.due_date.partners).toEqual(['Beta'])
  })

  it('an empty deciding field shows a hint on it and no partner badges', async () => {
    const a = await partnerNeeds(
      { collection: 'orders', item: null, values: { depot: null } },
      admin
    )
    expect(a.fields).toEqual({})
    expect(a.hints).toEqual({ depot: { message: 'Pick a Depot to see what it needs.' } })
  })

  it('judges lines one by one: each line carries the marks of the push it goes to', async () => {
    tables.instances = []
    tables.nivaro_workflow_instances = [
      {
        collection: 'orders',
        item: '10',
        template: T,
        current_state: S.ready,
        completed_at: null,
        started_at: 1
      }
    ]
    tables.orders = [{ id: 10, ref: null, depot: 1, site: null }]
    tables.order_lines = [
      { id: 101, order: 10, sku: null, bin: null, depot: null, qty: 2 },
      { id: 102, order: 10, sku: null, bin: null, depot: 3, qty: 1 }
    ]
    tables.order_lines_depots = [{ order_lines_id: 101, depots_id: 1 }]
    const a = await partnerNeeds({ collection: 'orders', item: '10', values: {} }, admin)
    const rel = a.lines['order_lines.order']
    expect(rel.rows['101']).toEqual({ sku: { partners: ['Alpha'], steps: ['Send to depot'] } })
    expect(rel.rows['102']).toEqual({ bin: { partners: ['Gamma'], steps: ['Send to depot'] } })

    // The form's unsaved lines win: a new line on depot 3 goes to Gamma, a qty-0 line to nobody.
    const b = await partnerNeeds(
      {
        collection: 'orders',
        item: '10',
        values: {},
        lines: {
          'order_lines.order': [
            { key: '101', values: { depot: null, qty: 0, depots: [1] } },
            { key: 'pending:0', values: { depot: 3, qty: 5 } }
          ]
        }
      },
      admin
    )
    expect(b.lines['order_lines.order'].rows['101']).toBeUndefined()
    expect(b.lines['order_lines.order'].rows['pending:0']).toEqual({
      bin: { partners: ['Gamma'], steps: ['Send to depot'] }
    })
    expect(b.inputs.lines['order_lines.order'].fields).toEqual(
      expect.arrayContaining(['depot', 'qty'])
    )
  })

  it('names only fields the caller may read', async () => {
    perm.allowed = { orders: ['id', 'ref', 'depot', 'contacts'], order_lines: ['id', 'sku'] }
    const reader = { user: { id: 'U2', role: 'R2' } as never, isAdmin: false }
    const a = await partnerNeeds(
      { collection: 'orders', item: null, values: { depot: 1, site: 7 } },
      reader
    )
    expect(Object.keys(a.fields).sort()).toEqual(['contacts', 'ref'])

    tables.nivaro_workflow_instances = [
      {
        collection: 'orders',
        item: '10',
        template: T,
        current_state: S.ready,
        completed_at: null,
        started_at: 1
      }
    ]
    tables.orders = [{ id: 10, depot: 1 }]
    tables.order_lines = [{ id: 102, order: 10, depot: 3, qty: 1 }]
    const b = await partnerNeeds({ collection: 'orders', item: '10', values: {} }, reader)
    // bin is not readable: line 102 names nothing.
    expect(b.lines['order_lines.order']?.rows['102']).toBeUndefined()

    // An unreadable deciding field gets no hint either.
    perm.allowed = { orders: ['id', 'ref'] }
    const c = await partnerNeeds({ collection: 'orders', item: null, values: {} }, reader)
    expect(c.hints).toEqual({})
  })

  it('a record the caller cannot read answers nothing (route: 404)', async () => {
    tables.orders = [{ id: 10, depot: 1 }]
    perm.hidden = new Set(['orders:10'])
    const reader = { user: { id: 'U2', role: 'R2' } as never, isAdmin: false }
    expect(await partnerNeeds({ collection: 'orders', item: '10', values: {} }, reader)).toBeNull()
  })

  it('a hidden deciding field decides nothing: no badge, no hint, whatever it holds', async () => {
    tables.nivaro_workflow_instances = [
      {
        collection: 'orders',
        item: '10',
        template: T,
        current_state: S.ready,
        completed_at: null,
        started_at: 1
      }
    ]
    // depot = 1 picks Alpha, but this reader may not read depot.
    tables.orders = [{ id: 10, ref: null, depot: 1, site: null }]
    perm.allowed = { orders: ['id', 'ref', 'site', 'contacts'], order_lines: ['id', 'sku', 'bin'] }
    const reader = { user: { id: 'U2', role: 'R2' } as never, isAdmin: false }
    const a = await partnerNeeds({ collection: 'orders', item: '10', values: {} }, reader)
    expect(a?.fields).toEqual({})
    expect(a?.hints).toEqual({})
    // Sending a value for it does not help either.
    const b = await partnerNeeds({ collection: 'orders', item: '10', values: { depot: 2 } }, reader)
    expect(b?.fields).toEqual({})
  })

  it('a lookup on a collection the caller cannot read never counts the push', async () => {
    perm.allowed = { orders: null, depots: [] }
    const reader = { user: { id: 'U2', role: 'R2' } as never, isAdmin: false }
    const a = await partnerNeeds({ collection: 'orders', item: null, values: { depot: 1 } }, reader)
    expect(a?.fields.ref).toBeUndefined()
    expect(a?.fields.due_date).toBeUndefined()
  })

  it('reported lines count only as new rows or as readable saved children of the record', async () => {
    tables.nivaro_workflow_instances = [
      {
        collection: 'orders',
        item: '10',
        template: T,
        current_state: S.ready,
        completed_at: null,
        started_at: 1
      }
    ]
    tables.orders = [{ id: 10, depot: 1 }]
    tables.order_lines = [
      { id: 102, order: 10, depot: 3, qty: 1 },
      { id: 900, order: 11, depot: 3, qty: 1 },
      { id: 103, order: 10, depot: 3, qty: 1 }
    ]
    perm.hidden = new Set(['order_lines:103'])
    const a = await partnerNeeds(
      {
        collection: 'orders',
        item: '10',
        values: {},
        lines: {
          'order_lines.order': [
            { key: '102', values: { depot: 3 } },
            { key: '900', values: { depot: 3 } }, // another record's line
            { key: '103', values: { depot: 3 } }, // a line this caller cannot see
            { key: 'pending:0', values: { depot: 3 } },
            { key: 'pending:x', values: { depot: 3 } },
            { key: "1' OR 1=1", values: { depot: 3 } }
          ]
        }
      },
      admin
    )
    expect(Object.keys(a?.lines['order_lines.order'].rows ?? {}).sort()).toEqual([
      '102',
      'pending:0'
    ])
  })

  it('lines are not judged on a column the caller may not read', async () => {
    tables.nivaro_workflow_instances = [
      {
        collection: 'orders',
        item: '10',
        template: T,
        current_state: S.ready,
        completed_at: null,
        started_at: 1
      }
    ]
    tables.orders = [{ id: 10, depot: 1 }]
    tables.order_lines = [{ id: 102, order: 10, depot: 3, qty: 1 }]
    // bin is readable, but Gamma picks its lines by depot, which is not.
    perm.allowed = { orders: null, order_lines: ['id', 'bin', 'sku'] }
    const reader = { user: { id: 'U2', role: 'R2' } as never, isAdmin: false }
    const a = await partnerNeeds({ collection: 'orders', item: '10', values: {} }, reader)
    expect(a?.lines['order_lines.order']?.rows['102']?.bin).toBeUndefined()
  })

  it('is off unless the collection turned it on', async () => {
    const mod = await import('./index.js')
    expect(mod.partnerBadgesOn({ partner_badges: true })).toBe(true)
    expect(mod.partnerBadgesOn('{"partner_badges":true}')).toBe(true)
    expect(mod.partnerBadgesOn(null)).toBe(false)
    expect(mod.partnerBadgesOn({ live_events: 'off' })).toBe(false)
  })
})

describe('countedTransitions', () => {
  it('without an order on the states, only the next moves count', async () => {
    const { countedTransitions } = await import('./index.js')
    const states = [
      { id: 'A', key: 'a', label: 'A', sort: 0, is_initial: true },
      { id: 'B', key: 'b', label: 'B', sort: 0, is_initial: false },
      { id: 'C', key: 'c', label: 'C', sort: 0, is_initial: false }
    ]
    const ts = [
      { id: '1', label: 'ab', from_state: 'A', to_state: 'B', actions: '[]', auto_trigger: false },
      { id: '2', label: 'bc', from_state: 'B', to_state: 'C', actions: '[]', auto_trigger: false }
    ]
    const r = countedTransitions(states, ts, 'A')
    expect(r.depth).toBe('next')
    expect(r.transitions.map((t) => t.id)).toEqual(['1'])
  })

  it('a send-back further on is not counted; one from the current state is', async () => {
    const { countedTransitions } = await import('./index.js')
    const states = [
      { id: 'A', key: 'a', label: 'A', sort: 1, is_initial: true },
      { id: 'B', key: 'b', label: 'B', sort: 2, is_initial: false },
      { id: 'C', key: 'c', label: 'C', sort: 3, is_initial: false }
    ]
    const ts = [
      { id: 'ab', label: '', from_state: 'A', to_state: 'B', actions: '', auto_trigger: false },
      { id: 'bc', label: '', from_state: 'B', to_state: 'C', actions: '', auto_trigger: false },
      { id: 'cb', label: '', from_state: 'C', to_state: 'B', actions: '', auto_trigger: false },
      { id: 'ba', label: '', from_state: 'B', to_state: 'A', actions: '', auto_trigger: false }
    ]
    expect(countedTransitions(states, ts, 'A').transitions.map((t) => t.id)).toEqual(['ab', 'bc'])
    expect(countedTransitions(states, ts, 'B').transitions.map((t) => t.id)).toEqual(['bc', 'ba'])
  })
})
