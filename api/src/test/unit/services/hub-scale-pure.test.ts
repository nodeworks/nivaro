import { describe, expect, it } from 'vitest'
import type { CapacityUsage } from '../../../services/capacity/app-usage.js'
import {
  addHistograms,
  LAT_BOUNDS_MS,
  p95Of,
  roleFigures
} from '../../../services/capacity/scale-figures.js'
import type { StackRole } from '../../../services/hub/docker/agent-types.js'
import { connectionMath, poolSetting } from '../../../services/hub/scale/connections.js'
import { figuresFromUsage } from '../../../services/hub/scale/figures.js'
import { changesBetween, parseRoleChanges, stepsBetween } from '../../../services/hub/scale/plan.js'
import {
  type AutoRule,
  checkRule,
  decide,
  EMPTY_STATE,
  floorNow,
  inWindow,
  maxHits24h
} from '../../../services/hub/scale/rules.js'
import {
  applyScaleShape,
  figuresOf,
  scaleAgentOk,
  shapeText
} from '../../../services/hub/scale/shape.js'

// Nivaro Hub scaling, the pure parts: the shape the renderers lay over the size template, the
// connection math, the plan's steps, the autoscaling decision and its schedule windows, and the
// figures read from a usage answer.

const LARGE: StackRole[] = [
  { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072, env: { SOCKETS: 'off' } },
  { role: 'worker', replicas: 1, cpus: 2, memory_mb: 4096 },
  { role: 'realtime', replicas: 2, cpus: 1, memory_mb: 1024 },
  { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 },
  { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
]

describe('applyScaleShape', () => {
  it('no shape renders the template exactly (a fresh copy)', () => {
    const out = applyScaleShape(LARGE, null)
    expect(out).toEqual(LARGE)
    expect(out).not.toBe(LARGE)
    expect(applyScaleShape(LARGE, {})).toEqual(LARGE)
  })

  it('lays replicas over scalable roles only, limits over any role, never below the floor', () => {
    const out = applyScaleShape(LARGE, {
      web: { replicas: 6 },
      worker: { replicas: 4, cpus: 3 },
      realtime: { replicas: 0, memory_mb: 2048 },
      all: { replicas: 3 }
    })
    expect(out.find((r) => r.role === 'web')).toMatchObject({
      replicas: 6,
      env: { SOCKETS: 'off' }
    })
    expect(out.find((r) => r.role === 'worker')).toMatchObject({ replicas: 1, cpus: 3 })
    expect(out.find((r) => r.role === 'realtime')).toMatchObject({ replicas: 1, memory_mb: 2048 })
    expect(out.some((r) => r.role === 'all')).toBe(false)
  })

  it('agent 0.2.4 gates scaling', () => {
    expect(scaleAgentOk('0.2.4')).toBe(true)
    expect(scaleAgentOk('v0.2.5-rc.1')).toBe(true)
    expect(scaleAgentOk('0.2.3')).toBe(false)
    expect(scaleAgentOk(undefined)).toBe(false)
  })

  it('says what changes', () => {
    const from = figuresOf(LARGE)
    const to = from.map((r) =>
      r.role === 'web'
        ? { ...r, replicas: 5 }
        : r.role === 'realtime'
          ? { ...r, memory_mb: 2048 }
          : r
    )
    expect(shapeText(from, to)).toBe('web 3 → 5; realtime memory 1024 → 2048 MB')
    expect(shapeText(from, from)).toBe('no change')
  })
})

describe('connection math', () => {
  it('dedicated: processes × (main + background) against the server, others counted', () => {
    const m = connectionMath({
      kind: 'environment',
      processes: { from: 8, to: 10 },
      pools: { main: 60, background: 10 },
      server: { id: 1, name: 'sql1', max_connections: 800, others: 140 }
    })
    // + 1 per process for the health probe's own connection.
    expect(m.per_process).toBe(71)
    expect(m.total).toEqual({ from: 568, to: 710 })
    expect(m.servers[0]).toMatchObject({ after: 850, fits: false })
    expect(m.refusals.map((r) => r.code)).toEqual(['DB_CONNECTIONS'])
  })

  it('a change that lowers connections is never refused, even over the limit', () => {
    const m = connectionMath({
      kind: 'environment',
      processes: { from: 10, to: 9 },
      pools: { main: 60, background: 10 },
      server: { id: 1, name: 'pg', max_connections: 100, others: 0 }
    })
    expect(m.refusals).toEqual([])
    expect(m.warnings.map((w) => w.code)).toEqual(['DB_LIMIT'])
  })

  it('an unknown limit or server only warns', () => {
    expect(
      connectionMath({
        kind: 'environment',
        processes: { from: 2, to: 5 },
        pools: { main: 60, background: 10 },
        server: { id: 1, name: 'sql1', max_connections: null, others: 0 }
      }).warnings.map((w) => w.code)
    ).toEqual(['DB_LIMIT'])
    expect(
      connectionMath({
        kind: 'environment',
        processes: { from: 2, to: 5 },
        pools: { main: 60, background: 10 },
        server: null
      }).warnings.map((w) => w.code)
    ).toEqual(['DB_UNKNOWN'])
  })

  it('shared: processes × each app pool per server, the per-process budget shown', () => {
    const m = connectionMath({
      kind: 'shared',
      processes: { from: 4, to: 6 },
      budget: 12,
      apps: [
        {
          env_id: 1,
          label: 'a/prod',
          pool_max: 5,
          server: { id: 1, name: 's1', max_connections: 50, others: 10 }
        },
        {
          env_id: 2,
          label: 'b/prod',
          pool_max: 5,
          server: { id: 1, name: 's1', max_connections: 50, others: 10 }
        },
        { env_id: 3, label: 'c/prod', pool_max: 4, server: null }
      ]
    })
    expect(m.per_process).toBe(14)
    expect(m.budget).toEqual({ per_process: 12, used: 14 })
    expect(m.total).toEqual({ from: 56, to: 84 })
    expect(m.servers[0]).toMatchObject({ from: 40, to: 60, after: 70, fits: false })
    expect(m.refusals).toHaveLength(1)
    expect(m.warnings.map((w) => w.code).sort()).toEqual(['DB_UNKNOWN', 'POOL_BUDGET'])
  })

  it('reads pool settings, else the defaults', () => {
    expect(poolSetting('30', 60)).toBe(30)
    expect(poolSetting('0', 10)).toBe(0)
    expect(poolSetting('x', 60)).toBe(60)
    expect(poolSetting(undefined, 10)).toBe(10)
  })
})

describe('plan steps', () => {
  const from = figuresOf(LARGE)
  it('a realtime scale-in goes one replica a step; everything else in the first', () => {
    const rt5 = from.map((r) => (r.role === 'realtime' ? { ...r, replicas: 5 } : r))
    const to = from.map((r) =>
      r.role === 'realtime' ? { ...r, replicas: 2 } : r.role === 'web' ? { ...r, replicas: 4 } : r
    )
    const steps = stepsBetween(rt5, to)
    expect(steps.map((s) => s.find((r) => r.role === 'realtime')?.replicas)).toEqual([4, 3, 2])
    expect(steps.every((s) => s.find((r) => r.role === 'web')?.replicas === 4)).toBe(true)
    expect(stepsBetween(from, to)).toHaveLength(1)
  })

  it('the agent is sent only what differs', () => {
    const to = from.map((r) => (r.role === 'web' ? { ...r, replicas: 5, cpus: 3 } : r))
    expect(changesBetween(from, to)).toEqual([{ role: 'web', replicas: 5, cpus: 3 }])
    expect(changesBetween(from, from)).toEqual([])
  })

  it('parses a change list', () => {
    expect(parseRoleChanges([{ role: 'web', replicas: 4 }])).toEqual([{ role: 'web', replicas: 4 }])
    expect(parseRoleChanges([{ role: 'db' }])).toHaveProperty('error')
    expect(parseRoleChanges([{ role: 'web' }, { role: 'web' }])).toHaveProperty('error')
    expect(parseRoleChanges([])).toHaveProperty('error')
  })
})

const rule = (over: Partial<AutoRule> = {}): AutoRule => {
  const r = checkRule(
    {
      enabled: true,
      min: 2,
      max: 6,
      metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 30 }],
      ...over
    },
    'web'
  )
  if (!r.ok) throw new Error(r.error)
  return r.rule
}

