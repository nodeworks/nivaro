import { beforeEach, describe, expect, it, vi } from 'vitest'

// No database in these tests: every query the code under test would make fails, and the code
// treats a failed lookup as "fall back" (labels → words, config → defaults).
vi.mock('../../db/index.js', () => ({
  db: vi.fn(() => {
    throw new Error('no database in tests')
  })
}))
vi.mock('../../lib/column-probe.js', () => ({ hasColumn: async () => false }))

const regionSets = new Map<string, Set<string> | null>()
vi.mock('./regions.js', () => ({
  recordIdsInRegion: async (collection: string) => regionSets.get(collection) ?? null,
  userIdsInRegion: async () => null
}))

import type { User } from '../../types.js'
import { computeFlow } from './flow.js'
import { assembleForecast } from './forecast.js'
import { memoryNudgeStore, type NudgeDeps, runNudge } from './nudge.js'
import type { OpenInstance, OpenWorkIndex } from './open-work.js'
import { Viewer } from './work-access.js'
import {
  ageStats,
  bucketByLocalHour,
  bucketDaysByLocalHour,
  clearsInDays,
  DAY_MS,
  expectedByHour,
  expectedSoFar,
  isBehind,
  localParts,
  narrowToRegion,
  rankAttention,
  workloadStatus,
  zonedMidnightUtc
} from './work-math.js'
import { assembleWorkload } from './workload.js'

const user = { id: 'U-1', first_name: 'Pat', last_name: 'Lee', email: 'pat@x' } as unknown as User

describe('age and stuck maths', () => {
  const now = Date.UTC(2026, 9, 30, 12)
  it('oldest, median and stuck count over entry times', () => {
    const entered = [now - 1 * DAY_MS, now - 3 * DAY_MS, now - 10 * DAY_MS]
    const s = ageStats(entered, now, 7)
    expect(s.oldest_age_s).toBe(10 * 86_400)
    expect(s.median_age_s).toBe(3 * 86_400)
    expect(s.stuck).toBe(1)
  })
  it('empty state has no ages', () => {
    expect(ageStats([], now, 7)).toEqual({ oldest_age_s: null, median_age_s: null, stuck: 0 })
  })
  it('a future entry (clock skew) counts as zero age', () => {
    expect(ageStats([now + 60_000], now, 7).oldest_age_s).toBe(0)
  })
  it('exactly stuck_days is not yet stuck', () => {
    expect(ageStats([now - 7 * DAY_MS], now, 7).stuck).toBe(0)
  })
})

describe('clears in days', () => {
  it('open at the 7-day completion pace', () => {
    expect(clearsInDays(14, 7)).toBe(14)
    expect(clearsInDays(10, 14)).toBe(5)
    expect(clearsInDays(5, 3)).toBe(11.7)
  })
  it('nothing open clears now; nothing completed never clears', () => {
    expect(clearsInDays(0, 0)).toBe(0)
    expect(clearsInDays(4, 0)).toBeNull()
  })
})

