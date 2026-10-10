import { beforeEach, describe, expect, it, vi } from 'vitest'

// "May be out of date" (#1495): the pure judgement, the label report, the
// re-flag rule after a dismissal, and the nightly check end to end on a
// mocked database (one notification per flag, none while it stands).

const h = vi.hoisted(() => ({
  column: true,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  updates: [] as Array<{
    table: string
    where: Record<string, unknown>
    patch: Record<string, unknown>
  }>
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async () => h.column
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/io-holder.js', () => ({
  getApp: () => ({ log: { warn: vi.fn() } })
}))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: vi.fn() }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://app.example' }))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const name = table.split(' as ')[0]
    let where: Record<string, unknown> = {}
    const rows = () => h.tables[name] ?? []
    const q: Record<string, unknown> = {}
    for (const m of ['join', 'whereIn', 'whereNotNull', 'orderBy']) q[m] = () => q
    q.where = (w: unknown) => {
      if (w && typeof w === 'object') where = { ...where, ...(w as Record<string, unknown>) }
      return q
    }
    q.select = async () => rows()
    q.first = async () => rows()[0]
    q.update = async (patch: Record<string, unknown>) => {
      h.updates.push({ table: name, where, patch })
      return 1
    }
    return q
  }
}))

import { logActivity } from '../../../services/activity.js'
import {
  judgeStale,
  labelOnPage,
  normalizeLabels,
  parseStaleReason,
  runStaleCheck,
  type StaleFacts,
  type StaleWorld,
  shouldReflag,
  staleForDto,
  staleReasons
} from '../../../services/help-video-stale.js'
import { notifyUser } from '../../../services/notification-channels.js'

const T = (s: string) => new Date(s)
const PUB = T('2026-10-01T00:00:00Z')
const NOW = T('2026-10-10T00:00:00Z')

function world(over: Partial<StaleWorld> = {}): StaleWorld {
  return { layouts: [], states: [], snapshots: [], pages: [], now: NOW, ...over }
}
function facts(over: Partial<StaleFacts> = {}): StaleFacts {
  return {
    published_at: PUB,
    contexts: [{ kind: 'collection', key: 'orders', state_key: 'review' }],
    clicks: null,
    ...over
  }
}

beforeEach(() => {
  h.column = true
  h.tables = {}
  h.updates = []
  vi.mocked(notifyUser).mockClear()
  vi.mocked(logActivity).mockClear()
})

describe('normalizeLabels', () => {
  it('collapses, cuts, deduplicates and caps', () => {
    expect(normalizeLabels(null)).toBeNull()
    expect(normalizeLabels([])).toBeNull()
    expect(normalizeLabels([3, '', '  '])).toBeNull()
    expect(normalizeLabels(['  Save  now ', 'save NOW', `${'x'.repeat(100)}`])).toEqual([
      'Save now',
      'x'.repeat(80)
    ])
    const many = Array.from({ length: 400 }, (_, i) => `L${i}`)
    expect(normalizeLabels(many)).toHaveLength(300)
  })
})

describe('labelOnPage', () => {
  it('ignores case and spacing, and accepts a label the recording cut short', () => {
    expect(labelOnPage('Approve request', ['approve   REQUEST'])).toBe(true)
    expect(labelOnPage('Approve', ['Approve request'])).toBe(false)
    const long = 'A'.repeat(80)
    expect(labelOnPage(long, [`${long}BCD`])).toBe(true)
  })
})

