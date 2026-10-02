// Traffic Map drill-down, group "request": the pure parts (ids, arms, the book, compare).
import { describe, expect, it } from 'vitest'
import {
  ARM_MAX_TTL_SEC,
  armMatches,
  CAPTURE_BODY_CAP,
  type CompareSide,
  diffCompare,
  isRequestId,
  isStatementSha,
  KeepNextBook,
  type KeptEntry,
  MAX_ARMS,
  normaliseCaller,
  normaliseRoute,
  parseArmBody,
  parseCompareId,
  parseQueryParams,
  recordRefFromPath,
  routeLogFilter,
  statementSha,
  statementTables
} from './request-logic.js'

const R1 = '0f0c3099-bcbf-499e-9066-a1de51cbabc5'
const R2 = 'ebbd2957-21bb-45b6-accf-00ba9447c023'

describe('ids', () => {
  it('accepts uuids only as request ids', () => {
    expect(isRequestId(R1)).toBe(true)
    expect(isRequestId(R1.toUpperCase())).toBe(true)
    expect(isRequestId('123')).toBe(false)
    expect(isRequestId(`${R1}x`)).toBe(false)
    expect(isRequestId("1' or 1=1--")).toBe(false)
    expect(isRequestId(null)).toBe(false)
  })
  it('accepts lower-case sha1 hex as statement ids', () => {
    const sha = statementSha('select 1')
    expect(isStatementSha(sha)).toBe(true)
    expect(isStatementSha(sha.toUpperCase())).toBe(false)
    expect(isStatementSha(sha.slice(1))).toBe(false)
  })
  it('hashes the shape, not its whitespace', () => {
    expect(statementSha('select  *\n from  [x]  where id = @p0')).toBe(
      statementSha('select * from [x] where id = @p0')
    )
    expect(statementSha('select 1')).not.toBe(statementSha('select 2'))
  })
  it('parses compare ids as two different request ids', () => {
    expect(parseCompareId(`${R1},${R2}`)).toEqual([R1, R2])
    expect(parseCompareId(`${R1},${R1}`)).toBeNull()
    expect(parseCompareId(R1)).toBeNull()
    expect(parseCompareId(`${R1},${R2},${R1}`)).toBeNull()
    expect(parseCompareId(`${R1},nope`)).toBeNull()
  })
})

describe('arm specs', () => {
  it('normalises route templates and refuses junk', () => {
    expect(normaliseRoute('get  /api/items/workflows/:id')).toBe('GET /api/items/workflows/:id')
    expect(normaliseRoute('/api/items')).toBeNull()
    expect(normaliseRoute('FETCH /api/items')).toBeNull()
    expect(normaliseRoute('GET api/items')).toBeNull()
  })
  it('normalises caller keys', () => {
    expect(normaliseCaller('k12')).toBe('k12')
    expect(normaliseCaller(`u${R1}`)).toBe(`u${R1.toUpperCase()}`)
    expect(normaliseCaller('anon')).toBe('anon')
    expect(normaliseCaller('robert')).toBeNull()
  })
  it('requires a route for trace-next and bounds count / ttl', () => {
    expect(parseArmBody({}, 'trace')).toEqual({ error: expect.stringMatching(/route/) })
    const ok = parseArmBody({ route: 'GET /api/items/x' }, 'trace')
    expect(ok).toMatchObject({ count: 1, ttlSec: 300 })
    expect(parseArmBody({ route: 'GET /api/items/x', count: 21 }, 'trace')).toHaveProperty('error')
    expect(parseArmBody({ route: 'GET /api/items/x', count: 0 }, 'trace')).toHaveProperty('error')
    expect(
      parseArmBody({ route: 'GET /api/items/x', ttlSec: ARM_MAX_TTL_SEC + 1 }, 'trace')
    ).toHaveProperty('error')
    expect(parseArmBody({ route: 'GET /api/items/x', caller: 'bob' }, 'trace')).toHaveProperty(
      'error'
    )
  })
  it('lets a capture name a route, caller or entity (at least one), count up to 50', () => {
    expect(parseArmBody({}, 'capture')).toHaveProperty('error')
    expect(parseArmBody({ entity: 'items/workflows', count: 50 }, 'capture')).toMatchObject({
      spec: { route: null, caller: null, entity: 'items/workflows' },
      count: 50
    })
    expect(parseArmBody({ caller: 'k3', count: 51 }, 'capture')).toHaveProperty('error')
    expect(parseArmBody({ entity: 'not an entity' }, 'capture')).toHaveProperty('error')
  })
})

