import type {
  OpsDelta,
  OpsDrill,
  OpsDrillMetric,
  OpsKpis,
  OpsReport,
  OpsReportListRow,
  OpsTrendPoint,
  OpsVerdict
} from '../../lib/ops-report-types'
import { OPS_KPI_META } from '../../lib/ops-report-types'
import type { OpsReportSettings } from './format'

/** Tonight's real prod day, shaped exactly like the contract — for tests and design checks. */
export const FIXTURE_KPIS: OpsKpis = {
  active_people: 205,
  signed_in_today: 125,
  sign_ins: 131,
  carried_sessions: 80,
  new_accounts: 2,
  view_as_sessions: 3,
  requests: 672_400,
  page_views: 41_880,
  avg_ms: 61,
  p95_ms: 250,
  p99_ms: 1180,
  over5s: 212,
  server_errors: 6,
  client_errors: 3_904,
  deadlocks: 4,
  deploys: 15,
  job_failures: 2,
  integration_failures: 5,
  integration_calls_failed: 14,
  open_alarms: 1,
  mail_sent: 388,
  mail_failed: 3,
  mail_deferred: 0,
  moves: 1_204,
  creates: 612,
  searches: 2_870,
  search_zero: 141,
  backlog_waiting: 934,
  trouble_people: 9,
  new_places: 4,
  failed_sign_ins: 7,
  open_bugs: 3,
  health_score: 78,
  pages_viewed: 41_880,
  browser_errors: 37,
  support_opened: 4,
  support_open: 11,
  ai_calls: 612,
  ai_cost_usd: 18.4,
  data_violations: 233,
  'business.requested_usd': 1_820_000
}

const META = OPS_KPI_META

function deltas(): OpsDelta[] {
  return META.filter((m) => FIXTURE_KPIS[m.key] != null).map((m) => {
    const today = FIXTURE_KPIS[m.key] as number
    const prev = Math.round(today * (m.key === 'server_errors' ? 0.5 : 0.92))
    const week = Math.round(today * 1.04)
    const pct = prev === 0 ? null : ((today - prev) / prev) * 100
    const good =
      m.better == null || today === prev ? null : m.better === 'down' ? today < prev : today > prev
    return {
      key: m.key,
      label: m.label,
      unit: m.unit,
      today,
      prev,
      week_avg: week,
      change_pct: pct,
      good
    }
  })
}

const WINDOW = {
  day: '2026-11-09',
  start: '2026-11-09T07:00:00-05:00',
  end: '2026-11-09T20:00:00-05:00',
  tz: 'America/New_York',
  label: '7:00 AM – 8:00 PM Eastern'
}

const hours = Array.from({ length: 13 }, (_, i) => {
  const hour = 7 + i
  const shape = [0.4, 0.8, 1, 0.95, 0.9, 0.7, 0.85, 1, 0.9, 0.75, 0.6, 0.4, 0.2][i] as number
  return {
    hour,
    requests: Math.round(78_000 * shape),
    people: Math.round(120 * shape),
    e5: hour === 14 ? 4 : hour === 16 ? 2 : 0,
    e4: Math.round(400 * shape),
    avg_ms: hour === 12 || hour === 16 ? 140 : 52,
    over5s: hour === 12 || hour === 16 ? 90 : 4
  }
})

