// api/src/test/unit/services/traffic-partners.test.ts
// Partner and API-shape lenses (#2150 #2200 #2201 #2205 #2206).
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  db: Object.assign(vi.fn(), { raw: vi.fn(async () => []) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({ instanceKey: () => 'test-node' }))

import { resetTrafficMap } from '../../../services/traffic-map.js'
import {
  attainment,
  type CallRow,
  percentile,
  readAgreed,
  validateAgreed,
  withAgreed
} from '../../../services/traffic-partner-contract.js'
import {
  driftReport,
  MIN_BODIES,
  type PathTypes,
  shapeOf,
  shapeOfBody
} from '../../../services/traffic-payload-drift.js'
import { costDetail, costRanking, recordCost } from '../../../services/traffic-taps/graphql-cost.js'
import {
  classifyRun,
  inboundOutcomesDetail,
  normalizeReason,
  recordInbound
} from '../../../services/traffic-taps/inbound-outcomes.js'
import {
  fieldNames,
  recordFieldHeat,
  restFieldsDetail
} from '../../../services/traffic-taps/rest-field-heat.js'

const SEC = 1_800_000_000
const HOUR = 3_600_000

beforeEach(() => resetTrafficMap())

describe('#2150 contract targets', () => {
  it('reads, validates and merges the agreed figures without losing the payload contract', () => {
    expect(readAgreed('{"required":["a"]}')).toBeNull()
    expect(readAgreed('{"agreed":{"p95_ms":800,"uptime_pct":99.5}}')).toEqual({
      p95_ms: 800,
      uptime_pct: 99.5
    })
    expect(validateAgreed({ p95_ms: 0 }).ok).toBe(false)
    expect(validateAgreed({ uptime_pct: 101 }).ok).toBe(false)
    expect(validateAgreed({ p95_ms: '', uptime_pct: '' })).toEqual({ ok: true, value: null })
    const merged = withAgreed('{"required":["a"]}', { p95_ms: 500, uptime_pct: null })
    expect(JSON.parse(merged as string)).toEqual({
      required: ['a'],
      agreed: { p95_ms: 500, uptime_pct: null }
    })
    expect(withAgreed('{"agreed":{"p95_ms":5}}', null)).toBeNull()
  })

  it('percentile is nearest-rank', () => {
    expect(percentile([], 95)).toBeNull()
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100)
    expect(percentile([5], 95)).toBe(5)
  })

  it('marks breached hours and computes month attainment', () => {
    const now = Date.UTC(2026, 9, 17, 12, 30)
    const rows: CallRow[] = []
    // hour 10: fast and up; hour 11: slow; hour 9: five 503s of ten
    const at = (h: number, i: number) => Date.UTC(2026, 9, 17, h, i)
    for (let i = 0; i < 6; i++) rows.push({ at: at(10, i), status: 200, ms: 100 })
    for (let i = 0; i < 6; i++) rows.push({ at: at(11, i), status: 200, ms: 2000 })
    for (let i = 0; i < 10; i++) rows.push({ at: at(9, i), status: i < 5 ? 503 : 200, ms: 100 })
    rows.push({ at: at(8, 1), status: 200, ms: 99999 }) // one call: too few to judge
    const a = attainment(rows, { p95_ms: 500, uptime_pct: 99 }, now)
    expect(a.hours_judged).toBe(3)
    expect(a.hours_breached).toBe(2)
    expect(a.attainment_pct).toBeCloseTo(33.3, 1)
    const by = Object.fromEntries(a.series.map((p) => [p.t.slice(11, 13), p.breach]))
    expect(by['09']).toBe('availability')
    expect(by['10']).toBeNull()
    expect(by['11']).toBe('latency')
    expect(by['08']).toBeNull() // judged:false
    expect(a.series).toHaveLength(24)
    expect(a.uptime_met).toBe(false)
    expect(a.latency_met).toBe(false)
  })

  it('ignores calls before the month start', () => {
    const now = Date.UTC(2026, 9, 2, 12)
    const rows: CallRow[] = [
      { at: Date.UTC(2026, 8, 30, 12), status: 500, ms: 9999 },
      ...Array.from({ length: 5 }, (_, i) => ({ at: now - HOUR + i * 1000, status: 200, ms: 50 }))
    ]
    const a = attainment(rows, { p95_ms: 100, uptime_pct: null }, now)
    expect(a.calls).toBe(5)
    expect(a.latency_met).toBe(true)
  })
})

