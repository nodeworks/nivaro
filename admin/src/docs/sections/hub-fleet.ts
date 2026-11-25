import type { DocSection } from '../types.js'

export const hubFleetDocs: DocSection = {
  id: 'hub-fleet',
  label: 'Fleet, uptime and drift alerts',
  content: [
    { type: 'h1', id: 'hub-fleet', text: 'Fleet, uptime and drift alerts' },
    {
      type: 'p',
      text: 'Apps → Fleet shows every app and environment the Hub looks after on one screen: the version each runs and how far it is behind the newest, health, readiness score, open issues, uptime, this month’s uptime target, the last deploy (when, who, how it ended), whether it runs on a shared deployment or its own stack, and any version drift alerts. Hub administrators see every app. App owners see only their own apps.'
    },
    {
      type: 'note',
      text: 'The page reads only the Hub’s own tables. Loading it never makes the Hub call an app. A job checks every environment once a minute, and the page refreshes every minute too. A new environment shows "Not read yet" until its first check.'
    },
    { type: 'h2', id: 'hub-fleet-columns', text: 'What each column means' },
    {
      type: 'table',
      head: ['Column', 'Where it comes from'],
      rows: [
        [
          'Version',
          'The version the environment last reported. "N behind" counts patch releases inside one release line (0.3.200 is 14 behind 0.3.214). "Other line" means the version is on a different minor line from the newest. The newest is the highest version any environment runs, or the Hub’s own version if that is higher.'
        ],
        [
          'Health',
          'The Hub’s status read, refreshed every 5 minutes. It goes through the hub link when the environment has a hub token, through the shared deployment’s link for a shared placement, and through the public `/api/version` + `/api/health` otherwise. "Not answering" means the last uptime probe failed.'
        ],
        [
          'Readiness, Issues',
          'The app’s cached readiness score and its count of open or in-progress issues. Both come only through the hub link, and the issue count only from apps on 0.3.215 or later. Otherwise the cell shows —.'
        ],
        [
          'Uptime 24 h / 30 d',
          'The share of probes that answered. Click it to see hour-by-hour bars, the recent failed probes and the stored monthly reports.'
        ],
        [
          'SLO this month',
          'Uptime since the 1st (UTC) against the environment’s target. "On track" means at or above the target so far.'
        ],
        [
          'Last deploy',
          'The newest promotion or rollback the Hub ran: its version, result, when and who started it. An environment the Hub only watches shows when its current version was first seen.'
        ],
        [
          'Placement',
          'Dedicated (its own stack or GitLab deploy), Shared (with the shared deployment’s key) or Watch only (no placement).'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Use the filters for app, placement and health ("Needs attention" = not answering, not running fine, or an open alert), the search box, and the sort (most releases behind, lowest uptime, longest since a deploy, lowest readiness). Clicking an environment opens its app on the Apps tab. Administrators can press Check now to probe every environment and evaluate the alert rules at once. That action is logged.'
    },
    { type: 'h2', id: 'hub-fleet-uptime', text: 'Uptime and the monthly SLO' },
    {
      type: 'ul',
      items: [
        'Every minute the job `hub-fleet-probe` calls each ACTIVE environment’s public `GET /api/version` and `GET /api/ready`. These are the same public routes and the same 8-second timeout as the Hub’s status read. No token is sent and no records are read. A probe counts as up when `/api/version` answers with a version and `/api/ready` did not refuse (a 404 from an app too old to have `/api/ready` does not count against it). At most 8 environments are probed at once, and a tick stops starting new ones after 45 seconds.',
        'An environment that is being created, waiting for its name or held in maintenance by a move makes no samples, so planned windows never count against its target.',
        'Samples are kept 45 days (job `hub-fleet-prune`, 04:20 daily). Each month’s figures are stored separately and kept.',
        'At 07:00 UTC on the 1st, job `hub-slo-report` stores last month’s uptime per environment. It then sends each app’s owners one report for their app and every Hub administrator one fleet summary, in-app and by email. A month is never sent twice. Switch the messages off under the rules card (the monthly figures are still stored).',
        'Targets are percentages: a default (99.5 % unless changed) and an optional target per environment.'
      ]
    },
    { type: 'h2', id: 'hub-fleet-alerts', text: 'Version drift alerts' },
    {
      type: 'p',
      text: 'Hub administrators set the rules in the "Alert rules and uptime targets" card under the fleet table. Job `hub-fleet-alerts` evaluates them every 15 minutes. When a rule starts firing for an environment (or an app), the app’s owners and every Hub administrator are told once. Each person gets one notification per run, however many alerts opened. When the condition clears, the alert closes without a message. Open alerts show as chips on the fleet rows.'
    },
    {
      type: 'table',
      head: ['Rule', 'Fires when'],
      rows: [
        [
          'Releases behind the newest',
          'An environment runs N or more releases behind the newest (or a different release line). It can be limited to some environment keys, e.g. `production`. Default: on, 5.'
        ],
        [
          'Two environments apart',
          'Two environments of the same app (by key, e.g. staging vs production) are MORE than N releases apart. Default: on, staging vs production, 3.'
        ],
        [
          'Not deployed for days',
          'An environment has not been deployed for N days or more: no successful Hub deploy and no version change seen. Default: on, 30.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'An environment whose version is unknown never fires. The rules, the targets and the report switch are stored in `nivaro_extension_settings` (`nivaro-core` / `hub_fleet`), so no migration is needed. Saving them is logged.'
    },
    { type: 'h2', id: 'hub-fleet-audit', text: 'Audit timeline' },
    {
      type: 'p',
      text: 'Apps → Audit (Hub administrators) lists every Hub action, newest first: promotions and rollbacks, moves and placements, stack changes, key and token rotations, shared upgrades, app creation, sign-in client changes, database actions and other Hub settings. Each row shows who, when, what, the app and environment where known, the result of a run (success, failed, cancelled, rolled back…) and the reason or note when one was given.'
    },
    {
      type: 'ul',
      items: [
        'Rows come from the activity log entries the Hub writes. Run results come from the Hub’s run tables (deploys, moves, shared deploys). Runs that no activity entry names also appear, attributed to System: a shared version change the Hub only observed, or a failed creation.',
        'Filter by app, environment, person, kind of action and dates. The filters are kept in the address, so a filtered view can be shared. CSV exports the same filter (the export is logged).',
        'One answer reads at most the newest 5,000 Hub entries in the date window. The page says so when there were more: narrow the dates to see older ones.'
      ]
    },
    { type: 'h2', id: 'hub-fleet-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        ['GET /api/hub/fleet', 'Admins; owners (their apps)', 'The fleet rows, the newest version'],
        [
          'GET /api/hub/fleet/environments/:envId/uptime?days=1..30',
          'Admins; owners',
          'Hourly uptime, recent failed probes, monthly reports'
        ],
        ['GET /api/hub/fleet/alerts?state=open|all', 'Admins; owners', 'Drift alerts'],
        ['GET /api/hub/fleet/reports', 'Admins; owners', 'Stored monthly uptime reports'],
        [
          'GET / PUT /api/hub/fleet/settings',
          'Admins',
          'Rules, targets, report switch (PUT logged)'
        ],
        [
          'POST /api/hub/fleet/check',
          'Admins',
          'Probe every environment and evaluate the rules now (logged)'
        ],
        [
          'GET /api/hub/audit, GET /api/hub/audit.csv',
          'Admins',
          'Audit timeline; filters app, environment, user, action (kind or exact id), from, to, offset, limit'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Tables (migration 566, created everywhere, used only with `HUB=on`): `nivaro_hub_fleet_status`, `nivaro_hub_uptime_samples`, `nivaro_hub_fleet_alerts`, `nivaro_hub_slo_reports`. The hub link (`GET /api/hub-link/status`) also returns `open_issues` from 0.3.215.'
    }
  ]
}