const T0 = Date.UTC(2026, 10, 25, 15, 0, 0) // a Wednesday, 10:00 in New York

describe('checkRule', () => {
  it('needs in_below under out_above (hysteresis), a floor of one, metrics the role knows', () => {
    expect(
      checkRule(
        {
          enabled: true,
          min: 2,
          max: 6,
          metrics: [{ metric: 'cpu_pct', out_above: 50, in_below: 50 }]
        },
        'web'
      )
    ).toMatchObject({ ok: false })
    expect(checkRule({ enabled: true, min: 0, max: 6, metrics: [] }, 'web')).toMatchObject({
      ok: false
    })
    expect(
      checkRule(
        {
          enabled: true,
          min: 1,
          max: 2,
          metrics: [{ metric: 'import_queue', out_above: 5, in_below: 1 }]
        },
        'web'
      )
    ).toMatchObject({ ok: false })
    expect(
      checkRule(
        {
          enabled: true,
          min: 1,
          max: 2,
          metrics: [{ metric: 'import_queue', out_above: 5, in_below: 1 }]
        },
        'importer'
      )
    ).toMatchObject({ ok: true })
    expect(checkRule({ enabled: true, min: 3, max: 2, metrics: [] }, 'web')).toMatchObject({
      ok: false
    })
  })

  it('fills the defaults and checks schedules', () => {
    const r = rule({
      schedules: [
        { days: [1, 2, 3, 4, 5], from: '07:00', to: '19:00', zone: 'America/New_York', min: 4 }
      ]
    } as never)
    expect(r).toMatchObject({ sustain: 3, sustain_in: 10, cooldown_out_min: 5, step: 1 })
    expect(r.schedules[0].min).toBe(4)
    expect(
      checkRule(
        {
          enabled: true,
          min: 2,
          max: 6,
          metrics: [],
          schedules: [{ days: [1], from: '07:00', to: '19:00', zone: 'Mars/Base', min: 3 }]
        },
        'web'
      )
    ).toMatchObject({ ok: false })
  })
})

