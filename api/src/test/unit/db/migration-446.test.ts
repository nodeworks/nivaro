import { describe, expect, it, vi } from 'vitest'
import { down, up } from '../../../db/migrations/446_ideas.js'

type Row = Record<string, unknown>

/** In-memory knex: tables are row arrays; where() matches equal columns. */
function fakeKnex(roles: Row[]) {
  const tables = new Map<string, Row[]>([
    ['nivaro_collections', []],
    ['nivaro_fields', []],
    ['nivaro_relations', []],
    ['nivaro_policies', []],
    ['nivaro_record_links', []],
    ['nivaro_roles', roles]
  ])
  const physical = new Set<string>()
  const matches = (row: Row, conds: Row[]) =>
    conds.length === 0 || conds.some((c) => Object.entries(c).every(([k, v]) => row[k] === v))
  const knex = (name: string) => {
    let conds: Row[] = []
    const rows = () => tables.get(name) ?? []
    const q = {
      where(c: Row) {
        conds = [c]
        return q
      },
      orWhere(c: Row) {
        conds.push(c)
        return q
      },
      async first() {
        return rows().find((r) => matches(r, conds))
      },
      async select() {
        return rows().filter((r) => matches(r, conds))
      },
      async insert(row: Row) {
        rows().push(row)
      },
      async delete() {
        tables.set(
          name,
          rows().filter((r) => !matches(r, conds))
        )
      }
    }
    return q
  }
  Object.assign(knex, {
    raw: vi.fn(() => 'now'),
    client: { config: { client: 'mssql' } },
    schema: {
      hasTable: vi.fn(async (n: string) => physical.has(n)),
      createTable: vi.fn(async (n: string) => void physical.add(n)),
      dropTable: vi.fn(async (n: string) => void physical.delete(n))
    }
  })
  return { knex: knex as never, tables, physical }
}

describe('migration 446', () => {
  it('registers ideas as a non-system collection, idempotently, and rolls back cleanly', async () => {
    const f = fakeKnex([
      { id: 'admin', admin_access: true },
      { id: 'staff', admin_access: false }
    ])
    await up(f.knex)
    await up(f.knex)

    expect(f.physical).toEqual(new Set(['ideas', 'nivaro_idea_votes']))
    const cols = f.tables.get('nivaro_collections')!
    expect(cols.map((c) => c.collection)).toEqual(['ideas'])
    expect(String(cols[0].collection)).not.toMatch(/^nivaro_/)
    const fields = f.tables.get('nivaro_fields')!.map((r) => r.field)
    expect(fields).toEqual(
      expect.arrayContaining([
        'title',
        'description',
        'status',
        'status_note',
        'merged_into',
        'vote_count',
        'created_by'
      ])
    )
    expect(new Set(fields).size).toBe(fields.length)
    expect(f.tables.get('nivaro_relations')).toHaveLength(2)
    // Only the non-admin role needs grants — admins pass every check.
    expect(
      f.tables
        .get('nivaro_policies')!
        .map((p) => `${p.role}:${p.action}`)
        .sort()
    ).toEqual(['staff:create', 'staff:read'])

    f.tables
      .get('nivaro_record_links')!
      .push({ from_collection: 'ideas', to_collection: 'backlog' })
    await down(f.knex)
    expect(f.physical.size).toBe(0)
    for (const t of [
      'nivaro_collections',
      'nivaro_fields',
      'nivaro_relations',
      'nivaro_policies',
      'nivaro_record_links'
    ]) {
      expect(f.tables.get(t)).toEqual([])
    }
  })
})
