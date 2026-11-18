import { describe, expect, it } from 'vitest'
import {
  bucketKeys,
  buildRegistry,
  type Cond,
  encodeCond,
  type MemRow,
  mailReasonOf,
  pageFilterConds,
  parseConds,
  parsePageFilters,
  resolveWindow
} from './model.js'
import { memoryExecutor, percentileCont } from './query.js'
import {
  BREAKDOWN_DIMS,
  buildBreakdown,
  buildSplit,
  buildSummary,
  type Cell,
  type Labeler
} from './summary.js'

const NOW = new Date('2026-11-18T12:00:00.000Z')
const A = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'
const B = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB'
const C = 'CCCCCCCC-CCCC-CCCC-CCCC-CCCCCCCCCCCC'
const ROLE = 'DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD'

const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

let nid = 0
function notif(over: Partial<MemRow> & { h: number }): MemRow {
  const { h, ...rest } = over
  nid++
  return {
    id: nid,
    timestamp: hoursAgo(h),
    recipient: A,
    sender: null,
    subject: `Notification ${nid}`,
    category: 'workflow',
    lane: 'needs_you',
    kind: 'record',
    collection: 'workflows',
    item: String(100 + nid),
    status: 'inbox',
    read_at: null,
    delivery: JSON.stringify({
      inapp: { status: 'delivered' },
      email: { status: 'not_requested' },
      push: { status: 'no_subscription' }
    }),
    delivery_reason: JSON.stringify({ v: 1, path: { kind: 'rules', text: 'x' } }),
    _recipient_role: ROLE,
    ...rest
  }
}

let mid = 0
function mail(over: Partial<MemRow> & { h: number }): MemRow {
  const { h, ...rest } = over
  mid++
  return {
    id: mid,
    created_at: hoursAgo(h),
    to: 'someone@example.com',
    subject: `Mail ${mid}`,
    template: 'workflow_transition',
    status: 'sent',
    error: null,
    collection: 'workflows',
    item: '7',
    ...rest
  }
}

function fixtures() {
  nid = 0
  mid = 0
  const n: MemRow[] = [
    // read after 30 min, acted (comment 2h later)
    notif({
      h: 50,
      status: 'read',
      read_at: hoursAgo(49.5),
      _actions: [{ user: A, at: hoursAgo(48) }]
    }),
    // read, no action
    notif({ h: 60, status: 'archived', read_at: hoursAgo(10), category: 'alerts', lane: 'fyi' }),
    // unread, no action, sender a person
    notif({ h: 70, sender: B, recipient: C, category: 'system', kind: null }),
    // window still open (sent 2h ago, 24h acted window)
    notif({ h: 2, status: 'read', read_at: hoursAgo(1) }),
    // not about a record
    notif({ h: 30, kind: 'external', collection: null, item: null, recipient: B }),
    // email failed + push sent + an integration sender
    notif({
      h: 40,
      sender: C,
      _sender_account_kind: 'integration',
      delivery: JSON.stringify({
        inapp: { status: 'delivered' },
        email: { status: 'failed', reason: 'relay down' },
        push: { status: 'sent' },
        teams: { status: 'not_connected' }
      })
    }),
    // email held for the summary, before reasons were recorded
    notif({
      h: 45,
      delivery: JSON.stringify({ inapp: { status: 'delivered' }, email: { status: 'deferred' } }),
      delivery_reason: null
    }),
    // before delivery tracking
    notif({ h: 100, delivery: null, category: null }),
    // a burst: 12 to B in one hour (flood > 10)
    ...Array.from({ length: 12 }, (_, i) =>
      notif({
        h: 20.5 + i / 100,
        recipient: B,
        category: 'integrations',
        lane: 'fyi',
        kind: 'external',
        collection: null,
        item: null
      })
    ),
    // previous period
    notif({ h: 24 * 8, status: 'read', read_at: hoursAgo(24 * 8 - 1) }),
    notif({ h: 24 * 9 }),
    // outside both windows
    notif({ h: 24 * 30 })
  ]
  const m: MemRow[] = [
    mail({ h: 5 }),
    mail({ h: 6 }),
    mail({ h: 7, status: 'deferred' }),
    mail({ h: 8, status: 'dropped', error: 'skipped: machine account (not a person)' }),
    mail({ h: 9, status: 'dropped', error: 'skipped: account suspended' }),
    mail({ h: 10, status: 'dropped', error: 'suppressed: 550 mailbox unavailable' }),
    mail({ h: 11, status: 'dropped', error: null }),
    mail({ h: 12, status: 'dropped', error: 'caught in localhost:1025 (MAIL_CATCH_HOST)' }),
    mail({ h: 13, status: 'failed', error: 'connect ECONNREFUSED 10.0.0.1:25' }),
    mail({ h: 14, status: 'failed', error: 'No recipients defined' }),
    mail({ h: 15, status: 'failed', error: '550 5.1.1 <x@y.com>: Recipient address rejected' }),
    mail({ h: 16, status: 'failed', error: 'Invalid login: 535 Authentication failed' }),
    mail({ h: 17, status: 'failed', error: 'something odd', template: null }),
    mail({ h: 24 * 8 }),
    mail({ h: 24 * 8, status: 'failed', error: 'Greeting never received' })
  ]
  const x: MemRow[] = [
    { id: 1, user: A, collection: 'workflows', item: '1', created_at: hoursAgo(5) },
    { id: 2, user: B, collection: 'workflows', item: '2', created_at: hoursAgo(500) },
    { id: 3, user: B, collection: 'invoices', item: '3', created_at: hoursAgo(5) }
  ]
  return { n, m, x }
}

