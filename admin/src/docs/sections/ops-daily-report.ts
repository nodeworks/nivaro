import type { DocSection } from '../types.js'

export const opsDailyReportDocs: DocSection = {
  id: 'ops-daily-report',
  label: 'Daily report',
  content: [
    { type: 'h1', id: 'ops-daily-report', text: 'Daily report' },
    {
      type: 'p',
      text: 'Every night Nivaro writes a post-mortem of the day: what people did, how fast the app answered, what failed, what partners refused, what changed, and why. It lives at Health → Daily report (/health/daily-report; efp-new hosts it at /admin/daily-report). Every number on the page opens the rows behind it in a side drawer, down to a single request, issue, job run, partner send or person — you never leave the page, and a row that is a record opens in the record drawer with "Open full record".'
    },
    { type: 'h2', id: 'ops-daily-report-how', text: 'How a report is made' },
    {
      type: 'ul',
      items: [
        'The window: one day of the instance, 6 AM to 11 PM by default (the SLA time zone). The nightly run fires 5 minutes after the window closes (11:05 PM); Run now works any time.',
        "The numbers (no AI): people (active vs signed in today vs still signed in from an earlier day vs new accounts, View-as, machine callers), traffic, speed, errors, deploys and drains, deadlocks, issues, jobs, partner sends and calls against their 7-day normal, imports, mail, notifications, work done, backlog and SLA misses, search, config changes, security, capacity, pages, browser errors, feature adoption, support, AI use, data quality, who holds the waiting work, tomorrow's watch list, and extension sections such as business volume.",
        'Leads (no AI): for every slow burst, deadlock, server error and cluster of partner refusals, what else happened at that minute — writes by origin, jobs, deploys, admin bulk actions, partner calls — and, for an "Invalid column" error, what the data model says.',
        "The bug tracker (no AI): today's errors become stable keys and are matched with yesterday's, so each bug reads new, open, fixed (with the version deployed after it stopped) or came back.",
        'The health score (no AI): 100 minus capped points for server errors, deadlocks, slow requests, failed sends, alarms, failed jobs, freezes, people who hit trouble and browser errors. The verdict falls back to it when AI is off.',
        "The investigation (AI, the chat model): reads the numbers, leads and tracker and drills into the same rows an administrator can click (about 24 drill calls), then hands in a verdict, headline, summary, incidents with cause and evidence, people to contact and a watch list. Cost is recorded on each report (about $0.50 a night on EFP's gateway)."
      ]
    },
    { type: 'h2', id: 'ops-daily-report-settings', text: 'Settings and email' },
    {
      type: 'ul',
      items: [
        'Off until turned on (Daily report → Settings): window start/end hour, model, token cap, in-app notice, and a master switch for email.',
        'Email is opt-in per administrator: "Email me this report" on the page (preferences.ops_report_email). Everyone else gets the in-app notice only.',
        'Stored per instance under the `ops_report` key of nivaro_settings_overrides, so a copied database never turns it on.'
      ]
    },
    { type: 'h2', id: 'ops-daily-report-api', text: 'API' },
    {
      type: 'pre',
      code: `GET   /api/ops-reports?limit=60                 // admin; newest first
GET   /api/ops-reports/trends?days=90            // one point per day (newest run), oldest first
GET   /api/ops-reports/:id                       // the report: digest, analysis, tracker, comparison
GET   /api/ops-reports/:id/drill?metric=&key=    // rows behind one number; leaf metrics return detail
POST  /api/ops-reports/run {day?}                // 202 { id }; poll GET /:id
GET   /api/ops-reports/settings                  // + email_me for the caller
PATCH /api/ops-reports/settings                  // 400 { error, fields: { <setting>: message } }
PATCH /api/users/me/preferences { ops_report_email: true | null }`
    },
    { type: 'h2', id: 'ops-daily-report-extensions', text: 'Extension sections' },
    {
      type: 'pre',
      code: `ctx.opsReport?.registerSection('business', 'Business volume', async (win) => [
  { key: 'requested_usd', label: 'Amount requested', value: 35_882_471, unit: 'usd', week_avg: 1_329_985 }
])
// each row also becomes a KPI "business.requested_usd" that Trends and Compare chart`
    },
    {
      type: 'note',
      text: 'Reports are kept a year in nivaro_ops_reports (migration 525), a per-environment table that config promotion never copies.'
    }
  ]
}
