// api/src/test/unit/services/traffic-deep-measurement.test.ts
// Group B2 — deep measurement taps (#1108 #1119 #1134 #1135 #1136 #1145 #1146 #1151).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { raw: vi.fn(async () => []) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import {
  attachQueryTracing,
  beginTrace,
  noteDerivedWrite,
  noteReadShape,
  requestMeasure,
  span,
  spanCategory,
  timeAccess,
  timeAccessSync
} from '../../../services/request-trace.js'
import {
  advanceTo,
  buildFrame,
  buildSnapshot,
  noteRequest,
  noteWrite,
  resetTrafficMap
} from '../../../services/traffic-map.js'
import {
  FIELD_HEAT_TAP,
  fieldHeatDetail,
  recordFieldChanges
} from '../../../services/traffic-taps/field-change-heat.js'
import {
  GRAPHQL_FIELDS_TAP,
  graphqlFieldsDetail,
  recordSelection,
  unusedFieldsOf
} from '../../../services/traffic-taps/graphql-field-heat.js'
import {
  hotRecordsDetail,
  rankHotRecords,
  recordOfRequestPath,
  recordRequest,
  recordWrite
} from '../../../services/traffic-taps/hot-records.js'
import { MinuteSlots } from '../../../services/traffic-taps/minute-slots.js'
import {
  conditionTerms,
  filterTerms,
  liveFilterColumns,
  readShape,
  recordReadShape,
  shapesDetail,
  shapeText
} from '../../../services/traffic-taps/read-shapes.js'
import {
  costDetail,
  N_PLUS_ONE_AVG_TRIPS,
  REQUEST_COST_TAP,
  splitLatency
} from '../../../services/traffic-taps/request-cost.js'

const T0 = 1_800_000_000

beforeEach(() => {
  resetTrafficMap()
  advanceTo(T0)
})

const baseEv = {
  method: 'GET',
  path: '/api/items/workflows',
  status: 200,
  latencyMs: 100,
  authMethod: 'session',
  apiKeyId: null,
  userId: 'u1',
  graphqlOperation: null,
  graphqlKind: null,
  cacheHit: false,
  at: T0 * 1000
}

describe('MinuteSlots', () => {
  it('sums per slot over the window and zeroes a reused minute', () => {
    const m = new MinuteSlots(2)
    m.add(T0, 0, 3)
    m.add(T0, 1, 1.5)
    m.add(T0 + 60, 0, 2)
    expect(m.sum(60, T0 + 60)).toEqual([5, 1.5])
    m.add(T0 + 60 * 15, 0, 7) // same bucket as T0, a newer minute
    expect(m.sum(60, T0 + 60 * 15)).toEqual([7, 0])
    expect(m.idle(T0 + 60 * 40)).toBe(true)
  })
})

describe('request-trace measure', () => {
  it('categorises spans, keeps SQL out of them, and reads back per request', async () => {
    expect(spanCategory('auth')).toBe(0)
    expect(spanCategory('permissions+metadata')).toBe(1)
    expect(spanCategory('hooks:after-read')).toBe(2)
    expect(spanCategory('hook:core:workflows:update:after')).toBe(2)
    expect(spanCategory('query+count')).toBe(-1)

    const req = { authMethod: 'session' }
    await (async () => {
      beginTrace('/api/items/workflows', req)
      await span('auth', async () => {
        await span('auth', async () => {}) // nested: counted once
      })
      await span('permissions+metadata', async () => {})
      timeAccessSync(() => undefined)
      await timeAccess(async () => {
        await timeAccess(async () => {}) // nested: one window
      })
      noteDerivedWrite('direct')
      noteDerivedWrite('revision', 2)
      noteDerivedWrite('activity')
      noteReadShape('workflows', { status: { _eq: 'x' } }, ['-created'], undefined)
      noteReadShape('projects', { id: { _in: [1] } }, [], undefined) // only the first is kept
    })()
    const m = requestMeasure(req)
    expect(m).not.toBeNull()
    expect(m?.authMs).toBeGreaterThanOrEqual(0)
    expect(m?.accessMs).toBeGreaterThanOrEqual(0)
    expect(m?.derived).toEqual([1, 0, 0, 0, 2, 1])
    expect(m?.shape?.collection).toBe('workflows')
    expect(requestMeasure({})).toBeNull()
  })

  it('does nothing outside a traced request', async () => {
    noteDerivedWrite('rollup')
    noteReadShape('x', {}, [], null)
    expect(timeAccessSync(() => 4)).toBe(4)
    expect(await timeAccess(async () => 5)).toBe(5)
  })
})

describe('splitLatency', () => {
  it('sums to the total, scaling overlapping parts down', () => {
    const s = splitLatency({ total: 100, sql: 80, auth: 20, meta: 20, hooks: 0, ser: 0 })
    expect(s.sql + s.auth + s.meta + s.hooks + s.ser + s.other).toBeCloseTo(100)
    expect(s.other).toBe(0)
    const t = splitLatency({ total: 100, sql: 30, auth: 5, meta: 5, hooks: 10, ser: 2 })
    expect(t.other).toBeCloseTo(48)
  })
})

