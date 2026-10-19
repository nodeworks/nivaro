import type Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  askTelemetry,
  collectTraces,
  executeTelemetryTool,
  metricExpr,
  requestFilter,
  TELEMETRY_TOOLS,
  TelemetryAskError,
  windowOf
} from '../../../services/telemetry-ai.js'
import { setStoreFetchForTests } from '../../../services/telemetry-store.js'
import { normaliseTraceId, summariseSpans } from '../../../services/telemetry-traces.js'

const KEYS = [
  'TELEMETRY_STORE_URL',
  'TELEMETRY_STORE_ENV',
  'TELEMETRY_STORE_TOKEN',
  'CLOUD_META_DB_URL'
] as const
let saved: Record<string, string | undefined> = {}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  setStoreFetchForTests(null)
})

describe('telemetry tool inputs (#2544)', () => {
  it('clamps the window to the store reach and defaults to the last hour', () => {
    const now = Date.parse('2026-10-19T12:00:00Z')
    expect(windowOf({}, now)).toEqual({ from: now - 3600_000, to: now })
    const w = windowOf({ minutes: 10_000_000 }, now)
    expect(w.from).toBe(now - 31 * 86_400_000)
    expect(() => windowOf({ from: 'yesterday' }, now)).toThrow(/ISO/)
    const f = windowOf({ from: '2026-10-19T10:00:00Z', to: '2026-10-19T11:00:00Z' }, now)
    expect(f).toEqual({
      from: Date.parse('2026-10-19T10:00:00Z'),
      to: Date.parse('2026-10-19T11:00:00Z')
    })
  })
  it('builds request filters from typed fields only and refuses anything else', () => {
    expect(
      requestFilter(
        { route: 'GET /api/items/workflows/:id', status: '5xx', min_ms: 800 },
        'staging'
      )
    ).toBe('{env="staging"} nvr:=api route:="GET /api/items/workflows/:id" status:>=500 ms:>=800')
    expect(requestFilter({ status: '4xx', error_text: 'Timeout (15s)' }, null)).toBe(
      'nvr:=api status:>=400 status:<500 err:~"(?i)Timeout \\\\(15s\\\\)"'
    )
    expect(() => requestFilter({ route: 'x" | delete' }, null)).toThrow(/route/)
    expect(() => requestFilter({ caller: 'admin' }, null)).toThrow(/caller/)
    expect(() => requestFilter({ status: 'weird' }, null)).toThrow(/status/)
  })
  it('only runs metrics from the fixed list, with the env matcher inserted', () => {
    expect(metricExpr('api_requests_per_s', 'staging')).toBe(
      'sum(rate(nivaro_http_requests_total{env="staging"}[5m]))'
    )
    expect(metricExpr('api_errors_5xx_per_s', 'prod')).toContain('{env="prod",status="5xx"}')
    expect(metricExpr('host_load_15m', null)).toBe('node_load15')
    expect(() => metricExpr('sum(up)', null)).toThrow(/metric must be one of/)
  })
  it('every tool is read-only by name and has a schema', () => {
    for (const t of TELEMETRY_TOOLS) {
      expect(t.name).not.toMatch(/delete|write|create|update|set_|propose/)
      expect(t.input_schema.type).toBe('object')
    }
  })
  it('refuses to run without a store', async () => {
    await expect(executeTelemetryTool('request_stats', {})).rejects.toThrow(/not configured/)
  })
})

