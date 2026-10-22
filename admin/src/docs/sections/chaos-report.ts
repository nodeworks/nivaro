import type { DocSection } from '../types.js'

export const chaosReportDocs: DocSection = {
  id: 'chaos-report',
  label: 'Chaos Results',
  content: [
    { type: 'h1', id: 'chaos-report', text: 'Chaos Results' },
    {
      type: 'p',
      text: 'Every chaos drill ends with a report, and the reports add up to a scorecard: which claims about how Nivaro degrades are proven, which broke, and which nobody has checked lately. All of it is for administrators and stays readable on instances where drills cannot run.'
    },
    { type: 'h2', id: 'chaos-report-run', text: 'Run report' },
    {
      type: 'p',
      text: 'Open a finished run from the Runs tab (Full report) or go to /chaos/runs/<id>. While the run is still going the same address shows the live cockpit.'
    },
    {
      type: 'ul',
      items: [
        'The verdict: held, broke or aborted, and the limit that broke it.',
        'One chart per limit, before, during and after the fault, with the normal range from before the drill, the limit line, and the alerts and notes marked where they happened.',
        'Time to detect: from arming the fault to the first alert, the first "noticed" note or a declared incident.',
        'Time to fix: to the first "fixed" note.',
        'Time to recover: from the end of the fault until every limit was back inside its normal range. "Not back while watched" means the samples after the fault never returned to it.',
        'The alerts that fired, what the readiness checks said, and the errors people actually saw: server errors by route (ids removed), client error reports and rage or dead clicks, as counts only.',
        'The participants’ notes and the full timeline.'
      ]
    },
    {
      type: 'p',
      text: 'Copy link gives a stable address other administrators can open. Export postmortem downloads the report as Markdown (timeline, figures and notes, never record data) to paste into a postmortem.'
    },
    { type: 'h2', id: 'chaos-report-claims', text: 'Claims and the matrix' },
    {
      type: 'p',
      text: 'The Matrix tab shows every dependency (the database, Redis, the file share, each partner API, the AI gateway, sign-in, sockets and mail) against the ways it can fail: down, slow, errors and cut off. Each cell takes the colour of its newest drill and fades as that drill gets older; an outlined cell has never been proven. Click a cell to open its last report or run it again with the start form already filled in.'
    },
    {
      type: 'p',
      text: 'Under the matrix, Claims lists what Nivaro says about degrading (for example, "when Redis is unreachable, requests keep answering") with the drill that last proved each one. A claim is proven when its newest drill held within the last 30 days, stale when that drill is older, broke when its newest drill broke or stopped itself, and never proven when nothing has run. A fault proves a claim when it names the claim in its catalog entry.'
    },
    {
      type: 'note',
      text: 'The readiness check "Resilience claims are proven" warns when a claim is stale or its last drill broke. Claims never proven are listed but do not warn. It is skipped where drills cannot run (cloud, or production without CHAOS_ENABLED).'
    },
    { type: 'h2', id: 'chaos-report-trends', text: 'Trends' },
    {
      type: 'p',
      text: 'The Trends tab shows median time to detect and time to recover per month or quarter, a calendar of the days drills ran (Eastern dates; an outlined day had a drill that did not hold), each dependency’s verdicts month by month, and the claims never proven. The strip on top (the last 90 days) is also served as JSON for a recovery-time panel.'
    },
    { type: 'h2', id: 'chaos-report-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Returns'],
      rows: [
        [
          'GET /api/chaos/runs/:id/report',
          'The run, its report, errors people saw, actor names and the share link'
        ],
        ['GET /api/chaos/runs/:id/postmortem', 'The report as a Markdown download'],
        ['GET /api/chaos/claims', 'Every claim with its status and last run'],
        [
          'GET /api/chaos/matrix',
          'Rows, fault kinds and one cell per pair with its last verdict and re-run spec'
        ],
        [
          'GET /api/chaos/trends?months=12',
          'Monthly and quarterly timings, drills per day, verdicts per dependency, never-proven claims and the recovery feed'
        ]
      ]
    }
  ]
}