export const FIXTURE_REPORT: OpsReport = {
  id: 41,
  day: '2026-11-09',
  status: 'ready',
  verdict: 'watch',
  score: 74,
  headline: 'Healthy traffic, but the PUB budget widget stalled twice and 15 deploys drained users',
  trigger: 'cron',
  created_at: '2026-11-09T20:05:00-05:00',
  finished_at: '2026-11-09T20:08:41-05:00',
  model: 'claude-sonnet-5-5',
  tokens_in: 188_400,
  tokens_out: 6_210,
  cost_usd: 0.66,
  kpis: FIXTURE_KPIS,
  window: WINDOW,
  digest: {
    version: 2,
    window: WINDOW,
    people: {
      active: 205,
      signed_in_today: 125,
      sign_ins: 131,
      carried_sessions: 80,
      first_time: 2,
      view_as_sessions: 3,
      trouble: [
        { person: 'Dana Whitfield', errors: 3, slow: 11, blocked: 0 },
        { person: 'Marcus Oyelaran', errors: 1, slow: 7, blocked: 2 }
      ],
      machine_callers: [
        { name: 'MWF sender', requests: 9_840, errors: 0 },
        { name: 'MDSi sync', requests: 4_120, errors: 12 }
      ],
      by_role: [
        { role: 'Project Manager', people: 71 },
        { role: 'Approver', people: 48 },
        { role: 'Administrator', people: 6 }
      ],
      explain: [
        '205 people did something today. That is not the same as signing in: only 125 of them signed in through Microsoft today (131 sign-ins, some more than once).',
        '80 people were already signed in from an earlier day and never needed to sign in again.'
      ]
    },
    traffic: {
      requests: 672_400,
      page_views: 41_880,
      peak: { hour: 9, requests: 78_000, people: 120 },
      by_hour: hours
    },
    speed: {
      avg_ms: 61,
      p50: 22,
      p90: 118,
      p95: 250,
      p99: 1180,
      over1s: 3_400,
      over5s: 212,
      over30s: 9,
      slow_routes: [
        {
          route: 'GET /api/dashboards/widgets/:id',
          n: 188,
          avg_ms: 14_200,
          max_ms: 57_000,
          people: 41
        },
        { route: 'POST /api/items/:c/batch-read', n: 31, avg_ms: 6_100, max_ms: 11_800, people: 12 }
      ],
      heavy_routes: [
        { route: 'GET /api/items/:c', total_s: 8_120, n: 301_000, avg_ms: 27 },
        { route: 'GET /api/dashboards/widgets/:id', total_s: 2_670, n: 188, avg_ms: 14_200 }
      ],
      bursts: [
        { at: '12:00 PM', route: 'PUB budget health widget', n: 74, people: 38, max_ms: 57_000 },
        { at: '4:00 PM', route: 'PUB budget health widget', n: 61, people: 33, max_ms: 30_400 }
      ]
    },
    errors: {
      server: [
        {
          at: '2:09 PM',
          route: 'POST /api/items/:c',
          path: '/api/items/invoices',
          status: 500,
          ms: 842,
          person: 'Dana Whitfield'
        },
        {
          at: '2:10 PM',
          route: 'POST /api/items/:c',
          path: '/api/items/invoices',
          status: 500,
          ms: 790,
          person: null
        }
      ],
      server_total: 6,
      drain_503: 80,
      client_by_route: [
        {
          status: 403,
          route: 'GET /api/items/:c/:id',
          n: 1_210,
          people: 14,
          message: 'You do not have access to this record'
        },
        { status: 401, route: 'GET /api/auth/me', n: 988, people: 61, message: 'Signed out' }
      ],
      signed_out_401: 988
    },
    deploys: Array.from({ length: 15 }, (_, i) => ({
      at: `${8 + Math.floor(i / 2)}:${i % 2 ? '40' : '05'} ${8 + Math.floor(i / 2) < 12 ? 'AM' : 'PM'}`,
      version: `0.3.${129 + Math.floor(i / 3)}`,
      release: i % 3 === 0 ? 'release' : null
    })),
    drains: [
      { at: '10:05 AM', n: 22 },
      { at: '1:40 PM', n: 31 },
      { at: '3:05 PM', n: 27 }
    ],
    database: {
      deadlocks: [
        {
          issue: 4410,
          at: '11:12 AM',
          victim: 'UPDATE nivaro_workflow_instances',
          other: 'efp_record_state trigger'
        },
        { issue: 4411, at: '1:48 PM', victim: 'UPDATE forecasts', other: 'rollup recalc' }
      ],
      timeouts: [{ issue: 4415, title: 'Expensive report query timed out at 15 s' }],
      freezes: []
    },
    issues: {
      new: [
        {
          id: 4410,
          source: 'database',
          severity: 'high',
          title: 'Deadlock on workflow instances',
          count: 3
        }
      ],
      repeating: [{ id: 4301, title: 'Presence ping retry', count: 41 }]
    },
    jobs: {
      runs: 318,
      failed: [
        { job: 'fusion-sync', at: '6:00 AM', status: 'failed', error: 'Partner refused the call' }
      ],
      slowest: [{ job: 'cache-warm', n: 1, max_ms: 212_000, avg_ms: 212_000 }]
    },
    integrations: {
      submissions: [
        { api: 'MWF', status: 'accepted', n: 519 },
        { api: 'MDSi', status: 'accepted', n: 112 },
        { api: 'MDSi', status: 'failed', n: 5 }
      ],
      failures: [
        {
          at: '10:42 AM',
          api: 'MDSi',
          collection: 'inventory_requests',
          item: 'IR-20418',
          error: 'Partner answered ERROR: unknown site'
        }
      ],
      calls: [
        { api: 'MDSi', n: 1_840, failed: 12, avg_ms: 12_000, max_ms: 41_000, week_avg_ms: 8_400 },
        { api: 'MWF', n: 519, failed: 2, avg_ms: 640, max_ms: 3_100, week_avg_ms: 610 }
      ],
      open_alarms: [{ api: 'MDSi', kind: 'slow', outcome: 'open', n: 1 }],
      alerts: [
        { title: 'MDSi response time high', status: 'open', started: '11:00 AM', ended: null }
      ]
    },
    imports: [{ definition: 'po-import', status: 'done', runs: 6, rows: 4_120 }],
    mail: {
      by_status: [
        { status: 'sent', n: 388 },
        { status: 'failed', n: 3 }
      ],
      reasons: [{ reason: 'Mailbox full', n: 3 }]
    },
    notifications: [{ category: 'approvals', n: 412, recipients: 96, read: 301 }],
    work: {
      moves: 1_204,
      movers: 88,
      by_state: [
        { state: 'Approved', n: 410 },
        { state: 'Sent back', n: 37 }
      ],
      creates: [{ collection: 'invoices', n: 301, people: 22 }],
      backlog: [{ state: 'Needs approval', waiting: 540, oldest_days: 12 }],
      sla_breaches: [{ rule: 'Approve within 3 days', collection: 'po_requests', breached: 19 }]
    },
    search: {
      n: 2_870,
      people: 130,
      zero: 141,
      avg_ms: 180,
      missed: [{ query: 'frame agreement', n: 9 }]
    },
    config_changes: [
      {
        at: '9:15 AM',
        who: 'Rob Lee',
        action: 'update',
        collection: 'nivaro_collection_layouts',
        item: '25'
      }
    ],
    security: {
      new_places: 4,
      failed_sign_ins: 7,
      view_as: [{ who: 'Rob Lee', at: '1:02 PM' }],
      role_changes: [],
      api_key_use: [{ name: 'claude-code staging', requests: 214 }],
      access_grants: 2,
      access_requests: 3,
      waiting_authorization: 5
    },
    capacity: {
      pool: { main_max: 60, background_max: 10 },
      backups: {
        last_full: '2:00 AM',
        last_full_age_hours: 18,
        last_log: '8:15 PM',
        last_log_age_hours: 0.2
      },
      restarts: [{ at: '10:05 AM', what: 'nivaro web 2 (deploy)' }],
      memory_mb: 1_420,
      disk: [{ path: '/uploads', free_pct: 41, free_gb: 380 }]
    },
    watch: {
      jobs_next: [{ job: 'retention-policy-1', at: '4:45 AM', heavy: true }],
      pending_sends: [{ api: 'MDSi', n: 5, oldest: '10:42 AM' }],
      expiring: [{ what: 'certificate', name: 'efp TLS', expires: 'Nov 29', days: 19 }]
    },
    pages: {
      views: 41_880,
      people: 198,
      top: [
        { page: '/my-work', views: 6_120, people: 170, avg_seconds: 48, week_avg_views: 5_800 },
        {
          page: '/collections/invoices',
          views: 3_010,
          people: 61,
          avg_seconds: 95,
          week_avg_views: 2_700
        }
      ]
    },
    client_errors: [
      {
        id: 5120,
        title: 'Cannot read properties of undefined (reading zone)',
        count: 22,
        screen: '/collections/projects',
        first_today: true
      },
      {
        id: 4980,
        title: 'ResizeObserver loop limit exceeded',
        count: 15,
        screen: null,
        first_today: false
      }
    ],
    adoption: {
      new_routes: [{ route: 'GET /api/ops-reports', n: 12, people: 2 }],
      rising: [{ route: 'POST /api/ai/ask', today: 210, week_avg: 120 }]
    },
    support: {
      opened: 4,
      closed: 6,
      open_total: 11,
      oldest_open_days: 9,
      topics: [{ topic: 'Access', n: 3 }],
      opened_today: [{ title: 'Cannot see my project', status: 'open' }]
    },
    ai: {
      calls: 612,
      cost_usd: 18.4,
      errors: 7,
      refusals: 2,
      thumbs_up: 31,
      thumbs_down: 4,
      by_feature: [{ feature: 'Ask AI', calls: 410, cost_usd: 14.2, errors: 5 }]
    },
    data_quality: [{ collection: 'forecasts', violations: 233, prev: 240, checked: 18_000 }],
    owners: [{ person: 'Priya Nair', waiting: 64, sla_breached: 9, at_risk: 14 }],
    score: {
      value: 78,
      parts: [
        { label: 'Slow dashboard bursts', points: 8 },
        { label: 'Deadlocks', points: 6 },
        { label: 'Deploy drains', points: 4 },
        { label: 'Failed partner sends', points: 4 }
      ]
    },
    sections: [
      {
        key: 'business',
        title: 'Business volume',
        rows: [
          {
            key: 'requested_usd',
            label: 'Requested (USD)',
            value: 1_820_000,
            unit: 'usd',
            week_avg: 1_650_000
          },
          {
            key: 'approved_pos',
            label: 'Approved POs',
            value: 188,
            unit: 'count',
            week_avg: 171,
            note: 'Counted at approval time'
          }
        ]
      }
    ]
  },
  analysis: {
    verdict: 'watch',
    score: 74,
    headline:
      'Healthy traffic, but the PUB budget widget stalled twice and 15 deploys drained users',
    summary_md:
      '## Day in short\n\nThe instance served **672k requests** to **205 active people** with a p95 of 250 ms.\n\n- 6 server errors, all on invoice create at 2:09 PM\n- 80 requests got a 503 while a deploy drained\n- The PUB budget health widget took 30–57 s at noon and 4:00 PM\n\n| Signal | Today | Usual |\n| --- | --- | --- |\n| p95 | 250 ms | 230 ms |\n| Deadlocks | 4 | 1 |',
    incidents: [
      {
        title: 'PUB budget health widget stalls',
        when: '12:00 PM and 4:00 PM',
        severity: 'medium',
        impact: '38 people waited 30–57 s for the dashboard',
        cause: 'The widget recomputes cold when its cache expires on the hour',
        evidence: '74 requests at noon, max 57 s; 61 at 4:00 PM, max 30 s'
      },
      {
        title: 'Deadlocks on workflow instances',
        when: '11:12 AM and 1:48 PM',
        severity: 'high',
        impact: '4 saves failed and were retried',
        cause: 'Trigger on workflow instances competes with the rollup recalc',
        evidence: 'Issues 4410 and 4411'
      }
    ],
    people_to_contact: [
      { person: 'Dana Whitfield', why: 'Hit three invoice errors and 11 slow screens' }
    ],
    watch_tomorrow: [
      'Retention policy runs at 4:45 AM (heavy)',
      'efp TLS certificate expires in 19 days'
    ]
  },
  tracker: [
    {
      key: 'widget-pub-stall',
      title: 'PUB budget widget stalls on the hour',
      kind: 'needs_dev',
      status: 'open',
      first_seen: '2026-11-03',
      last_seen: '2026-11-09',
      days_seen: 5,
      today_count: 135,
      fixed_in: null,
      impact: '38 people wait up to 57 s'
    },
    {
      key: 'mdsi-unknown-site',
      title: 'MDSi refuses unknown site',
      kind: 'partner',
      status: 'new',
      first_seen: '2026-11-09',
      last_seen: '2026-11-09',
      days_seen: 1,
      today_count: 5,
      fixed_in: null,
      impact: null
    },
    {
      key: 'presence-503',
      title: 'Presence ping 503 during drain',
      kind: 'config',
      status: 'fixed',
      first_seen: '2026-11-01',
      last_seen: '2026-11-07',
      days_seen: 7,
      today_count: 0,
      fixed_in: '0.3.128',
      impact: null
    },
    {
      key: 'invoice-500',
      title: 'Invoice create 500',
      kind: 'data_fix',
      status: 'came_back',
      first_seen: '2026-10-28',
      last_seen: '2026-11-09',
      days_seen: 4,
      today_count: 6,
      fixed_in: '0.3.120',
      impact: null
    }
  ],
  comparison: { prev_day: '2026-11-08', week_days: 7, deltas: deltas() },
  kpi_meta: OPS_KPI_META,
  tools: [
    { tool: 'search_activity', ok: true },
    { tool: 'read_issue', ok: true }
  ],
  error: null
}