describe('request-cost tap (#1108 #1151 #1146 #1145)', () => {
  // A fake knex client: emits the query / query-response events request-trace listens to.
  const handlers: Record<string, (...a: unknown[]) => void> = {}
  attachQueryTracing({
    on: (ev: string, fn: (...a: unknown[]) => void) => {
      handlers[ev] = fn
    }
  })
  let uid = 0
  async function measuredRequest(queries: number) {
    const req = {}
    await (async () => {
      beginTrace('/api/items/workflows', req as object)
      await span('auth', async () => {})
      for (let i = 0; i < queries; i++) {
        const q = { __knexQueryUid: String(++uid), sql: 'select * from x where id = @p0' }
        handlers.query(q)
        handlers['query-response'](null, q)
      }
      noteDerivedWrite('direct')
      noteDerivedWrite('rollup', 2)
    })()
    return { req }
  }

  it('aggregates per entity, badges N+1 and reports amplification', async () => {
    for (let i = 0; i < 4; i++) {
      const { req } = await measuredRequest(3)
      noteRequest({ ...baseEv, method: 'PATCH', path: '/api/items/workflows/7', req })
    }
    const d = costDetail('items/workflows', 60, T0)
    expect(d?.n).toBe(4)
    expect(d?.avg_trips).toBe(3)
    expect(d?.amplification).toMatchObject({ write_requests: 4, direct: 4, derived_total: 8 })
    expect(d?.amplification?.derived.rollup).toBe(8)
    expect(d?.amplification?.factor).toBe(2)
    expect(d?.n_plus_one).toBe(false)
    const b = d?.breakdown
    expect(
      (b?.auth ?? 0) +
        (b?.metadata ?? 0) +
        (b?.sql ?? 0) +
        (b?.hooks ?? 0) +
        (b?.serialization ?? 0) +
        (b?.other ?? 0)
    ).toBeCloseTo(100, 0)
    // snapshot + frame carry the figures
    const snap = buildSnapshot(60, { sockets: 0, users: 0, journalSeq: null })
    const row = snap.entities.find((e) => e.key === 'items/workflows')
    expect(row?.ext?.[REQUEST_COST_TAP]).toMatchObject({ n: 4, n_plus_one: false })
    const frame = buildFrame(T0, { sockets: 0, journalSeq: null })
    expect(frame.ext?.[REQUEST_COST_TAP]).toMatchObject({ n1: [], threshold: N_PLUS_ONE_AVG_TRIPS })
  })

  it('badges an entity whose requests average more round trips than the threshold', async () => {
    for (let i = 0; i < 3; i++) {
      const { req } = await measuredRequest(N_PLUS_ONE_AVG_TRIPS + 5)
      noteRequest({ ...baseEv, path: '/api/items/projects', req })
    }
    expect(costDetail('items/projects', 60, T0)?.n_plus_one).toBe(true)
    const frame = buildFrame(T0, { sockets: 0, journalSeq: null })
    const ext = frame.ext?.[REQUEST_COST_TAP] as { n1: string[]; trips: Record<string, number> }
    expect(ext.n1).toEqual(['items/projects'])
    expect(ext.trips['items/projects']).toBe(N_PLUS_ONE_AVG_TRIPS + 5)
  })

  it('ignores a request without a measure', () => {
    noteRequest({ ...baseEv })
    expect(costDetail('items/workflows', 60, T0)).toBeNull()
  })
})

describe('read shapes (#1135)', () => {
  it('derives paths + operators, never values', () => {
    const f = { _and: [{ status: { _eq: 'secret' } }, { project: { name: { _contains: 'x' } } }] }
    expect(filterTerms(f)).toEqual(['status eq', 'project.name contains'])
    expect(filterTerms({ owner: 'abc' })).toEqual(['owner eq'])
    expect(
      conditionTerms([
        { path: ['a', 'b'], op: '_in', value: [1] },
        { or: [{ path: ['c'], op: '_null' }] }
      ])
    ).toEqual(['a.b in', 'c null'])
    const shape = readShape(f, ['-created', 'name'], undefined)
    expect(shapeText(shape)).toBe('filter project.name contains, status eq · sort -created, name')
    expect(JSON.stringify(shape)).not.toContain('secret')
    expect(filterTerms({ 'bad seg': { _eq: 1 } })).toEqual([])
  })

  it('aggregates per collection and feeds the index advisor', async () => {
    recordReadShape('workflows', { status: { _eq: 1 } }, ['-created'], undefined, T0)
    recordReadShape('workflows', { status: { _in: [1] } }, [], undefined, T0)
    recordReadShape('workflows', { project: { name: { _eq: 'p' } } }, [], undefined, T0)
    const live = liveFilterColumns(900, T0)
    const status = live.find((l) => l.collection === 'workflows' && l.column === 'status')
    expect(status).toMatchObject({ filter: 2, sort: 0 })
    expect(status?.ops.sort()).toEqual(['eq', 'in'])
    expect(live.find((l) => l.column === 'created')).toMatchObject({ sort: 1 })
    expect(live.some((l) => l.column.includes('.'))).toBe(false)
    const d = await shapesDetail('items/workflows', 900, T0)
    expect(d?.reads).toBe(3)
    expect(d?.shapes[0]).toMatchObject({ n: 1 })
    expect(await shapesDetail('graphql/op', 900, T0)).toBeUndefined()
  })

  it('reads the shape off a measured request', async () => {
    const req = {}
    await (async () => {
      beginTrace('/api/items/workflows', req)
      noteReadShape('workflows', { stage: { _neq: 3 } }, [], undefined)
    })()
    noteRequest({ ...baseEv, req })
    expect(liveFilterColumns(900, T0)).toEqual([
      { collection: 'workflows', column: 'stage', filter: 1, sort: 0, ops: ['neq'] }
    ])
  })
})