describe("schedule windows (on the zone's own calendar)", () => {
  const day = {
    days: [1, 2, 3, 4, 5],
    from: '07:00',
    to: '19:00',
    zone: 'America/New_York',
    min: 4
  }
  it('weekdays 7 AM–7 PM Eastern', () => {
    expect(inWindow(day, T0)).toBe(true) // Wed 10:00 ET
    expect(inWindow(day, Date.UTC(2026, 10, 25, 23, 30))).toBe(true) // Wed 18:30 ET
    expect(inWindow(day, Date.UTC(2026, 10, 26, 0, 30))).toBe(false) // Wed 19:30 ET
    expect(inWindow(day, Date.UTC(2026, 10, 28, 15, 0))).toBe(false) // Saturday
  })
  it('a window past midnight belongs to the day it starts', () => {
    const night = { days: [5], from: '22:00', to: '02:00', zone: 'America/New_York', min: 3 }
    expect(inWindow(night, Date.UTC(2026, 10, 28, 4, 0))).toBe(true) // Fri 23:00 ET
    expect(inWindow(night, Date.UTC(2026, 10, 28, 6, 30))).toBe(true) // Sat 01:30 ET
    expect(inWindow(night, Date.UTC(2026, 10, 29, 6, 30))).toBe(false) // Sun 01:30 ET
  })
  it('raises the floor inside, never past max', () => {
    const r = rule({ schedules: [{ ...day, min: 4 }] })
    expect(floorNow(r, 'web', T0)).toMatchObject({ min: 4 })
    expect(floorNow(r, 'web', Date.UTC(2026, 10, 28, 15, 0))).toMatchObject({
      min: 2,
      schedule: null
    })
  })
})

