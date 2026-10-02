// Traffic Map drill-down group "record": recording-for selection, write delta shaping,
// id parsing and the issue ↔ request route match.
import { describe, expect, it } from 'vitest'
import {
  issueTitleMatchesRequest,
  issueTitleRoute,
  parseIssueId,
  parseRecordId,
  parseRecordingId,
  pickIssueForRequest,
  pickRecordingFor,
  shapeWriteDelta,
  splitIssueDetails,
  touchesNote
} from './record-logic.js'

const U = '7a0411f3-c687-40e5-adf5-614157cf88ec'
const T = Date.parse('2026-10-01T12:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ON = { now: T + 60_000, recordingOn: true, clipsOn: true }

describe('pickRecordingFor', () => {
  it('picks the full recording covering the moment and its offset', () => {
    const p = pickRecordingFor(
      [{ id: 'a', started_at: iso(T - 10_000), last_event_at: iso(T + 5_000) }],
      T,
      ON
    )
    expect(p).toEqual({ found: true, id: 'a', offset_ms: 10_000, clip: false, distance_ms: 0 })
  })

  it('prefers the shortest covering span when several tabs recorded', () => {
    const p = pickRecordingFor(
      [
        { id: 'long', started_at: iso(T - 3_600_000), last_event_at: iso(T + 60_000) },
        { id: 'short', started_at: iso(T - 30_000), last_event_at: iso(T + 1_000) }
      ],
      T,
      ON
    )
    expect(p.found && p.id).toBe('short')
  })

  it('ignores recordings that ended before or start after the moment', () => {
    const p = pickRecordingFor(
      [
        { id: 'before', started_at: iso(T - 60_000), last_event_at: iso(T - 1_000) },
        { id: 'after', started_at: iso(T + 1_000), last_event_at: iso(T + 9_000) }
      ],
      T,
      ON
    )
    expect(p.found).toBe(false)
  })

  it('uses ended_at, then started_at, when last_event_at is missing', () => {
    const p = pickRecordingFor(
      [{ id: 'e', started_at: iso(T - 5_000), ended_at: iso(T + 5_000), last_event_at: null }],
      T,
      ON
    )
    expect(p.found && p.id).toBe('e')
  })

  it('falls back to the nearest error clip within two minutes', () => {
    const p = pickRecordingFor(
      [
        {
          id: 'far',
          app: 'error-clip',
          started_at: iso(T + 150_000),
          last_event_at: iso(T + 160_000)
        },
        {
          id: 'near',
          app: 'error-clip',
          started_at: iso(T - 40_000),
          last_event_at: iso(T - 30_000)
        }
      ],
      T,
      ON
    )
    expect(p).toEqual({
      found: true,
      id: 'near',
      offset_ms: 40_000,
      clip: true,
      distance_ms: 30_000
    })
  })

  it('a full recording beats a clip even when the clip is closer', () => {
    const p = pickRecordingFor(
      [
        {
          id: 'clip',
          app: 'error-clip',
          started_at: iso(T - 1_000),
          last_event_at: iso(T + 1_000)
        },
        { id: 'full', app: 'efp', started_at: iso(T - 600_000), last_event_at: iso(T + 600_000) }
      ],
      T,
      ON
    )
    expect(p.found && p.id).toBe('full')
  })

  it('explains why there is nothing', () => {
    const off = pickRecordingFor([], T, { now: T, recordingOn: false, clipsOn: false })
    expect(!off.found && off.reason).toMatch(/recording is off/)
    const noFull = pickRecordingFor([], T, { now: T, recordingOn: false, clipsOn: true })
    expect(!noFull.found && noFull.reason).toMatch(/Full session recording is off/)
    const old = pickRecordingFor([], T, {
      now: T + 8 * 86_400_000,
      recordingOn: true,
      clipsOn: true
    })
    expect(!old.found && old.reason).toMatch(/7 days/)
    const none = pickRecordingFor([], T, ON)
    expect(!none.found && none.reason).toMatch(/No recording of this person/)
  })
})

describe('shapeWriteDelta', () => {
  it('update: delta against the previous snapshot', () => {
    const s = shapeWriteDelta({
      action: 'update',
      delta: '{"amount":5}',
      data: '{"amount":5,"name":"x"}',
      prevData: '{"amount":3,"name":"x"}',
      hasRevision: true
    })
    expect(s).toEqual({ delta: { amount: 5 }, previous: { amount: 3, name: 'x' }, note: null })
  })

  it('update without an earlier version says old values are unknown', () => {
    const s = shapeWriteDelta({
      action: 'update',
      delta: { amount: 5 },
      data: null,
      prevData: null,
      hasRevision: true
    })
    expect(s.delta).toEqual({ amount: 5 })
    expect(s.note).toMatch(/old values are unknown/)
  })

  it('create: every created field is new', () => {
    const s = shapeWriteDelta({
      action: 'create',
      delta: null,
      data: '{"a":1,"b":"two"}',
      prevData: null,
      hasRevision: true
    })
    expect(s).toEqual({ delta: { a: 1, b: 'two' }, previous: null, note: null })
  })

  it('delete: every field the record held goes to nothing', () => {
    const s = shapeWriteDelta({
      action: 'delete',
      delta: null,
      data: null,
      prevData: '{"a":1,"b":"two"}',
      hasRevision: true
    })
    expect(s).toEqual({ delta: { a: null, b: null }, previous: { a: 1, b: 'two' }, note: null })
  })

  it('no revision: activity-only collection', () => {
    const s = shapeWriteDelta({
      action: 'update',
      delta: null,
      data: null,
      prevData: null,
      hasRevision: false
    })
    expect(s.delta).toBeNull()
    expect(s.note).toMatch(/activity only/)
  })

  it('unreadable JSON and empty deltas are said plainly', () => {
    const bad = shapeWriteDelta({
      action: 'update',
      delta: '{nope',
      data: null,
      prevData: null,
      hasRevision: true
    })
    expect(bad.delta).toBeNull()
    expect(bad.note).toMatch(/changed no field values/)
  })
})

describe('ids', () => {
  it('parses record ids strictly', () => {
    expect(parseRecordId('workflows:371367')).toEqual({ collection: 'workflows', item: '371367' })
    expect(parseRecordId(`regions:${U}`)).toEqual({ collection: 'regions', item: U })
    expect(parseRecordId('workflows')).toBeNull()
    expect(parseRecordId(':1')).toBeNull()
    expect(parseRecordId("workflows:1'; drop")).toBeNull()
    expect(parseRecordId('bad-name:1')).toBeNull()
  })
  it('parses recording and issue ids', () => {
    expect(parseRecordingId(U)).toEqual({ kind: 'recording', id: U })
    expect(parseRecordingId(`for:${U}`)).toEqual({ kind: 'for', user: U })
    expect(parseRecordingId('for:abc')).toBeNull()
    expect(parseIssueId('1350')).toEqual({ kind: 'issue', id: 1350 })
    expect(parseIssueId(`rid:${U}`)).toEqual({ kind: 'rid', rid: U })
    expect(parseIssueId('0')).toBeNull()
    expect(parseIssueId('12a')).toBeNull()
  })
})

describe('issueTitleMatchesRequest', () => {
  const title = '[server] PATCH /api/items/:collection/:id: Validation failed'
  it('matches the template against the concrete path', () => {
    expect(issueTitleMatchesRequest(title, 'PATCH', '/api/items/workflows/371367')).toBe(true)
    expect(issueTitleMatchesRequest(title, 'patch', '/api/items/workflows/371367?x=1')).toBe(true)
  })
  it('refuses another method, another shape or a client issue', () => {
    expect(issueTitleMatchesRequest(title, 'GET', '/api/items/workflows/371367')).toBe(false)
    expect(issueTitleMatchesRequest(title, 'PATCH', '/api/items/workflows')).toBe(false)
    expect(issueTitleMatchesRequest(title, 'PATCH', '/api/other/workflows/1')).toBe(false)
    expect(issueTitleMatchesRequest('[client] /x: boom', 'GET', '/x')).toBe(false)
  })
  it('a wildcard template swallows the rest', () => {
    expect(issueTitleMatchesRequest('[server] GET /files/*: gone', 'GET', '/files/a/b/c')).toBe(
      true
    )
  })
  it('reads the route a server title names', () => {
    expect(issueTitleRoute(title)).toEqual({
      method: 'PATCH',
      template: '/api/items/:collection/:id'
    })
    expect(issueTitleRoute('[client] /x: boom')).toBeNull()
  })
})

describe('pickIssueForRequest', () => {
  const route = 'PATCH /api/items/:collection/:id'
  const fpOf = (message: string) => `fp(${route}|${message})`
  const rows = [
    { id: 55, title: `[server] ${route}: Deadlock victim`, fingerprint: fpOf('Deadlock victim') },
    {
      id: 40,
      title: `[server] ${route}: Validation failed`,
      fingerprint: fpOf('Validation failed')
    },
    { id: 12, title: '[server] GET /api/other: Validation failed', fingerprint: fpOf('x') }
  ]
  const req = { method: 'PATCH', path: '/api/items/workflows/12' }

  it('prefers the issue whose fingerprint is the request’s own error', () => {
    expect(pickIssueForRequest(rows, req, (k) => `fp(${k}|Validation failed)`)).toEqual({
      id: 40,
      matched_by: 'fingerprint'
    })
    expect(pickIssueForRequest(rows, req, (k) => `fp(${k}|Deadlock victim)`)).toEqual({
      id: 55,
      matched_by: 'fingerprint'
    })
  })
  it('falls back to the newest route match, marked as such', () => {
    expect(pickIssueForRequest(rows, req, (k) => `fp(${k}|Something new)`)).toEqual({
      id: 55,
      matched_by: 'route'
    })
  })
  it('nothing on the route → null; computes each route key once', () => {
    const seen: string[] = []
    expect(
      pickIssueForRequest(rows, { method: 'DELETE', path: '/api/items/a/1' }, (k) => {
        seen.push(k)
        return k
      })
    ).toBeNull()
    expect(seen).toEqual([])
    pickIssueForRequest(rows, req, (k) => {
      seen.push(k)
      return 'none'
    })
    expect(seen).toEqual([route])
  })
})

describe('splitIssueDetails / touchesNote', () => {
  it('splits route, context and stack', () => {
    const d = splitIssueDetails(
      'Route: GET /x\nRequest context: {"url":"/x"}\n\nError: boom\n    at f (a.js:1:1)'
    )
    expect(d.route).toBe('GET /x')
    expect(d.context).toBe('{"url":"/x"}')
    expect(d.stack).toMatch(/^Error: boom/)
    expect(splitIssueDetails(null).route).toBeNull()
  })
  it('says why the touch list is not the window', () => {
    expect(touchesNote(3, 300, 10)).toBeNull()
    expect(touchesNote(0, 300, 0)).toMatch(/Nobody/)
    expect(touchesNote(0, 300, 4)).toMatch(/within 5 min/)
  })
})