describe('armMatches', () => {
  const facts = { route: 'GET /api/items/workflows/:id', caller: 'k3', entity: 'items/workflows' }
  it('needs every set criterion to match', () => {
    expect(armMatches({ route: facts.route, caller: null, entity: null }, facts)).toBe(true)
    expect(armMatches({ route: facts.route, caller: 'k4', entity: null }, facts)).toBe(false)
    expect(armMatches({ route: null, caller: 'k3', entity: 'items/workflows' }, facts)).toBe(true)
    expect(armMatches({ route: null, caller: null, entity: null }, facts)).toBe(false)
  })
  it('matches every GraphQL operation when the arm names none', () => {
    const g = { route: 'POST /api/graphql · workflows', caller: 'anon', entity: null }
    expect(armMatches({ route: 'POST /api/graphql', caller: null, entity: null }, g)).toBe(true)
    expect(armMatches({ route: 'POST /api/graphql · units', caller: null, entity: null }, g)).toBe(
      false
    )
  })
})

function entry(rid: string, over: Partial<KeptEntry> = {}): KeptEntry {
  return {
    rid,
    at: 1,
    ms: 10,
    route: 'GET /api/x',
    method: 'GET',
    path: '/api/x',
    status: 200,
    node: 'n1',
    ...over
  }
}

const spec = { route: 'GET /api/x', caller: null, entity: null }
const facts = { route: 'GET /api/x', caller: 'anon', entity: null }

describe('KeepNextBook', () => {
  it('consumes one unit per matching request and stops at the count', () => {
    let t = 1000
    const b = new KeepNextBook(() => t)
    b.arm({
      id: 'a',
      kind: 'trace',
      spec,
      total: 2,
      remaining: 2,
      createdAt: t,
      expiresAt: t + 60_000,
      by: null,
      node: 'n1'
    })
    expect(b.active()).toBe(1)
    expect(b.match(facts)).toHaveLength(1)
    expect(b.match({ ...facts, route: 'GET /api/y' })).toHaveLength(0)
    expect(b.match(facts)).toHaveLength(1)
    expect(b.match(facts)).toHaveLength(0)
    expect(b.active()).toBe(0)
    expect(b.view('a')?.done).toBe(true)
    t += 1
  })
  it('expires arms and drops their entries', () => {
    let t = 1000
    const b = new KeepNextBook(() => t)
    b.arm({
      id: 'c',
      kind: 'capture',
      spec,
      total: 5,
      remaining: 5,
      createdAt: t,
      expiresAt: t + 1000,
      by: null,
      node: 'n1'
    })
    b.match(facts)
    expect(b.record('c', entry(R1, { body: '{"a":1}' }))).toBe(true)
    expect(b.captured(R1)?.entry.body).toBe('{"a":1}')
    t += 1001
    expect(b.match(facts)).toHaveLength(0)
    expect(b.view('c')).toBeNull()
    expect(b.captured(R1)).toBeNull()
  })
  it('bounds a capture buffer to its count, at most 50, and each body to 64 KB', () => {
    const t = 1000
    const b = new KeepNextBook(() => t)
    b.arm({
      id: 'c',
      kind: 'capture',
      spec,
      total: 500,
      remaining: 500,
      createdAt: t,
      expiresAt: t + 60_000,
      by: null,
      node: 'n1'
    })
    expect(b.view('c')?.total).toBe(50)
    for (let i = 0; i < 60; i++) {
      const rid = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      b.record('c', entry(rid, { body: 'x'.repeat(CAPTURE_BODY_CAP + 10) }))
    }
    const v = b.view('c')
    expect(v?.entries).toHaveLength(50)
    expect(v?.entries[0].body?.length).toBe(CAPTURE_BODY_CAP + 1)
    expect(v?.entries[0].body?.endsWith('…')).toBe(true)
  })
  it('never keeps bodies on a trace arm and dedupes by request id', () => {
    const b = new KeepNextBook(() => 0)
    b.arm({
      id: 't',
      kind: 'trace',
      spec,
      total: 3,
      remaining: 3,
      createdAt: 0,
      expiresAt: 10,
      by: null,
      node: 'n1'
    })
    expect(b.record('t', entry(R1, { body: 'secret' }))).toBe(true)
    expect(b.record('t', entry(R1))).toBe(false)
    expect(b.view('t')?.entries[0]).not.toHaveProperty('body')
  })
  it('counts a peer’s kept entry against what is left here', () => {
    const b = new KeepNextBook(() => 0)
    b.arm({
      id: 't',
      kind: 'trace',
      spec,
      total: 2,
      remaining: 2,
      createdAt: 0,
      expiresAt: 10,
      by: null,
      node: 'n1'
    })
    b.applyRemote('t', entry(R1, { node: 'n2' }))
    expect(b.view('t')?.remaining).toBe(1)
    b.applyRemote('t', entry(R1, { node: 'n2' }))
    expect(b.view('t')?.remaining).toBe(1)
    b.applyRemote('nope', entry(R2))
  })
  it('holds at most MAX_ARMS arms (oldest dropped)', () => {
    const b = new KeepNextBook(() => 0)
    for (let i = 0; i < MAX_ARMS + 5; i++)
      b.arm({
        id: `a${i}`,
        kind: 'trace',
        spec,
        total: 1,
        remaining: 1,
        createdAt: 0,
        expiresAt: 10,
        by: null,
        node: 'n'
      })
    expect(b.view('a0')).toBeNull()
    expect(b.view(`a${MAX_ARMS + 4}`)).not.toBeNull()
  })
})