describe('GraphQL field heat (#1134)', () => {
  const schema = {
    getType: (n: string) =>
      n === 'workflows'
        ? { getFields: () => ({ id: {}, name: {}, legacy_code: {}, __typename: {} }) }
        : undefined
  }

  it('counts selections per operation and lists unused fields as candidates', async () => {
    recordSelection('graphql/listWorkflows', 'k1', ['workflows.id', 'workflows.name'], T0)
    recordSelection('graphql/listWorkflows', 'k1', ['workflows.id'], T0)
    expect(unusedFieldsOf(schema, 'workflows', T0)).toEqual(['legacy_code'])
    const d = await graphqlFieldsDetail('graphql/listWorkflows', 60, T0, async () => schema)
    expect(d?.fields[0]).toMatchObject({
      field: 'workflows.id',
      n: 2,
      callers: [{ key: 'k1', n: 2 }]
    })
    expect(d?.types).toEqual([
      { type: 'workflows', selected: 2, total: 3, unused: ['legacy_code'] }
    ])
    expect(await graphqlFieldsDetail('items/x', 60, T0, async () => schema)).toBeUndefined()
  })

  it('records from the request stamp on the graphql lane', () => {
    noteRequest({
      ...baseEv,
      method: 'POST',
      path: '/api/graphql',
      graphqlOperation: 'MyOp',
      graphqlKind: 'query',
      req: { __nvrGql: { fields: ['workflows.name'] } }
    })
    expect(unusedFieldsOf(schema, 'workflows', T0)).toEqual(['id', 'legacy_code'])
    void GRAPHQL_FIELDS_TAP
  })
})

describe('field change heat (#1136)', () => {
  it('ranks fields with their top callers', () => {
    recordFieldChanges('items/workflows', 'u1', ['status', 'amount'], T0)
    recordFieldChanges('items/workflows', 'k2', ['status'], T0)
    const d = fieldHeatDetail('items/workflows', 60, T0)
    expect(d?.writes).toBe(2)
    expect(d?.fields[0]).toMatchObject({ field: 'status', n: 2, share: 1 })
    expect(d?.fields[0].callers.map((c) => c.key).sort()).toEqual(['k2', 'u1'])
    void FIELD_HEAT_TAP
  })

  it('feeds from noteWrite', () => {
    noteWrite({
      collection: 'projects',
      item: 4,
      action: 'update',
      changedFields: ['owner'],
      at: T0 * 1000
    })
    expect(fieldHeatDetail('items/projects', 60, T0)?.fields[0].field).toBe('owner')
  })
})

describe('hot records (#1119)', () => {
  it('parses item and lock paths', () => {
    expect(recordOfRequestPath('/api/items/workflows/12')).toEqual({
      collection: 'workflows',
      id: '12',
      lock: false
    })
    expect(recordOfRequestPath('/api/item-locks/workflows/12/lock')).toMatchObject({ lock: true })
    expect(recordOfRequestPath('/api/item-locks/config/workflows')).toBeNull()
    expect(recordOfRequestPath('/api/items/workflows/bulk')).toBeNull()
    expect(recordOfRequestPath('/api/items/workflows')).toBeNull()
  })

  it('ranks writes, conflicts, locks and queues', async () => {
    recordWrite('items/workflows', '1', T0)
    recordWrite('items/workflows', '1', T0)
    recordWrite('items/workflows', '2', T0)
    recordRequest('/api/items/workflows/2', 'PATCH', 409, T0)
    recordRequest('/api/item-locks/workflows/3/lock', 'POST', 200, T0)
    const d = await hotRecordsDetail('items/workflows', 60, T0, {
      locks: async () => ({ locks: new Map([['4', 'Beth Smith']]), queues: new Map([['4', 2]]) }),
      labels: async () => ({ '2': 'WF-2' })
    })
    expect(d?.rows.map((r) => r.id)).toEqual(['4', '2', '1', '3'])
    expect(d?.rows[1]).toMatchObject({ label: 'WF-2', writes: 1, conflicts: 1 })
    expect(d?.rows[0]).toMatchObject({ locked_by: 'Beth Smith', queue: 2 })
    expect(rankHotRecords([], 10)).toEqual([])
    expect(await hotRecordsDetail('graphql/x', 60, T0)).toBeUndefined()
  })
})
