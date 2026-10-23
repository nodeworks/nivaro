// api/src/test/unit/services/traffic-integrations.test.ts
// #2162 edit locks, #2189 business events, #2198 role split, #2276 ticket traffic, #2277 chat card.
import { describe, expect, it } from 'vitest'
import {
  AROUND_MIN,
  foldPath,
  summariseTicketTraffic
} from '../../../services/support-ticket-traffic.js'
import { bucketMinutes, minutesOf, topCreated } from '../../../services/traffic-business-events.js'
import {
  type Card,
  freezeCard,
  QUIET_REFRESHES,
  renderCard,
  sparkText,
  stepCard
} from '../../../services/traffic-chat-card.js'
import { shapeLocks } from '../../../services/traffic-edit-locks.js'
import type { TrafficSnapshot } from '../../../services/traffic-map.js'
import { roleNote, roleOf, splitByRole } from '../../../services/traffic-role-split.js'

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0)
const TTL = 5 * 60_000

describe('edit lock lens (#2162)', () => {
  const lock = (item: string, heldMin: number, idleMin: number, user = 'U1') => ({
    collection: 'orders',
    item,
    user,
    holder_name: `Holder ${user}`,
    locked_at: new Date(NOW - heldMin * 60_000),
    // last heartbeat idleMin ago => expires_at = heartbeat + ttl
    expires_at: new Date(NOW - idleMin * 60_000 + TTL),
    note: null
  })
  it('lists long-held and contested locks, most contested first', () => {
    const queue = [
      {
        collection: 'orders',
        item: 'b',
        user: 'U9',
        name: 'Wanda',
        requested_at: new Date(NOW - 120_000)
      },
      {
        collection: 'orders',
        item: 'b',
        user: 'U8',
        name: 'Vic',
        requested_at: new Date(NOW - 300_000)
      }
    ]
    const lens = shapeLocks(
      [lock('a', 40, 1), lock('b', 3, 0), lock('quiet', 2, 0)],
      queue,
      NOW,
      TTL
    )
    expect(lens.active).toBe(3)
    expect(lens.rows.map((r) => r.item)).toEqual(['b', 'a'])
    expect(lens.rows[0].waiting.map((w) => w.name)).toEqual(['Vic', 'Wanda'])
    expect(lens.rows[0].reasons).toEqual(['contested'])
    expect(lens.rows[1].reasons).toEqual(['long'])
  })
  it('reads idle time from the last heartbeat and ignores expired locks', () => {
    const lens = shapeLocks([lock('a', 30, 4), lock('gone', 60, 9)], [], NOW, TTL)
    expect(lens.rows).toHaveLength(1)
    expect(Math.round(lens.rows[0].idle_ms / 60_000)).toBe(4)
    expect(lens.active).toBe(1)
  })
})

describe('business events (#2189)', () => {
  it('buckets timestamps into minutes and ignores strays', () => {
    const from = NOW - 4 * 60_000
    const pts = bucketMinutes(
      [
        new Date(from + 1000),
        new Date(from + 61_000),
        new Date(from + 62_000),
        new Date(from - 5),
        'x'
      ],
      from,
      5
    )
    expect(pts).toEqual([1, 2, 0, 0, 0])
  })
  it('ranks creates per collection and leaves system tables out', () => {
    const top = topCreated([
      { collection: 'orders' },
      { collection: 'orders' },
      { collection: 'nivaro_tasks' },
      { collection: 'invoices' },
      { collection: null }
    ])
    expect(top).toEqual([
      { collection: 'orders', created: 2 },
      { collection: 'invoices', created: 1 }
    ])
  })
  it('clamps the minute count', () => {
    expect(minutesOf(undefined)).toBe(30)
    expect(minutesOf('1')).toBe(5)
    expect(minutesOf('9999')).toBe(120)
    expect(minutesOf('abc')).toBe(30)
  })
})