const labels: Labeler = {
  users: async (ids) => new Map(ids.map((i) => [i.toUpperCase(), `Person ${i.slice(0, 1)}`])),
  roles: async (ids) => new Map(ids.map((i) => [i.toUpperCase(), 'Engineers'])),
  template: (k) => (k === 'workflow_transition' ? 'Workflow moved' : null),
  category: (k) => k
}

function collectCells(v: unknown, out: Array<{ path: string; cell: Cell }>, path = ''): void {
  if (!v || typeof v !== 'object') return
  const o = v as Record<string, unknown>
  if (typeof o.n === 'number' && typeof o.s === 'string' && Array.isArray(o.w)) {
    out.push({ path, cell: o as unknown as Cell })
    return
  }
  for (const [k, x] of Object.entries(o)) collectCells(x, out, path ? `${path}.${k}` : k)
}

async function setup(filters = {}) {
  const data = fixtures()
  const reg = buildRegistry({ resend: false })
  const window = resolveWindow({ window: '7d' }, NOW)
  const ctx = { asof: window.to, actedHours: 24 }
  const exec = memoryExecutor(data, reg, ctx)
  const summary = await buildSummary({
    exec,
    reg,
    window,
    filters,
    actedHours: 24,
    labels,
    relay: null,
    floodPerHour: 10,
    mutes: true
  })
  return { data, reg, window, exec, summary }
}

/** Every number → its drill's row count, page filters included. */
async function assertEveryDrillMatches(
  s: Awaited<ReturnType<typeof setup>>,
  extra: Array<{ path: string; cell: Cell }> = [],
  filters = {}
) {
  const cells: Array<{ path: string; cell: Cell }> = []
  collectCells(s.summary, cells)
  cells.push(...extra)
  const mismatches: string[] = []
  for (const { path, cell } of cells) {
    const span =
      cell.s === 'x'
        ? null
        : cell.win === 'prev'
          ? { from: s.window.prevFrom, to: s.window.prevTo }
          : { from: s.window.from, to: s.window.to }
    const r = await s.exec.rows({
      source: cell.s,
      span,
      where: [...pageFilterConds(cell.s, filters), ...cell.w],
      sort: 'time',
      dir: 'desc',
      offset: 0,
      limit: 1000
    })
    if (r.total !== cell.n) mismatches.push(`${path}: shown ${cell.n}, drill ${r.total}`)
    if (r.rows.length !== Math.min(r.total, 1000)) mismatches.push(`${path}: rows page short`)
  }
  return { mismatches, count: cells.length }
}

