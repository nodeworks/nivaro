import type { DocSection } from '../types.js'

export const overviewSectionsDocs: DocSection = {
  id: 'overview-sections',
  label: 'Overview page sections',
  content: [
    { type: 'h1', id: 'overview-sections', text: 'Overview page sections' },
    {
      type: 'p',
      text: 'The admin home page (`/`) is built from sections. Each one reads its own answer from `/api/overview/<section>` and shows its own loading, empty and error state. Everything a section counts about a person is counted as that person; the administrator sections are refused (403) on the server for anyone else, not just hidden.'
    },
    {
      type: 'table',
      head: ['Section', 'Who sees it', 'What it shows'],
      rows: [
        [
          'Needs you',
          'Everyone',
          'What is waiting on you, one sentence and one action per line: approvals and records waiting on you (the My Work set), tasks overdue or due today, unread mentions. Administrators also see failed job runs, failed imports and rejected partner submissions in the last 24 hours, support requests with nobody on them or assigned to them, critical SQL check findings and failing readiness checks. Shows nothing when nothing waits.'
        ],
        [
          'System',
          'Everyone',
          'One line: "Everything\'s running", "Some things are slow right now" or "The database is not answering". Administrators also see the version, when it started serving and readiness warnings (the stored scorecard, never a fresh run); the line opens Health.'
        ],
        [
          'Today on this instance',
          'Administrators',
          'The last 24 hours in half-hour slots: job runs (failures stand out), deploys, imports and config changes. Hover or focus a slot for its words, click it for what happened, or switch to the list.'
        ],
        [
          'Top problems',
          'Administrators',
          "The three most urgent open problems: jobs whose latest run failed, critical SQL findings, failing readiness checks and open Integrations console problems (in the console's own order). Critical first, then the one open longest."
        ],
        [
          'Recent config changes',
          'Administrators',
          'The last five changes to roles, policies, fields, layouts, flows, pipelines and other authored configuration in the last 30 days, in plain words. Undo appears where the activity log can undo the entry; every line opens the entry.'
        ],
        [
          'People waiting for access',
          'Administrators',
          'People on the new-account roles (Settings → Sign-in providers → New accounts), those who asked first, longest waiting first. Pick a role and Approve (with a confirm) — the same change the Users page makes.'
        ],
        [
          'Usage today',
          'Administrators',
          'Collections with the most record changes today, the most-opened screens (page views, or browser timings where page views are not collected) and the slowest screen this week (3 in 4 loads finish within the time shown).'
        ],
        [
          'Following',
          'Everyone',
          'Records, collections, field watches and queues you follow, with how many unread notifications each has. A record you can no longer see drops out.'
        ]
      ]
    },
    {
      type: 'pre',
      code: `GET /api/overview/needs-you?today=YYYY-MM-DD&tz=<minutes>   # signed in; today/tz = your day
GET /api/overview/health                                   # signed in
GET /api/overview/following                                # signed in
GET /api/overview/timeline                                 # administrators
GET /api/overview/problems                                 # administrators (integrations merged in the page)
GET /api/overview/config-changes                           # administrators
GET /api/overview/people-waiting                           # administrators
GET /api/overview/usage                                    # administrators`
    },
    {
      type: 'note',
      text: 'Figures are kept briefly so a busy home page does not repeat heavy reads: a minute for needs-you, problems and the timeline, five minutes for usage. Expensive reads wait their turn at the heavy-read gate.'
    }
  ]
}
