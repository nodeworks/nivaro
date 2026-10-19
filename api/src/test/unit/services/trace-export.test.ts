import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resetTelemetryStatusForTests,
  telemetrySettings,
  telemetryStatus
} from '../../../services/telemetry-status.js'
import { setStoreFetchForTests } from '../../../services/telemetry-store.js'
import {
  buildSpans,
  exportReason,
  flushTraceExport,
  nanos,
  otlpBody,
  queueTraceExport,
  resetTraceExportForTests,
  setTraceExportFetchForTests,
  traceExportConfig,
  traceExportStats,
  traceIdFor
} from '../../../services/trace-export.js'

const KEYS = [
  'TRACE_EXPORT_URL',
  'TRACE_EXPORT_TOKEN',
  'TRACE_EXPORT_SAMPLE',
  'TRACE_EXPORT_ENV',
  'TELEMETRY_STORE_URL',
  'TELEMETRY_STORE_TOKEN',
  'TELEMETRY_STORE_ENV',
  'TELEMETRY_ACCESS_LOG',
  'TELEMETRY_GRAFANA_URL',
  'CLOUD_META_DB_URL'
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  resetTraceExportForTests()
  resetTelemetryStatusForTests()
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setTraceExportFetchForTests(null)
  setStoreFetchForTests(null)
})

const RID = '7a0411f3-c687-40e5-adf5-614157cf88ec'
const input = (over: Record<string, unknown> = {}) => ({
  requestId: RID,
  startMs: 1_792_000_000_000.5,
  totalMs: 1500,
  method: 'GET',
  route: '/api/items/:collection',
  path: '/api/items/workflows?filter=secret-value',
  status: 200,
  user: 'u-1',
  queries: 3,
  reason: 'slow' as const,
  phases: [
    { phase: 'auth', at: 0, ms: 20 },
    { phase: 'readItems', at: 25, ms: 1400, queries: 2 },
    { phase: 'permissions', at: 30, ms: 100 }
  ],
  statements: [
    { sql: 'select * from workflows where id = ?', at: 35, ms: 50 },
    { sql: 'select count(*) from workflows', at: 200, ms: 900 }
  ],
  ...over
})

describe('trace export config and choice (#690)', () => {
  it('is off without a URL and in cloud mode', () => {
    expect(traceExportConfig()).toBeNull()
    process.env.TRACE_EXPORT_URL = 'http://efp_obs_alloy:4318/v1/traces'
    expect(traceExportConfig()).toMatchObject({ sample: 0.02, service: 'nivaro-api' })
    process.env.CLOUD_META_DB_URL = 'x'
    expect(traceExportConfig()).toBeNull()
  })
  it('sends slow, failed and kept requests, and a sample of the rest', () => {
    process.env.TRACE_EXPORT_URL = 'http://x/v1/traces'
    process.env.TRACE_EXPORT_SAMPLE = '0.1'
    const cfg = traceExportConfig()
    expect(exportReason(cfg, 50, 503, 1000, false)).toBe('error')
    expect(exportReason(cfg, 1200, 200, 1000, false)).toBe('slow')
    expect(exportReason(cfg, 50, 200, 1000, true)).toBe('kept')
    expect(exportReason(cfg, 50, 200, 1000, false, () => 0.05)).toBe('sampled')
    expect(exportReason(cfg, 50, 200, 1000, false, () => 0.5)).toBeNull()
    expect(exportReason(null, 5000, 500, 1000, true)).toBeNull()
  })
  it('uses the request id as the W3C trace id', () => {
    expect(traceIdFor(RID)).toBe('7a0411f3c68740e5adf5614157cf88ec')
    expect(traceIdFor('req-1')).toBeNull()
    expect(nanos(1.5)).toBe('1500000')
  })
})

describe('building spans', () => {
  let n = 0
  const ids = () => `s${String(++n).padStart(15, '0')}`
  beforeEach(() => {
    n = 0
  })
  it('nests phases by time and statements under the innermost phase', () => {
    const spans = buildSpans(input(), ids)
    const byName = (name: string) => spans.filter((s) => s.name === name)
    const root = spans[0]
    expect(root.name).toBe('GET /api/items/:collection')
    expect(root.kind).toBe(2)
    expect(root.parentSpanId).toBeUndefined()
    const read = byName('readItems')[0]
    expect(read.parentSpanId).toBe(root.spanId)
    expect(byName('permissions')[0].parentSpanId).toBe(read.spanId)
    const [first, second] = byName('SQL')
    expect(first.parentSpanId).toBe(byName('permissions')[0].spanId)
    expect(second.parentSpanId).toBe(read.spanId)
    expect(new Set(spans.map((s) => s.traceId))).toEqual(
      new Set(['7a0411f3c68740e5adf5614157cf88ec'])
    )
  })
  it('never sends the query string or bound values', () => {
    const spans = buildSpans(input(), ids)
    const all = JSON.stringify(spans)
    expect(all).not.toContain('secret-value')
    expect(all).toContain('"url.path"')
    expect(all).toContain('/api/items/workflows"')
    expect(spans.find((s) => s.name === 'SQL')?.attributes).toEqual([
      { key: 'db.system', value: { stringValue: 'mssql' } },
      { key: 'db.query.text', value: { stringValue: 'select * from workflows where id = ?' } }
    ])
  })
  it('marks a server error on the request span', () => {
    expect(buildSpans(input({ status: 502 }), ids)[0].status.code).toBe(2)
  })
})