describe('paths and routes', () => {
  it('names the record a path points at', () => {
    expect(recordRefFromPath('/api/items/workflows/371407')).toBe('workflows:371407')
    expect(recordRefFromPath(`/api/items/units/${R1}?fields=*`)).toBe(`units:${R1}`)
    expect(recordRefFromPath('/api/items/workflows')).toBeNull()
    expect(recordRefFromPath('/api/items/workflows/resolve-paths')).toBeNull()
  })
  it('turns a route template into a log filter, wildcards escaped', () => {
    expect(routeLogFilter('GET /api/items/work_flows/:id')).toEqual({
      method: 'GET',
      pathLike: '/api/items/work\\_flows/%',
      pathExact: null,
      operation: null
    })
    expect(routeLogFilter('GET /api/version')).toMatchObject({ pathExact: '/api/version' })
    expect(routeLogFilter('POST /api/graphql · workflows')).toMatchObject({
      pathExact: '/api/graphql',
      operation: 'workflows'
    })
    expect(routeLogFilter('nope')).toBeNull()
  })
  it('lists the tables a statement touches', () => {
    expect(
      statementTables(
        'select [a].* from [workflows] as [a] left join [dbo].[nivaro_users] u on u.id = a.creator'
      )
    ).toEqual(['workflows', 'nivaro_users'])
    expect(statementTables('update [units] set x = @p0')).toEqual(['units'])
  })
  it('parses query params, decoding names and values', () => {
    expect([...parseQueryParams('a=1&b=x%20y&a=2&flag').entries()]).toEqual([
      ['a', '1, 2'],
      ['b', 'x y'],
      ['flag', '']
    ])
  })
})

describe('diffCompare', () => {
  const side = (over: Partial<CompareSide>): CompareSide => ({
    status: 200,
    latency_ms: 100,
    query: null,
    trace: null,
    ...over
  })
  it('diffs status, time and query params', () => {
    const d = diffCompare(
      side({ status: 200, latency_ms: 100, query: 'limit=25&page=1' }),
      side({ status: 500, latency_ms: 150, query: 'limit=50&sort=id' })
    )
    expect(d.status).toEqual({ a: 200, b: 500, same: false })
    expect(d.ms).toEqual({ a: 100, b: 150, delta: 50, pct: 50 })
    expect(d.params).toEqual([
      { name: 'limit', a: '25', b: '50', change: 'changed' },
      { name: 'page', a: '1', b: null, change: 'removed' },
      { name: 'sort', a: null, b: 'id', change: 'added' }
    ])
    expect(d.sql.comparable).toBe(false)
  })
  it('sums phases and classifies SQL shapes added / removed / slower / faster', () => {
    const a = side({
      trace: {
        total_ms: 300,
        spans: [
          { phase: 'auth', ms: 10 },
          { phase: 'hooks', ms: 5 },
          { phase: 'hooks', ms: 5 }
        ],
        top_sql: [
          { sql: 'select 1', ms: 10, n: 1 },
          { sql: 'select 2', ms: 50, n: 5 },
          { sql: 'select 3', ms: 40, n: 1 },
          { sql: 'select gone', ms: 7, n: 1 }
        ]
      }
    })
    const b = side({
      trace: {
        total_ms: 900,
        spans: [
          { phase: 'auth', ms: 12 },
          { phase: 'query', ms: 600 }
        ],
        top_sql: [
          { sql: 'select  1', ms: 11, n: 1 },
          { sql: 'select 2', ms: 500, n: 50 },
          { sql: 'select 3', ms: 10, n: 1 },
          { sql: 'select new', ms: 30, n: 2 }
        ]
      }
    })
    const d = diffCompare(a, b)
    expect(d.ms.delta).toBe(600)
    expect(d.phases.find((p) => p.phase === 'hooks')).toEqual({
      phase: 'hooks',
      a: 10,
      b: null,
      delta: null
    })
    expect(d.phases[0].phase).toBe('query')
    expect(d.sql.comparable).toBe(true)
    expect(d.sql.added.map((s) => s.sql)).toEqual(['select new'])
    expect(d.sql.removed.map((s) => s.sql)).toEqual(['select gone'])
    expect(d.sql.slower.map((s) => s.sql)).toEqual(['select 2'])
    expect(d.sql.faster.map((s) => s.sql)).toEqual(['select 3'])
  })
})