describe('delivery analytics: every number drills to exactly its rows', () => {
  it('summary, every breakdown and a split', async () => {
    const s = await setup()
    const extra: Array<{ path: string; cell: Cell }> = []
    for (const by of BREAKDOWN_DIMS) {
      const b = await buildBreakdown(
        { exec: s.exec, reg: s.reg, window: s.window, filters: {}, labels },
        by
      )
      collectCells(b, extra, `breakdown:${by}`)
    }
    for (const by of ['acted', 'ch_outcome.email', 'sender_type', 'reason']) {
      const sp = await buildSplit(
        { exec: s.exec, reg: s.reg, labels },
        {
          source: 'n',
          span: { from: s.window.from, to: s.window.to },
          filters: {},
          where: [['read', ['unread', 'read']]],
          by
        }
      )
      collectCells(sp, extra, `split:${by}`)
    }
    const { mismatches, count } = await assertEveryDrillMatches(s, extra)
    expect(mismatches).toEqual([])
    expect(count).toBeGreaterThan(150)
  })

  it('holds under page filters too', async () => {
    const filters = { category: 'workflow', channel: 'email' as const }
    const s = await setup(filters)
    const { mismatches } = await assertEveryDrillMatches(s, [], filters)
    expect(mismatches).toEqual([])
    // the filtered window holds the failed + deferred email notifications only
    expect(s.summary.headline.sent.n).toBe(2)
    expect(s.summary.email.ignored_filters).toEqual(['category'])
  })
})

describe('delivery analytics: the figures', () => {
  it('counts the headline over the window and the previous period', async () => {
    const { summary } = await setup()
    // 8 single rows + 12 burst rows inside 7 days; 2 in the previous 7 days.
    expect(summary.headline.sent.n).toBe(20)
    expect(summary.headline.sent_prev.n).toBe(2)
    expect(summary.headline.read.n).toBe(3)
    expect(summary.headline.unread.n).toBe(17)
    expect(summary.headline.timed.n).toBe(3)
    // eligible = record notifications whose 24 h window closed: rows 1,2,3,6,7,8 (row 4 open, 5 + burst not records)
    expect(summary.headline.eligible.n).toBe(6)
    expect(summary.headline.acted.n).toBe(1)
    expect(summary.headline.read_ignored.n).toBe(1)
    expect(summary.headline.email_total.n).toBe(13)
    expect(summary.headline.email_delivered.n).toBe(2)
    expect(summary.headline.email_failed.n).toBe(5)
    expect(summary.headline.email_failed_prev.n).toBe(1)
  })

  it('median and p90 time to read follow PERCENTILE_CONT', async () => {
    const { summary } = await setup()
    // 30, 60 and 3000 minutes
    expect(summary.headline.ttr.p50).toBe(60)
    expect(summary.headline.ttr.p90).toBeCloseTo(60 + (3000 - 60) * 0.8, 6)
    expect(percentileCont([], 0.5)).toBeNull()
    expect(percentileCont([5], 0.9)).toBe(5)
  })

  it('channels group statuses into outcomes and count attempts', async () => {
    const { summary } = await setup()
    const email = summary.channels.find((c) => c.channel === 'email')!
    expect(email.outcomes.failed.n).toBe(1)
    expect(email.outcomes.deferred.n).toBe(1)
    expect(email.outcomes.not_recorded.n).toBe(1)
    expect(email.attempted.n).toBe(2)
    const push = summary.channels.find((c) => c.channel === 'push')!
    expect(push.outcomes.delivered.n).toBe(1)
    const teams = summary.channels.find((c) => c.channel === 'teams')!
    expect(teams.outcomes.skipped.n).toBe(1)
  })

  it('buckets email reasons', async () => {
    const { summary } = await setup()
    const by = Object.fromEntries(summary.email.reasons.map((r) => [r.key, r.cell.n]))
    expect(by).toEqual({
      sent: 2,
      digest: 1,
      machine_account: 1,
      inactive_account: 1,
      suppressed: 1,
      test_caught: 1,
      test_mode: 1,
      no_recipients: 1,
      relay_unreachable: 1,
      relay_auth: 1,
      address_rejected: 1,
      failed_other: 1
    })
    expect(summary.email.templates[0]?.label).toBe('Workflow moved')
  })

  it('finds the flood, the never-readers and the noisy category', async () => {
    const { summary } = await setup()
    expect(summary.people.floods).toHaveLength(1)
    expect(summary.people.floods[0]?.cell.n).toBe(12)
    expect(summary.people.floods[0]?.name).toBe('Person B')
    expect(summary.people.never_read.map((p) => p.id)).toEqual([B])
    expect(summary.health.map((h) => h.id)).toEqual(
      expect.arrayContaining([
        'flood',
        'never-read',
        'mail:relay_unreachable',
        'mail:relay_auth',
        'mail:address_rejected',
        'mail:no_recipients'
      ])
    )
    expect(summary.health.some((h) => h.id === 'noisy:category:integrations')).toBe(false) // 12 < 20
  })

  it('fills every bucket of the window, hourly for two days or less', async () => {
    const { summary } = await setup()
    expect(summary.series).toHaveLength(8) // 7 days, partial first and last day
    expect(summary.series.reduce((s, b) => s + b.sent.n, 0)).toBe(20)
    const w = resolveWindow({ window: '24h' }, NOW)
    expect(w.bucket).toBe('hour')
    expect(bucketKeys(w)).toHaveLength(24)
  })

  it('mutes are a standing list', async () => {
    const { summary } = await setup()
    expect(summary.mutes?.total.n).toBe(3)
    expect(summary.mutes?.by_collection[0]).toMatchObject({ key: 'workflows' })
  })
})

