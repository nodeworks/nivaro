import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: async () => [] }) }))

import {
  extractJson,
  parseAnalysis,
  repairJson,
  shrinkOldResults
} from '../../../services/ops-report/agent.js'
import {
  deadlockSides,
  percentileFromBuckets,
  scoreDigest,
  stripParamList
} from '../../../services/ops-report/digest.js'
import { routeOf } from '../../../services/ops-report/digest-route.js'
import { minuteOf } from '../../../services/ops-report/drill.js'
import { compareKpis } from '../../../services/ops-report/kpis.js'
import { emailOptedIn, verdictFromScore } from '../../../services/ops-report/run.js'
import {
  mergeOpsReportPatch,
  normalizeOpsReportSettings,
  OPS_REPORT_DEFAULTS,
  OpsReportSettingsError
} from '../../../services/ops-report/settings.js'
import { bugSignals, trackBugs } from '../../../services/ops-report/tracker.js'
import type { OpsDigest } from '../../../services/ops-report/types.js'
import { OPS_KPI_META } from '../../../services/ops-report/types.js'
import { dayIn, reportWindow, zonedInstant } from '../../../services/ops-report/window.js'

describe('report window', () => {
  it('cuts 7 AM–8 PM in the instance zone, across a DST change', () => {
    const w = reportWindow('2026-11-10', 7, 20, 'America/New_York')
    expect(w.start.toISOString()).toBe('2026-11-10T12:00:00.000Z')
    expect(w.end.toISOString()).toBe('2026-11-11T01:00:00.000Z')
    expect(zonedInstant('2026-07-10', 7, 'America/New_York').toISOString()).toBe(
      '2026-07-10T11:00:00.000Z'
    )
    expect(dayIn(new Date('2026-11-11T01:30:00Z'), 'America/New_York')).toBe('2026-11-10')
  })

  it('reads a clock label back into the window day', () => {
    const w = { ...reportWindow('2026-11-10', 7, 20, 'America/New_York'), day: '2026-11-10' }
    expect(minuteOf(w, '4:00 PM')?.toISOString()).toBe('2026-11-10T21:00:00.000Z')
    expect(minuteOf(w, '11:42 AM')?.toISOString()).toBe('2026-11-10T16:42:00.000Z')
    expect(minuteOf(w, 'later')).toBeNull()
  })
})

