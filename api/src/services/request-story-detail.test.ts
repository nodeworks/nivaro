import { describe, expect, it, vi } from 'vitest'

// The loader's sanitizer is pure; its readers are not needed here.
vi.mock('./event-path/exact.js', () => ({ loadChainSteps: vi.fn() }))
vi.mock('./request-trace.js', () => ({ getTrace: vi.fn() }))
vi.mock('./traffic-inspect/request.js', () => ({
  findRequestRow: vi.fn(),
  LOG_RETENTION_DAYS: 14,
  PENDING_MS: 60_000,
  traceAbsence: vi.fn()
}))

import {
  actionPhrase,
  assembleRequestStory,
  layoutPhases,
  phaseCategory,
  phaseLabel,
  type StoryLog,
  type StoryTrace,
  stepRowId,
  storyEffect,
  storyStatements,
  timeSplit
} from './request-story.js'
import { storyStep } from './request-story-load.js'

const RID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'

const log: StoryLog = {
  method: 'PATCH',
  path: '/api/items/workflows/85607',
  route: 'PATCH /api/items/:collection/:id',
  status: 200,
  latency_ms: 200,
  created_at: '2026-10-29T15:00:00.200Z',
  who: 'Jordan Lee',
  caller_kind: 'user',
  instance: 'api-1',
  chain_id: 'c0ffee00-0000-4000-8000-000000000001',
  error: null,
  graphql_operation: null,
  auth: 'session',
  user_id: 'U-1',
  api_key_id: null,
  ip: '10.0.0.1',
  user_agent: 'Mozilla/5.0',
  has_query: true,
  body_kept: false,
  matched_by: 'request_id'
}

const trace: StoryTrace = {
  total_ms: 200,
  queries: 12,
  sql_ms: 60,
  spans: [
    { seq: 1, phase: 'auth', ms: 10, at: 0 },
    { seq: 2, phase: 'permissions', ms: 20, at: 10 },
    {
      seq: 3,
      phase: 'hook:efp-ops:workflows:update:before',
      ms: 80,
      at: 30,
      detail: 'forecast-guard',
      repeat: { sql: 'select id from lines where wf = ?', n: 9, ms: 45 }
    },
    { seq: 4, phase: 'rollup-recalc', ms: 30, at: 40 },
    { seq: 5, phase: 'read-back', ms: 40, at: 120, queries: 2 }
  ],
  top_sql: [
    {
      sql: 'select id from lines where wf = ?',
      n: 9,
      ms: 45,
      sha: 'a'.repeat(40),
      tables: ['lines']
    },
    { sql: 'select * from workflows where id = ?', n: 1, ms: 15, sha: 'b'.repeat(40) }
  ],
  wide: [{ table: 'workflows', n: 1 }]
}

describe('words', () => {
  it('names the record a pipeline move was for, and says an', () => {
    expect(actionPhrase('POST', '/api/pipelines/instance/workflows/373029/transition')).toBe(
      'Moved workflow 373029 along its pipeline'
    )
    expect(actionPhrase('POST', '/api/items/inventory_request')).toBe(
      'Created an inventory request'
    )
  })
})

describe('phases', () => {
  it('categorises and names phases', () => {
    expect(phaseCategory('auth')).toBe('auth')
    expect(phaseCategory('permissions')).toBe('access')
    expect(phaseCategory('tree-permissions')).toBe('access')
    expect(phaseCategory('hook:core:x:update:after')).toBe('hooks')
    expect(phaseCategory('rules:before-update')).toBe('hooks')
    expect(phaseCategory('queue:sla')).toBe('work')
    expect(phaseLabel('auth')).toBe('Sign-in check')
    expect(phaseLabel('queue:send-backs')).toBe('Queue · send backs')
    expect(phaseLabel('hook:efp-ops:workflows:update:before', 'guard')).toBe('Hook efp-ops:guard')
  })

  it('nests a span inside the one before it and splits top-level time', () => {
    const phases = layoutPhases(trace.spans)
    expect(phases.map((p) => [p.phase, p.depth])).toEqual([
      ['auth', 0],
      ['permissions', 0],
      ['hook:efp-ops:workflows:update:before', 0],
      ['rollup-recalc', 1],
      ['read-back', 0]
    ])
    // 10 auth + 20 access + 80 hooks + 40 work = 150 measured; 50 unmeasured.
    expect(timeSplit(phases, 200)).toEqual([
      { key: 'auth', label: 'Sign-in', ms: 10 },
      { key: 'access', label: 'Access checks', ms: 20 },
      { key: 'hooks', label: 'Hooks & rules', ms: 80 },
      { key: 'work', label: 'Other measured work', ms: 40 },
      { key: 'unmeasured', label: 'Not measured', ms: 50 }
    ])
  })
})

