import { readFileSync } from 'node:fs'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const fake = vi.hoisted(() => {
  const tables: Record<string, Row[]> = {}
  let nextId = 500
  let transactions = 0
  type Cond = (r: Row) => boolean
  const eq = (a: unknown, b: unknown) => String(a) === String(b)
  const q = (table: string) => {
    const conds: Cond[] = []
    let order: { col: string; desc: boolean } | null = null
    const rows = () => {
      const out = (tables[table] ?? []).filter((r) => conds.every((c) => c(r)))
      if (order) {
        const { col, desc } = order
        out.sort((a, b) => (Number(a[col]) - Number(b[col])) * (desc ? -1 : 1))
      }
      return out
    }
    const api: Record<string, unknown> = {
      where(a: Row | string, op?: string, v?: unknown) {
        if (typeof a === 'string') {
          conds.push((r) => {
            const x = r[a] instanceof Date ? (r[a] as Date).getTime() : r[a]
            const y = v instanceof Date ? v.getTime() : v
            return op === '>=' ? (x as number) >= (y as number) : eq(x, y)
          })
        } else conds.push((r) => Object.entries(a).every(([k, val]) => eq(r[k], val)))
        return api
      },
      whereNot(w: Row) {
        conds.push((r) => !Object.entries(w).every(([k, val]) => eq(r[k], val)))
        return api
      },
      whereNotNull(c: string) {
        conds.push((r) => r[c] != null)
        return api
      },
      whereIn(c: string, vs: unknown[]) {
        conds.push((r) => vs.some((v) => eq(r[c], v)))
        return api
      },
      select() {
        return api
      },
      orderBy(col: unknown, dir?: string) {
        if (typeof col === 'string') order = { col, desc: dir === 'desc' }
        return api
      },
      first: async () => {
        const r = rows()[0]
        return r ? { ...r } : undefined
      },
      delete: async () => {
        const drop = new Set(rows())
        tables[table] = (tables[table] ?? []).filter((r) => !drop.has(r))
      },
      update: async (p: Row) => {
        for (const r of rows()) Object.assign(r, p)
      },
      insert: async (p: Row) => {
        tables[table] = tables[table] ?? []
        tables[table].push({ id: nextId++, ...p })
      },
      // biome-ignore lint/suspicious/noThenProperty: the fake query builder is awaited like knex's
      then: (res: (v: Row[]) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve(
          rows()
            .map((r) => ({ ...r }))
            .sort(
              (a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0) || Number(a.id) - Number(b.id)
            )
        ).then(res, rej)
    }
    return api
  }
  const db = Object.assign((t: string) => q(t), {
    raw: async () => [],
    transaction: async (cb: (t: unknown) => unknown) => {
      transactions++
      return cb(db)
    }
  })
  const reset = (init: Record<string, Row[]>) => {
    for (const k of Object.keys(tables)) delete tables[k]
    for (const [k, v] of Object.entries(init)) tables[k] = v.map((r) => ({ ...r }))
    transactions = 0
  }
  // Stands in for the snapshot hash: changes whenever the layout's rows do.
  const stateOf = (layoutId: number) =>
    JSON.stringify({
      l: (tables.nivaro_collection_layouts ?? []).filter((r) => eq(r.id, layoutId)),
      g: (tables.nivaro_field_groups ?? []).filter((r) => eq(r.layout_id, layoutId)),
      a: (tables.nivaro_layout_field_assignments ?? []).filter((r) => eq(r.layout_id, layoutId))
    })
  const resetCount = () => {
    transactions = 0
  }
  return { db, tables, reset, resetCount, stateOf, transactions: () => transactions }
})

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async () => {}),
  requireAdmin: vi.fn(async (req: { user?: { id: string }; isAdmin?: boolean }) => {
    req.user = { id: 'test-admin' }
    req.isAdmin = true
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: fake.db }))
vi.mock('../../../services/layout-versions.js', () => ({
  snapshotLayoutVersion: vi.fn(async () => {}),
  restoreLayoutVersion: vi.fn(async () => {}),
  layoutStateHash: vi.fn(async (id: number) => `h:${fake.stateOf(id).length}:${fake.stateOf(id)}`)
}))

