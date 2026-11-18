import type { Knex } from 'knex'
import { describe, expect, it, vi } from 'vitest'
import { buildRegistry, CHANNELS, type Cond } from './model.js'
import { sqlExecutor } from './query.js'

/**
 * The SQL executor against a fake knex that records every statement: each
 * statement's `?` count equals its bindings, for every dimension used as a
 * group, a measure and a drill condition (acted — with its asof and hours —
 * included), and rows / keyset / percentile reads. A mismatch would be a
 * runtime "parameter count" error only a real database shows.
 */
function recorder() {
  const calls: Array<{ sql: string; bindings: unknown[] }> = []
  const knex = {
    raw: vi.fn(async (sql: string, bindings: unknown[]) => {
      calls.push({ sql, bindings })
      return /COUNT\(\*\) AS total/.test(sql) ? [{ total: 5 }] : []
    })
  }
  return { knex: knex as unknown as Knex, calls }
}

const placeholders = (sql: string) => (sql.match(/\?/g) ?? []).length
const ctx = { asof: new Date('2026-11-18T12:00:00.000Z'), actedHours: 24 }
const span = {
  from: new Date('2026-11-11T00:00:00.000Z'),
  to: new Date('2026-11-18T00:00:00.000Z')
}

describe('delivery analytics SQL: every placeholder has its binding', () => {
  for (const resend of [false, true]) {
    const reg = buildRegistry({ resend })
    for (const source of ['n', 'm', 'x'] as const) {
      const dims = [...reg.dims[source].keys()]
      it(`${source}${resend ? ' (resend columns)' : ''}: ${dims.length} dimensions as group, measure and condition`, async () => {
        const { knex, calls } = recorder()
        const exec = sqlExecutor(knex, reg, ctx)
        const sp = source === 'x' ? null : span
        for (const d of dims) {
          const cond: Cond = [d, ['a', 'b']]
          await exec.aggregate({
            source,
            span: sp,
            where: [cond],
            groupBy: [d],
            measures: { all: [], one: [[d, ['a']]], two: [cond, [d, ['c']]] },
            top: { by: 'all', n: 10 },
            having: { measure: 'all', min: 2 }
          })
          await exec.rows({
            source,
            span: sp,
            where: [cond],
            sort: 'time',
            dir: 'desc',
            offset: 0,
            limit: 5
          })
          await exec.rows({
            source,
            span: sp,
            where: [cond],
            sort: 'time',
            dir: 'asc',
            offset: 0,
            limit: 5,
            count: false,
            after: { t: source === 'x' ? 3 : new Date(), id: 3 }
          })
          if (source === 'n') {
            await exec.percentiles({ span, where: [cond], groupBy: [d] })
            await exec.rows({
              source,
              span: sp,
              where: [cond],
              sort: 'ttr',
              dir: 'desc',
              offset: 0,
              limit: 5
            })
          }
        }
        expect(calls.length).toBeGreaterThan(dims.length)
        for (const c of calls)
          expect(placeholders(c.sql), c.sql.slice(0, 160)).toBe(c.bindings.length)
      })
    }
  }

  it('computes acted once per row however many measures read it', async () => {
    const { knex, calls } = recorder()
    const exec = sqlExecutor(knex, buildRegistry({ resend: false }), ctx)
    await exec.aggregate({
      source: 'n',
      span,
      where: [],
      groupBy: ['category'],
      measures: {
        acted: [['acted', ['acted']]],
        eligible: [['acted', ['acted', 'read_no_action', 'unread_no_action']]],
        ignored: [['acted', ['read_no_action']]]
      }
    })
    const sql = calls[0]?.sql ?? ''
    expect(sql.match(/nivaro_workflow_history/g)).toHaveLength(1)
    // the acted window closes against the asof, which is bound, not "now"
    expect(calls[0]?.bindings).toContain(ctx.asof)
  })

  it('channel dimensions read the delivery JSON only through ISJSON', () => {
    const reg = buildRegistry({ resend: false })
    for (const c of CHANNELS) {
      const s = reg.dims.n.get(`ch.${c}`)?.sql(ctx).sql ?? ''
      expect(s).toContain('ISJSON(n.delivery) = 1')
    }
  })

  it('limits one executor to three statements at once', async () => {
    let live = 0
    let peak = 0
    const knex = {
      raw: vi.fn(async () => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 5))
        live--
        return []
      })
    } as unknown as Knex
    const exec = sqlExecutor(knex, buildRegistry({ resend: false }), ctx)
    await Promise.all(
      Array.from({ length: 10 }, () =>
        exec.aggregate({ source: 'm', span, where: [], groupBy: ['status'], measures: { all: [] } })
      )
    )
    expect(peak).toBe(3)
  })
})
