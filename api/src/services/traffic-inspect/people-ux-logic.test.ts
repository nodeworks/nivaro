import { describe, expect, it } from 'vitest'
import {
  aiCostByScreen,
  apdex,
  apdexBy,
  attribute,
  buildFunnels,
  buildVisits,
  deliveredChannels,
  deviceSplit,
  flowEdges,
  isNewPerson,
  type JourneyRow,
  newVsExperienced,
  notificationPressure,
  parseBrowser,
  rankErrorPeople,
  screenClass,
  signInStep,
  splitTime,
  visitAt,
  weekStart
} from './people-ux-logic.js'

const T0 = Date.UTC(2026, 9, 12, 10, 0, 0)
const j = (
  user: string,
  page: string,
  at: number,
  dur: number | null,
  session = 's1'
): JourneyRow => ({
  user,
  session_id: session,
  page,
  app: 'admin',
  entered_at: at,
  duration_seconds: dur
})

describe('visits', () => {
  const visits = buildVisits([j('U1', '/a', T0, 60), j('U1', '/b', T0 + 60_000, null)])
  it('finds the open visit and none outside it', () => {
    expect(visitAt(visits, 'U1', T0 + 10_000)?.page).toBe('/a')
    expect(visitAt(visits, 'U1', T0 + 61_000)?.page).toBe('/b')
    expect(visitAt(visits, 'U1', T0 - 1)).toBeNull()
    expect(visitAt(visits, 'U1', T0 + 40 * 60_000)).toBeNull()
    expect(visitAt(visits, 'U2', T0)).toBeNull()
  })
  it('skips the map and the beacon', () => {
    const got = attribute(visits, [
      { user: 'U1', at: T0 + 1000, latency_ms: 10, status: 200, path: '/api/traffic-map/frame' },
      { user: 'U1', at: T0 + 1000, latency_ms: 10, status: 200, path: '/api/items/x' }
    ])
    expect(got).toHaveLength(1)
  })
})

describe('new vs experienced', () => {
  it('splits the cohorts and flags the slower new people', () => {
    const visits = buildVisits([j('NEW', '/a', T0, 600, 'n'), j('OLD', '/a', T0, 600, 'o')])
    const created = new Map([
      ['NEW', T0 - 2 * 86_400_000],
      ['OLD', T0 - 90 * 86_400_000]
    ])
    const reqs = []
    for (let i = 0; i < 6; i++) {
      reqs.push({
        user: 'NEW',
        at: T0 + 1000 + i,
        latency_ms: 900,
        status: i === 0 ? 500 : 200,
        path: '/api/items/a'
      })
      reqs.push({
        user: 'OLD',
        at: T0 + 1000 + i,
        latency_ms: 300,
        status: 200,
        path: '/api/items/a'
      })
    }
    const rows = newVsExperienced(visits, reqs, [], created)
    expect(rows).toHaveLength(1)
    expect(rows[0].new.requests).toBe(6)
    expect(rows[0].new.errors).toBe(1)
    expect(rows[0].experienced.requests).toBe(6)
    expect(rows[0].slower_by).toBe(3)
  })
  it('a week from creation is the edge', () => {
    expect(isNewPerson(T0, T0 + 7 * 86_400_000)).toBe(true)
    expect(isNewPerson(T0, T0 + 8 * 86_400_000)).toBe(false)
    expect(isNewPerson(undefined, T0)).toBe(false)
  })
})

describe('devices', () => {
  it('parses browsers and screen classes', () => {
    expect(
      parseBrowser(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
      )
    ).toEqual({ browser: 'Chrome 126', os: 'macOS' })
    expect(
      parseBrowser('Mozilla/5.0 (Windows NT 10.0) Chrome/126.0 Safari/537.36 Edg/126.0').browser
    ).toBe('Edge 126')
    expect(
      parseBrowser('Mozilla/5.0 (iPhone) AppleWebKit Version/17.4 Mobile Safari/604.1')
    ).toEqual({ browser: 'Safari 17', os: 'iOS' })
    expect(screenClass(390)).toBe('phone')
    expect(screenClass(1280)).toBe('laptop')
    expect(screenClass('x')).toBeNull()
  })
  it('flags the one browser that is slow', () => {
    const s = (browser: string, ms: number) => ({
      app: 'admin',
      route: '/a',
      kind: 'route',
      ms,
      browser,
      os: 'macOS',
      screen: 'laptop'
    })
    const samples = [
      ...Array.from({ length: 10 }, () => s('Chrome 126', 200)),
      ...Array.from({ length: 6 }, () => s('Safari 17', 2000))
    ]
    const rows = deviceSplit(samples)
    expect(rows[0]).toMatchObject({ dimension: 'browser', value: 'Safari 17', outlier: true })
    // One OS and one screen class is no split.
    expect(rows.some((r) => r.dimension === 'os')).toBe(false)
  })
})