describe('#2200 payload shape drift', () => {
  it('reads paths and types, never values', () => {
    const s = shapeOf({ id: 1, name: 'x', tags: [{ k: 'v' }], meta: null, 12345: 'a' })
    expect([...s.keys()].sort()).toEqual(['*', 'id', 'meta', 'name', 'tags', 'tags[]', 'tags[].k'])
    expect(s.get('id')).toEqual(new Set(['number']))
    expect(JSON.stringify([...s])).not.toContain('"x"')
    expect(shapeOfBody('{"a":')).toBeNull()
  })

  const body = (extra: Record<string, unknown> = {}, omit: string[] = []): PathTypes => {
    const o: Record<string, unknown> = { id: 1, status: 'ok', total: 12.5, ...extra }
    for (const k of omit) delete o[k]
    return shapeOf(o)
  }

  it('learns first, then steady', () => {
    expect(driftReport(Array.from({ length: 5 }, () => body())).status).toBe('learning')
    const steady = driftReport(Array.from({ length: MIN_BODIES + 5 }, () => body()))
    expect(steady.status).toBe('steady')
  })

  it('flags new, missing and retyped fields', () => {
    const old = Array.from({ length: 30 }, () => body())
    const recent = Array.from({ length: 8 }, () => body({ discount: 3, status: 7 }, ['total']))
    const r = driftReport([...old, ...recent])
    expect(r.status).toBe('drifting')
    expect(r.new_fields.map((f) => f.path)).toEqual(['discount'])
    expect(r.missing_fields.map((f) => f.path)).toEqual(['total'])
    expect(r.type_changes).toEqual([
      expect.objectContaining({ path: 'status', from: 'string', to: 'number' })
    ])
  })

  it('does not flag a field that appears once, or null for a typed field', () => {
    const old = Array.from({ length: 30 }, () => body())
    const recent = [body({ stray: 1 }), ...Array.from({ length: 6 }, () => body({ status: null }))]
    const r = driftReport([...old, ...recent])
    expect(r.new_fields).toEqual([])
    expect(r.type_changes).toEqual([])
  })
})

describe('#2201 inbound outcomes', () => {
  const run = (actions: Array<'created' | 'rejected'>, error = 'Vendor 8841 not found') => ({
    results: actions.map((action) => ({
      action,
      error: action === 'rejected' ? error : undefined
    })),
    created: actions.filter((a) => a === 'created').length,
    updated: 0,
    rejected: actions.filter((a) => a === 'rejected').length
  })

  it('classifies accepted, partial and rejected payloads', () => {
    expect(classifyRun(run(['created', 'created']))?.outcome).toBe('accepted')
    expect(classifyRun(run(['created', 'rejected']))?.outcome).toBe('partial')
    expect(classifyRun(run(['rejected']))?.outcome).toBe('rejected')
    expect(classifyRun(run([]))).toBeNull()
  })

  it('folds ids and numbers out of reasons', () => {
    expect(normalizeReason('Vendor 8841 not found')).toBe('Vendor # not found')
    expect(normalizeReason('bad 3f2a1b0c-1111-2222-3333-444455556666 x')).toBe('bad # x')
  })

  it('counts outcomes and top reasons per mapping', () => {
    const s1 = classifyRun(run(['created', 'rejected']))
    const s2 = classifyRun(run(['rejected'], 'Vendor 12 not found'))
    const s3 = classifyRun(run(['created']))
    for (const s of [s1, s2, s3]) recordInbound('inbound/po', s as never, SEC)
    const d = inboundOutcomesDetail('inbound/po', 60, SEC)
    expect(d?.payloads).toEqual({ accepted: 1, partial: 1, rejected: 1 })
    expect(d?.entries).toBe(4)
    expect(d?.entries_rejected).toBe(2)
    expect(d?.reasons).toEqual([{ reason: 'Vendor # not found', n: 2 }])
    expect(inboundOutcomesDetail('items/x', 60, SEC)).toBeUndefined()
  })
})

describe('#2205 GraphQL query cost', () => {
  it('ranks operations by resolver time and names callers', () => {
    recordCost('graphql/Heavy', 'key:a', { depth: 9, selections: 120 }, 400, 300, SEC)
    recordCost('graphql/Heavy', 'key:a', { depth: 7, selections: 100 }, 380, 260, SEC)
    recordCost('graphql/Heavy', 'user:b', { depth: 8, selections: 110 }, 420, 340, SEC)
    recordCost('graphql/Light', 'key:a', { depth: 2, selections: 5 }, 20, 0, SEC)
    const rank = costRanking(60, SEC)
    expect(rank.map((r) => r.operation)).toEqual(['Heavy', 'Light'])
    const d = costDetail('graphql/Heavy', 60, SEC)
    expect(d).toMatchObject({
      calls: 3,
      max_depth: 9,
      avg_selections: 110,
      avg_resolver_ms: 300,
      rank: 1,
      of: 2
    })
    expect(d?.callers[0]).toEqual({ key: 'key:a', n: 2 })
    const light = costDetail('graphql/Light', 60, SEC)
    expect(light?.avg_resolver_ms).toBeNull()
    expect(light?.rank).toBe(2)
    expect(costDetail('items/x', 60, SEC)).toBeUndefined()
  })
})

describe('#2206 REST field heat', () => {
  it('keeps names only, defaults to *, and rejects anything else', () => {
    expect(fieldNames(undefined)).toEqual(['*'])
    expect(fieldNames(['id', 'owner.name', 'owner.*', 'a b', "x';--", 7])).toEqual([
      'id',
      'owner.name',
      'owner.*'
    ])
    expect(fieldNames(['', '  '])).toEqual(['*'])
  })

  it('counts fields per collection with the callers asking', () => {
    recordFieldHeat('workflows', 'key:a', ['id', 'name'], SEC)
    recordFieldHeat('workflows', 'key:a', ['id'], SEC)
    recordFieldHeat('workflows', 'user:b', ['*'], SEC)
    const d = restFieldsDetail('items/workflows', 60, SEC)
    expect(d?.reads).toBe(3)
    expect(d?.star_reads).toBe(1)
    expect(d?.fields[0]).toMatchObject({ field: 'id', n: 2 })
    expect(d?.fields[0].callers).toEqual([{ key: 'key:a', n: 2 }])
    expect(restFieldsDetail('items/missing', 60, SEC)).toBeUndefined()
    expect(restFieldsDetail('graphql/x', 60, SEC)).toBeUndefined()
  })
})