describe('web vs worker split (#2198)', () => {
  const snap = (req: number, jobRuns: number, pool?: object, live = 0): TrafficSnapshot =>
    ({
      totals: { req, error: 1, p95: req },
      sources: [
        // a job's writes land in the core rows too; only the tap's run count is judged
        ...(jobRuns ? [{ id: 'cron:x', label: 'x', kind: 'cron', req: 99, error: 0 }] : []),
        ...(live
          ? [{ id: 'socket', label: 'Browser sockets', kind: 'socket', req: live, error: 0 }]
          : [])
      ],
      ext: {
        ...(pool ? { pool } : {}),
        ...(jobRuns
          ? {
              sources: {
                sources: {
                  'cron:x': {
                    label: 'x',
                    kind: 'cron',
                    runs: jobRuns,
                    errors: 0,
                    p95_ms: 1,
                    last: null
                  },
                  'flow:y': { label: 'y', kind: 'flow', runs: 7, errors: 0, p95_ms: 1, last: null }
                }
              }
            }
          : {})
      }
    }) as unknown as TrafficSnapshot
  it('groups nodes by roster role and sums them', () => {
    const snaps = new Map([
      ['a', snap(100, 0, { peak_used: 4, max: 10, saturated_pct: 0, wait_p95_ms: 5 })],
      ['b', snap(50, 0, { peak_used: 8, max: 10, saturated_pct: 10, wait_p95_ms: 9 })],
      ['c', snap(5, 40)]
    ])
    const roles = new Map([
      ['a', 'web'],
      ['b', 'WEB'],
      ['c', 'worker']
    ])
    const out = splitByRole(snaps, roles, 60)
    const web = out.groups.find((g) => g.role === 'web')
    expect(web).toMatchObject({ nodes: 2, req: 150, p95: 100 })
    expect(web?.pool?.peak_used).toBe(8)
    expect(out.groups.find((g) => g.role === 'worker')?.background).toBe(40)
    expect(out.note).toBeNull()
  })
  it('never counts sockets, streams or MCP on the web processes as background jobs', () => {
    const snaps = new Map([
      ['a', snap(100, 0, undefined, 500)],
      ['c', snap(5, 0)]
    ])
    const roles = new Map([
      ['a', 'web'],
      ['c', 'worker']
    ])
    const out = splitByRole(snaps, roles, 60)
    expect(out.groups.find((g) => g.role === 'web')).toMatchObject({ background: 0, live: 500 })
    expect(out.note).toBeNull()
  })
  it('names a node with no role "unset" and warns when web runs the jobs', () => {
    expect(roleOf(null)).toBe('unset')
    expect(roleOf('Worker ')).toBe('worker')
    expect(roleOf('bad role!')).toBe('unset')
    const snaps = new Map([
      ['a', snap(100, 3)],
      ['c', snap(5, 0)]
    ])
    const out = splitByRole(
      snaps,
      new Map([
        ['a', 'web'],
        ['c', 'worker']
      ]),
      60
    )
    expect(out.groups.find((g) => g.role === 'web')?.background).toBe(3)
    expect(out.note).toMatch(/web processes/)
    const note = roleNote([
      { role: 'web', nodes: 1, req: 1, error: 0, p95: 1, background: 30, live: 0, pool: null },
      { role: 'worker', nodes: 1, req: 1, error: 0, p95: 1, background: 0, live: 0, pool: null }
    ])
    expect(note).toMatch(/web processes/)
  })
})

describe('traffic on a support ticket (#2276)', () => {
  it('folds ids out of paths and drops the query string', () => {
    expect(foldPath('/api/items/orders/3F2504E0-4F89-11D3-9A0C-0305E82C3301?x=1')).toBe(
      '/api/items/orders/:id'
    )
    expect(foldPath('/api/items/orders/12/lines')).toBe('/api/items/orders/:id/lines')
  })
  it('keeps only rows inside the window and lists the nearest errors first', () => {
    const moment = NOW
    const at = (min: number) => new Date(moment + min * 60_000)
    const out = summariseTicketTraffic(
      [
        { method: 'GET', path: '/api/items/a', status: 200, latency_ms: 5, created_at: at(-2) },
        { method: 'POST', path: '/api/items/a/12', status: 500, latency_ms: 5, created_at: at(1) },
        { method: 'GET', path: '/api/items/a', status: 404, latency_ms: 5, created_at: at(-20) },
        {
          method: 'GET',
          path: '/api/items/a',
          status: 200,
          latency_ms: 5,
          created_at: at(-AROUND_MIN - 5)
        }
      ],
      [
        { route: '/orders/:id', kind: 'load', duration_ms: 900, created_at: at(-1) },
        { route: '/orders/:id', kind: 'route', duration_ms: 300, created_at: at(0) }
      ],
      moment
    )
    expect(out.requests).toBe(3)
    expect(out.errors).toBe(2)
    expect(out.error_list.map((e) => e.status)).toEqual([500, 404])
    expect(out.error_list[0].path).toBe('/api/items/a/:id')
    expect(out.timeline).toHaveLength(2 * AROUND_MIN + 1)
    expect(out.pages).toEqual([{ route: '/orders/:id', n: 2, avg_ms: 600, worst_ms: 900 }])
    expect(out.rum).toBe(true)
    // nothing identifying beyond method, folded path and status
    expect(Object.keys(out.error_list[0]).sort()).toEqual(['at', 'method', 'path', 'status'])
  })
})

