import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildWaterfall,
  classifySearch,
  finishRelated,
  finishResults,
  p75,
  RELATED_PER_GROUP,
  SEARCH_REFUSED_CREDENTIAL,
  screenMatches,
  statementLabel,
  statementSha
} from './nav-logic.js'

describe('classifySearch', () => {
  it('reads uuids (lower-cased), integers and emails', () => {
    expect(classifySearch(' F5B4C905-5DD8-4FD1-B6B2-26819D9BE740 ')).toEqual({
      type: 'uuid',
      id: 'f5b4c905-5dd8-4fd1-b6b2-26819d9be740'
    })
    expect(classifySearch('1351')).toEqual({ type: 'int', n: 1351 })
    expect(classifySearch('0')).toEqual({ type: 'text' })
    expect(classifySearch('Rob.Lee@Example.com')).toEqual({
      type: 'email',
      email: 'rob.lee@example.com'
    })
  })

  it('reads routes, screens, collection/id and friendly record ids', () => {
    expect(classifySearch('/api/items/workflows/12?x=1')).toEqual({
      type: 'route',
      method: null,
      path: '/api/items/workflows/12'
    })
    expect(classifySearch('patch /api/items/workflows/12')).toEqual({
      type: 'route',
      method: 'PATCH',
      path: '/api/items/workflows/12'
    })
    expect(classifySearch('workflows/371393')).toEqual({
      type: 'record',
      collection: 'workflows',
      id: '371393'
    })
    expect(classifySearch('CR26-80329')).toEqual({ type: 'friendly', value: 'CR26-80329' })
    expect(classifySearch('hello')).toEqual({ type: 'text' })
    expect(classifySearch('')).toEqual({ type: 'empty' })
    expect(classifySearch(null)).toEqual({ type: 'empty' })
  })

  it('refuses credentials before anything else and never returns them', () => {
    for (const q of [
      'nvk_0123456789abcdef',
      'NVM_abc',
      'nvq_xyz',
      'Bearer abc.def',
      'a'.repeat(64),
      'f'.repeat(48),
      'Zx9_Kq2-PLm7Tn4vBc8dRs1fGh3jWy5u'
    ]) {
      const c = classifySearch(q)
      expect(c.type).toBe('refused')
      expect(JSON.stringify(c)).not.toContain(q)
      if (c.type === 'refused' && !q.startsWith('a'.repeat(10)))
        expect(c.reason).toBe(SEARCH_REFUSED_CREDENTIAL)
    }
    expect(classifySearch('x'.repeat(201)).type).toBe('refused')
  })
})

describe('finishResults', () => {
  it('dedupes by kind:id and caps', () => {
    const r = (kind: string, id: string) => ({ ref: { kind, id }, label: id, hint: '' })
    const out = finishResults(
      [r('request', 'a'), r('request', 'a'), r('chain', 'a'), r('write', '1')],
      2
    )
    expect(out.map((x) => `${x.ref.kind}:${x.ref.id}`)).toEqual(['request:a', 'chain:a'])
  })
})

describe('finishRelated', () => {
  it('drops the level itself and duplicates, caps at 10 and counts the rest', () => {
    const refs = Array.from({ length: 14 }, (_, i) => ({ kind: 'request', id: `r${i}` }))
    const groups = finishRelated(
      [
        {
          key: 'caller',
          label: 'Same caller',
          refs: [{ kind: 'request', id: 'R0' }, ...refs],
          total: 30
        },
        { key: 'chain', label: 'Same chain', refs: [{ kind: 'chain', id: 'c' }] },
        { key: 'record', label: 'Same record', refs: [] }
      ],
      { kind: 'request', id: 'r0' }
    )
    expect(groups.map((g) => g.key)).toEqual(['chain', 'caller'])
    const caller = groups[1]
    expect(caller.refs).toHaveLength(RELATED_PER_GROUP)
    expect(caller.refs.some((r) => r.id.toLowerCase() === 'r0')).toBe(false)
    // 30 counted, 2 rows were the level itself → 28, 10 shown
    expect(caller.more).toBe(18)
    expect(groups[0].more).toBeUndefined()
  })

  it('without a total, more is what was fetched past the cap', () => {
    const refs = Array.from({ length: 12 }, (_, i) => ({ kind: 'write', id: String(i + 1) }))
    const [g] = finishRelated([{ key: 'record', label: 'x', refs }], { kind: 'record', id: 'w:1' })
    expect(g.refs).toHaveLength(10)
    expect(g.more).toBe(2)
  })

  it('drops every self ref: a trace level is also its request', () => {
    const groups = finishRelated(
      [
        {
          key: 'chain',
          label: 'Same chain',
          refs: [
            { kind: 'chain', id: 'c' },
            { kind: 'request', id: 'RID-1' },
            { kind: 'request', id: 'rid-2' }
          ],
          total: 3
        }
      ],
      [
        { kind: 'trace', id: 'rid-1' },
        { kind: 'request', id: 'rid-1' }
      ]
    )
    expect(groups[0].refs.map((r) => `${r.kind}:${r.id}`)).toEqual(['chain:c', 'request:rid-2'])
    expect(groups[0].more).toBeUndefined()
  })
})

