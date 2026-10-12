// Ops assistant cluster: Ask the logs (#1914), log alerts from questions (#1960),
// suggested log alerts (#2013), ops chat tools (#1967), approval cards (#2015),
// incident threads (#2016), a person's week (#1968).
import knexFactory from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))
vi.mock('../../../services/ops-room-guard.js', () => ({
  activeAdminIds: vi.fn(
    async (ids: string[]) =>
      new Set(ids.map((i) => i.toUpperCase()).filter((i) => i === 'ANA' || i === 'KIM'))
  )
}))

import { db } from '../../../db/index.js'
import { cooledDown, ruleFilter } from '../../../services/log-alert-requests.js'
import {
  applyRequestFilters,
  cleanLogFilter,
  filterChips,
  requestListParams,
  requestMatches
} from '../../../services/log-filters.js'
import { filterFromToolInput } from '../../../services/log-question.js'
import { isRequestRule, ruleShouldFire } from '../../../services/log-ring.js'
import {
  coveredByRingRule,
  messagePattern,
  normalizeMessage,
  normalizePath,
  pathPrefix,
  suggestFromLog,
  suggestFromRequests
} from '../../../services/log-rule-suggest.js'
import { executeOpsTool, OPS_REFUSAL, opsRoomVerdict } from '../../../services/ops-assistant.js'
import { closingSummary, describeChange, parseState } from '../../../services/ops-incidents.js'
import { routeFor, validateProposal } from '../../../services/ops-proposals.js'
import { shapeWeek } from '../../../services/person-activity-summary.js'

afterEach(() => vi.clearAllMocks())

const mssql = knexFactory({ client: 'mssql' })
const U = '0E5A1C1B-1111-4222-8333-444455556666'

describe('cleanLogFilter', () => {
  it('keeps only known, well-formed fields', () => {
    const f = cleanLogFilter({
      target: 'requests',
      method: 'post',
      status: '5XX',
      path: ' /items/orders ',
      user: U.toLowerCase(),
      auth: 'session,bogus,token',
      errors: '1',
      api_key: '7',
      group: 'caller',
      evil: 'DROP TABLE'
    })
    expect(f).toEqual({
      target: 'requests',
      method: 'POST',
      status: '5xx',
      path: '/items/orders',
      user: U,
      auth: 'session,token',
      errors: true,
      api_key: 7,
      group: 'caller'
    })
  })
  it('drops a non-uuid user and an unparseable time', () => {
    const f = cleanLogFilter({ user: "1' OR 1=1", from: 'yesterday' })
    expect(f.user).toBeUndefined()
    expect(f.from).toBeUndefined()
  })
  it('a log-target filter carries level + text only', () => {
    expect(cleanLogFilter({ target: 'log', level: 'warn', q: 'ECONNRESET', path: '/x' })).toEqual({
      target: 'log',
      level: 'warn',
      q: 'ECONNRESET'
    })
  })
  it('caps the look-back at 30 days', () => {
    expect(cleanLogFilter({ hours: 99999 }).hours).toBe(720)
  })
})

describe('applyRequestFilters — the one compile', () => {
  it('builds the request list WHERE with bound values', () => {
    const now = Date.parse('2026-10-12T12:00:00Z')
    const q = applyRequestFilters(
      mssql('nivaro_api_logs as l'),
      cleanLogFilter({ path: '50%_[x', status: '5xx', user: U, inbound: true, hours: 2 }),
      'l',
      now
    ).toSQL()
    expect(q.sql).toContain('[l].[path] like ?')
    expect(q.bindings).toContain('%50[%][_][[]x%')
    expect(q.sql).toContain('[l].[status] >= ?')
    expect(q.sql).toContain('[l].[auth] in (?, ?)')
    expect(q.bindings).toContain(U)
    expect((q.bindings[0] as Date).toISOString()).toBe('2026-10-12T10:00:00.000Z')
  })
  it('from beats hours', () => {
    const q = applyRequestFilters(
      mssql('nivaro_api_logs as l'),
      cleanLogFilter({
        hours: 1,
        from: '2026-10-11T12:00:00-04:00',
        to: '2026-10-11T18:00:00-04:00'
      })
    ).toSQL()
    expect((q.bindings[0] as Date).toISOString()).toBe('2026-10-11T16:00:00.000Z')
    expect((q.bindings[1] as Date).toISOString()).toBe('2026-10-11T22:00:00.000Z')
  })
})

