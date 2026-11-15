import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/dialect.js', () => ({ utcNow: () => 'utc-now', isMssql: () => true }))

const { down, up } = await import('../../../db/migrations/530_reload_trust.js')

/** Fake knex schema: which tables/columns exist and what each step did. */
function fakeKnex(tables: Record<string, string[]>) {
  const have = new Map(Object.entries(tables).map(([t, c]) => [t, new Set(c)]))
  const added: string[] = []
  const dropped: string[] = []
  const created: string[] = []
  const col = () => {
    const c = {
      nullable: () => c,
      notNullable: () => c,
      defaultTo: () => c,
      primary: () => c
    }
    return c
  }
  const builder = (table: string) => ({
    string(name: string) {
      added.push(`${table}.${name}`)
      have.get(table)?.add(name)
      return col()
    },
    bigIncrements: () => col(),
    integer: () => col(),
    bigInteger: () => col(),
    datetime: () => col(),
    unique: vi.fn(),
    index: vi.fn(),
    dropColumn(name: string) {
      dropped.push(`${table}.${name}`)
      have.get(table)?.delete(name)
    }
  })
  const schema = {
    hasTable: vi.fn(async (t: string) => have.has(t)),
    hasColumn: vi.fn(async (t: string, c: string) => have.get(t)?.has(c) ?? false),
    alterTable: vi.fn(async (t: string, cb: (b: unknown) => void) => cb(builder(t))),
    createTable: vi.fn(async (t: string, cb: (b: unknown) => void) => {
      created.push(t)
      have.set(t, new Set())
      cb(builder(t))
    }),
    dropTableIfExists: vi.fn(async (t: string) => {
      have.delete(t)
      dropped.push(t)
    })
  }
  return { knex: { schema } as never, added, dropped, created, have }
}

describe('migration 530 — reload trust', () => {
  it('adds the three rum columns and the aggregates table once', async () => {
    const f = fakeKnex({ nivaro_rum_events: ['id', 'route'] })
    await up(f.knex)
    expect(f.added.filter((a) => a.startsWith('nivaro_rum_events.'))).toEqual([
      'nivaro_rum_events.nav_type',
      'nivaro_rum_events.prev_route',
      'nivaro_rum_events.release'
    ])
    expect(f.created).toEqual(['nivaro_missed_updates'])
    const before = f.added.length
    await up(f.knex)
    expect(f.added.length).toBe(before)
    expect(f.created).toEqual(['nivaro_missed_updates'])
  })

  it('skips the rum columns when the rum table is missing', async () => {
    const f = fakeKnex({})
    await up(f.knex)
    expect(f.added.some((a) => a.startsWith('nivaro_rum_events.'))).toBe(false)
    expect(f.created).toEqual(['nivaro_missed_updates'])
  })

  it('down removes only what it added', async () => {
    const f = fakeKnex({
      nivaro_rum_events: ['id', 'route', 'nav_type', 'prev_route', 'release'],
      nivaro_missed_updates: ['id']
    })
    await down(f.knex)
    expect(f.dropped).toEqual([
      'nivaro_missed_updates',
      'nivaro_rum_events.nav_type',
      'nivaro_rum_events.prev_route',
      'nivaro_rum_events.release'
    ])
    expect(f.have.get('nivaro_rum_events')?.has('route')).toBe(true)
  })
})