describe('statement shape', () => {
  it('hashes the whitespace-collapsed statement (sha1 hex, lower case)', () => {
    const a = statementSha('select  *\n from   workflows where id = @p0')
    expect(a).toBe(statementSha(' select * from workflows where id = @p0 '))
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(a).toBe(
      createHash('sha1').update('select * from workflows where id = @p0').digest('hex')
    )
    expect(statementSha('select 1')).not.toBe(statementSha('select 2'))
  })
  it('labels a statement with its count, time and a short head', () => {
    expect(statementLabel({ sql: 'select   1', n: 3, ms: 12.4 })).toBe('3× · 12 ms · select 1')
    const long = statementLabel({ sql: `select ${'x,'.repeat(80)} from t` })
    expect(long.startsWith('1× · 0 ms · select x,')).toBe(true)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('buildWaterfall', () => {
  it('offsets from the first call, total span, slowest, duplicates and errors', () => {
    const w = buildWaterfall([
      { rid: 'b', route: 'GET /api/items/x', start: 1_100, ms: 50, status: 200 },
      { rid: 'a', route: 'GET /api/auth/me', start: 1_000, ms: 30, status: 200 },
      { rid: 'c', route: 'GET /api/items/x', start: 1_120, ms: 400, status: 500 },
      { rid: null, route: 'GET /api/version', start: 1_300, ms: -5, status: 200 }
    ])
    expect(w.rows.map((r) => r.offset_ms)).toEqual([0, 100, 120, 300])
    expect(w.total_ms).toBe(520)
    expect(w.slowest?.rid).toBe('c')
    expect(w.duplicates).toEqual([{ route: 'GET /api/items/x', n: 2 }])
    expect(w.errors).toBe(1)
    expect(w.rows[3].ms).toBe(0)
    expect(buildWaterfall([])).toMatchObject({ rows: [], total_ms: 0, slowest: null })
  })

  it('measures from the load’s own span when calls were dropped', () => {
    // A long call that arrived after the cap started before the first kept one and ended last.
    const w = buildWaterfall(
      [
        { rid: 'a', route: 'GET /api/auth/me', start: 1_000, ms: 30, status: 200 },
        { rid: 'b', route: 'GET /api/items/x', start: 1_100, ms: 50, status: 200 }
      ],
      { first: 900, last: 1_600 }
    )
    expect(w.rows.map((r) => r.offset_ms)).toEqual([100, 200])
    expect(w.total_ms).toBe(700)
    expect(buildWaterfall([], { first: 5, last: 9 }).total_ms).toBe(4)
  })
})

describe('p75 and screens', () => {
  it('p75 is the nearest-rank 75th percentile of finite values', () => {
    expect(p75([])).toBeNull()
    expect(p75([null, undefined])).toBeNull()
    expect(p75([4, 1, 3, 2])).toBe(3)
    expect(p75([10])).toBe(10)
  })
  it('a page matches its screen key or its bare pattern', () => {
    expect(screenMatches('admin /traffic-map', 'admin /traffic-map')).toBe(true)
    expect(screenMatches('admin /traffic-map', '/traffic-map')).toBe(true)
    expect(screenMatches('/traffic-map', '/traffic-map')).toBe(true)
    expect(screenMatches('admin /traffic-map', '/users')).toBe(false)
    expect(screenMatches('admin /traffic-map', '')).toBe(false)
  })
})
