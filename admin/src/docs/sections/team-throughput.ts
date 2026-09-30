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

export const peoplePageGuide: DocSection = {
  id: 'people-page',
  label: 'People page tools',
  content: [
    { type: 'h1', id: 'people-page', text: 'People page tools' },
    {
      type: 'p',
      text: 'The shared people page (admin `/users/:id`, a headless host’s profile route) carries four admin tools beside the colleague view, and the Users list gains bulk actions.'
    },
    { type: 'h2', id: 'people-best-time', text: 'Best time to reach' },
    {
      type: 'p',
      text: 'Under the contact line: "Usually online 9 AM–4 PM EDT · overlaps your day 6h · usually back in ~2h". The window is the middle 80% of the hours the person acted in over the last eight weeks (transitions, completed tasks, created records), shown in the viewer’s zone; it is left out under 12 samples and for machine accounts. The overlap is against the viewer’s own rhythm, or a 9-to-5 day when they have none. Out of office replaces the "back in" part. The profile payload carries it as `typical_hours_utc`.'
    },
    {
      type: 'h2',
      id: 'people-working-on',
      text: 'Working on: filter, sort, export, open in a queue'
    },
    {
      type: 'ul',
      items: [
        '`GET /api/users/:id/working-on?limit=` returns up to 1,000 of the records the person owns (default 30), as the viewer may read them.',
        'The card filters by collection, state and past SLA, sorts by urgency, time in state or name, and exports the filtered list as CSV.',
        '"Open in queue" lists the queues that read those collections (`GET /api/queues` now carries `source_collections`) and opens one at `/queues/:id?owner=<user id>`. The queue applies that owner filter once, drops the parameter from the address bar, and shows an "Owner: <name> ✕" chip.'
      ]
    },
    { type: 'h2', id: 'people-compare', text: 'Compare and copy access' },
    {
      type: 'p',
      text: 'Access tab → Compare access: pick a second person to see role, scope limits, teams and approval seats side by side, with differences marked. "Copy access from" makes this person’s role and scopes (both limits and default filters) match the other person’s and adds them to the other person’s teams; it never removes a team, and approval seats are not copied (they come from owner groups). Preview first, with what each scope change does to the rows they can see; applying rebuilds the plan on the server.'
    },
    {
      type: 'pre',
      code: `POST /api/users/:id/copy-access          (admin)
{ "from": "<user id>", "include": { "role": true, "scopes": true, "teams": true }, "dry_run": true }
→ 200 { "data": { "role": {...} | null, "scopes": [...], "teams": { "add": [...], "keeps": [...] }, "empty": false, "applied": false } }
→ 400 "Pick a different person to copy from"`
    },
    { type: 'h2', id: 'people-view-as', text: 'View as' },
    {
      type: 'p',
      text: 'An admin’s header button on someone’s page. In the admin app it opens a NEW TAB as that person: the tab carries its own masquerade token in sessionStorage (it arrives in the URL fragment, which never reaches a server, and is removed at once), every request that tab makes rides it as a bearer token, and an amber bar says who the tab is. The admin’s other tabs stay signed in as the admin. "Stop viewing as" revokes the token and closes the tab. The tab never records a session replay. A host registers how it opens itself as someone else with `registerViewAsOpener`; without one the button does not show.'
    },
    { type: 'h2', id: 'people-bulk', text: 'Users list bulk actions' },
    {
      type: 'p',
      text: 'Tick people on the Users list (the selection survives paging and filtering) for: set role, assign or clear a delegate, add to a team, send a message, check the directory, reactivate or suspend. Each person is changed on their own with an activity row; the bar reports who was changed, who already matched and who failed. You cannot change your own role or suspend yourself here.'
    },
    {
      type: 'pre',
      code: `POST /api/users/bulk                    (admin, at most 500 ids)
{ "ids": [...], "action": "set_role", "role_id": "<uuid>" }
{ "ids": [...], "action": "suspend" | "activate" }
{ "ids": [...], "action": "set_delegate", "delegate_id": "<uuid>" | null, "expires_at": "2026-12-31" }
{ "ids": [...], "action": "add_to_team", "team_id": 12 }
→ 200 { "data": { "results": [{ "id", "name", "outcome": "changed" | "skipped" | "failed", "reason" }], "changed", "skipped", "failed" } }`
    }
  ]
}