describe('delivery analytics: windows and filters', () => {
  it('resolves presets and custom windows in UTC', () => {
    const w = resolveWindow({ window: '30d' }, NOW)
    expect(w.to.toISOString()).toBe(NOW.toISOString())
    expect(w.from.toISOString()).toBe('2026-10-19T12:00:00.000Z')
    expect(w.prevTo.toISOString()).toBe(w.from.toISOString())
    expect(w.prevFrom.toISOString()).toBe('2026-09-19T12:00:00.000Z')
    const c = resolveWindow({ from: '2026-11-01', to: '2026-11-02' }, NOW)
    expect(c.preset).toBe('custom')
    expect(c.from.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    // a bare to date runs to the end of that UTC day
    expect(c.to.toISOString()).toBe('2026-11-03T00:00:00.000Z')
    expect(c.bucket).toBe('hour')
    expect(() => resolveWindow({ from: '2026-11-02', to: '2026-11-01' }, NOW)).toThrow(
      /ends before/
    )
    expect(() => resolveWindow({ window: '5y' }, NOW)).toThrow(/Unknown window/)
    expect(() => resolveWindow({ from: '2024-01-01', to: '2026-01-01' }, NOW)).toThrow(/year/)
  })

  it('page filters narrow each source by what it has', () => {
    expect(pageFilterConds('n', { category: 'x', sender: 'abc', channel: 'push' })).toEqual([
      ['category', ['x']],
      ['sender', ['ABC']],
      ['ch_attempted.push', ['yes']]
    ])
    expect(pageFilterConds('m', { category: 'x', collection: 'po' })).toEqual([
      ['collection', ['po']]
    ])
    expect(() => parsePageFilters({ channel: 'pigeon' })).toThrow(/Unknown channel/)
  })

  it('drill conditions compose and survive commas and colons', () => {
    const reg = buildRegistry({ resend: false })
    const conds: Cond[] = [
      ['category', ['workflow']],
      ['ch.email', ['failed', 'dropped']]
    ]
    const back = parseConds(reg, 'n', conds.map(encodeCond))
    expect(back).toEqual(conds)
    const odd: Cond = ['template', ['flow:mail,addendum']]
    expect(parseConds(reg, 'm', [encodeCond(odd)])).toEqual([odd])
    expect(() => parseConds(reg, 'n', ['nope:1'])).toThrow(/Unknown dimension/)
    expect(() => parseConds(reg, 'n', ['category'])).toThrow(/Bad condition/)
  })

  it('composing conditions narrows a drill step by step', async () => {
    const s = await setup()
    const step = async (where: Cond[]) =>
      (
        await s.exec.rows({
          source: 'n',
          span: { from: s.window.from, to: s.window.to },
          where,
          sort: 'time',
          dir: 'desc',
          offset: 0,
          limit: 100
        })
      ).total
    const a = await step([['category', ['workflow']]])
    const b = await step([
      ['category', ['workflow']],
      ['ch_attempted.email', ['yes']]
    ])
    const c = await step([
      ['category', ['workflow']],
      ['ch_attempted.email', ['yes']],
      ['ch.email', ['failed']]
    ])
    expect([a, b, c]).toEqual([5, 2, 1])
  })

  it('classifies mail errors like the SQL CASE (first match wins)', () => {
    expect(
      mailReasonOf({
        status: 'dropped',
        error: 'skipped: their notification rules turn email off for this'
      })
    ).toBe('opted_out')
    expect(mailReasonOf({ status: 'dropped', error: 'skipped: something new' })).toBe(
      'skipped_other'
    )
    expect(mailReasonOf({ status: 'failed', error: 'read ECONNRESET' })).toBe('relay_unreachable')
    expect(
      mailReasonOf({
        status: 'failed',
        error: 'Mail command failed: 421 4.3.2 Service not available'
      })
    ).toBe('relay_unreachable')
    expect(mailReasonOf({ status: 'weird' })).toBe('other')
  })
})