describe('staleReasons', () => {
  it('flags a layout version made after the publish, never one before', () => {
    const w = world({
      layouts: [
        { collection: 'orders', name: 'Main', changed_at: T('2026-09-20T00:00:00Z') },
        { collection: 'orders', name: 'Main', changed_at: T('2026-10-03T00:00:00Z') },
        { collection: 'invoices', name: 'Main', changed_at: T('2026-10-04T00:00:00Z') }
      ]
    })
    expect(staleReasons(facts(), w)).toEqual([
      {
        kind: 'layout',
        detail: 'The "Main" layout of orders changed',
        since: '2026-10-03T00:00:00.000Z'
      }
    ])
    expect(staleReasons(facts({ published_at: T('2026-10-05T00:00:00Z') }), w)).toEqual([])
  })

  it('flags a pipeline step renamed after the publish, with its old name', () => {
    const w = world({
      states: [{ collection: 'orders', key: 'review', label: 'Manager review' }],
      snapshots: [
        {
          collection: 'orders',
          at: T('2026-10-02T00:00:00Z'),
          states: [{ key: 'review', label: 'Review' }]
        }
      ]
    })
    expect(judgeStale(facts(), w)).toEqual({
      kind: 'state',
      detail: 'The pipeline step "Review" of orders is now called "Manager review"',
      since: '2026-10-02T00:00:00.000Z'
    })
  })

  it('flags a removed step only with a snapshot after the publish that still held it', () => {
    const current = [{ collection: 'orders', key: 'done', label: 'Done' }]
    expect(judgeStale(facts(), world({ states: current }))).toBeNull()
    const w = world({
      states: current,
      snapshots: [
        {
          collection: 'orders',
          at: T('2026-10-04T00:00:00Z'),
          states: [
            { key: 'review', label: 'Review' },
            { key: 'done', label: 'Done' }
          ]
        }
      ]
    })
    expect(judgeStale(facts(), w)).toMatchObject({
      kind: 'state',
      detail: 'The pipeline step "Review" of orders was removed'
    })
  })

  it('says nothing about a collection with no pipeline, a context without a step, or an unchanged step', () => {
    const w = world({
      states: [{ collection: 'orders', key: 'review', label: 'Review' }],
      snapshots: [
        {
          collection: 'orders',
          at: T('2026-10-04T00:00:00Z'),
          states: [{ key: 'review', label: 'Review' }]
        }
      ]
    })
    expect(judgeStale(facts(), w)).toBeNull()
    expect(
      judgeStale(facts({ contexts: [{ kind: 'collection', key: 'orders', state_key: null }] }), w)
    ).toBeNull()
    expect(
      judgeStale(facts({ contexts: [{ kind: 'collection', key: 'other', state_key: 'x' }] }), w)
    ).toBeNull()
  })

  it('flags a click label gone from a page reported after the publish and inside the window', () => {
    const clicks = [
      { t_ms: 0, x: 0, y: 0, label: 'Approve', page_key: 'orders.form' },
      { t_ms: 1, x: 0, y: 0, label: 'Send back', page_key: 'orders.form' },
      { t_ms: 2, x: 0, y: 0, page_key: 'orders.form' }
    ]
    const page = (labels_at: Date, labels = ['Save', 'Send back']) =>
      world({ pages: [{ key: 'orders.form', label: 'Order form', labels, labels_at }] })
    expect(judgeStale(facts({ clicks }), page(T('2026-10-08T00:00:00Z')))).toEqual({
      kind: 'label',
      detail: '"Approve" is no longer on Order form',
      since: '2026-10-08T00:00:00.000Z'
    })
    // Every recorded label is still there.
    expect(
      judgeStale(facts({ clicks }), page(T('2026-10-08T00:00:00Z'), ['approve', 'send back']))
    ).toBeNull()
    // Reported before the publish, or outside the 14-day window: no judgement.
    expect(judgeStale(facts({ clicks }), page(T('2026-09-30T00:00:00Z')))).toBeNull()
    expect(
      judgeStale(
        facts({ clicks, published_at: T('2026-09-01T00:00:00Z') }),
        page(T('2026-09-20T00:00:00Z'))
      )
    ).toBeNull()
  })

  it('answers the earliest change first', () => {
    const w = world({
      layouts: [{ collection: 'orders', name: 'Main', changed_at: T('2026-10-06T00:00:00Z') }],
      pages: [
        {
          key: 'orders.form',
          label: 'Order form',
          labels: [],
          labels_at: T('2026-10-03T00:00:00Z')
        }
      ]
    })
    const clicks = [{ t_ms: 0, x: 0, y: 0, label: 'Approve', page_key: 'orders.form' }]
    const reasons = staleReasons(facts({ clicks }), w)
    expect(reasons.map((r) => r.kind)).toEqual(['label', 'layout'])
    expect(judgeStale(facts({ clicks }), w)?.kind).toBe('label')
  })
})

describe('shouldReflag', () => {
  const dismissed = {
    kind: 'layout' as const,
    detail: 'The "Main" layout of orders changed',
    since: '2026-10-02T00:00:00.000Z'
  }
  const at = T('2026-10-05T00:00:00Z')
  it('never re-raises a flag that was not dismissed, and skips the same change', () => {
    expect(shouldReflag(dismissed, null, dismissed)).toBe(true)
    expect(shouldReflag(dismissed, at, dismissed)).toBe(false)
    expect(shouldReflag(dismissed, at, { ...dismissed, since: '2026-10-07T00:00:00.000Z' })).toBe(
      true
    )
    expect(shouldReflag(dismissed, at, { ...dismissed, since: '2026-10-04T00:00:00.000Z' })).toBe(
      false
    )
  })
  it('keeps a dismissed missing label dismissed even as the page report moves', () => {
    const label = {
      kind: 'label' as const,
      detail: '"Approve" is no longer on Order form',
      since: '2026-10-03T00:00:00.000Z'
    }
    expect(shouldReflag(label, at, { ...label, since: '2026-10-09T00:00:00.000Z' })).toBe(false)
    expect(
      shouldReflag(label, at, {
        ...label,
        detail: '"Reject" is no longer on Order form',
        since: '2026-10-09T00:00:00.000Z'
      })
    ).toBe(true)
  })
})