import { collectionLayoutsRoutes } from '../../../routes/collection-layouts.js'
import {
  applyLayoutOps,
  type LayoutBundle,
  type LayoutOp,
  LayoutOpError
} from '../../../services/layout-ops-apply.js'
import { snapshotLayoutVersion } from '../../../services/layout-versions.js'

const SHARED_TWIN = new URL('../../../../../packages/shared/src/lib/layout-ops.ts', import.meta.url)
const API_TWIN = new URL('../../../services/layout-ops-apply.ts', import.meta.url)
const FIXTURES = new URL(
  '../../../../../packages/shared/src/lib/layout-ops.fixtures.json',
  import.meta.url
)

describe('applyLayoutOps (api twin)', () => {
  it('is byte-identical to the packages/shared twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(SHARED_TWIN, 'utf8'))
  })

  const { cases } = JSON.parse(readFileSync(FIXTURES, 'utf8')) as {
    cases: Array<{
      name: string
      before: LayoutBundle
      ops: LayoutOp[]
      after?: Omit<LayoutBundle, 'rev'>
      error?: { op_index: number }
    }>
  }
  for (const c of cases) {
    it(`fixture: ${c.name}`, () => {
      if (c.error) {
        let caught: unknown
        try {
          applyLayoutOps(c.before, c.ops)
        } catch (e) {
          caught = e
        }
        expect(caught).toBeInstanceOf(LayoutOpError)
        expect((caught as LayoutOpError).op_index).toBe(c.error.op_index)
        return
      }
      const { rev: _rev, ...result } = applyLayoutOps(c.before, c.ops)
      expect(result).toEqual(c.after)
    })
  }
})

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  app.register(collectionLayoutsRoutes, { prefix: '/collection-layouts' })
  await app.ready()
  const res = await app.inject({ method, url, payload: payload as Record<string, unknown> })
  await app.close()
  return res
}

const asg = (id: number, field: string, group_key: string | null, sort: number, x: Row = {}) => ({
  id,
  layout_id: 1,
  field,
  group_key,
  sort,
  is_visible: true,
  default_expanded: true,
  allow_revision_restore: true,
  ...x
})
const grp = (id: number, key: string, type: string, sort: number, x: Row = {}) => ({
  id,
  layout_id: 1,
  collection: 'orders',
  key,
  label: key,
  type,
  sort,
  is_collapsed: false,
  container_id: null,
  visibility_mode: 'always',
  ...x
})
const assignments = () => fake.tables.nivaro_layout_field_assignments
const groups = () => fake.tables.nivaro_field_groups
const find = (field: string, gk: string | null) =>
  assignments().find((r) => r.field === field && (r.group_key ?? null) === gk)

async function bundle(): Promise<LayoutBundle> {
  const res = await call('GET', '/collection-layouts/1/bundle')
  expect(res.statusCode).toBe(200)
  return res.json() as LayoutBundle
}
async function ops(list: unknown[], base_rev?: string) {
  const rev = base_rev ?? (await bundle()).rev
  fake.resetCount()
  vi.mocked(snapshotLayoutVersion).mockClear()
  return call('POST', '/collection-layouts/1/ops', { ops: list, base_rev: rev })
}

