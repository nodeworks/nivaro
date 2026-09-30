import { describe, expect, it } from 'vitest'
import { matchesColumnFilterOp, parseColumnFilterOp } from '../../../services/column-filter-ops.js'
import {
  decodeCachedExtra,
  encodeCachedExtra,
  hasTypedExtraFilter,
  twinJsonPath,
  typedTwins
} from '../../../services/queue-materialization-extra.js'
import { ownerSortKey } from '../../../services/queues.js'

describe('typed twins (#801)', () => {
  it('reads each value with the live filter readers', () => {
    const t = typedTwins({
      due: '2026-09-19T14:00:00.000Z',
      us: '09/05/2026',
      cost: '$1,234.50',
      flag: 'Yes',
      text: 'Installation labor',
      none: null
    })
    expect(t.due).toEqual({ d: '2026-09-19' })
    expect(t.us).toEqual({ d: '2026-09-05' })
    expect(t.cost).toEqual({ n: 1234.5 })
    expect(t.flag).toEqual({ b: 1 })
    expect(t.text).toBeUndefined()
    expect(t.none).toBeUndefined()
  })

  it('agrees with the live matcher on every twin it writes', () => {
    const samples = ['2026-09-19', '1500', '0', 'true', 'no', '12/31/2025', '$0.50']
    const ops = [
      'before:2026-09-20',
      'on:2026-09-19',
      'onafter:2026-01-01',
      'between:2025-12-01..2025-12-31',
      'num:gt:100',
      'num:eq:0',
      'num:between:0..1',
      'num:neq:1500',
      'bool:true',
      'bool:false'
    ]
    for (const v of samples) {
      const twin = typedTwins({ x: v }).x ?? {}
      for (const raw of ops) {
        const op = parseColumnFilterOp(raw)!
        let viaTwin: boolean
        if (op.kind === 'date')
          viaTwin = !!twin.d && (!op.from || twin.d >= op.from) && (!op.to || twin.d <= op.to)
        else if (op.kind === 'num') {
          const n = twin.n
          viaTwin =
            n != null &&
            {
              eq: n === op.a,
              neq: n !== op.a,
              gt: n > op.a,
              gte: n >= op.a,
              lt: n < op.a,
              lte: n <= op.a,
              between: n >= op.a && n <= (op.b as number)
            }[op.op]
        } else viaTwin = twin.b != null && twin.b === (op.value ? 1 : 0)
        expect([v, raw, viaTwin]).toEqual([v, raw, matchesColumnFilterOp(v, op)])
      }
    }
  })

  it('round-trips the reserved keys and strips them from extra', () => {
    const raw = encodeCachedExtra({ a: 'x' }, { a: ['1'] }, { id: 'AD-1', title: 'Change' })
    const parsed = JSON.parse(raw)
    expect(parsed.__t).toEqual({})
    const back = decodeCachedExtra(raw)
    expect(back).toEqual({
      extra: { a: 'x' },
      extra_ids: { a: ['1'] },
      via_addendum: { id: 'AD-1', title: 'Change' }
    })
  })

  it('always writes __t so a stale cache can be told apart', () => {
    expect(JSON.parse(encodeCachedExtra({}, null)).__t).toEqual({})
  })

  it('builds twin JSON paths with quotes stripped', () => {
    expect(twinJsonPath('a."b', 'n')).toBe('$."__t"."a.b".n')
  })

  it('detects typed filters only', () => {
    expect(hasTypedExtraFilter({ 'extra.a': 'plain' })).toBe(false)
    expect(hasTypedExtraFilter({ 'extra.a': ['plain', 'bool:true'] })).toBe(true)
    expect(hasTypedExtraFilter({ state: 'on:2026-01-01' })).toBe(false)
  })
})

describe('owner sort key (#800)', () => {
  it('orders names and joins them the way the cache stores owner_names', () => {
    expect(ownerSortKey(['Zed', 'Amy', 'Bo'])).toBe('Amy, Bo, Zed')
    expect(ownerSortKey([])).toBeNull()
  })
})

describe('server-side group-by (#741)', () => {
  const item = (over: Record<string, unknown>) =>
    ({
      collection: 'workflows',
      item_id: '1',
      label: 'x',
      state: 'started',
      state_color: null,
      owners: [],
      sla_status: null,
      at_risk: false,
      aging_hours: null,
      claimed_by: null,
      url: '',
      ...over
    }) as never

  it('keys rows the way the cache groups them', async () => {
    const { queueGroupKey } = await import('../../../services/queues.js')
    expect(queueGroupKey(item({ state: null }), 'state')).toBe('No state')
    expect(
      queueGroupKey(
        item({
          owners: [
            { id: 'b', name: 'Zed' },
            { id: 'a', name: 'Amy' }
          ]
        }),
        'owners'
      )
    ).toBe('Amy, Zed')
    expect(queueGroupKey(item({}), 'owners')).toBe('No owners')
    expect(queueGroupKey(item({ extra: { cost: 5 } }), 'extra.cost')).toBe('5')
    expect(queueGroupKey(item({ extra: { cost: '' } }), 'extra.cost')).toBe('—')
    expect(queueGroupKey(item({ aging_hours: 30 }), 'aging')).toBe('1–3d')
  })

  it('summarizes counts, breached, at-risk and sums in the client order', async () => {
    const { summarizeQueueGroups } = await import('../../../services/queues.js')
    const groups = summarizeQueueGroups(
      [
        item({ state: 'a', sla_status: 'breached', extra: { cost: '$1,000' } }),
        item({ state: 'a', at_risk: true, extra: { cost: 250 } }),
        item({ state: 'b', extra: { cost: null } })
      ],
      'state',
      ['cost']
    )
    expect(groups).toEqual([
      { key: 'a', count: 2, breached: 1, at_risk: 1, sums: { cost: 1250 } },
      { key: 'b', count: 1, breached: 0, at_risk: 0, sums: {} }
    ])
  })

  it('compiles SQL group keys only for cache-groupable attributes', async () => {
    const { groupKeySql, requiresLiveResolveFallback } = await import(
      '../../../services/queue-materialization-read.js'
    )
    expect(groupKeySql('state')?.sql).toContain('No state')
    expect(groupKeySql('extra.cost')?.bindings).toEqual(['$."cost"', '$."cost"', '$."cost"'])
    expect(groupKeySql('sla_status')).toBeNull()
    expect(requiresLiveResolveFallback('', {}, { groupBy: 'aging' })).toBe(true)
    expect(requiresLiveResolveFallback('', {}, { groupBy: 'owners' })).toBe(false)
  })
})