describe('traces read back', () => {
  it('accepts a trace id or a request id', () => {
    expect(normaliseTraceId('4B666C6263AC45E5996287B641074EE6')).toBe(
      '4b666c6263ac45e5996287b641074ee6'
    )
    expect(normaliseTraceId('4b666c62-63ac-45e5-9962-87b641074ee6')).toBe(
      '4b666c6263ac45e5996287b641074ee6'
    )
    expect(normaliseTraceId('nope')).toBeNull()
  })
  it('summarises spans: phase depth, statement shapes, repeated statements', () => {
    const rows = [
      {
        kind: '2',
        span_id: 'r',
        name: 'GET /api/items/:collection',
        duration: '900000000',
        _time: '2026-10-19T10:00:00Z',
        'span_attr:http.route': '/api/items/:collection',
        'span_attr:http.response.status_code': '200'
      },
      {
        kind: '1',
        span_id: 'p1',
        parent_span_id: 'r',
        name: 'readItems',
        duration: '800000000',
        start_time_unix_nano: '2'
      },
      {
        kind: '1',
        span_id: 'p2',
        parent_span_id: 'p1',
        name: 'permissions',
        duration: '50000000',
        start_time_unix_nano: '3'
      },
      ...Array.from({ length: 6 }, (_, i) => ({
        kind: '3',
        span_id: `s${i}`,
        parent_span_id: 'p1',
        name: 'SQL',
        duration: '10000000',
        'span_attr:db.query.text': 'select * from owners where id = ?'
      })),
      {
        kind: '3',
        span_id: 'big',
        parent_span_id: 'p1',
        name: 'SQL',
        duration: '500000000',
        'span_attr:db.query.text': 'select count(*) from workflows'
      }
    ]
    const t = summariseSpans('abc', rows as unknown as Array<Record<string, string>>)!
    expect(t.route).toBe('/api/items/:collection')
    expect(t.total_ms).toBe(900)
    expect(t.phases).toEqual([
      { phase: 'readItems', ms: 800, depth: 0, queries: null },
      { phase: 'permissions', ms: 50, depth: 1, queries: null }
    ])
    expect(t.heaviest_statements[0]).toEqual({
      sql: 'select count(*) from workflows',
      calls: 1,
      total_ms: 500
    })
    expect(t.repeated_statements).toEqual([
      { sql: 'select * from owners where id = ?', calls: 6, total_ms: 60 }
    ])
    expect(t.sql_ms).toBe(560)
  })
  it('collects the traces a tool result mentions, with route and timing', () => {
    const out = new Map()
    collectTraces(
      {
        traces: [
          {
            trace_id: '4b666c6263ac45e5996287b641074ee6',
            route: 'GET /api/x',
            total_ms: 2000,
            status: 200
          }
        ],
        requests: [{ tid: 'not-hex' }],
        trace: {
          trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          method: 'GET',
          route: '/api/y',
          total_ms: 5,
          status: 500
        }
      },
      out
    )
    expect([...out.values()]).toEqual([
      { id: '4b666c6263ac45e5996287b641074ee6', route: 'GET /api/x', ms: 2000, status: 200 },
      { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', route: 'GET /api/y', ms: 5, status: 500 }
    ])
  })
})

describe('asking', () => {
  it('runs tools, feeds results back and returns the answer with the traces it saw', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    setStoreFetchForTests(
      async () =>
        new Response(
          `${JSON.stringify({ trace_id: '4b666c6263ac45e5996287b641074ee6', name: 'GET /api/x', duration: '2000000000', _time: '2026-10-19T10:00:00Z', 'span_attr:http.response.status_code': '200' })}\n`
        )
    )
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = []
    const client = {
      messages: {
        create: async (args: Anthropic.MessageCreateParamsNonStreaming) => {
          calls.push(structuredClone(args))
          if (calls.length === 1)
            return {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id: 't1', name: 'slow_traces', input: { minutes: 60 } }]
            } as unknown as Anthropic.Message
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'GET /api/x took 2 s.' }]
          } as unknown as Anthropic.Message
        }
      }
    }
    const r = await askTelemetry('why slow?', { id: 'u' } as never, { client })
    expect(r.answer).toBe('GET /api/x took 2 s.')
    expect(r.traces.map((t) => t.id)).toEqual(['4b666c6263ac45e5996287b641074ee6'])
    expect(r.tools).toEqual([{ tool: 'slow_traces', ok: true }])
    const second = calls[1].messages
    const last = second[second.length - 1].content as Anthropic.ToolResultBlockParam[]
    expect(last[0].type).toBe('tool_result')
    expect(String(last[0].content)).toContain('4b666c6263ac45e5996287b641074ee6')
  })
  it('hands a bad tool input back to the model as an error instead of failing', async () => {
    process.env.TELEMETRY_STORE_URL = 'http://store:8427'
    let n = 0
    const client = {
      messages: {
        create: async () => {
          n++
          if (n === 1)
            return {
              stop_reason: 'tool_use',
              content: [
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'metric_series',
                  input: { metric: 'drop table' }
                }
              ]
            } as unknown as Anthropic.Message
          return {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'ok' }]
          } as unknown as Anthropic.Message
        }
      }
    }
    const r = await askTelemetry('cpu?', { id: 'u' } as never, { client })
    expect(r.tools).toEqual([{ tool: 'metric_series', ok: false }])
  })
  it('rejects empty questions and a missing store', async () => {
    await expect(askTelemetry('x', { id: 'u' } as never)).rejects.toBeInstanceOf(TelemetryAskError)
    await expect(askTelemetry('why slow?', { id: 'u' } as never)).rejects.toThrow(/not configured/)
  })
})