beforeEach(() => {
  vi.mocked(snapshotLayoutVersion).mockClear()
  fake.reset({
    nivaro_collection_layouts: [
      {
        id: 1,
        collection: 'orders',
        name: 'Main',
        slug: 'main',
        layout_type: 'grouped',
        is_active: true
      },
      {
        id: 2,
        collection: 'orders',
        name: 'Other',
        slug: 'other',
        layout_type: 'grouped',
        is_active: false
      }
    ],
    nivaro_field_groups: [
      grp(10, 'main', 'section', 0),
      grp(11, 'details', 'section', 1),
      grp(13, 'tabs', 'container', 3, { tab_mode: 'tabs' }),
      grp(14, 't1', 'tab', 0, { container_id: 13 })
    ],
    nivaro_layout_field_assignments: [
      asg(1, 'notes', null, 0),
      asg(2, '__ungrouped_pos__', null, 2),
      asg(3, '__pipeline__', null, 4),
      asg(4, 'a', '__header__', 0, { col_span: 4, overrides: '{"x":1}' }),
      asg(5, 'a', 'main', 0),
      asg(6, 'b', 'main', 1),
      asg(7, 'd', 'details', 0),
      asg(8, 'f', 't1', 0)
    ],
    nivaro_layout_versions: []
  })
})

describe('GET /collection-layouts/:id/bundle', () => {
  it('returns groups by key, the Ungrouped position and a rev', async () => {
    const b = await bundle()
    expect(b.rev).toMatch(/^h:/)
    expect(b.groups.find((g) => g.key === 't1')?.parent_key).toBe('tabs')
    expect(b.groups.find((g) => g.key === '__ungrouped__')?.sort).toBe(2)
    expect(b.placements.some((p) => p.field === '__ungrouped_pos__')).toBe(false)
    expect(b.placements.find((p) => p.group_key === '__header__')?.overrides).toEqual({ x: 1 })
  })
})