describe('queue and send', () => {
  it('batches, sends with the token, and counts', async () => {
    process.env.TRACE_EXPORT_URL = 'http://alloy:4318/v1/traces'
    process.env.TRACE_EXPORT_TOKEN = 'send-token'
    process.env.TRACE_EXPORT_ENV = 'staging'
    const posts: Array<{ url: string; init: RequestInit }> = []
    setTraceExportFetchForTests(async (url, init) => {
      posts.push({ url, init })
      return new Response('{}', { status: 200 })
    })
    expect(queueTraceExport(input())).toBe(true)
    expect(queueTraceExport(input({ reason: 'error', status: 500 }))).toBe(true)
    await flushTraceExport()
    expect(posts).toHaveLength(1)
    expect((posts[0].init.headers as Record<string, string>).authorization).toBe(
      'Bearer send-token'
    )
    const body = JSON.parse(String(posts[0].init.body))
    const res = body.resourceSpans[0].resource.attributes
    expect(res).toContainEqual({
      key: 'deployment.environment.name',
      value: { stringValue: 'staging' }
    })
    expect(traceExportStats()).toMatchObject({
      traces_sent: 2,
      queued: 0,
      by_reason: { slow: 1, error: 1, kept: 0, sampled: 0 }
    })
  })
  it('drops a failed batch and records the error, without throwing', async () => {
    process.env.TRACE_EXPORT_URL = 'http://alloy:4318/v1/traces'
    setTraceExportFetchForTests(async () => new Response('no', { status: 401 }))
    queueTraceExport(input())
    await flushTraceExport()
    expect(traceExportStats()).toMatchObject({ traces_sent: 0, dropped: 1, failed_batches: 1 })
    expect(traceExportStats().last_error).toMatch(/401/)
  })
  it('builds a valid OTLP body', () => {
    process.env.TRACE_EXPORT_URL = 'http://alloy:4318/v1/traces'
    const body = otlpBody([], traceExportConfig()!, 'api-1')
    expect(body.resourceSpans[0].scopeSpans[0].scope.name).toBe('nivaro.request-trace')
  })
})

describe('telemetry status (#2544)', () => {
  it('reports settings without token values', () => {
    process.env.TELEMETRY_STORE_URL = 'http://efp_obs_vmauth:8427'
    process.env.TELEMETRY_STORE_TOKEN = 'read-secret'
    process.env.TRACE_EXPORT_URL = 'http://efp_obs_alloy:4318/v1/traces'
    process.env.TRACE_EXPORT_TOKEN = 'send-secret'
    process.env.TELEMETRY_GRAFANA_URL = 'javascript:alert(1)'
    const s = telemetrySettings()
    expect(s.store).toMatchObject({
      configured: true,
      host: 'efp_obs_vmauth:8427',
      token_set: true
    })
    expect(s.traces).toMatchObject({
      configured: true,
      host: 'efp_obs_alloy:4318',
      token_set: true
    })
    expect(s.grafana_url).toBeNull()
    expect(JSON.stringify(s)).not.toMatch(/secret/)
  })
  it('reads each part on its own; one failure does not blank the rest', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    setStoreFetchForTests(async (url, init) => {
      const q = new URLSearchParams(String(init.body)).get('query') ?? ''
      if (url.endsWith('/api/v1/query')) {
        if (q === 'up')
          return Response.json({
            data: { result: [{ metric: { job: 'node', instance: 'staging' }, value: [0, '1'] }] }
          })
        if (q.startsWith('ALERTS')) return new Response('boom', { status: 500 })
        return Response.json({ data: { result: [] } })
      }
      return new Response('{"n":"12"}\n', { status: 200 })
    })
    const st = await telemetryStatus()
    expect(st.stack.targets.items).toEqual([
      { job: 'node', instance: 'staging', host: null, up: true }
    ])
    expect(st.stack.alerts.error).toMatch(/500/)
    expect(st.arrival.access_lines_1h).toBe(12)
  })
})