describe('requestMatches / chips / params', () => {
  const f = cleanLogFilter({ path: '/items/orders', status: '5xx', method: 'PATCH' })
  it('matches in memory like the SQL does', () => {
    expect(requestMatches(f, { method: 'PATCH', path: '/api/items/orders/9', status: 502 })).toBe(
      true
    )
    expect(requestMatches(f, { method: 'PATCH', path: '/api/items/orders/9', status: 404 })).toBe(
      false
    )
    expect(requestMatches(f, { method: 'GET', path: '/api/items/orders/9', status: 500 })).toBe(
      false
    )
  })
  it('chips say what will run', () => {
    const chips = filterChips({ ...f, user: U, user_label: 'Beth Ng', group: 'caller' }).map(
      (c) => c.label
    )
    expect(chips).toEqual(
      expect.arrayContaining(['API requests', 'Beth Ng', 'PATCH', 'status 5xx', 'top callers'])
    )
  })
  it('params are the request list query string', () => {
    expect(requestListParams({ ...f, errors: true, group: 'path' })).toEqual({
      path: '/items/orders',
      status: '5xx',
      method: 'PATCH',
      errors: '1',
      group: 'path'
    })
  })
})

describe('filterFromToolInput (#1914)', () => {
  it('turns the model input into a checked filter and a person name', () => {
    const out = filterFromToolInput({
      target: 'requests',
      from: '2026-10-11T12:00:00-04:00',
      to: '2026-10-11T18:00:00-04:00',
      person: 'Beth',
      errors: true,
      method: 'TRACE',
      summary: 'Errors for Beth yesterday afternoon'
    })
    expect(out.person).toBe('Beth')
    expect(out.filter.errors).toBe(true)
    expect(out.filter.method).toBeUndefined()
    expect(out.filter.from).toBe('2026-10-11T16:00:00.000Z')
  })
  it('drops an inverted or future window', () => {
    const out = filterFromToolInput({
      target: 'requests',
      from: '2099-01-02T00:00:00Z',
      to: '2099-01-01T00:00:00Z',
      summary: ''
    })
    expect(out.filter.from).toBeUndefined()
    expect(out.filter.to).toBeUndefined()
  })
  it('a log question never names a person', () => {
    expect(
      filterFromToolInput({ target: 'log', person: 'Beth', text: 'timeout' }).person
    ).toBeNull()
  })
})

describe('ring rules (#1960)', () => {
  it('threshold: fires only on the Nth match inside the window, then cools down', () => {
    const hits = new Map<number, number[]>()
    const cds = new Map<number, number>()
    const r = { id: 1, threshold: 3, window_minutes: 5, cooldown_minutes: 10 }
    const t = 1_000_000_000
    expect(ruleShouldFire(r, t, hits, cds)).toBe(false)
    expect(ruleShouldFire(r, t + 1000, hits, cds)).toBe(false)
    expect(ruleShouldFire(r, t + 2000, hits, cds)).toBe(true)
    for (let i = 0; i < 5; i++) expect(ruleShouldFire(r, t + 3000 + i, hits, cds)).toBe(false)
    // matches that fall out of the window do not count
    const r2 = { id: 2, threshold: 2, window_minutes: 1, cooldown_minutes: null }
    expect(ruleShouldFire(r2, t, hits, cds)).toBe(false)
    expect(ruleShouldFire(r2, t + 120_000, hits, cds)).toBe(false)
    expect(ruleShouldFire(r2, t + 121_000, hits, cds)).toBe(true)
  })
  it('a plain rule fires every match outside the 5-minute default cooldown', () => {
    const hits = new Map<number, number[]>()
    const cds = new Map<number, number>()
    const r = { id: 3, threshold: null, window_minutes: null, cooldown_minutes: null }
    expect(ruleShouldFire(r, 10 * 60_000, hits, cds)).toBe(true)
    expect(ruleShouldFire(r, 12 * 60_000, hits, cds)).toBe(false)
    expect(ruleShouldFire(r, 16 * 60_000, hits, cds)).toBe(true)
  })
  it('request-log rules stay out of the ring', () => {
    expect(isRequestRule(JSON.stringify({ target: 'requests', status: '5xx' }))).toBe(true)
    expect(isRequestRule(JSON.stringify({ target: 'log', q: 'x' }))).toBe(false)
    expect(isRequestRule(null)).toBe(false)
  })
})

