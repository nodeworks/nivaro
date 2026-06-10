import type { DocSection } from '../types.js'

export const obsApiAnalytics: DocSection = {
  id: 'api-analytics',
  label: 'API Analytics',
  content: [
    { type: 'h1', id: 'api-analytics', text: 'API Analytics' },
    {
      type: 'p',
      text: 'Every API request is sampled into `nivaro_api_logs`, a ring buffer retaining 14 days of traffic. The /api-analytics page visualises it: request volume timeseries, p50/p95 latency, error rate, and the slowest/most-hit endpoints.'
    },
    {
      type: 'ul',
      items: [
        'Filter by time range, route, method, status class, and user.',
        'p50/p95 are computed over the selected window; the error-rate card breaks down 4xx vs 5xx.',
        'The ring buffer self-prunes — no maintenance required and bounded storage.'
      ]
    }
  ]
}

export const obsHealthDashboard: DocSection = {
  id: 'health-dashboard',
  label: 'Health Dashboard',
  content: [
    { type: 'h1', id: 'health-dashboard', text: 'Health Dashboard' },
    {
      type: 'p',
      text: 'The /health admin page gives a live view of every subsystem, backed by a detailed health endpoint that goes beyond the public liveness probe.'
    },
    {
      type: 'pre',
      code: `GET /api/health/detailed
{
  "db":        { "ok": true, "latency_ms": 4 },
  "redis":     { "ok": true },
  "inngest":   { "ok": true },
  "migrations":{ "ok": true, "pending": 0 },
  "sockets":   { "connected": 12 }
}`
    },
    {
      type: 'note',
      text: 'GET /api/health remains the lightweight unauthenticated liveness check for load balancers; the detailed endpoint requires authentication.'
    }
  ]
}

export const obsDataQuality: DocSection = {
  id: 'data-quality',
  label: 'Data Quality Inspector',
  content: [
    { type: 'h1', id: 'data-quality', text: 'Data Quality Inspector' },
    {
      type: 'p',
      text: 'Define data-quality rules per collection (`nivaro_dq_rules`) and run them on demand or on a schedule; each run (`nivaro_dq_runs`) records pass/fail counts and the offending rows. The /data-quality page shows rule health at a glance.'
    },
    { type: 'h3', text: 'Rule types' },
    {
      type: 'table',
      head: ['Type', 'Checks'],
      rows: [
        ['not_null', 'Field has a value on every row'],
        ['regex', 'Field matches a pattern'],
        ['range', 'Numeric/date field within min–max'],
        ['unique', 'No duplicate values in the field'],
        ['formula', 'Custom expression evaluates truthy per row']
      ]
    },
    {
      type: 'ul',
      items: [
        'Each run lists failing rows with links straight into the item editor.',
        'Failing rules can raise issues in the Issue Log automatically.'
      ]
    }
  ]
}

export const obsIssueLog: DocSection = {
  id: 'issue-log',
  label: 'Issue Log',
  content: [
    { type: 'h1', id: 'issue-log', text: 'Issue Log' },
    {
      type: 'p',
      text: 'A central log of operational problems — failed syncs, data-quality breaches, webhook dead letters, manual reports — stored in `nivaro_issues` with severity and status. Triage from the /issues page.'
    },
    {
      type: 'table',
      head: ['Field', 'Values'],
      rows: [
        ['severity', 'info | warning | error | critical'],
        ['status', 'open | acknowledged | resolved']
      ]
    },
    {
      type: 'ul',
      items: [
        'Issues link back to their source (sync job, DQ run, webhook, record) where applicable.',
        'Filter by severity, status, and source; resolve with an optional note.',
        'Subsystems raise issues automatically; users and extensions can create them via POST /api/issues.'
      ]
    }
  ]
}
