import { describe, expect, it } from 'vitest'
import {
  compareBars,
  comparePair,
  countdown,
  curlFor,
  fmtDelta,
  fmtMs,
  graphqlParts,
  isWideStatement,
  layoutWaterfall,
  offsetText,
  PENDING_GIVE_UP_MS,
  prettyBody,
  queryPairs,
  repeatOf,
  shouldRetryPending
} from './logic'

describe('layoutWaterfall', () => {
  it('indents contained spans and keeps overlapping ones level', () => {
    const rows = layoutWaterfall(
      [
        { seq: 0, phase: 'request', ms: 80, at: 0 },
        { seq: 1, phase: 'auth', ms: 10, at: 1 },
        { seq: 2, phase: 'auth:token', ms: 4, at: 2 },
        { seq: 3, phase: 'query', ms: 50, at: 20 },
        { seq: 4, phase: 'tail', ms: 10, at: 90 }
      ],
      100
    )
    expect(rows.map((r) => [r.phase, r.depth])).toEqual([
      ['request', 0],
      ['auth', 1],
      ['auth:token', 2],
      ['query', 1],
      ['tail', 0]
    ])
    const q = rows.find((r) => r.phase === 'query')
    expect(q?.left).toBe(20)
    expect(q?.width).toBe(50)
  })
  it('scales to the furthest span when it outruns the total and never draws a 0-width bar', () => {
    const rows = layoutWaterfall([{ seq: 0, phase: 'x', ms: 0, at: 150 }], 100)
    expect(rows[0].width).toBeGreaterThan(0)
    expect(rows[0].left).toBe(100)
  })
})

describe('formatting', () => {
  it('formats durations and deltas', () => {
    expect(fmtMs(12.34)).toBe('12.3 ms')
    expect(fmtMs(1240)).toBe('1.24 s')
    expect(fmtMs(12_400)).toBe('12.4 s')
    expect(fmtMs(null)).toBe('—')
    expect(fmtDelta(0)).toBe('same')
    expect(fmtDelta(-40)).toBe('−40 ms')
    expect(fmtDelta(1500)).toBe('+1.50 s')
  })
  it('counts down and states offsets', () => {
    expect(countdown(65_000, 0)).toBe('1:05')
    expect(countdown(0, 10)).toBe('expired')
    expect(offsetText('2026-10-01T10:00:01.200Z', '2026-10-01T10:00:00.000Z')).toBe('+1.20 s')
    expect(offsetText('2026-10-01T10:00:00.000Z', '2026-10-01T10:00:00.010Z')).toBe('same time')
  })
})

describe('bodies', () => {
  it('pretty-prints JSON and leaves the rest', () => {
    expect(prettyBody('{"a":1}')).toEqual({ text: '{\n  "a": 1\n}', json: true })
    expect(prettyBody('a=1')).toEqual({ text: 'a=1', json: false })
  })
  it('splits a GraphQL body into its document and variables', () => {
    const g = graphqlParts('{"query":"query X { a }","variables":{"id":1},"operationName":"X"}')
    expect(g).toEqual({ query: 'query X { a }', variables: '{\n  "id": 1\n}', operationName: 'X' })
    expect(graphqlParts('{"name":"a"}')).toBeNull()
    expect(graphqlParts('not json')).toBeNull()
  })
  it('decodes query pairs', () => {
    expect(queryPairs('?a=1&b=x%20y&flag')).toEqual([
      ['a', '1'],
      ['b', 'x y'],
      ['flag', '']
    ])
  })
})

describe('curlFor', () => {
  it('builds a runnable command with a placeholder token', () => {
    const c = curlFor({
      origin: 'https://n.example',
      method: 'patch',
      path: '/api/items/workflows/5',
      query: 'fields=id',
      body: '{"name":"it\'s"}'
    })
    expect(c).toContain(`curl -X PATCH 'https://n.example/api/items/workflows/5?fields=id'`)
    expect(c).toContain('$NIVARO_TOKEN')
    expect(c).toContain(`--data '{"name":"it'\\''s"}'`)
  })
  it('says when a value was masked or cut', () => {
    expect(curlFor({ origin: '', method: 'GET', path: '/x', query: 'token=••••••' })).toMatch(
      /masked/
    )
    expect(curlFor({ origin: '', method: 'POST', path: '/x', body: '{"a":…' })).toMatch(/cut/)
  })
})

describe('pending retry', () => {
  it('polls for 20 s after the first answer, then gives up', () => {
    expect(shouldRetryPending(0, 1000)).toBe(true)
    expect(shouldRetryPending(0, PENDING_GIVE_UP_MS)).toBe(false)
  })
})

describe('statement flags', () => {
  it('marks wide selects and repeated shapes', () => {
    expect(
      isWideStatement('select * from [workflows] where id = @p0', [{ table: 'WORKFLOWS' }])
    ).toBe(true)
    expect(isWideStatement('select id from [workflows]', [{ table: 'workflows' }])).toBe(false)
    expect(isWideStatement('select * from [x]', undefined)).toBe(false)
    expect(
      repeatOf('select 1', [
        { repeat: { sql: 'select 1', n: 7 } },
        { repeat: { sql: 'select 2', n: 9 } },
        {}
      ])
    ).toBe(7)
    expect(repeatOf('select 3', [])).toBeNull()
  })
})

describe('compare helpers', () => {
  it('scales both bars to the largest phase', () => {
    expect(
      compareBars([
        { a: 100, b: 50 },
        { a: null, b: 200 }
      ])
    ).toEqual([
      { a: 50, b: 25 },
      { a: 0, b: 100 }
    ])
  })
  it('splits a compare id', () => {
    expect(comparePair('a,b')).toEqual(['a', 'b'])
    expect(comparePair('a')).toBeNull()
  })
})