describe('errors', () => {
  it('ranks by total with pages and text', () => {
    const ev = (user: string, kind: 'client' | 'server', page: string, text = 'boom') => ({
      user,
      at: T0,
      kind,
      page,
      text
    })
    const rows = rankErrorPeople([
      ev('A', 'client', '/x'),
      ev('A', 'server', '/x'),
      ev('A', 'server', '/y'),
      ev('B', 'server', '/z')
    ])
    expect(rows.map((r) => r.user)).toEqual(['A', 'B'])
    expect(rows[0]).toMatchObject({ client: 1, server: 2, total: 3 })
    expect(rows[0].pages[0]).toEqual({ page: '/x', n: 2 })
  })
})

describe('time split', () => {
  it('attributes to the biggest side', () => {
    expect(splitTime(900, 100, 1500).verdict).toBe('network')
    expect(splitTime(100, 1200, 1500).verdict).toBe('server')
    expect(splitTime(100, 100, 1500).verdict).toBe('browser')
  })
  it('never exceeds the total', () => {
    const s = splitTime(5000, 5000, 1000)
    expect(s.network + s.server + s.browser).toBe(1000)
  })
})

describe('apdex', () => {
  it('scores satisfied, tolerating, frustrated', () => {
    const a = apdex([100, 400, 500, 1000, 3000], 500)
    expect(a).toMatchObject({ satisfied: 3, tolerating: 1, frustrated: 1 })
    expect(a.score).toBe(0.7)
    expect(apdex([], 500).score).toBeNull()
  })
  it('puts the worst first and trends weekly', () => {
    const at = (d: number) => Date.UTC(2026, 9, d)
    const mk = (key: string, ms: number, d: number) => ({ key, at: at(d), ms })
    const page = [
      ...Array.from({ length: 5 }, () => mk('/slow', 5000, 5)),
      ...Array.from({ length: 5 }, () => mk('/slow', 100, 13)),
      ...Array.from({ length: 5 }, () => mk('/fast', 100, 5))
    ]
    const rows = apdexBy(page, [], 1000, 500)
    expect(rows[0].id).toBe('/slow')
    expect(rows[0].weeks.map((w) => w.week)).toEqual(['2026-10-05', '2026-10-12'])
    expect(rows[0].weeks[0].page).toBe(0)
    expect(rows[0].weeks[1].page).toBe(1)
    expect(weekStart(Date.UTC(2026, 9, 11))).toBe('2026-10-05')
  })
})

describe('sign-in funnel', () => {
  const ev = (who: string, at: number, method: string, path: string, status = 302) => ({
    who,
    at,
    method,
    path,
    status,
    user: null
  })
  it('names the steps', () => {
    expect(signInStep('GET', '/api/auth/callback?code=1')).toEqual({
      method: 'microsoft',
      step: 'callback'
    })
    expect(signInStep('POST', '/api/auth/login/password')).toEqual({
      method: 'password',
      step: 'submit'
    })
    expect(signInStep('GET', '/api/auth/me')).toBeNull()
  })
  it('counts attempts down the steps and the failures', () => {
    const events = [
      ev('a', T0, 'GET', '/api/auth/providers', 200),
      ev('a', T0 + 1000, 'GET', '/api/auth/login'),
      ev('a', T0 + 5000, 'GET', '/api/auth/callback'),
      ev('b', T0, 'GET', '/api/auth/providers', 200),
      ev('b', T0 + 1000, 'GET', '/api/auth/login'),
      ev('b', T0 + 9000, 'GET', '/api/auth/callback', 500),
      ev('c', T0, 'POST', '/api/auth/login/password', 401)
    ]
    const f = buildFunnels(events, (who, at) => (who === 'a' ? at + 2000 : null))
    const ms = f.find((x) => x.method === 'microsoft')
    expect(ms?.attempts).toBe(2)
    expect(ms?.completed).toBe(1)
    const byKey = Object.fromEntries((ms?.steps ?? []).map((s) => [s.key, s]))
    expect(byKey.callback).toMatchObject({ reached: 2, failed: 1 })
    expect(byKey.first.reached).toBe(1)
    expect(byKey.callback.p50_ms).toBeGreaterThan(0)
    const pw = f.find((x) => x.method === 'password')
    expect(pw?.steps[0]).toMatchObject({ reached: 1, failed: 1 })
    expect(pw?.completed).toBe(0)
  })
})

