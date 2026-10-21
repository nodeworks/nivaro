import { describe, expect, it, vi } from 'vitest'

// Pure helpers only: the db is never reached.
vi.mock('../../../db/index.js', () => ({ db: {} }))

const { down, up } = await import('../../../db/migrations/457_layout_named_versions_schedules.js')
const { foldScheduled, parseRunAt } = await import('../../../services/layout-schedules.js')
const { snapshotToBundle } = await import('../../../services/layout-ops.js')
const { cleanVersionName, sectionChangesFrom, sectionSignatures } = await import(
  '../../../services/layout-versions.js'
)

type Snap = Parameters<typeof sectionSignatures>[0]

const group = (id: number, key: string, extra: Record<string, unknown> = {}) => ({
  id,
  layout_id: 1,
  key,
  label: key,
  type: 'section',
  sort: id,
  container_id: null,
  ...extra
})
const asg = (id: number, field: string, group_key: string | null, sort: number, extra = {}) => ({
  id,
  layout_id: 1,
  field,
  group_key,
  sort,
  col_span: 6,
  ...extra
})
const snap = (
  groups: Array<Record<string, unknown>>,
  assignments: Array<Record<string, unknown>>
): Snap => ({
  layout: { id: 1, collection: 'orders', name: 'Main', layout_type: 'grouped' },
  groups,
  assignments
})

describe('sectionSignatures', () => {
  it('ignores sort renumbering and ids, sees settings and field order', () => {
    const a = snap([group(1, 'basic'), group(2, 'money')], [asg(10, 'name', 'basic', 0)])
    const b = snap(
      [group(1, 'basic', { sort: 5 }), group(2, 'money')],
      [asg(99, 'name', 'basic', 3)]
    )
    expect(sectionSignatures(a).get('basic')).toBe(sectionSignatures(b).get('basic'))
    const c = snap([group(1, 'basic', { label: 'Basics' }), group(2, 'money')], [])
    expect(sectionSignatures(c).get('basic')).not.toBe(sectionSignatures(a).get('basic'))
    expect(sectionSignatures(a).get('money')).toBe(sectionSignatures(c).get('money'))
  })

  it('puts fields outside sections under the ungrouped key', () => {
    const s = snap([], [asg(1, 'name', null, 0), asg(2, '__ungrouped_pos__', null, 4)])
    expect([...sectionSignatures(s).keys()]).toEqual(['__ungrouped__'])
  })
})

