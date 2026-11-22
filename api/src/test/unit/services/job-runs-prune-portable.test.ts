import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import knex, { type Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Review Minor 2: the daily job-run prune kept "the newest 50 per job" with
// `WITH ranked … DELETE FROM ranked`, which only SQL Server accepts. On SQLite, Postgres, MySQL
// and MariaDB apps the error was swallowed and only the 30-day cut applied. Now one portable
// DELETE … WHERE id IN (SELECT id FROM (… ROW_NUMBER() …) r WHERE rn > ?). Run on a real SQLite
// database; the other engines are checked by the SQL each one is sent.

const dir = mkdtempSync(join(tmpdir(), 'nvr-jobprune-'))
const sqlite: Knex = knex({
  client: 'better-sqlite3',
  connection: { filename: join(dir, 'db.sqlite') },
  useNullAsDefault: true
})
const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    get: (_t, p) => Reflect.get(holder.db as object, p),
    apply: (_t, _this, args) => (holder.db as (...a: unknown[]) => unknown)(...args)
  })
}))
holder.db = sqlite
const { pruneJobRuns } = await import('../../../services/job-runs.js')

beforeAll(async () => {
  await sqlite.schema.createTable('nivaro_job_runs', (t) => {
    t.increments('id')
    t.string('kind')
    t.string('job_id')
    t.datetime('started_at')
  })
})
afterAll(async () => {
  await sqlite.destroy()
  rmSync(dir, { recursive: true, force: true })
})

describe('pruneJobRuns keeps the newest N per job on every engine', () => {
  it('SQLite: newest 3 per (kind, job) stay, older and >30-day rows go', async () => {
    const now = Date.now()
    const rows: Array<Record<string, unknown>> = []
    for (let i = 0; i < 6; i++)
      rows.push({ kind: 'cron', job_id: 'a', started_at: new Date(now - i) })
    for (let i = 0; i < 2; i++)
      rows.push({ kind: 'cron', job_id: 'b', started_at: new Date(now - i) })
    for (let i = 0; i < 4; i++)
      rows.push({ kind: 'render', job_id: 'a', started_at: new Date(now) })
    rows.push({ kind: 'cron', job_id: 'old', started_at: new Date(now - 40 * 86_400_000) })
    await sqlite('nivaro_job_runs').insert(rows)
    const deleted = await pruneJobRuns(3, 30)
    // 1 too old, then 3 of cron/a and 1 of render/a over the cap
    expect(deleted).toBe(5)
    const left = (await sqlite('nivaro_job_runs')
      .select('kind', 'job_id')
      .count({ n: '*' })
      .groupBy('kind', 'job_id')
      .orderBy(['kind', 'job_id'])) as Array<{ kind: string; job_id: string; n: number }>
    expect(left.map((r) => [r.kind, r.job_id, Number(r.n)])).toEqual([
      ['cron', 'a', 3],
      ['cron', 'b', 2],
      ['render', 'a', 3]
    ])
    // the newest (highest) ids are the ones kept
    const kept = (await sqlite('nivaro_job_runs')
      .where({ kind: 'cron', job_id: 'a' })
      .pluck('id')) as number[]
    expect(kept.sort((x, y) => x - y)).toEqual([4, 5, 6])
  })

  it.each([
    'pg',
    'mysql2',
    'mssql'
  ])('%s is sent a DELETE … IN (derived table), never a CTE delete', async (client) => {
    const sent: string[] = []
    const k = knex({ client })
    const wrapped = new Proxy(k, {
      apply: (_t, _this, args: [string]) => {
        const qb = k(args[0])
        const origDel = qb.del.bind(qb)
        ;(qb as unknown as { del: () => Promise<number> }).del = async () => {
          sent.push(origDel().toQuery())
          return 0
        }
        return qb
      }
    })
    holder.db = wrapped
    try {
      await pruneJobRuns(50, 30)
    } finally {
      holder.db = sqlite
      await k.destroy()
    }
    const keep = sent.find((s) => /row_number/i.test(s))
    expect(keep).toBeDefined()
    expect(keep).toMatch(/^delete from/i)
    expect(keep).toMatch(/row_number\(\) over \(partition by [`"[]?kind/i)
    expect(keep).not.toMatch(/^\s*with\b/i)
  })
})