describe('forecast expectation', () => {
  it('expected per hour is the mean of the past same weekdays', () => {
    const day = (h: number, n: number) => Array.from({ length: 24 }, (_, i) => (i === h ? n : 0))
    expect(expectedByHour([day(9, 4), day(9, 2), day(9, 0), day(9, 2)])[9]).toBe(2)
    expect(expectedByHour([])).toHaveLength(24)
  })
  it('expected so far = whole past hours + the elapsed share of this one', () => {
    const byHour = Array.from({ length: 24 }, () => 2)
    expect(expectedSoFar(byHour, 3, 0.5)).toBe(7)
    expect(expectedSoFar(byHour, 0, 0)).toBe(0)
  })
  it('behind when the backlog grows faster than usual beyond the band', () => {
    expect(
      isBehind({
        arrivals_so_far: 30,
        completions_so_far: 10,
        arrivals_expected: 30,
        completions_expected: 25
      })
    ).toBe(true)
    expect(
      isBehind({
        arrivals_so_far: 30,
        completions_so_far: 23,
        arrivals_expected: 30,
        completions_expected: 25
      })
    ).toBe(false)
    // Small numbers stay inside the minimum band of 3.
    expect(
      isBehind({
        arrivals_so_far: 3,
        completions_so_far: 0,
        arrivals_expected: 1,
        completions_expected: 1
      })
    ).toBe(false)
  })
  it('assembles today against four past weeks; no history = never behind', () => {
    const z = () => new Array(24).fill(0) as number[]
    const today = { arrivals: z(), completions: z() }
    today.arrivals[9] = 20
    const past = Array.from({ length: 4 }, () => {
      const d = { arrivals: z(), completions: z() }
      d.arrivals[9] = 10
      d.completions[9] = 10
      return d
    })
    const f = assembleForecast({ today, past, hour: 10, fraction: 0 })
    expect(f.arrivals_so_far).toBe(20)
    expect(f.arrivals_expected).toBe(10)
    expect(f.completions_expected).toBe(10)
    expect(f.behind).toBe(true)
    expect(f.by_hour[9]).toMatchObject({
      arrivals: 20,
      expected_arrivals: 10,
      expected_completions: 10
    })
    expect(assembleForecast({ today, past: [], hour: 10, fraction: 0 }).behind).toBe(false)
  })
  it('local hours follow the time zone, including across DST', () => {
    // 2026-03-08 is the US spring-forward day: local midnight is 05:00 UTC.
    const mid = zonedMidnightUtc('2026-03-08', 'America/New_York')
    expect(new Date(mid).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(localParts(Date.UTC(2026, 9, 30, 13, 30), 'America/New_York')).toMatchObject({
      ymd: '2026-10-30',
      hour: 9,
      minute: 30
    })
    const b = bucketByLocalHour(
      [Date.UTC(2026, 9, 30, 13), Date.UTC(2026, 9, 31, 13)],
      '2026-10-30',
      'America/New_York'
    )
    expect(b[9]).toBe(1)
    expect(b.reduce((a, x) => a + x, 0)).toBe(1)
  })

  it('buckets several days in one pass, quickly enough for 100k instants', () => {
    const days = bucketDaysByLocalHour(
      [Date.UTC(2026, 9, 30, 13), Date.UTC(2026, 9, 23, 14), Date.UTC(2026, 9, 1, 0)],
      ['2026-10-30', '2026-10-23'],
      'America/New_York'
    )
    expect(days.get('2026-10-30')?.[9]).toBe(1)
    expect(days.get('2026-10-23')?.[10]).toBe(1)
    const many = Array.from({ length: 100_000 }, (_, i) => Date.UTC(2026, 9, 30) + i * 1000)
    const t0 = performance.now()
    bucketDaysByLocalHour(many, ['2026-10-30'], 'America/New_York')
    // A new Intl formatter per instant took tens of seconds here.
    expect(performance.now() - t0).toBeLessThan(4000)
  })
})

describe('attention ranking', () => {
  it('severity first, then oldest, then larger count', () => {
    const ranked = rankAttention([
      { id: 'a', severity: 'warning' as const, since: '2026-10-01T00:00:00Z', count: 1 },
      { id: 'b', severity: 'critical' as const, since: '2026-10-20T00:00:00Z', count: 1 },
      { id: 'c', severity: 'critical' as const, since: '2026-10-10T00:00:00Z', count: 1 },
      { id: 'd', severity: 'info' as const, since: null, count: 9 },
      { id: 'e', severity: 'warning' as const, since: null, count: 5 },
      { id: 'f', severity: 'warning' as const, since: null, count: 7 }
    ])
    expect(ranked.map((r) => r.id)).toEqual(['c', 'b', 'a', 'f', 'e', 'd'])
  })
})

describe('workload status', () => {
  it('over / normal / idle', () => {
    expect(workloadStatus(15, 8)).toBe('over')
    expect(workloadStatus(4, 2)).toBe('normal') // 2× but only 2 more
    expect(workloadStatus(0, 5)).toBe('idle')
    expect(workloadStatus(0, 0)).toBe('normal')
  })
  it('usual = own median with enough history, else the team median; narrowed counts scale it', () => {
    const rows = assembleWorkload([
      { id: 'a', name: 'A', open: 20, fullOpen: 20, out: false, history: [10, 10, 10, 10, 10] },
      { id: 'b', name: 'B', open: 2, fullOpen: 4, out: true, history: [] },
      { id: 'c', name: 'C', open: 6, fullOpen: 6, out: false, history: [6] }
    ])
    expect(rows[0]).toMatchObject({ usual: 10, status: 'over', usual_source: 'history' })
    // Team median of full counts (20, 4, 6) = 6, seen at half → 3.
    expect(rows[1]).toMatchObject({ usual: 3, open: 2, out: true, usual_source: 'team' })
    expect(rows[2]).toMatchObject({ usual: 6, status: 'normal', usual_source: 'team' })
  })
})

describe('nudge', () => {
  const deps = (over: Partial<NudgeDeps> = {}): NudgeDeps & { sent: string[] } => {
    const sent: string[] = []
    return {
      sent,
      store: memoryNudgeStore(),
      canSee: async () => true,
      owners: async () => [
        { id: 'O-1', name: 'Olu' },
        { id: 'u-1', name: 'Pat (me)' }
      ],
      label: async () => 'WO-42',
      notify: async (id) => {
        sent.push(id)
      },
      log: async () => undefined,
      ...over
    }
  }
  const body = { collection: 'work_orders', item: '42', message: 'Any news?' }

  it('notifies the owners except the sender, then refuses a second nudge inside 30 minutes', async () => {
    const d = deps()
    const first = await runNudge(user, false, body, d)
    expect(first.status).toBe(200)
    expect(d.sent).toEqual(['O-1'])
    const second = await runNudge(user, false, body, d)
    expect(second.status).toBe(429)
    expect((second.body as { retry_after_s: number }).retry_after_s).toBeGreaterThan(29 * 60)
    expect(d.sent).toEqual(['O-1'])
  })

  it('the window is per person + record and ends after 30 minutes', async () => {
    let now = 0
    const store = memoryNudgeStore(() => now)
    const d = deps({ store })
    expect((await runNudge(user, false, body, d)).status).toBe(200)
    expect((await runNudge(user, false, { ...body, item: '43' }, d)).status).toBe(200)
    now = 31 * 60_000
    expect((await runNudge(user, false, body, d)).status).toBe(200)
  })

  it('a record the caller cannot open is a 404 and nobody is told', async () => {
    const d = deps({ canSee: async () => false })
    const r = await runNudge(user, false, body, d)
    expect(r.status).toBe(404)
    expect(d.sent).toEqual([])
  })

  it('no other owner → 409 and the window is not used up', async () => {
    let owners = [{ id: 'U-1', name: 'me' }]
    const d = deps({ owners: async () => owners })
    expect((await runNudge(user, false, body, d)).status).toBe(409)
    owners = [{ id: 'O-2', name: 'Kim' }]
    expect((await runNudge(user, false, body, d)).status).toBe(200)
  })

  it('refuses system tables and malformed ids', async () => {
    expect(
      (await runNudge(user, true, { collection: 'nivaro_users', item: '1' }, deps())).status
    ).toBe(400)
    expect((await runNudge(user, true, { collection: 'x', item: "1'; drop" }, deps())).status).toBe(
      400
    )
  })
})

describe('region lens', () => {
  beforeEach(() => regionSets.clear())

  it('narrows to the region set, case-insensitively; null = does not apply', () => {
    const rows = [{ id: 'a1' }, { id: 'B2' }, { id: 'c3' }]
    expect(narrowToRegion(rows, (r) => r.id, new Set(['A1', 'b2']))).toEqual({
      rows: [{ id: 'a1' }, { id: 'B2' }],
      applies: true
    })
    expect(narrowToRegion(rows, (r) => r.id, null)).toEqual({ rows, applies: false })
  })

  const now = Date.UTC(2026, 9, 30, 12)
  const inst = (item: string, state: string, ageDays: number): OpenInstance => ({
    instance_id: `i-${item}`,
    collection: 'work_orders',
    template: 'T1',
    item,
    state_id: state,
    started_at: now - ageDays * DAY_MS,
    entered_at: now - ageDays * DAY_MS,
    sla: null,
    sla_remaining_h: null
  })
  const index: OpenWorkIndex = {
    as_of: now,
    live: true,
    truncated: false,
    bindings: [{ collection: 'work_orders', template: 'T1', template_name: 'Work orders' }],
    states: new Map([
      [
        'S1',
        {
          id: 'S1',
          template: 'T1',
          key: 'review',
          label: 'Review',
          color: null,
          sort: 1,
          is_terminal: false
        }
      ],
      [
        'S2',
        {
          id: 'S2',
          template: 'T1',
          key: 'done',
          label: 'Done',
          color: null,
          sort: 2,
          is_terminal: true
        }
      ]
    ]),
    open: [inst('1', 'S1', 1), inst('2', 'S1', 9), inst('3', 'S1', 20)],
    recent: [
      {
        collection: 'work_orders',
        template: 'T1',
        item: '1',
        started_at: now - DAY_MS,
        completed_at: null
      },
      {
        collection: 'work_orders',
        template: 'T1',
        item: '9',
        started_at: now - 30 * DAY_MS,
        completed_at: now - 2 * DAY_MS
      },
      {
        collection: 'work_orders',
        template: 'T1',
        item: '8',
        started_at: now - 30 * DAY_MS,
        completed_at: now - 3 * DAY_MS
      }
    ]
  }

  it('flow without a region: every open record, ages, stuck, clears in', async () => {
    const [f] = await computeFlow(new Viewer(user, true, null), index, { stuckDays: 7 })
    expect(f.open).toBe(3)
    expect(f.states.map((s) => s.key)).toEqual(['review']) // empty terminal state left out
    expect(f.states[0]).toMatchObject({ count: 3, stuck: 2, oldest_age_s: 20 * 86_400 })
    expect(f.completed_7d).toBe(2)
    expect(f.wip_7d_delta).toBe(1 - 2)
    expect(f.clears_in_days).toBe(10.5)
    expect(f.region_applies).toBeUndefined()
  })

  it('flow with a region the collection can be placed in: narrowed, region_applies true', async () => {
    regionSets.set('work_orders', new Set(['3']))
    const [f] = await computeFlow(new Viewer(user, true, 'R1'), index, { stuckDays: 7 })
    expect(f.open).toBe(1)
    expect(f.states[0]).toMatchObject({ count: 1, stuck: 1 })
    expect(f.region_applies).toBe(true)
  })

  it('flow with a region that cannot place the collection: everywhere, region_applies false', async () => {
    const [f] = await computeFlow(new Viewer(user, true, 'R1'), index, { stuckDays: 7 })
    expect(f.open).toBe(3)
    expect(f.region_applies).toBe(false)
  })
})