const VERDICTS: OpsVerdict[] = ['healthy', 'healthy', 'watch', 'healthy', 'bad', 'watch', 'healthy']

/** ~20 days, oldest first, the last one is FIXTURE_REPORT's day. */
export const FIXTURE_TRENDS: OpsTrendPoint[] = Array.from({ length: 20 }, (_, i) => {
  const last = i === 19
  const wave = 1 + Math.sin(i / 2) * 0.08
  const d = new Date(2026, 10, 9 - (19 - i))
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const kpis: OpsKpis = { ...FIXTURE_KPIS }
  if (!last)
    for (const k of Object.keys(FIXTURE_KPIS)) {
      const v = FIXTURE_KPIS[k] as number
      kpis[k] =
        k === 'p95_ms'
          ? Math.round(v * wave)
          : Math.max(0, Math.round(v * wave * (0.85 + ((i * 7) % 5) / 20)))
    }
  const verdict = last ? 'watch' : (VERDICTS[i % VERDICTS.length] as OpsVerdict)
  return { id: 22 + i, day, verdict, score: last ? 74 : 60 + ((i * 11) % 38), kpis }
})

export const FIXTURE_LIST: OpsReportListRow[] = [...FIXTURE_TRENDS].reverse().map((t, i) => ({
  id: t.id,
  day: t.day,
  status: i === 0 ? FIXTURE_REPORT.status : 'ready',
  verdict: t.verdict,
  score: t.score,
  headline: i === 0 ? (FIXTURE_REPORT.headline as string) : `Quiet day ${t.day}`,
  trigger: 'cron',
  created_at: `${t.day}T20:05:00-05:00`,
  finished_at: `${t.day}T20:08:00-05:00`,
  model: 'claude-sonnet-5-5',
  tokens_in: 180_000,
  tokens_out: 6_000,
  cost_usd: 0.62,
  kpis: t.kpis
}))