describe('decide', () => {
  const at = (min: number) => T0 + min * 60_000
  it('scales out one step only after `sustain` checks above, then waits for the cooldown', () => {
    const r = rule()
    let state = { ...EMPTY_STATE, max_hits: [] as string[] }
    const outcomes: string[] = []
    for (let i = 0; i < 3; i++) {
      const d = decide({
        rule: r,
        role: 'web',
        state,
        current: 3,
        figures: { cpu_pct: 85 },
        now: at(i)
      })
      outcomes.push(`${d.action}:${d.to}`)
      state = d.state
    }
    expect(outcomes).toEqual(['hold:3', 'hold:3', 'out:4'])
    // Right after: above again, but the cooldown (and one step per 10 min) holds it.
    for (let i = 3; i < 6; i++)
      state = decide({
        rule: r,
        role: 'web',
        state,
        current: 4,
        figures: { cpu_pct: 90 },
        now: at(i)
      }).state
    const d = decide({
      rule: r,
      role: 'web',
      state,
      current: 4,
      figures: { cpu_pct: 90 },
      now: at(6)
    })
    expect(d.action).toBe('hold')
    expect(d.reason).toMatch(/cooldown/)
    const later = decide({
      rule: r,
      role: 'web',
      state: d.state,
      current: 4,
      figures: { cpu_pct: 90 },
      now: at(13)
    })
    expect(later).toMatchObject({
      action: 'out',
      to: 5,
      metric: 'cpu_pct',
      value: 90,
      threshold: 70
    })
    expect(later.reason).toMatch(/CPU/)
  })

  it('between the marks nothing moves; under every mark for `sustain_in` checks it scales in', () => {
    const r = rule({ sustain_in: 2, cooldown_in_min: 0, step_every_min: 1 })
    let state = { ...EMPTY_STATE, max_hits: [] as string[] }
    expect(
      decide({ rule: r, role: 'web', state, current: 4, figures: { cpu_pct: 50 }, now: at(0) })
        .action
    ).toBe('hold')
    state = decide({
      rule: r,
      role: 'web',
      state,
      current: 4,
      figures: { cpu_pct: 10 },
      now: at(1)
    }).state
    const d = decide({
      rule: r,
      role: 'web',
      state,
      current: 4,
      figures: { cpu_pct: 10 },
      now: at(2)
    })
    expect(d).toMatchObject({ action: 'in', to: 3 })
  })

  it('never below the floor; a schedule window raises it at once', () => {
    const r = rule({
      sustain_in: 1,
      cooldown_in_min: 0,
      schedules: [{ days: [3], from: '07:00', to: '19:00', zone: 'America/New_York', min: 5 }]
    })
    const inside = decide({
      rule: r,
      role: 'web',
      state: EMPTY_STATE,
      current: 3,
      figures: { cpu_pct: 5 },
      now: T0
    })
    expect(inside).toMatchObject({ action: 'out', to: 5 })
    expect(inside.reason).toMatch(/schedule/)
    const atMin = decide({
      rule: r,
      role: 'web',
      state: EMPTY_STATE,
      current: 2,
      figures: { cpu_pct: 5 },
      now: Date.UTC(2026, 10, 28, 15)
    })
    expect(atMin.action).toBe('hold')
  })

  it('no figure is never a zero: nothing moves and the counters reset', () => {
    const d = decide({
      rule: rule(),
      role: 'web',
      state: { ...EMPTY_STATE, above: 2, max_hits: [] },
      current: 3,
      figures: { cpu_pct: null },
      now: T0
    })
    expect(d).toMatchObject({ action: 'hold', reason: 'No figures to judge by.' })
    expect(d.state.above).toBe(0)
  })

  it('at max it notes a hit (one per 10 minutes) instead of scaling', () => {
    const r = rule({ sustain: 1 })
    let state = { ...EMPTY_STATE, max_hits: [] as string[] }
    for (let i = 0; i < 25; i++) {
      const d = decide({
        rule: r,
        role: 'web',
        state,
        current: 6,
        figures: { cpu_pct: 99 },
        now: at(i)
      })
      expect(d.action).toBe('hold')
      expect(d.past_max).toBe(true)
      state = d.state
    }
    expect(maxHits24h(state, at(25))).toBe(3)
  })

  it('realtime scales one replica a step whatever the rule says', () => {
    const r = checkRule(
      {
        enabled: true,
        min: 1,
        max: 8,
        step: 3,
        metrics: [{ metric: 'cpu_pct', out_above: 70, in_below: 20 }],
        sustain: 1
      },
      'realtime'
    )
    if (!r.ok) throw new Error(r.error)
    expect(
      decide({
        rule: r.rule,
        role: 'realtime',
        state: EMPTY_STATE,
        current: 2,
        figures: { cpu_pct: 90 },
        now: T0
      }).to
    ).toBe(3)
  })
})

