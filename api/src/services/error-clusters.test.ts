import { describe, expect, it } from 'vitest'
import {
  buildClusters,
  type ClusterIssue,
  messageOfIssue,
  normalizeErrorMessage,
  routeTemplateOf,
  topFrame
} from './error-clusters.js'

describe('normalizeErrorMessage', () => {
  it('strips ids, numbers, quoted values, dates, emails and urls', () => {
    expect(normalizeErrorMessage('Record 4471 not found')).toBe('Record <n> not found')
    expect(normalizeErrorMessage('Record 4472 not found')).toBe('Record <n> not found')
    expect(
      normalizeErrorMessage(
        "Workflow CR26-80361 owner 'Beth Smith' (beth@x.com) at 2026-10-29T10:00:00Z: see https://h/x?y=1"
      )
    ).toBe("Workflow <id> owner '…' (<email>) at <date>: see <url>")
    expect(normalizeErrorMessage('row 1b4e28ba-2fa1-11d2-883f-0016d3cca427 locked')).toBe(
      'row <id> locked'
    )
    expect(normalizeErrorMessage('')).toBe('Unknown error')
  })
  it('keeps identifier words with digits intact', () => {
    expect(normalizeErrorMessage('Invalid column name v2_status')).toBe(
      'Invalid column name v2_status'
    )
  })
})

describe('topFrame', () => {
  it('server stacks: first own frame, path from src/', () => {
    const stack = `Error: boom
    at Object.<anonymous> (node:internal/process:1:1)
    at updateOne (/app/api/dist/services/items.js:120:11)
    at async handler (/app/api/dist/routes/items.js:40:3)`
    expect(topFrame(stack)).toBe('updateOne (dist/services/items.js)')
  })
  it('client stacks: chunk hashes and line numbers dropped', () => {
    const a = topFrame(
      'TypeError: x\n    at render (https://efp.example.com/assets/index-AbC12345xy.js:1:2345)'
    )
    const b = topFrame(
      'TypeError: x\n    at render (https://efp.example.com/assets/index-Zz998877qq.js:1:999)'
    )
    expect(a).toBe('render (assets/index.js)')
    expect(a).toBe(b)
  })
  it('firefox frames', () => {
    expect(topFrame('render@https://h/assets/app-12345678.js:3:4')).toBe('render (assets/app.js)')
  })
  it('null without frames', () => {
    expect(topFrame('just text')).toBeNull()
  })
})

describe('routeTemplateOf', () => {
  it('templates ids in urls and keeps method prefixes', () => {
    expect(routeTemplateOf('https://h/collections/workflows/85607?x=1')).toBe(
      '/collections/workflows/:id'
    )
    expect(routeTemplateOf('PATCH /api/items/:collection/:id')).toBe(
      'PATCH /api/items/:collection/:id'
    )
    expect(routeTemplateOf('/records/CR26-80361')).toBe('/records/:id')
  })
})

describe('buildClusters', () => {
  const issue = (id: number, title: string, extra: Partial<ClusterIssue> = {}): ClusterIssue => ({
    id,
    source: 'server',
    title,
    details:
      'Route: PATCH /api/items/:collection/:id\n\nError: x\n    at updateOne (/app/src/services/items.ts:1:1)',
    status: 'open',
    severity: 'high',
    occurrence_count: 2,
    created_at: '2026-10-27T10:00:00.000Z',
    last_seen_at: '2026-10-28T10:00:00.000Z',
    raised_by: null,
    recording_id: null,
    recording_offset_ms: null,
    ...extra
  })

  it('merges issues that differ only by ids; counts, users, trend', () => {
    const since = Date.parse('2026-10-22T12:00:00.000Z')
    const until = Date.parse('2026-10-29T12:00:00.000Z')
    const clusters = buildClusters(
      [
        issue(1, '[server] PATCH /api/items/:collection/:id: Record 4471 not found'),
        issue(2, '[server] PATCH /api/items/:collection/:id: Record 4472 not found', {
          occurrence_count: 5,
          last_seen_at: '2026-10-29T09:00:00.000Z'
        }),
        issue(3, '[server] GET /api/settings: boom')
      ],
      [
        {
          issue: 1,
          occurred_at: '2026-10-27T10:00:00.000Z',
          user_id: 'U1',
          route: null,
          build: null
        },
        {
          issue: 2,
          occurred_at: '2026-10-29T09:00:00.000Z',
          user_id: 'u1',
          route: null,
          build: null
        },
        {
          issue: 2,
          occurred_at: '2026-10-29T09:30:00.000Z',
          user_id: 'u2',
          route: null,
          build: null
        }
      ],
      { since, until, buckets: 7 }
    )
    expect(clusters).toHaveLength(2)
    const c = clusters[0]
    expect(c.message).toBe('Record <n> not found')
    expect(c.issues).toBe(2)
    expect(c.count).toBe(7)
    expect(c.users).toBe(2)
    expect(c.frame).toBe('updateOne (src/services/items.ts)')
    expect(c.trend.reduce((a, b) => a + b, 0)).toBe(3)
    expect(c.trend[6]).toBe(2)
    expect(c.last_seen).toBe('2026-10-29T09:00:00.000Z')
    expect(c.signature).toMatch(/^[0-9a-f]{20}$/)
  })

  it('a different top frame is a different cluster', () => {
    const clusters = buildClusters(
      [
        issue(1, '[server] GET /a: boom'),
        issue(2, '[server] GET /a: boom', {
          details: 'Error\n    at other (/app/src/x.ts:1:1)'
        })
      ],
      [],
      { since: 0, until: Date.now(), buckets: 7 }
    )
    expect(clusters).toHaveLength(2)
  })

  it('messageOfIssue splits route from message', () => {
    expect(
      messageOfIssue({ title: '[client] https://h/x/1: Cannot read x', source: 'client' })
    ).toEqual({ route: 'https://h/x/1', message: 'Cannot read x' })
  })
})