describe('parseStaleReason / staleForDto', () => {
  it('reads only a well-formed reason and hides a dismissed one', () => {
    expect(parseStaleReason(null)).toBeNull()
    expect(parseStaleReason('{')).toBeNull()
    expect(parseStaleReason('{"kind":"x","detail":"d","since":"s"}')).toBeNull()
    const r = { kind: 'label', detail: 'd', since: 's' }
    expect(parseStaleReason(JSON.stringify(r))).toEqual(r)
    expect(staleForDto({ stale_reason: JSON.stringify(r), stale_dismissed_at: null })).toEqual(r)
    expect(
      staleForDto({ stale_reason: JSON.stringify(r), stale_dismissed_at: new Date() })
    ).toBeNull()
  })
})

describe('runStaleCheck', () => {
  const V1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
  const V2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
  const P1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
  const P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'

  function seed() {
    h.tables.nivaro_help_videos = [
      {
        id: V1,
        title: 'Approve an order',
        created_by: 'U1',
        published_version_id: P1,
        stale_reason: null,
        stale_dismissed_at: null
      },
      {
        id: V2,
        title: 'Flagged already',
        created_by: 'U2',
        published_version_id: P2,
        stale_reason: JSON.stringify({ kind: 'layout', detail: 'x', since: 's' }),
        stale_dismissed_at: null
      }
    ]
    h.tables.nivaro_help_video_versions = [
      { id: P1, created_at: PUB, clicks: null },
      { id: P2, created_at: PUB, clicks: null }
    ]
    h.tables.nivaro_help_video_contexts = [
      { video_id: V1, kind: 'collection', key: 'orders', state_key: null },
      { video_id: V2, kind: 'collection', key: 'orders', state_key: null }
    ]
    h.tables.nivaro_layout_versions = [
      { collection: 'orders', name: 'Main', created_at: T('2026-10-05T00:00:00Z') }
    ]
  }

  it('does nothing before migration 415', async () => {
    h.column = false
    seed()
    expect(await runStaleCheck(NOW)).toMatch(/migration 415/)
    expect(h.updates).toEqual([])
  })

  it('flags a video once, tells its author, and leaves a standing flag alone', async () => {
    seed()
    const out = await runStaleCheck(NOW)
    expect(out).toContain('1 newly flagged')
    expect(h.updates).toHaveLength(1)
    expect(h.updates[0]).toMatchObject({
      table: 'nivaro_help_videos',
      where: { id: V1 },
      patch: { stale_dismissed_at: null }
    })
    expect(JSON.parse(String(h.updates[0].patch.stale_reason))).toMatchObject({
      kind: 'layout',
      detail: 'The "Main" layout of orders changed'
    })
    expect(notifyUser).toHaveBeenCalledTimes(1)
    const [, userId, opts] = vi.mocked(notifyUser).mock.calls[0] as unknown as [
      unknown,
      string,
      Record<string, unknown>
    ]
    expect(userId).toBe('U1')
    expect(opts.subject).toBe('A video may be out of date: Approve an order')
    expect(String(opts.message)).toContain('The "Main" layout of orders changed')
    expect(opts.target).toEqual({
      kind: 'external',
      url: `https://app.example/help-videos?edit=${V1}`
    })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'help-video-stale', item: V1 })
    )
  })

  it('does not raise a dismissed reason again for the same change', async () => {
    seed()
    h.tables.nivaro_help_videos[0].stale_reason = JSON.stringify({
      kind: 'layout',
      detail: 'The "Main" layout of orders changed',
      since: '2026-10-05T00:00:00.000Z'
    })
    h.tables.nivaro_help_videos[0].stale_dismissed_at = T('2026-10-06T00:00:00Z')
    expect(await runStaleCheck(NOW)).toContain('0 newly flagged')
    expect(notifyUser).not.toHaveBeenCalled()
    // A later change to the same layout is news again.
    h.tables.nivaro_layout_versions.push({
      collection: 'orders',
      name: 'Main',
      created_at: T('2026-10-08T00:00:00Z')
    })
    expect(await runStaleCheck(NOW)).toContain('1 newly flagged')
    expect(notifyUser).toHaveBeenCalledTimes(1)
  })
})