describe('chat card (#2277)', () => {
  const card = (over: Partial<Card> = {}): Card => ({
    message: 7,
    room: 'channel:ops',
    kind: 'entity',
    node: 'items/orders',
    label: 'orders (items)',
    started: NOW,
    updated: NOW,
    readings: [10],
    last: { label: 'orders (items)', req: 10, error: 2, p95: 120 },
    startedWithErrors: true,
    quiet: 0,
    status: 'live',
    frozen_at: null,
    reason: null,
    by: 'U1',
    link: null,
    ...over
  })
  it('draws block sparklines scaled to the series', () => {
    expect(sparkText([0, 5, 10])).toBe('▁▅█')
    expect(sparkText([0, 0])).toBe('▁▁')
    expect(sparkText([])).toBe('')
  })
  it('refreshes the figure and freezes after a quiet stretch on an incident card', () => {
    const c = card()
    let reason = null
    for (let i = 0; i < QUIET_REFRESHES; i++) {
      reason = stepCard(c, { label: 'x', req: 20 + i, error: 0, p95: 90 }, NOW + (i + 1) * 30_000)
    }
    expect(reason).toBe('recovered')
    expect(c.last.req).toBe(20 + QUIET_REFRESHES - 1)
    freezeCard(c, 'recovered', NOW + 200_000)
    const text = renderCard(c)
    expect(text).toContain('Frozen at')
    expect(text).toContain('last values')
    expect(text).toMatch(/req\/min · 0 errors · p95 90 ms/)
  })
  it('an error resets the quiet count; a card that started clean never auto-closes on quiet', () => {
    const c = card()
    stepCard(c, { label: 'x', req: 1, error: 0, p95: 1 }, NOW + 1)
    stepCard(c, { label: 'x', req: 1, error: 3, p95: 1 }, NOW + 2)
    expect(c.quiet).toBe(0)
    const clean = card({ startedWithErrors: false })
    let r = null
    for (let i = 0; i < QUIET_REFRESHES + 2; i++)
      r = stepCard(clean, { label: 'x', req: 1, error: 0, p95: 1 }, NOW + i)
    expect(r).toBeNull()
  })
  it('expires after two hours and keeps the readings bounded', () => {
    const c = card()
    let r = null
    for (let i = 0; i < 40; i++) r = stepCard(c, { label: 'x', req: i, error: 1, p95: 1 }, NOW + i)
    expect(c.readings.length).toBeLessThanOrEqual(24)
    r = stepCard(c, { label: 'x', req: 1, error: 1, p95: 1 }, NOW + 2 * 3600_000)
    expect(r).toBe('expired')
  })
  it('a node that left the snapshot reads as zero', () => {
    const c = card()
    stepCard(c, null, NOW + 1)
    expect(c.last).toMatchObject({ req: 0, error: 0, label: 'orders (items)' })
  })
})

describe('ticket traffic paths shown to the desk', () => {
  it('folds ids, share tokens and emails', () => {
    expect(foldPath('/api/items/orders/3F2504E0-4F89-11D3-9A0C-0305E82C3301?x=1')).toBe(
      '/api/items/orders/:id'
    )
    expect(foldPath('/api/session-replay-shares/view/a8Fk29xQpL0zR7mN')).toBe(
      '/api/session-replay-shares/view/:id'
    )
    expect(foldPath('/api/directory/users/jane.doe%40example.com')).toBe('/api/directory/users/:id')
    expect(foldPath('/share/k3Jd8sLq0Pz1Xc9V')).toBe('/share/:id')
  })
})
