import { describe, expect, it, vi } from 'vitest'
import { down, up } from './445_issue_occurrences.js'

function fakeKnex(exists: boolean) {
  const created: string[] = []
  const dropped: string[] = []
  const knex = {
    raw: vi.fn(() => 'now'),
    client: { config: { client: 'mssql' } },
    schema: {
      hasTable: vi.fn(async () => exists),
      createTable: vi.fn(async (name: string) => {
        created.push(name)
      }),
      dropTable: vi.fn(async (name: string) => {
        dropped.push(name)
      })
    }
  }
  return { knex: knex as never, created, dropped }
}

describe('migration 445', () => {
  it('creates the table once and is a no-op when it exists', async () => {
    const a = fakeKnex(false)
    await up(a.knex)
    expect(a.created).toEqual(['nivaro_issue_occurrences'])
    const b = fakeKnex(true)
    await up(b.knex)
    expect(b.created).toEqual([])
  })

  it('down only drops an existing table', async () => {
    const a = fakeKnex(true)
    await down(a.knex)
    expect(a.dropped).toEqual(['nivaro_issue_occurrences'])
    const b = fakeKnex(false)
    await down(b.knex)
    expect(b.dropped).toEqual([])
  })
})