describe('flow', () => {
  it('draws moves with the cost of the destination load', () => {
    const visits = buildVisits([
      j('U', '/home', T0, 10),
      j('U', '/list', T0 + 10_000, 10),
      j('U', '/list', T0 + 20_000, 10),
      j('U', '/rec', T0 + 30_000, 10)
    ])
    const reqs = [
      { user: 'U', at: T0 + 10_500, latency_ms: 100, status: 200, path: '/api/items/a' },
      { user: 'U', at: T0 + 11_000, latency_ms: 100, status: 200, path: '/api/items/b' },
      { user: 'U', at: T0 + 31_000, latency_ms: 50, status: 200, path: '/api/items/c' }
    ]
    const edges = flowEdges(visits, reqs, 'admin')
    expect(edges[0]).toMatchObject({
      from: '/home',
      to: '/list',
      moves: 1,
      requests: 2,
      per_move: 2
    })
    expect(edges.find((e) => e.to === '/rec')?.requests).toBe(1)
    // A move to the same page is not a move.
    expect(edges.some((e) => e.from === '/list' && e.to === '/list')).toBe(false)
    expect(flowEdges(visits, reqs, 'other')).toHaveLength(0)
  })
})

describe('notification pressure', () => {
  it('flags the flooded and names the senders', () => {
    const now = Date.UTC(2026, 9, 12, 12, 30)
    const hourStart = Date.UTC(2026, 9, 12, 12)
    const rows = Array.from({ length: 12 }, (_, i) => ({
      recipient: 'U1',
      at: hourStart + i * 1000,
      category: 'approvals',
      sender: 'Robot' as string | null,
      channels: ['inapp', 'email']
    }))
    rows.push({ recipient: 'U2', at: hourStart, category: 'x', sender: null, channels: ['inapp'] })
    const out = notificationPressure(rows, now, 24, 10)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ user: 'U1', peak: 12, total: 12 })
    expect(out[0].channels).toEqual({ inapp: 12, email: 12 })
    expect(out[0].senders[0]).toEqual({ name: 'Robot', n: 12 })
    expect(out[0].per_hour).toHaveLength(24)
  })
  it('reads the channels that reached the person', () => {
    expect(
      deliveredChannels({
        inapp: { status: 'delivered' },
        push: { status: 'no_subscription' },
        email: { status: 'sent' },
        escalation: { push_at: 'x' }
      })
    ).toEqual(['inapp', 'email'])
    expect(deliveredChannels(null)).toEqual([])
  })
})

describe('ai cost', () => {
  it('lands calls on the screen the person had open', () => {
    const visits = buildVisits([j('U', '/records/:id', T0, 600)])
    const rows = aiCostByScreen(visits, [
      { user: 'U', at: T0 + 1000, feature: 'chat', cost: 0.5, tokens: 100, ok: true },
      { user: 'U', at: T0 + 2000, feature: 'summarize', cost: 0.25, tokens: 50, ok: false },
      { user: null, at: T0 + 2000, feature: 'brief', cost: 1, tokens: 10, ok: true }
    ])
    expect(rows[0].screen).toContain('no screen')
    const rec = rows.find((r) => r.screen === 'admin /records/:id')
    expect(rec).toMatchObject({ calls: 2, cost: 0.75, errors: 1 })
    expect(rec?.features[0].feature).toBe('chat')
  })
})