describe('POST /collection-layouts/:id/ops', () => {
  it('applies all ops in one transaction and snapshots once', async () => {
    const res = await ops([
      { op: 'move', from: { field: 'b', group_key: 'main' }, to_group_key: 'main', index: 0 },
      { op: 'place', field: 'g', group_key: 'details', index: 0, patch: { col_span: 6 } },
      { op: 'group_update', key: 'main', patch: { label: 'General' } },
      { op: 'layout_update', patch: { name: 'Main form' } }
    ])
    expect(res.statusCode).toBe(200)
    expect(fake.transactions()).toBe(1)
    expect(vi.mocked(snapshotLayoutVersion)).toHaveBeenCalledTimes(1)
    expect(find('b', 'main')?.sort).toBe(0)
    expect(find('a', 'main')?.sort).toBe(1)
    expect(find('g', 'details')).toMatchObject({ sort: 0, col_span: 6 })
    expect(find('d', 'details')?.sort).toBe(1)
    expect(groups().find((g) => g.key === 'main')?.label).toBe('General')
    expect(fake.tables.nivaro_collection_layouts[0].name).toBe('Main form')
    const body = res.json() as LayoutBundle
    expect(body.rev).toBe((await bundle()).rev)
  })

  it('rejects ops against a stale rev', async () => {
    const before = JSON.stringify(fake.tables)
    const res = await ops(
      [{ op: 'remove', at: { field: 'b', group_key: 'main' } }],
      'rev-from-another-tab'
    )
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string; bundle: LayoutBundle }
    expect(body.error).toBe('stale')
    expect(body.bundle.rev).toBe((await bundle()).rev)
    expect(body.bundle.placements.some((p) => p.field === 'b')).toBe(true)
    expect(JSON.stringify(fake.tables)).toBe(before)
    expect(vi.mocked(snapshotLayoutVersion)).not.toHaveBeenCalled()
  })

  it('rejects unknown op with op_index', async () => {
    const before = JSON.stringify(fake.tables)
    const res = await ops([
      { op: 'remove', at: { field: 'b', group_key: 'main' } },
      { op: 'teleport', key: 'main' }
    ])
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ op_index: 1 })
    expect(JSON.stringify(fake.tables)).toBe(before)
  })

  it('rejects an invalid layout setting with its op_index', async () => {
    const res = await ops([
      { op: 'group_update', key: 'main', patch: { label: 'X' } },
      { op: 'layout_update', patch: { sheet_width: 10 } }
    ])
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ op_index: 1 })
    expect(groups().find((g) => g.key === 'main')?.label).toBe('main')
  })

  it('coalesces snapshots within 2 minutes per layout+user', async () => {
    const ago = (ms: number) => new Date(Date.now() - ms)
    const v = (version: number, layout_id: number, created_by: string, ms: number) => ({
      id: version * 10 + layout_id,
      version,
      layout_id,
      created_by,
      created_at: ago(ms)
    })
    const move = (index: number) => ({
      op: 'move',
      from: { field: 'b', group_key: 'main' },
      to_group_key: 'main',
      index
    })
    const snapsFor = async (versions: Row[], index: number) => {
      fake.tables.nivaro_layout_versions = versions
      expect((await ops([move(index)])).statusCode).toBe(200)
      return vi.mocked(snapshotLayoutVersion).mock.calls.length
    }
    // The newest version is this user's, 60 s old: same burst, no snapshot.
    expect(await snapsFor([v(1, 1, 'test-admin', 60_000), v(5, 2, 'x', 1_000)], 0)).toBe(0)
    // Someone else saved since (newest is theirs): snapshot their state.
    expect(
      await snapsFor([v(1, 1, 'test-admin', 60_000), v(2, 1, 'someone-else', 10_000)], 1)
    ).toBe(1)
    // This user's newest version is older than 2 minutes: snapshot.
    expect(await snapsFor([v(1, 1, 'test-admin', 180_000)], 0)).toBe(1)
  })

  it('moves one twin without touching the other', async () => {
    const res = await ops([
      { op: 'move', from: { field: 'a', group_key: 'main' }, to_group_key: 'details', index: 0 }
    ])
    expect(res.statusCode).toBe(200)
    expect(find('a', '__header__')).toMatchObject({ id: 4, sort: 0, col_span: 4 })
    expect(find('a', 'details')?.sort).toBe(0)
    expect(find('a', 'main')).toBeUndefined()
  })

  it('writes group nesting by id and unhooks a removed container', async () => {
    let res = await ops([
      {
        op: 'group_create',
        key: 't2',
        label: 'Two',
        group_type: 'tab',
        parent_key: 'tabs',
        index: 1
      }
    ])
    expect(res.statusCode).toBe(200)
    const t2 = groups().find((g) => g.key === 't2')
    expect(t2).toMatchObject({ container_id: 13, sort: 1, collection: 'orders', layout_id: 1 })

    res = await ops([{ op: 'group_remove', key: 'tabs', placements: 'ungroup' }])
    expect(res.statusCode).toBe(200)
    expect(groups().find((g) => g.key === 'tabs')).toBeUndefined()
    expect(groups().find((g) => g.key === 't1')?.container_id).toBeNull()
    expect(groups().find((g) => g.key === 't2')?.container_id).toBeNull()
  })

  it('stores the Ungrouped position in the __ungrouped_pos__ row', async () => {
    const res = await ops([{ op: 'group_move', key: '__ungrouped__', parent_key: null, index: 0 }])
    expect(res.statusCode).toBe(200)
    expect(assignments().filter((r) => r.field === '__ungrouped_pos__')).toHaveLength(1)
    expect(find('__ungrouped_pos__', null)?.sort).toBe(0)
    expect(groups().find((g) => g.key === 'main')?.sort).toBe(1)
  })

  it('activates through the activate rule', async () => {
    fake.tables.nivaro_collection_layouts[0].is_active = false
    fake.tables.nivaro_collection_layouts[1].is_active = true
    const res = await ops([{ op: 'layout_update', patch: { is_active: true } }])
    expect(res.statusCode).toBe(200)
    expect(fake.tables.nivaro_collection_layouts.map((l) => l.is_active)).toEqual([1, 0])
  })

  it('writes nothing for a batch that changes nothing', async () => {
    const res = await ops([])
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(snapshotLayoutVersion)).not.toHaveBeenCalled()
  })
})
