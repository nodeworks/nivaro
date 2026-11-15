import { describe, expect, it, vi } from 'vitest'

// "Since this email": the strip's summary is assembled as the viewer — a field change or a
// field comment counts only on a field the viewer may read; the send-time stamp lands only on
// this instance's record links.

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/permissions.js', () => ({ getAllowedFields: vi.fn() }))

const { parseSinceParam, summarizeSince } = await import('../../../services/record-since.js')
const { recordUrlPattern, stampSinceOnRecordLinks, withSince } = await import(
  '../../../services/mail-since-links.js'
)

const since = new Date('2026-11-10T12:00:00Z')

describe('summarizeSince', () => {
  it('counts only fields the viewer may read', () => {
    const s = summarizeSince({
      since,
      deltas: ['{"status":"b","salary":1}', { amount: 5 }, null, 'not json'],
      allowed: ['status', 'amount'],
      transitions: [],
      comments: [{ field: null }, { field: 'salary' }, { field: 'status' }]
    })
    expect(s).toMatchObject({ field_changes: 2, fields: ['Status', 'Amount'], comments: 2 })
    expect(JSON.stringify(s)).not.toContain('alary')
  })

  it('a change only to hidden fields is no news', () => {
    expect(
      summarizeSince({
        since,
        deltas: ['{"salary":1}'],
        allowed: ['status'],
        transitions: [],
        comments: [{ field: 'salary' }]
      })
    ).toBeNull()
  })

  it('all fields for an unrestricted reader; the last move names the step', () => {
    const s = summarizeSince({
      since,
      deltas: ['{"salary":1}'],
      allowed: null,
      transitions: [
        { label: 'Review', color: '#f00' },
        { label: 'Approved', color: '#0f0' }
      ],
      comments: [],
      labels: new Map([['salary', 'Base pay']])
    })
    expect(s).toEqual({
      since: since.toISOString(),
      moved_to: { label: 'Approved', color: '#0f0' },
      transitions: 2,
      field_changes: 1,
      fields: ['Base pay'],
      comments: 0
    })
  })

  it('parses only a real past moment within a year', () => {
    const now = Date.parse('2026-11-14T00:00:00Z')
    expect(parseSinceParam('2026-11-10T12:00:00.000Z', now)?.toISOString()).toBe(
      '2026-11-10T12:00:00.000Z'
    )
    expect(parseSinceParam('2026-12-01T00:00:00Z', now)).toBeNull()
    expect(parseSinceParam('2024-01-01T00:00:00Z', now)).toBeNull()
    expect(parseSinceParam('nope', now)).toBeNull()
    expect(parseSinceParam(['x'], now)).toBeNull()
  })
})

describe('mail since links', () => {
  const pattern = recordUrlPattern([
    { base: 'https://admin.example.com', template: '/collections/{collection}/{id}' },
    { base: 'https://portal.example.com/', template: '/project-360/{id}' }
  ])
  const iso = '2026-11-10T12:00:00.000Z'
  const enc = encodeURIComponent(iso)

  it('stamps own record links only, keeps query and hash, never twice', () => {
    const html = [
      '<a href="https://admin.example.com/collections/orders/42">a</a>',
      '<a href="https://admin.example.com/collections/orders/42?tab=notes&amp;x=1#c">b</a>',
      "<a href='https://portal.example.com/project-360/7'>c</a>",
      '<a href="https://admin.example.com/collections/orders">list</a>',
      '<a href="https://evil.example.com/collections/orders/42">d</a>',
      '<a href="https://admin.example.com/profile#rules">e</a>',
      `<a href="https://admin.example.com/collections/orders/42?since=old">f</a>`
    ].join('')
    const out = stampSinceOnRecordLinks(html, pattern, iso)
    expect(out).toContain(`/collections/orders/42?since=${enc}"`)
    expect(out).toContain(`?tab=notes&amp;x=1&amp;since=${enc}#c"`)
    expect(out).toContain(`/project-360/7?since=${enc}'`)
    expect(out).toContain('href="https://admin.example.com/collections/orders"')
    expect(out).toContain('href="https://evil.example.com/collections/orders/42"')
    expect(out).toContain('href="https://admin.example.com/profile#rules"')
    expect(out).toContain('?since=old"')
  })

  it('stamps bare URLs in a text body', () => {
    expect(
      stampSinceOnRecordLinks(
        'Open https://admin.example.com/collections/orders/42 now',
        pattern,
        iso,
        'text'
      )
    ).toBe(`Open https://admin.example.com/collections/orders/42?since=${enc} now`)
  })

  it('withSince respects an existing since', () => {
    expect(withSince('https://a/x?since=1', iso)).toBe('https://a/x?since=1')
  })
})
