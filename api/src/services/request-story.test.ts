import { describe, expect, it } from 'vitest'
import {
  actionPhrase,
  assembleRequestStory,
  hookName,
  normalizeRequestId,
  type StoryLog,
  type StoryParts
} from './request-story.js'

const RID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'

const log: StoryLog = {
  method: 'PATCH',
  path: '/api/items/workflows/85607',
  route: 'PATCH /api/items/:collection/:id',
  status: 200,
  latency_ms: 1800,
  created_at: '2026-10-29T15:00:01.800Z',
  who: 'Jordan Lee',
  caller_kind: 'user',
  instance: 'api-1',
  chain_id: 'c0ffee00-0000-4000-8000-000000000001',
  error: null,
  graphql_operation: null
}

describe('assembleRequestStory', () => {
  it('tells the whole story when every part is there', () => {
    const parts: StoryParts = {
      requestId: RID,
      log,
      trace: {
        total_ms: 1800,
        queries: 3,
        sql_ms: 42,
        spans: [
          { phase: 'auth', ms: 4, at: 1 },
          {
            phase: 'hook:efp-ops:workflows:update:before',
            ms: 120,
            at: 20,
            detail: 'forecast-guard'
          }
        ],
        top_sql: [{ sql: 'select * from workflows where id = ?', n: 1, ms: 12 }],
        emits: [{ event: 'collection:update', n: 1 }]
      },
      steps: [
        {
          key: 'activity:1',
          kind: 'write',
          at: '2026-10-29T15:00:00.300Z',
          summary: 'Updated workflow 85607',
          record: { collection: 'workflows', item: '85607' },
          detail: { type: 'changes', changes: [{ field: 'status', label: 'Status' }] }
        },
        {
          key: 'call:9',
          kind: 'partner_call',
          at: '2026-10-29T15:00:01.500Z',
          summary: 'Fusion answered 200',
          detail: { type: 'call', status: 200, duration_ms: 1400 }
        },
        {
          key: 'n:1',
          kind: 'notify',
          at: '2026-10-29T15:00:01.600Z',
          summary: 'Told Sam',
          detail: { type: 'notify', recipient: 'Sam' }
        },
        {
          key: 'n:2',
          kind: 'notify',
          at: '2026-10-29T15:00:01.600Z',
          summary: 'Told Priya',
          detail: { type: 'notify', recipient: 'Priya' }
        }
      ]
    }
    const s = assembleRequestStory(parts)
    expect(s.found).toBe(true)
    expect(s.headline).toBe(
      'Saved workflow 85607 · 3 SQL statements (42 ms) · hook efp-ops:forecast-guard 120 ms · pushed to Fusion (200, 1.4 s) · 2 people notified · 1 live update · 1.8 s total'
    )
    expect(s.missing).toEqual([])
    expect(s.sources).toEqual({ log: 'found', trace: 'kept', chain: 'found' })
    expect(s.timeline[0].kind).toBe('request')
    // Write details name fields, never values.
    expect(s.timeline.find((e) => e.kind === 'write')?.text).toBe('Updated workflow 85607 (Status)')
    // Timeline is in time order (known offsets first).
    const offsets = s.timeline.map((e) => e.offset_ms).filter((n): n is number => n != null)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
    expect(s.sql?.statements[0]).toEqual({
      sql: 'select * from workflows where id = ?',
      n: 1,
      ms: 12
    })
  })

  it('says what is missing when the trace expired and the chain is empty', () => {
    const s = assembleRequestStory({
      requestId: RID,
      log: { ...log, status: 500, error: 'Internal Server Error' },
      trace: null,
      traceReason: 'Not kept — requests under 1000 ms are not traced.',
      steps: []
    })
    expect(s.headline).toBe('Saved workflow 85607 — failed 500 · 1.8 s total')
    expect(s.missing).toEqual(['Not kept — requests under 1000 ms are not traced.'])
    expect(s.sources.trace).toBe('missing')
    expect(s.sources.chain).toBe('empty')
    expect(s.timeline.some((e) => e.kind === 'error' && e.text.includes('500'))).toBe(true)
  })

  it('a trace without a log row (still batching) still tells something', () => {
    const s = assembleRequestStory({
      requestId: RID,
      log: null,
      logPending: true,
      trace: { total_ms: 2100, queries: 40, sql_ms: 900, spans: [], top_sql: [] },
      steps: null
    })
    expect(s.found).toBe(true)
    expect(s.headline).toBe('Request · 40 SQL statements (900 ms)')
    expect(s.sources.log).toBe('pending')
    expect(s.missing[0]).toContain('not written yet')
  })

  it('nothing at all', () => {
    const s = assembleRequestStory({ requestId: RID, log: null, trace: null, steps: null })
    expect(s.found).toBe(false)
    expect(s.headline).toBe('Nothing is kept about this request id.')
    expect(s.missing.length).toBe(2)
  })
})

describe('helpers', () => {
  it('actionPhrase', () => {
    expect(actionPhrase('POST', '/api/items/purchase_orders')).toBe('Created a purchase order')
    expect(actionPhrase('DELETE', '/api/items/categories/4')).toBe('Deleted category 4')
    expect(actionPhrase('GET', '/api/settings')).toBe('GET /api/settings')
  })
  it('hookName', () => {
    expect(hookName('hook:core:workflows:update:after')).toBe('core after-update on workflows')
    expect(hookName('hook:efp-ops:workflows:update:before', 'guard')).toBe('efp-ops:guard')
  })
  it('normalizeRequestId accepts the OTLP 32-hex spelling', () => {
    expect(normalizeRequestId('1B4E28BA2FA111D2883F0016D3CCA427')).toBe(RID)
    expect(normalizeRequestId(RID.toUpperCase())).toBe(RID)
    expect(normalizeRequestId('nope')).toBeNull()
  })
})
