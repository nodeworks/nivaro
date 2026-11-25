import type { Knex } from 'knex'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// Hub link, app side: the request-log counts automatic rollback judges are this instance's own
// (several instances may share one database) and come from one bounded read per source.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  return { db, migrationsDir: '/nowhere' }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { recentFigures } = await import('../../../services/hub-link/release-figures.js')

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000)

beforeAll(async () => {
  await db.schema.createTable('nivaro_api_logs', (t) => {
    t.increments('id')
    t.integer('status')
    t.string('instance', 60)
    t.dateTime('created_at')
  })
  await db.schema.createTable('nivaro_issue_occurrences', (t) => {
    t.increments('id')
    t.string('source', 10)
    t.dateTime('occurred_at')
  })
  await db('nivaro_api_logs').insert([
    { status: 200, instance: 'slot-a', created_at: ago(1) },
    { status: 502, instance: 'slot-a', created_at: ago(2) },
    { status: 500, instance: 'slot-b', created_at: ago(2) },
    { status: 500, instance: 'slot-a', created_at: ago(30) }
  ])
  await db('nivaro_issue_occurrences').insert([
    { source: 'client', occurred_at: ago(1) },
    { source: 'server', occurred_at: ago(1) }
  ])
})

describe('recentFigures', () => {
  it('counts this instance only, over the window, through the bounded runner', async () => {
    const ran: string[] = []
    const out = await recentFigures(10, {
      run: async (q) => {
        ran.push(q.toSQL().sql)
        return (await q) as Array<Record<string, unknown>>
      },
      instance: async () => 'slot-a'
    })
    expect(out).toEqual({ minutes: 10, requests: 2, errors_5xx: 1, crashes: 1 })
    expect(ran).toHaveLength(2)
  })

  it('without the instance column counts every row; a failed read is null', async () => {
    const out = await recentFigures(10, {
      run: async (q) => {
        if (q.toSQL().sql.includes('nivaro_issue_occurrences')) throw new Error('cancelled')
        return (await q) as Array<Record<string, unknown>>
      },
      instance: async () => null
    })
    expect(out).toEqual({ minutes: 10, requests: 3, errors_5xx: 2, crashes: null })
  })
})