describe('request-log rules (#1960)', () => {
  const now = Date.parse('2026-10-12T12:00:00Z')
  it('evaluate their own window, never the question’s time words', () => {
    const f = ruleFilter(
      {
        id: 1,
        name: 'x',
        filters: JSON.stringify({
          target: 'requests',
          status: '5xx',
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-02T00:00:00Z',
          group: 'caller'
        }),
        threshold: 10,
        window_minutes: 15,
        cooldown_minutes: 60,
        last_matched_at: null
      },
      now
    )
    expect(f).toEqual({ target: 'requests', status: '5xx', from: '2026-10-12T11:45:00.000Z' })
  })
  it('respects the cooldown', () => {
    const rule = {
      id: 1,
      name: 'x',
      filters: null,
      threshold: 1,
      window_minutes: 15,
      cooldown_minutes: 60,
      last_matched_at: new Date(now - 30 * 60_000)
    }
    expect(cooledDown(rule, now)).toBe(false)
    expect(cooledDown({ ...rule, last_matched_at: new Date(now - 61 * 60_000) }, now)).toBe(true)
    expect(cooledDown({ ...rule, last_matched_at: null }, now)).toBe(true)
  })
})

describe('suggested log alerts (#2013)', () => {
  it('normalizes ids out of paths and messages', () => {
    expect(normalizePath('/api/items/orders/1234?x=1')).toBe('/api/items/orders/*')
    expect(normalizePath(`/api/users/${U}/profile`)).toBe('/api/users/*/profile')
    expect(pathPrefix('/api/items/orders/*')).toBe('/api/items/orders/')
    const t = normalizeMessage(`push 4411 to "ACME" failed: ECONNRESET after 3000ms (${U})`)
    expect(t).not.toMatch(/4411|ACME|3000|0E5A/)
    const re = new RegExp(messagePattern(t), 'i')
    expect(re.test('push 9 to "Other" failed: ECONNRESET after 12ms (x)')).toBe(true)
    expect(re.test('push failed: ETIMEDOUT')).toBe(false)
  })
  it('patterns never carry nested quantifiers and stay short', () => {
    const p = messagePattern(normalizeMessage(`${'word '.repeat(80)}(a+)+ 12`))
    expect(p.length).toBeLessThanOrEqual(200)
    expect(/(\([^)]*[+*][^)]*\)|\[[^\]]*\])[+*]\??[+*]/.test(p)).toBe(false)
  })
  const h = 3_600_000
  const fail = (path: string, at: number, status = 500) => ({
    method: 'POST',
    path,
    status,
    auth: 'token',
    at
  })
  it('proposes a rule for a failure that keeps coming back', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => fail(`/api/items/orders/${i}`, 10 * h + i)),
      ...Array.from({ length: 3 }, (_, i) => fail(`/api/items/orders/${i}`, 12 * h + i))
    ]
    const [s] = suggestFromRequests(rows, [])
    expect(s.filters).toEqual({
      target: 'requests',
      method: 'POST',
      path: '/api/items/orders/',
      status: '5xx'
    })
    expect(s.threshold).toBe(3)
    expect(s.window_minutes).toBe(15)
    expect(s.cooldown_minutes).toBe(60)
    expect(s.evidence.count).toBe(9)
  })
  it('skips one-off bursts and failures a rule already watches', () => {
    const burst = Array.from({ length: 9 }, (_, i) => fail('/api/x', 10 * h + i))
    expect(suggestFromRequests(burst, [])).toEqual([])
    const spread = [
      fail('/api/x', h),
      fail('/api/x', 2 * h),
      fail('/api/x', 3 * h),
      fail('/api/x', 4 * h),
      fail('/api/x', 5 * h)
    ]
    expect(suggestFromRequests(spread, [])).toHaveLength(1)
    const rule = {
      pattern: '(?!)',
      level: null,
      filters: JSON.stringify({ target: 'requests', path: '/api/x', status: '5xx' })
    }
    expect(suggestFromRequests(spread, [rule])).toEqual([])
  })
  it('log lines: recurring error shapes become ring rules', () => {
    const lines = [0, 70_000, 140_000].map((t, i) => ({
      ts: t,
      level: 50,
      msg: `sync job ${i} failed: deadlock victim on table orders`
    }))
    const [s] = suggestFromLog(lines, [])
    expect(s.level).toBe('error')
    expect(new RegExp(s.pattern as string, 'i').test(lines[0].msg)).toBe(true)
    expect(
      coveredByRingRule([{ pattern: 'deadlock victim', level: null, filters: null }], lines[0].msg)
    ).toBe(true)
    expect(
      suggestFromLog(lines, [{ pattern: 'deadlock victim', level: null, filters: null }])
    ).toEqual([])
  })
})

