import { describe, expect, it } from 'vitest'
import { defineExtension } from './index.js'
import { createTestContext, createTestDb } from './testing.js'

const ext = defineExtension({
  id: 'demo',
  async register(ctx) {
    ctx.hooks.after('orders', 'create', async ({ result }) => {
      const row = result as { id: number; owner: string }
      await ctx.notifyUser(row.owner, { subject: `Order ${row.id}`, message: 'created' })
      await ctx.logActivity({ action: 'seen', collection: 'orders', item: row.id })
    })
    ctx.cron.schedule('nightly', '0 3 * * *', async () => {
      const open = await ctx.database('orders').where({ status: 'open' }).count('id as n')
      ctx.flows.emit('orders-open', { n: (open[0] as { n: number }).n })
    })
    ctx.tasks.register({
      key: 'demo:count-open',
      label: 'Count open orders',
      description: '',
      dryRun: async (rc) => {
        const n = (await ctx.database('orders').where({ status: 'open' })).length
        rc.log(`${n} open`)
        return { summary: `${n} open`, counts: { open: n } }
      },
      execute: async () => ({ summary: 'closed them' })
    })
    ctx.seeds.register({
      key: 'demo:statuses',
      collection: 'statuses',
      match_by: ['key'],
      rows: [{ key: 'open', label: 'Open' }],
      mode: 'fill-only'
    })
    ctx.integrations.registerSignal({
      id: 'demo:stuck',
      label: 'Stuck',
      description: '',
      tab: 'firefight',
      severity: 'warn',
      thresholds: [],
      evaluate: async () => ({ count: 0, rows: [] })
    })
    ctx.app.register(
      async (f: unknown) => {
        ;(f as { get: (u: string, h: (req: { params: { id: string } }) => unknown) => void }).get(
          '/orders/:id',
          async (req) => ({
            data: await ctx.database('orders').where({ id: req.params.id }).first()
          })
        )
      },
      { prefix: '/api/demo' }
    )
  }
})

describe('test context', () => {
  it('records hooks, effects, crons, signals and routes without booting anything', async () => {
    const ctx = createTestContext({
      tables: {
        orders: [
          { id: 1, owner: 'u1', status: 'open' },
          { id: 2, owner: 'u2', status: 'done' }
        ]
      }
    })
    await ext.register(ctx)
    expect(ctx.registered.signals.map((s) => s.id)).toEqual(['demo:stuck'])
    expect(ctx.registered.seeds.map((s) => s.key)).toEqual(['demo:statuses'])

    await ctx.runHooks('orders', 'create', 'after', { keys: [1], result: { id: 1, owner: 'u1' } })
    expect(ctx.calls.notifications).toEqual([
      { userId: 'u1', opts: { subject: 'Order 1', message: 'created' } }
    ])
    expect(ctx.calls.activity[0]).toMatchObject({ action: 'seen', item: 1 })

    expect(await ctx.runTask('demo:count-open')).toEqual({
      summary: '1 open',
      counts: { open: 1 },
      log: ['1 open']
    })
    expect((await ctx.runTask('demo:count-open', { execute: true })).summary).toBe('closed them')

    await ctx.runCron('nightly')
    expect(ctx.calls.flowsEmitted).toEqual([{ type: 'orders-open', payload: { n: 1 } }])

    const res = await ctx.invoke('GET', '/api/demo/orders/2')
    expect(res).toEqual({ status: 200, body: { data: { id: 2, owner: 'u2', status: 'done' } } })
    await expect(ctx.invoke('GET', '/api/demo/nothing')).rejects.toThrow(/no route GET/)
  })

  it('the in-memory db supports the chain extensions use', async () => {
    const db = createTestDb({
      tables: {
        t: [
          { id: 1, a: 'x', n: 5 },
          { id: 2, a: 'y', n: 7 },
          { id: 3, a: null, n: 9 }
        ]
      }
    })
    expect(await db('t').where('n', '>', 5).orderBy('n', 'desc').pluck('id')).toEqual([3, 2])
    expect(await db('t').whereNull('a').first('id')).toEqual({ id: 3 })
    expect(await db('t').whereIn('id', [1, 2]).select('a')).toEqual([{ a: 'x' }, { a: 'y' }])
    expect(
      await db('t')
        .where((qb: unknown) => (qb as { where: (k: string, v: unknown) => void }).where('a', 'x'))
        .count()
    ).toEqual([{ count: 1 }])
    const ins = await db('t').insert({ a: 'z', n: 1 }).returning('id')
    expect(ins).toEqual([{ id: 1000 }])
    expect(await db('t').where({ id: 1000 }).update({ n: 2 })).toBe(1)
    expect(await db('t').where({ n: 2 }).del()).toBe(1)
    expect(await db.schema.hasColumn('t', 'n')).toBe(true)
    expect(await db.schema.hasColumn('t', 'missing')).toBe(false)
    expect(db.state.log.filter((l) => l.op === 'insert')).toHaveLength(1)
  })
})