describe('sectionChangesFrom', () => {
  it('names who changed each section, the latest change winning', () => {
    const v1 = snap([group(1, 'basic'), group(2, 'money')], [asg(10, 'name', 'basic', 0)])
    const v2 = snap(
      [group(1, 'basic', { label: 'Basics' }), group(2, 'money')],
      [asg(10, 'name', 'basic', 0)]
    )
    const now = snap(
      [group(1, 'basic', { label: 'Basics' }), group(2, 'money')],
      [asg(10, 'name', 'basic', 0), asg(11, 'amount', 'money', 0)]
    )
    const out = sectionChangesFrom(
      [
        { created_by: 'u1', created_by_name: 'Ann', created_at: '2026-10-01T10:00:00Z', snap: v1 },
        { created_by: 'u2', created_by_name: 'Bo', created_at: '2026-10-02T10:00:00Z', snap: v2 }
      ],
      now
    )
    expect(out.basic).toEqual({ by: 'Ann', by_id: 'u1', at: '2026-10-01T10:00:00Z' })
    expect(out.money).toEqual({ by: 'Bo', by_id: 'u2', at: '2026-10-02T10:00:00Z' })
  })

  it('leaves out sections that are gone and sections nobody touched', () => {
    const v1 = snap([group(1, 'basic'), group(2, 'old')], [])
    const now = snap([group(1, 'basic')], [])
    expect(
      sectionChangesFrom(
        [{ created_by: 'u1', created_by_name: '', created_at: null, snap: v1 }],
        now
      )
    ).toEqual({})
  })

  it('a section added since a version is that person’s change', () => {
    const v1 = snap([group(1, 'basic')], [])
    const now = snap([group(1, 'basic'), group(3, 'extra')], [])
    const out = sectionChangesFrom(
      [{ created_by: 'u1', created_by_name: 'Ann', created_at: new Date(0), snap: v1 }],
      now
    )
    expect(Object.keys(out)).toEqual(['extra'])
    expect(out.extra.at).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('snapshotToBundle', () => {
  it('turns stored rows into the editor bundle (nesting by key, order by sort)', () => {
    const b = snapshotToBundle(
      snap(
        [group(2, 'tabs', { type: 'tab_group', sort: 0 }), group(3, 't1', { container_id: 2 })],
        [asg(11, 'b', 't1', 2), asg(10, 'a', 't1', 1)]
      ),
      'version:7'
    )
    expect(b.rev).toBe('version:7')
    expect(b.groups.find((g) => g.key === 't1')?.parent_key).toBe('tabs')
    expect(b.placements.map((p) => p.field)).toEqual(['a', 'b'])
    expect(b.groups.some((g) => g.key === '__ungrouped__')).toBe(true)
  })
})

describe('named versions', () => {
  it('cleans names: trimmed, collapsed, capped; empty unnames', () => {
    expect(cleanVersionName('  go-live   baseline ')).toBe('go-live baseline')
    expect(cleanVersionName('')).toBeNull()
    expect(cleanVersionName(null)).toBeNull()
    expect(cleanVersionName(5)).toBeNull()
    expect(cleanVersionName('x'.repeat(300))?.length).toBe(120)
  })
})

describe('scheduled changes', () => {
  const now = new Date('2026-10-20T12:00:00Z')
  it('takes a future time, refuses the past and junk', () => {
    expect(parseRunAt('2026-10-21T09:00:00Z', now).toISOString()).toBe('2026-10-21T09:00:00.000Z')
    expect(() => parseRunAt('2026-10-19T09:00:00Z', now)).toThrow(/future/)
    expect(() => parseRunAt('soon', now)).toThrow(/date/)
    expect(() => parseRunAt('2028-01-01T00:00:00Z', now)).toThrow(/year/)
  })

  it('folds ops onto the layout as it is now: null when they all fit', () => {
    const bundle = snapshotToBundle(snap([group(1, 'basic')], [asg(10, 'name', 'basic', 0)]), 'r')
    expect(
      foldScheduled(bundle, [
        {
          op: 'update_placement',
          at: { field: 'name', group_key: 'basic' },
          patch: { col_span: 12 }
        }
      ])
    ).toBeNull()
    expect(
      foldScheduled(bundle, [
        {
          op: 'update_placement',
          at: { field: 'gone', group_key: 'basic' },
          patch: { col_span: 12 }
        }
      ])
    ).toMatch(/gone/)
  })
})

describe('migration 457', () => {
  function fakeKnex(has: { table: boolean; column: boolean; schedules: boolean }) {
    const calls: string[] = []
    const knex = {
      schema: {
        hasTable: vi.fn(async (t: string) =>
          t === 'nivaro_layout_schedules' ? has.schedules : has.table
        ),
        hasColumn: vi.fn(async () => has.column),
        alterTable: vi.fn(async (t: string) => calls.push(`alter ${t}`)),
        createTable: vi.fn(async (t: string) => calls.push(`create ${t}`)),
        dropTable: vi.fn(async (t: string) => calls.push(`drop ${t}`))
      }
    }
    return { knex: knex as never, calls }
  }

  it('adds the name column and the schedules table when missing', async () => {
    const { knex, calls } = fakeKnex({ table: true, column: false, schedules: false })
    await up(knex)
    expect(calls).toEqual(['alter nivaro_layout_versions', 'create nivaro_layout_schedules'])
  })

  it('is re-run safe', async () => {
    const { knex, calls } = fakeKnex({ table: true, column: true, schedules: true })
    await up(knex)
    expect(calls).toEqual([])
  })

  it('down drops only what it added', async () => {
    const { knex, calls } = fakeKnex({ table: true, column: true, schedules: true })
    await down(knex)
    expect(calls).toEqual(['drop nivaro_layout_schedules', 'alter nivaro_layout_versions'])
  })
})