// ── chat ops tools ──────────────────────────────────────────────────────────

/** A knex-ish builder that is also the awaited result (a real promise underneath). */
function chain(result: unknown) {
  const b = Object.assign(Promise.resolve(result), {}) as Promise<unknown> & Record<string, unknown>
  for (const m of ['where', 'join', 'whereNot', 'orWhereNull', 'select']) b[m] = vi.fn(() => b)
  b.first = vi.fn(async () => result)
  return b
}

function mockTables(t: Record<string, unknown>) {
  vi.mocked(db).mockImplementation(((name: string) => {
    const key = String(name).split(' ')[0]
    return chain(t[key])
  }) as never)
}

describe('opsRoomVerdict (#1967)', () => {
  it('refuses DMs, record rooms and open channels without touching the database', async () => {
    expect((await opsRoomVerdict(`dm:${U}:${U}`)).ok).toBe(false)
    expect((await opsRoomVerdict('wf:REQ-1')).ok).toBe(false)
    mockTables({ nivaro_chat_channels: { visibility: 'open' } })
    expect(await opsRoomVerdict('ch:general')).toEqual({
      ok: false,
      reason: 'the channel is open to everyone'
    })
  })
  it('a private channel is admin-only only while every member is an admin', async () => {
    mockTables({
      nivaro_chat_channels: { visibility: 'private' },
      nivaro_chat_memberships: [{ user: 'ANA' }, { user: 'KIM' }]
    })
    expect(await opsRoomVerdict('ch:ops')).toEqual({ ok: true })
    mockTables({
      nivaro_chat_channels: { visibility: 'private' },
      nivaro_chat_memberships: [{ user: 'ANA' }, { user: 'BOB' }]
    })
    expect(await opsRoomVerdict('ch:ops')).toEqual({
      ok: false,
      reason: 'a member is not an administrator'
    })
  })
  it('a role channel needs an admin role; archived channels never pass', async () => {
    mockTables({
      nivaro_chat_channels: { visibility: 'role', role: 'R1' },
      nivaro_roles: { admin_access: false },
      nivaro_chat_memberships: [{ user: 'ANA' }]
    })
    expect((await opsRoomVerdict('ch:ops')).ok).toBe(false)
    mockTables({ nivaro_chat_channels: { visibility: 'private', is_archived: true } })
    expect((await opsRoomVerdict('ch:ops')).ok).toBe(false)
  })
  it('the tools refuse a non-admin asker even in an admin-only channel', async () => {
    mockTables({
      nivaro_users: undefined,
      nivaro_chat_channels: { visibility: 'private' },
      nivaro_chat_memberships: [{ user: 'ANA' }]
    })
    await expect(
      executeOpsTool({} as never, { id: 'X' } as never, 'ch:ops', 'ops_status', {})
    ).rejects.toThrow(OPS_REFUSAL)
    await expect(
      executeOpsTool({} as never, { id: 'X' } as never, null, 'ops_status', {})
    ).rejects.toThrow(OPS_REFUSAL)
  })
})

