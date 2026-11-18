import knexFactory, { type Knex } from 'knex'
import { afterAll, describe, expect, it } from 'vitest'
import { relayHealth } from '../mail-stats.js'
import { buildRegistry, resolveWindow } from './model.js'
import { sqlExecutor } from './query.js'
import { BREAKDOWN_DIMS, buildBreakdown, buildSplit, buildSummary, type Cell } from './summary.js'

/**
 * Integration: every number the summary shows equals the row count of its
 * drill, on a REAL SQL Server database (read-only). Off unless
 * DELIVERY_ANALYTICS_IT=1; connection from DB_HOST / DB_PORT / DB_USER /
 * DB_PASSWORD and DELIVERY_ANALYTICS_IT_DB (the database to read).
 */
const on = process.env.DELIVERY_ANALYTICS_IT === '1'

function collectCells(v: unknown, out: Array<{ path: string; cell: Cell }>, path = ''): void {
  if (!v || typeof v !== 'object') return
  const o = v as Record<string, unknown>
  if (typeof o.n === 'number' && typeof o.s === 'string' && Array.isArray(o.w)) {
    out.push({ path, cell: o as unknown as Cell })
    return
  }
  for (const [k, x] of Object.entries(o)) collectCells(x, out, path ? `${path}.${k}` : k)
}

describe.skipIf(!on)('delivery analytics on a real database', () => {
  let knex: Knex
  afterAll(async () => {
    await knex?.destroy()
  })

  it('every number equals the rows its drill lists', { timeout: 600_000 }, async () => {
    knex = knexFactory({
      client: 'mssql',
      connection: <Knex.MsSqlConnectionConfig>{
        server: String(process.env.DB_HOST),
        port: Number(process.env.DB_PORT || 1433),
        database: String(process.env.DELIVERY_ANALYTICS_IT_DB),
        user: String(process.env.DB_USER),
        password: String(process.env.DB_PASSWORD),
        options: { encrypt: true, trustServerCertificate: true, requestTimeout: 60_000 }
      },
      pool: { min: 0, max: 6 }
    })
    const window = resolveWindow({ window: process.env.DELIVERY_ANALYTICS_IT_WINDOW || '30d' })
    const reg = buildRegistry({ resend: false })
    const ctx = { asof: window.to, actedHours: 24 }
    const exec = sqlExecutor(knex, reg, ctx)
    const labels = {
      users: async () => new Map<string, string>(),
      roles: async () => new Map<string, string>(),
      template: () => null,
      category: (k: string) => k
    }
    const relayRows = await knex('nivaro_mail_log')
      .whereIn('status', ['sent', 'failed'])
      .orderBy('id', 'desc')
      .limit(20)
      .select('to', 'status', 'template', 'error', 'created_at')
    const t0 = Date.now()
    const summary = await buildSummary({
      exec,
      reg,
      window,
      filters: {},
      actedHours: 24,
      labels,
      relay: relayHealth(relayRows),
      floodPerHour: 10,
      mutes: true
    })
    const summaryMs = Date.now() - t0
    const cells: Array<{ path: string; cell: Cell }> = []
    collectCells(summary, cells)
    for (const by of BREAKDOWN_DIMS) {
      const b = await buildBreakdown({ exec, reg, window, filters: {}, labels }, by)
      collectCells(b, cells, `breakdown:${by}`)
    }
    const split = await buildSplit(
      { exec, reg, labels },
      {
        source: 'n',
        span: { from: window.from, to: window.to },
        filters: {},
        where: [['read', ['unread']]],
        by: 'ch_outcome.push'
      }
    )
    collectCells(split, cells, 'split')
    const mismatches: string[] = []
    // Drill each distinct condition list once.
    const seen = new Map<string, number>()
    for (const { path, cell } of cells) {
      const key = JSON.stringify([cell.s, cell.win ?? '', cell.w])
      let total = seen.get(key)
      if (total == null) {
        const span =
          cell.s === 'x'
            ? null
            : cell.win === 'prev'
              ? { from: window.prevFrom, to: window.prevTo }
              : { from: window.from, to: window.to }
        total = (
          await exec.rows({
            source: cell.s,
            span,
            where: cell.w,
            sort: 'time',
            dir: 'desc',
            offset: 0,
            limit: 0
          })
        ).total
        seen.set(key, total)
      }
      if (total !== cell.n) mismatches.push(`${path}: shown ${cell.n}, drill ${total}`)
    }
    process.stdout.write(
      `[delivery-analytics IT] ${cells.length} numbers, ${seen.size} distinct drills, summary ${summaryMs} ms\n`
    )
    expect(mismatches).toEqual([])
    expect(cells.length).toBeGreaterThan(50)
  })
})