describe('digest helpers', () => {
  it('folds ids, uuids and record keys out of a route', () => {
    expect(routeOf('/api/items/workflows/372866')).toBe('/api/items/workflows/:id')
    expect(routeOf('/api/files/DB6B0A83-9147-4778-8E00-EA867BD65783?x=1')).toBe('/api/files/:uuid')
    expect(routeOf('/records/workflows/HQ26-81336')).toBe('/records/workflows/:key')
  })

  it('reads a percentile from latency buckets', () => {
    // 10 in <10 ms, 80 in <25, 10 in <50
    const counts = [10, 80, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    expect(percentileFromBuckets(counts, 100, 0.5)).toBe(25)
    expect(percentileFromBuckets(counts, 100, 0.95)).toBe(50)
    expect(percentileFromBuckets([], 0, 0.5)).toBeNull()
  })

  it('drops an sp_executesql parameter list and reads both deadlock sides', () => {
    expect(stripParamList('(@p0 nvarchar(36), @p1 int)select 1')).toBe('select 1')
    const xml =
      '<victim-list><victimProcess id="a"/></victim-list><process id="a" x="1"><inputbuf>(@p0 int)select [user] from t</inputbuf></process><process id="b"><inputbuf>insert into t values (1)</inputbuf></process>'
    expect(deadlockSides(xml)).toEqual({
      victim: 'select [user] from t',
      other: 'insert into t values (1)'
    })
  })
})

function digest(over: Partial<OpsDigest> = {}): OpsDigest {
  const base = {
    errors: { server: [], server_total: 0, drain_503: 0, client_by_route: [], signed_out_401: 0 },
    database: { deadlocks: [], timeouts: [], freezes: [] },
    speed: {
      avg_ms: 0,
      p50: 10,
      p90: 50,
      p95: 100,
      p99: 300,
      over1s: 0,
      over5s: 0,
      over30s: 0,
      slow_routes: [],
      heavy_routes: [],
      bursts: []
    },
    traffic: { requests: 100_000, page_views: 0, peak: null, by_hour: [] },
    integrations: { submissions: [], failures: [], calls: [], open_alarms: [], alerts: [] },
    jobs: { runs: 0, failed: [], slowest: [] },
    people: {
      active: 0,
      signed_in_today: 0,
      sign_ins: 0,
      carried_sessions: 0,
      first_time: 0,
      view_as_sessions: 0,
      trouble: [],
      machine_callers: [],
      by_role: [],
      explain: []
    },
    client_errors: [],
    deploys: []
  }
  return { ...base, ...over } as unknown as OpsDigest
}

describe('health score', () => {
  it('starts at 100 and names what took points off', () => {
    expect(scoreDigest(digest()).value).toBe(100)
    const s = scoreDigest(
      digest({
        errors: {
          server: [],
          server_total: 6,
          drain_503: 80,
          client_by_route: [],
          signed_out_401: 0
        },
        database: { deadlocks: [1, 2] as never, timeouts: [], freezes: [] }
      })
    )
    expect(s.value).toBe(100 - 12 - 5)
    expect(s.parts[0]).toEqual({ label: '6 server errors', points: 12 })
    expect(verdictFromScore(90)).toBe('healthy')
    expect(verdictFromScore(70)).toBe('watch')
    expect(verdictFromScore(40)).toBe('bad')
  })
})

describe('bug tracker', () => {
  const d = digest({
    errors: {
      server: [
        {
          at: '11:54 AM',
          route: 'GET /api/lineage/:id',
          path: '/api/lineage/1',
          status: 500,
          ms: 10,
          person: 'A'
        }
      ],
      server_total: 1,
      drain_503: 0,
      client_by_route: [
        { status: 400, route: 'GET /api/items/workflows', n: 21, people: 3, message: 'cursor' },
        { status: 401, route: 'GET /api/auth/me', n: 300, people: 0, message: 'signed out' },
        { status: 404, route: 'GET /api/items/x/:id', n: 4, people: 1, message: 'Not found' }
      ],
      signed_out_401: 300
    }
  })

  it('turns signals into stable keys and ignores signed-out noise', () => {
    const keys = bugSignals(d).map((s) => s.key)
    expect(keys).toContain('500:GET /api/lineage/:id')
    expect(keys).toContain('400:GET /api/items/workflows')
    expect(keys.some((k) => k.startsWith('401'))).toBe(false)
    expect(keys.some((k) => k.startsWith('404'))).toBe(false)
  })

  it('carries a bug across days: new → open → fixed in the deployed version → came back', () => {
    const day1 = trackBugs('2026-11-10', bugSignals(d), [], [])
    expect(day1.every((b) => b.status === 'new')).toBe(true)
    const day2 = trackBugs('2026-11-11', bugSignals(d), day1, [])
    expect(day2.find((b) => b.key.startsWith('500'))?.status).toBe('open')
    expect(day2.find((b) => b.key.startsWith('500'))?.days_seen).toBe(2)
    const day3 = trackBugs('2026-11-12', [], day2, [{ version: '0.3.130' }])
    expect(day3.find((b) => b.key.startsWith('500'))).toMatchObject({
      status: 'fixed',
      fixed_in: '0.3.130'
    })
    const day4 = trackBugs('2026-11-13', bugSignals(d), day3, [])
    expect(day4.find((b) => b.key.startsWith('500'))?.status).toBe('came_back')
  })

  it('a quiet bug with no deploy reads fixed only after 3 quiet days', () => {
    const day1 = trackBugs('2026-11-10', bugSignals(d), [], [])
    expect(trackBugs('2026-11-11', [], day1, []).find((b) => b.key.startsWith('500'))?.status).toBe(
      'open'
    )
    expect(trackBugs('2026-11-13', [], day1, []).find((b) => b.key.startsWith('500'))?.status).toBe(
      'fixed'
    )
  })
})

describe('comparison', () => {
  it('colours by which way is good, never by up or down', () => {
    const c = compareKpis(
      { server_errors: 2, requests: 900 },
      [{ day: '2026-11-09', kpis: { server_errors: 6, requests: 1000 } }],
      OPS_KPI_META
    )
    expect(c.prev_day).toBe('2026-11-09')
    expect(c.deltas.find((x) => x.key === 'server_errors')).toMatchObject({
      good: true,
      change_pct: -66.7
    })
    expect(c.deltas.find((x) => x.key === 'requests')?.good).toBeNull()
  })
})

describe('settings', () => {
  it('defaults off with the 6 AM–11 PM window', () => {
    expect(normalizeOpsReportSettings(null)).toEqual(OPS_REPORT_DEFAULTS)
    expect(OPS_REPORT_DEFAULTS).toMatchObject({
      enabled: false,
      window_start_hour: 6,
      window_end_hour: 23
    })
  })

  it('names every bad field', () => {
    try {
      mergeOpsReportPatch(OPS_REPORT_DEFAULTS, { window_end_hour: 5, token_cap: 1, nope: 1 })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(OpsReportSettingsError)
      expect(Object.keys((err as OpsReportSettingsError).fields).sort()).toEqual([
        'nope',
        'token_cap',
        'window_end_hour'
      ])
    }
    expect(
      mergeOpsReportPatch(OPS_REPORT_DEFAULTS, { enabled: true, window_end_hour: 21 })
    ).toMatchObject({ enabled: true, window_end_hour: 21 })
  })

  it('saves a form that sends back the GET answer whole (email_me is read-only, not refused)', () => {
    const next = mergeOpsReportPatch(OPS_REPORT_DEFAULTS, {
      ...OPS_REPORT_DEFAULTS,
      window_start_hour: 5,
      email_me: true
    })
    expect(next.window_start_hour).toBe(5)
    expect(next).not.toHaveProperty('email_me')
  })

  it('emails only administrators who opted in', () => {
    expect(emailOptedIn('{"ops_report_email":true}')).toBe(true)
    expect(emailOptedIn({ ops_report_email: true })).toBe(true)
    expect(emailOptedIn(null)).toBe(false)
    expect(emailOptedIn('{}')).toBe(false)
  })
})

describe('reading the AI answer', () => {
  const ok = {
    verdict: 'watch',
    score: 49,
    headline: 'h',
    summary_md: 's',
    incidents: [],
    people_to_contact: [],
    watch_tomorrow: []
  }

  it('reads a fenced answer after some prose', () => {
    expect(parseAnalysis(`Done.\n\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``)?.verdict).toBe('watch')
  })

  it('repairs stray quotes inside a value', () => {
    const broken =
      '{"verdict":"watch","score":49,"headline":"the "who is online" query","summary_md":"x","incidents":[],"people_to_contact":[],"watch_tomorrow":[]}'
    expect((repairJson(broken) as { headline: string }).headline).toBe('the "who is online" query')
    expect(parseAnalysis(broken)?.headline).toBe('the "who is online" query')
    expect(extractJson('nothing here')).toBeNull()
  })

  it('shrinks results the model already read, keeping the data envelope closed', () => {
    const big = `<data source="x">\n${'y'.repeat(5000)}\n</data>`
    const turn = () => ({
      role: 'user' as const,
      content: [{ type: 'tool_result' as const, tool_use_id: 't', content: big }]
    })
    const convo = [turn(), turn(), turn()]
    shrinkOldResults(convo)
    const first = (convo[0].content[0] as { content: string }).content
    expect(first.length).toBeLessThan(1400)
    expect(first.endsWith('</data>')).toBe(true)
    expect((convo[2].content[0] as { content: string }).content).toBe(big)
  })
})