describe('proposals (#2015)', () => {
  const app = {
    cron: {
      list: () => [
        { id: 'nightly-sync', paused: false },
        { id: 'paused-one', paused: true }
      ]
    }
  } as never
  it('validates the target before a card is posted', async () => {
    await expect(
      validateProposal(app, { action: 'pause_job', job_id: 'nope', reason: 'x' })
    ).rejects.toThrow('No scheduled job')
    await expect(
      validateProposal(app, { action: 'pause_job', job_id: 'paused-one', reason: 'x' })
    ).rejects.toThrow('already paused')
    await expect(
      validateProposal(app, { action: 'pause_job', job_id: 'nightly-sync' })
    ).rejects.toThrow('reason')
    await expect(
      validateProposal(app, {
        action: 'open_breaker',
        target_kind: 'caller',
        target: 'everyone',
        reason: 'x'
      })
    ).rejects.toThrow('caller target')
    const v = await validateProposal(app, {
      action: 'open_breaker',
      target_kind: 'caller',
      target: `u${U.toLowerCase()}`,
      mode: 'limit',
      limit: 30,
      minutes: 9999,
      reason: 'hammering /items'
    })
    expect(v.params).toEqual({
      kind: 'caller',
      target: `u${U}`,
      mode: 'limit',
      minutes: 1440,
      limit: 30
    })
  })
  it('an approved proposal dispatches the admin route a person would use', () => {
    expect(routeFor({ action: 'pause_job', params: { job_id: 'a b' }, reason: 'r' })).toEqual({
      method: 'POST',
      url: '/api/cron/a%20b/pause',
      body: {}
    })
    expect(
      routeFor({
        action: 'open_breaker',
        params: { kind: 'caller', target: 'k7', mode: 'refuse', minutes: 30, limit: null },
        reason: 'noisy'
      }).url
    ).toBe('/api/traffic-map/breakers')
    expect(routeFor({ action: 'retry_push', params: { submission_id: 12 }, reason: 'r' }).url).toBe(
      '/api/erp-submissions/12/retry'
    )
    expect(routeFor({ action: 'incident_mode', params: { on: false }, reason: 'r' }).body).toEqual({
      on: false,
      title: null,
      reason: 'r'
    })
  })
})

describe('incident threads (#2016)', () => {
  it('reports new issues, error starts and recoveries — and nothing when nothing changed', () => {
    const s0 = parseState(null)
    const a = describeChange(s0, {
      e5: 12,
      issues: [{ id: 1, title: 'DB timeout', severity: 'high' }]
    })
    expect(a.lines.join(' ')).toMatch(/1 new issue: DB timeout \(high\).*Server errors started: 12/)
    expect(a.next.peak_e5).toBe(12)
    const b = describeChange(a.next, {
      e5: 11,
      issues: [{ id: 1, title: 'DB timeout', severity: 'high' }]
    })
    expect(b.lines).toEqual([])
    const c = describeChange(b.next, { e5: 0, issues: [] })
    expect(c.lines).toEqual(['Recovering: no server errors in the last 5 min.'])
    expect(c.signal).toBe(false)
  })
  it('closes with duration, peak, issues and actions', () => {
    const s = {
      ...parseState(null),
      peak_e5: 40,
      issue_ids: [1],
      issue_titles: ['DB timeout'],
      actions: ['Approved by Ana and done: Pause the background job x.']
    }
    const text = closingSummary(
      { kind: 'incident', title: 'Checkout down', started_at: new Date(0).toISOString() },
      s,
      'Kim',
      75 * 60_000
    )
    expect(text).toContain('Incident closed after 1h 15m by Kim: Checkout down.')
    expect(text).toContain('Peak: 40 server errors')
    expect(text).toContain('DB timeout')
    expect(text).toContain('Pause the background job x')
  })
})

describe("a person's week (#1968)", () => {
  const at = (h: number) => new Date(Date.UTC(2026, 9, 10, h))
  it('counts distinct records, moves and approvals; highlights finished work first', () => {
    const week = shapeWeek(
      [
        { collection: 'orders', item: '1', kind: 'created', at: at(1) },
        { collection: 'orders', item: '1', kind: 'updated', at: at(2) },
        { collection: 'orders', item: '1', kind: 'updated', at: at(3) },
        { collection: 'orders', item: '2', kind: 'completed', at: at(4), state: 'Done' },
        { collection: 'orders', item: '3', kind: 'sent back', at: at(5), state: 'Draft' },
        { collection: 'invoices', item: '9', kind: 'approved', at: at(6) },
        { collection: 'invoices', item: '9', kind: 'comment', at: at(7) }
      ],
      { 'orders:2': 'ORD-2' },
      { orders: 'Orders' },
      1
    )
    expect(week.figures).toMatchObject({
      created: 1,
      updated: 1,
      moved: 2,
      completed: 1,
      sent_back: 1,
      approved: 1,
      comments: 1,
      imports: 1
    })
    expect(week.highlights[0]).toMatchObject({
      item_id: '2',
      label: 'ORD-2',
      what: 'completed',
      state: 'Done'
    })
    // no label for a record the viewer has none for: #id
    expect(week.highlights.find((h) => h.item_id === '9')?.label).toBe('#9')
    expect(week.by_collection[0]).toMatchObject({
      collection: 'orders',
      label: 'Orders',
      created: 1
    })
  })
})