/** An older, numbers-only report: AI off, most digest blocks missing. */
export const FIXTURE_DIGEST_ONLY = {
  ...FIXTURE_REPORT,
  id: 99,
  day: '2026-11-08',
  status: 'digest_only',
  verdict: null,
  score: null,
  headline: null,
  analysis: null,
  tracker: [],
  model: null,
  tokens_in: null,
  tokens_out: null,
  cost_usd: null,
  error: 'Model gateway refused the call (HTTP 503)',
  digest: {
    version: 1,
    window: { ...WINDOW, day: '2026-11-08' },
    traffic: { requests: 640_000, page_views: 39_000, peak: null, by_hour: [] }
  }
} as unknown as OpsReport

export const FIXTURE_SETTINGS: OpsReportSettings = {
  enabled: true,
  window_start_hour: 6,
  window_end_hour: 23,
  model: null,
  token_cap: 600_000,
  email: true,
  notify: true
}

const col = (
  key: string,
  label: string,
  type?: 'text' | 'number' | 'ms' | 'usd' | 'time' | 'status'
) => ({
  key,
  label,
  type
})

/** What GET /ops-reports/:id/drill answers in tests: a 3-level chain (server errors → route →
 *  one request → its person → another request) plus a record-row list. */
export function fixtureDrill(metric: OpsDrillMetric, key: string | null): OpsDrill {
  const base = { metric, key, total: 0, truncated: false, rows: [], columns: [], description: '' }
  if (metric === 'server_errors')
    return {
      ...base,
      title: 'Server errors',
      description: 'Every 500 in the window, grouped by route.',
      columns: [
        col('route', 'Route'),
        col('n', 'Errors', 'number'),
        col('last', 'Last at', 'time')
      ],
      rows: [
        {
          route: 'POST /api/items/:c',
          n: 6,
          last: '2:10 PM',
          _drill_metric: 'slow_route',
          _drill_key: 'POST /api/items/:c'
        }
      ],
      total: 1
    }
  if (metric === 'slow_route')
    return {
      ...base,
      title: `Requests on ${key}`,
      description: 'The failing requests on this route.',
      columns: [
        col('at', 'At', 'time'),
        col('person', 'Person'),
        col('ms', 'Took', 'ms'),
        col('status', 'Status', 'status')
      ],
      rows: [
        {
          at: '2:09 PM',
          person: 'Dana Whitfield',
          ms: 842,
          status: 'failed 500',
          _drill_metric: 'request',
          _drill_key: 'req-1'
        },
        {
          at: '2:10 PM',
          person: 'Dana Whitfield',
          ms: 790,
          status: 'failed 500',
          _drill_metric: 'request',
          _drill_key: 'req-2'
        }
      ],
      total: 7,
      truncated: true
    }
  if (metric === 'request')
    return {
      ...base,
      title: key === 'req-2' ? 'Request req-2' : 'Request req-1',
      description: 'One request, as the server saw it.',
      columns: [col('what', 'Related'), col('detail', 'Detail')],
      rows: [
        {
          what: 'Dana Whitfield’s day',
          detail: '41 requests, 3 errors',
          _drill_metric: 'person',
          _drill_key: 'Dana Whitfield'
        },
        {
          what: 'Invoice 4410',
          detail: 'the record it wrote',
          _record_collection: 'invoices',
          _record_id: '4410'
        }
      ],
      total: 2,
      detail: {
        fields: [
          { label: 'Route', value: 'POST /api/items/:c' },
          { label: 'Status', value: 500 },
          { label: 'Took', value: '842 ms' },
          { label: 'Issue', value: '#5101', link: '/issues/5101' }
        ],
        blocks: [
          {
            title: 'Error body',
            kind: 'json',
            text: '{"statusCode":500,"message":"Cannot insert duplicate key"}'
          },
          {
            title: 'Stack',
            kind: 'code',
            text: 'Error: Cannot insert duplicate key\n    at createOne (items.ts:211)'
          }
        ]
      }
    }
  if (metric === 'person')
    return {
      ...base,
      title: `${key} — their day`,
      description: 'Their requests in the window.',
      columns: [col('at', 'At', 'time'), col('route', 'Route'), col('status', 'Status', 'status')],
      rows: [
        {
          at: '2:15 PM',
          route: 'POST /api/items/:c',
          status: 'failed 500',
          _drill_metric: 'request',
          _drill_key: 'req-2'
        }
      ],
      total: 1
    }
  if (metric === 'requests')
    return {
      ...base,
      title: 'Requests',
      description: 'Busiest routes today.',
      columns: [col('route', 'Route'), col('n', 'Calls', 'number')],
      rows: [{ route: 'GET /api/items/:c', n: 301_000 }],
      total: 1
    }
  return { ...base, title: `Drill ${metric}`, description: 'Nothing special.' }
}