describe('figures from a usage answer', () => {
  it('per role: CPU and memory against the limits, requests per web replica, p95, queues', () => {
    const usage = {
      version: '0.3.215',
      at: 'x',
      partial: false,
      processes: [
        { instance: 'w1', role: 'web', cpu_pct: 150, memory_mb: 1536, uptime_s: 1 },
        { instance: 'w2', role: 'web', cpu_pct: 50, memory_mb: 1536, uptime_s: 1 },
        { instance: 'i1', role: 'importer', cpu_pct: 20, memory_mb: 400, uptime_s: 1 }
      ],
      totals: { cpu_pct: 220, memory_mb: 3472, requests_per_min: 900, busy_ms_per_min: 1 },
      apps: [],
      roles: [{ role: 'web', processes: 2, p95_ms: 750, heavy_queued: 3 }],
      queues: { imports: 7, exports: null }
    } as unknown as CapacityUsage
    const roles: StackRole[] = [
      { role: 'web', replicas: 3, cpus: 2, memory_mb: 3072 },
      { role: 'importer', replicas: 1, cpus: 2, memory_mb: 4096 },
      { role: 'exporter', replicas: 1, cpus: 2, memory_mb: 4096 }
    ]
    const f = figuresFromUsage(usage, roles)
    expect(f.web).toEqual({
      cpu_pct: 50,
      memory_pct: 50,
      p95_ms: 750,
      heavy_queue: 3,
      requests_per_min: 300
    })
    expect(f.importer).toMatchObject({ cpu_pct: 10, import_queue: 7 })
    expect(f.exporter).toEqual({})
  })
})

describe('answer-time histograms (app side)', () => {
  it('p95 is the bound of the bucket the 95th answer falls in; none = null', () => {
    const h = new Array(LAT_BOUNDS_MS.length + 1).fill(0)
    h[2] = 90 // ≤ 100 ms
    h[6] = 10 // ≤ 750 ms
    expect(p95Of(h)).toBe(750)
    expect(p95Of(new Array(h.length).fill(0))).toBeNull()
    expect(addHistograms([h, h, null, [1, 2]])[2]).toBe(180)
  })

  it('per role over every process', () => {
    const h = (i: number) => {
      const a = new Array(LAT_BOUNDS_MS.length + 1).fill(0)
      a[i] = 100
      return a
    }
    const out = roleFigures([
      { role: 'web', lat: h(1), heavy_queued: 1 },
      { role: 'web', lat: h(4), heavy_queued: 2 },
      { role: null, lat: h(0), heavy_queued: null }
    ])
    expect(out).toEqual([
      { role: null, processes: 1, p95_ms: 25, heavy_queued: null },
      { role: 'web', processes: 2, p95_ms: 300, heavy_queued: 3 }
    ])
  })
})
