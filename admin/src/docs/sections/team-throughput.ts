import type { DocSection } from '../types.js'

export const teamThroughputGuide: DocSection = {
  id: 'team-throughput',
  label: 'Team Throughput',
  content: [
    { type: 'h1', id: 'team-throughput', text: 'Team Throughput' },
    {
      type: 'p',
      text: 'Team Throughput is an admin-only report showing how each user is moving work through a workflow-bound collection over time — transitions performed, completions, send-backs, and average time to act.'
    },
    { type: 'h2', id: 'team-throughput-metrics', text: 'Metrics' },
    {
      type: 'ul',
      items: [
        'Transitions — state changes performed by the user.',
        'Completions — transitions into a terminal state other than canceled.',
        'Send-backs — transitions to a state earlier in the state order.',
        'Avg time to action — how long items sat in a state before this user moved them (wall-clock).'
      ]
    },
    {
      type: 'note',
      text: 'Computed live from `nivaro_workflow_history` — fully retroactive, including imported legacy history. Per-owner backlog trends (My Items sparklines) accumulate daily from the snapshot cron and are not retroactive.'
    }
  ]
}

export const managersTeamGuide: DocSection = {
  id: 'managers-team',
  label: 'Your team (managers)',
  content: [
    { type: 'h1', id: 'managers-team', text: 'Your team (managers)' },
    {
      type: 'p',
      text: 'A manager is anyone with active direct reports (people whose manager is set to them). `/auth/me` answers `has_reports`, and a headless dashboard offers its team widgets only to those people. Every count and every record listed is narrowed to what the viewer may open, so two people asking about the same report can see different numbers.'
    },
    { type: 'h2', id: 'managers-team-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'What it answers'],
      rows: [
        [
          'GET /users/me/team-load',
          'One row per report: open records, past SLA, oldest, stuck count, the three oldest records, out-of-office and who covers. Admins may pass ?team=<team id> to read a Team instead.'
        ],
        [
          'GET /delegation/team?days=14',
          'Reports who are out now or whose time off starts within the window, gaps (no working delegate) first.'
        ],
        [
          'POST /delegation/:userId/remind',
          'Asks a report to set a delegate. Their manager or an admin; once a day per person (429 REMIND_TOO_SOON).'
        ],
        [
          'GET /users/me/team-week',
          'The last seven days: completions, send-backs, records newly past SLA, who was out, and gaps in the next two weeks.'
        ],
        [
          'GET /users/me/team-tasks',
          "Open and overdue tasks per report with who asked. The assignee's manager may nudge (POST /tasks/:id/nudge)."
        ],
        [
          'GET /users/me/team-trend?days=30',
          'Past-SLA and at-risk counts per day from the per-owner queue snapshots, with the change against the previous window.'
        ],
        [
          'GET /users/me/team-wins?days=7',
          'Completions and accepted partner pushes per report; POST /users/me/team-wins/kudos posts a message as the manager through the chat send path.'
        ],
        [
          'GET /users/me/team-onboarding?days=60',
          'New reports: sign-ins, first request and approval, setup steps, pending access requests. POST /access-requests/:id/vouch tells admins the manager backs a request; it grants nothing.'
        ],
        [
          'GET /users/me/team-access',
          'Role, scope limits, directory status, sign-in staleness, token presence, pending requests and expired delegations. POST /users/me/team-access/flag tells admins about a needed scope change or a departure.'
        ],
        [
          'GET /users/:id/one-on-one?since=',
          '1:1 preparation for one report (their manager or an admin); POST …/summary writes a short brief from that payload only.'
        ]
      ]
    },
    { type: 'h2', id: 'managers-team-alerts', text: 'Team alerts' },
    {
      type: 'p',
      text: 'A manager sets `preferences.team_alerts` — `breached_max`, `uncovered`, `stuck_hours`, `silent_days` — through PATCH /users/me/preferences. The hourly `team-alerts` job checks each manager\'s team against those lines and sends one notification per report and rule per day. On Mondays the daily summary carries a "Your team this week" section for anyone with reports.'
    },
    {
      type: 'note',
      text: 'What counts as stuck is set once for the instance: Settings → `team_stuck_hours` (blank = 240 hours).'
    }
  ]
}