describe('statements', () => {
  it('flags the N+1 and the wide read, with shares of the SQL wait', () => {
    const [a, b] = storyStatements(trace)
    expect(a).toMatchObject({ index: 0, n: 9, ms: 45, avg_ms: 5, repeat_n: 9, wide: false })
    expect(a.share).toBeCloseTo(0.75)
    expect(a.tables).toEqual(['lines'])
    expect(b).toMatchObject({ index: 1, wide: true, select: true, truncated: false, tables: [] })
  })
})

describe('effects', () => {
  it('reads the row id off the step key', () => {
    expect(stepRowId('activity:12')).toBe(12)
    expect(stepRowId('notification:7')).toBe(7)
    expect(stepRowId('request:abc')).toBeNull()
  })

  it('keeps ids that open each leaf, never values', () => {
    const write = storyEffect(
      {
        key: 'activity:5',
        kind: 'write',
        at: '2026-10-29T15:00:00.100Z',
        summary: 'updated Status, Owner',
        record: { collection: 'workflows', item: '85607' },
        detail: { type: 'changes', changes: [{ field: 'status', label: 'Status' }] }
      },
      100
    )
    expect(write.facts).toEqual({
      id: 5,
      action: 'update',
      fields: [{ field: 'status', label: 'Status' }]
    })
    const push = storyEffect(
      {
        key: 'submission:3',
        kind: 'push',
        at: '2026-10-29T15:00:00.150Z',
        summary: 'Push to Fusion · failed',
        failed: true,
        api_id: 4,
        detail: { type: 'push', status: 'failed', attempts: 2, submission_id: 3 }
      },
      150
    )
    expect(push.facts).toMatchObject({ id: 3, submission_id: 3, api_id: 4, attempts: 2 })
    const attempt = storyEffect(
      {
        key: 'attempt:9',
        kind: 'attempt',
        parent: 'submission:3',
        at: '2026-10-29T15:00:00.160Z',
        summary: 'Attempt 1 · failed'
      },
      160
    )
    expect(attempt.facts.submission_id).toBe(3)
    expect(attempt.parent).toBe('submission:3')
  })

  it('assembles request, caller, trace and effects', () => {
    const s = assembleRequestStory({
      requestId: RID,
      log,
      trace,
      steps: [
        {
          key: 'notification:2',
          kind: 'notify',
          at: '2026-10-29T15:00:00.190Z',
          summary: 'Told Sam · in-app',
          detail: { type: 'notify', recipient: 'Sam', recipient_id: 'U-2', channels: [] }
        },
        {
          key: 'activity:1',
          kind: 'write',
          at: '2026-10-29T15:00:00.050Z',
          summary: 'created',
          record: { collection: 'workflows', item: '85607' }
        }
      ]
    })
    expect(s.request).toMatchObject({
      route: 'PATCH /api/items/:collection/:id',
      started_at: '2026-10-29T15:00:00.000Z',
      has_query: true,
      auth: 'session'
    })
    expect(s.caller).toMatchObject({ kind: 'user', label: 'Jordan Lee', user_id: 'U-1' })
    expect(s.trace?.unaccounted_ms).toBe(50)
    expect(s.trace?.statements).toHaveLength(2)
    expect(s.effects.map((e) => [e.key, e.offset_ms])).toEqual([
      ['activity:1', 50],
      ['notification:2', 190]
    ])
    expect(s.effects[1].facts.recipient_id).toBe('U-2')
    expect(s.effects[0].facts.action).toBe('create')
  })
})

describe('storyStep (loader sanitizer)', () => {
  it('drops values, subjects and comments', () => {
    const write = storyStep({
      key: 'activity:1',
      kind: 'write',
      at: 'x',
      summary: 'updated Status',
      detail: {
        type: 'changes',
        changes: [{ field: 'status', label: 'Status', old: 'Draft', new: 'Approved' }]
      }
    })
    expect(JSON.stringify(write)).not.toContain('Approved')
    const notify = storyStep({
      key: 'notification:1',
      kind: 'notify',
      at: 'x',
      summary: 'Told Sam',
      detail: { type: 'notify', recipient: 'Sam', recipient_id: 'U-2', subject: 'Secret plan' }
    })
    expect(JSON.stringify(notify)).not.toContain('Secret plan')
    expect(notify.detail).toMatchObject({ recipient_id: 'U-2' })
    const move = storyStep({
      key: 'history:1',
      kind: 'transition',
      at: 'x',
      summary: 'Approve → Approved',
      detail: { type: 'transition', from: 'Review', to: 'Approved', comment: 'my words' }
    })
    expect(JSON.stringify(move)).not.toContain('my words')
    const mail = storyStep({
      key: 'mail:1',
      kind: 'mail',
      at: 'x',
      summary: 'Email to 2 recipients · sent',
      detail: {
        type: 'mail',
        status: 'sent',
        to: 'a@b.c',
        subject: 'Hello',
        recipients: 2,
        mail_log_id: 1
      }
    })
    expect(JSON.stringify(mail)).not.toContain('a@b.c')
    expect(JSON.stringify(mail)).not.toContain('Hello')
  })
})
