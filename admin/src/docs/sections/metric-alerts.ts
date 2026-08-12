import type { DocSection } from '../types'

export const metricAlertsGuide: DocSection = {
  id: 'metric-alerts-guide',
  label: 'Alert Manager (Metric Alerts)',
  content: [
    { type: 'h1', id: 'metric-alerts-guide', text: 'Alert Manager — Metric Alerts & Anomaly Detection' },
    {
      type: 'p',
      text: 'The Alert Manager (Monitoring → Alert Manager) is a metric-level alert engine: admins publish a catalog of metric definitions, any user creates threshold rules against them, subscribes for delivery, and the engine maintains a firing/resolved state per rule. It is separate from the per-record Alert & Threshold Engine.'
    },
    { type: 'h2', id: 'metric-alerts-concepts', text: 'Concepts' },
    {
      type: 'table',
      head: ['Object', 'Purpose'],
      rows: [
        [
          'Metric definition',
          'Admin-authored catalog entry. Backed by a custom query (slug + value column, filters map to query params) or a collection row count. Carries unit, default operator/threshold and the filter pickers rules may scope by.'
        ],
        [
          'Alert rule',
          'User-created: operator (gt/gte/lt/lte/eq/% change) + threshold + check frequency (hourly/daily/weekly) + optional filter scope. Private or shared with the team.'
        ],
        [
          'Subscription',
          'Per-user delivery: in-app and/or email, immediate or bundled into a daily/weekly digest. The rule creator is auto-subscribed.'
        ],
        [
          'Alert log',
          'One open "firing" row per rule is the state machine — it fires once, resolves when the metric returns in range, then can fire again.'
        ],
        [
          'Anomaly rules',
          'Statistical detection over a row source query: amount outliers (z-score), period spikes (30d vs prior year) and duplicate patterns, with low/medium/high sensitivity, optional Claude explanations, and an acknowledge/resolve triage log.'
        ]
      ]
    },
    { type: 'h2', id: 'metric-alerts-scheduling', text: 'Scheduling' },
    {
      type: 'ul',
      items: [
        'Rule checks: hourly at :05, daily 06:35, weekly Monday 06:35 (per rule check_frequency). Immediate subscribers are notified inside the check pass.',
        'Digests: daily 08:00 and weekly Monday 08:00 — one bundled notification per user covering firings since their last notification.',
        'Anomaly detection: daily 03:00, weekly Monday 03:20.',
        'Manual runs (admin): POST /api/metric-alerts/run { frequency }, /run-digest, /anomaly-run.'
      ]
    },
    { type: 'h2', id: 'metric-alerts-api', text: 'REST API' },
    {
      type: 'table',
      head: ['Endpoint', 'Description'],
      rows: [
        ['GET /api/metric-alerts/definitions', 'Metric catalog (active). Admin ?all=1 includes inactive; admin POST/PATCH/DELETE manage it.'],
        ['GET|POST /api/metric-alerts/rules', 'Shared rules + your own; create auto-subscribes you. PATCH/DELETE /rules/:id (owner or admin).'],
        ['GET|POST /api/metric-alerts/subscriptions', 'Your subscriptions; PATCH/DELETE /subscriptions/:id toggles delivery/digest.'],
        ['GET /api/metric-alerts/log', 'Firing/resolved history for rules you can see.'],
        ['GET /api/metric-alerts/anomaly-definitions', 'Anomaly catalog incl. scope pickers + sensitivity hints (admin CRUD).'],
        ['GET|POST /api/metric-alerts/anomaly-rules', 'Anomaly rules; PATCH/DELETE /anomaly-rules/:id (owner or admin).'],
        ['GET /api/metric-alerts/anomaly-log', 'Detections; PATCH /anomaly-log/:id { status: acknowledged | resolved }.'],
        ['GET /api/metric-alerts/report-alerts', 'Report-widget alerts across reports you can read (+ /report-alerts-log).']
      ]
    },
    {
      type: 'note',
      text: 'Frontends embed the full surface via the AlertManagerView component exported from @nivaro/react (requires NivaroProvider + QueryClientProvider).'
    }
  ]
}
