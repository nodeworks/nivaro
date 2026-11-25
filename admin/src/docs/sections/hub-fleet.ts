import type { DocSection } from '../types.js'

export const hubFleetDocs: DocSection = {
  id: 'hub-fleet',
  label: 'Fleet, uptime and drift alerts',
  content: [
    { type: 'h1', id: 'hub-fleet', text: 'Fleet, uptime and drift alerts' },
    {
      type: 'p',
      text: 'Apps → Fleet shows every app and environment the Hub looks after on one screen: the version each runs and how far it is behind the newest release, health, readiness score, open issues, uptime, this month’s uptime against its target, the last deploy (when, who, how it ended), whether it runs on a shared deployment or its own stack, and any version drift alerts. Hub administrators see every app. App owners see only their own apps.'
    },
    {
      type: 'note',
      text: 'The page reads only the Hub’s own tables. Loading it never makes the Hub call an app or the image registry, and each answer is kept 30 seconds per viewer. A job checks every environment once a minute. An environment that has never been checked shows "Not checked yet"; one the last few probes skipped shows "Not checked lately". A skipped probe is counted neither up nor down.'
    },
    { type: 'h2', id: 'hub-fleet-columns', text: 'What each column means' },
    {
      type: 'table',
      head: ['Column', 'Where it comes from'],
      rows: [
        [
          'Version',
          'The version the environment last reported. "N behind" counts the releases the Hub KNOWS between that version and the newest one. Known releases are the versions a Hub promotion, rollback or shared deployment ran successfully, plus the image’s published x.y.z tags (refreshed at most once an hour). The count works the same across a minor or major line. The newest release is the highest known one; neither the Hub’s own version nor anything an app reports sets it. A version above every known release (a pre-release, a hand-built image) shows "not a known release" and never counts for drift.'
        ],
        [
          'Health',
          'The Hub’s status read, refreshed every 5 minutes. It goes through the hub link when the environment has a hub token, through the shared deployment’s link for a shared placement, and through the public `/api/version` + `/api/health` otherwise.'
        ],
        [
          'Readiness, Open issues',
          'The app’s cached readiness score (out of 100) and its count of open or in-progress issues. Both come only through the hub link, and the issue count only from apps on 0.3.215 or later. Otherwise the cell shows —.'
        ],
        [
          'Uptime 24 h / 30 d',
          'The share of probes that answered. Click it to see the chosen window’s uptime, hour-by-hour bars (with the hour’s p95 response time), the recent failed probes and the stored monthly reports.'
        ],
        [
          'Uptime this month',
          'Uptime since the 1st (UTC) against the environment’s target. "On track" means at or above the target so far.'
        ],
        [
          'Last deploy',
          'The newest promotion or rollback the Hub ran: its version, result, when and who started it. An environment the Hub only watches shows when its current version was first seen.'
        ],
        [
          'Placement',
          'Dedicated (its own stack or GitLab deploy), Shared (with the shared deployment’s key) or Watch only (the Hub watches it but does not deploy it).'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Filter by app, placement and health ("Needs attention" means not answering, not running fine, or an open alert), and use the search box. The "not answering" and "with drift alerts" counts in the header filter the table too. Click a column header to sort by it. The filters and the sort are kept in the address, so a view can be shared. Clicking an environment opens its app on the Apps tab.'
    },
    {
      type: 'p',
      text: 'Administrators can press Check now. It runs in the background and the page updates when it ends; while a check runs, a second one is refused. It probes every environment, reads every status and evaluates the alert rules. It never runs beside the minute job: it waits for the job to finish. A probe within 50 seconds of the last one stores no extra sample, so pressing Check repeatedly never weighs a minute twice. The check is logged.'
    },
    { type: 'h2', id: 'hub-fleet-uptime', text: 'Uptime and the monthly SLO' },
    {
      type: 'ul',
      items: [
        'Every minute, job `hub-fleet-probe` calls each ACTIVE environment’s public `GET /api/version` and `GET /api/ready`. These are the same public routes and the same 8-second timeout as the Hub’s status read. No token is sent and no records are read.',
        'A probe never follows a redirect: a 3xx counts as down, with code REDIRECT. It reads at most 64 KB of an answer. It counts as up when `/api/version` answers with a version and `/api/ready` did not refuse (a 404 from an app too old to have `/api/ready` does not count against it).',
        'At most 8 environments are probed at once, and a tick starts no new one after 45 seconds. The order rotates every minute, so a slow tick skips different environments each time.',
        'What does not count: no samples are stored while an environment is being created, waiting for its name or held in maintenance by a move, and none while a Hub promotion, rollback, stack apply or move is running on it (the Hub restarting it is a declared window).',
        'What does count: a restart nobody declared to the Hub (a deploy run outside the Hub, a crash, a host reboot) counts as down for as long as the app does not answer.',
        'Job `hub-fleet-rollup` folds the samples into hourly rows every 5 minutes, and every uptime figure reads those. Raw samples are kept 48 hours and hourly rows 400 days (job `hub-fleet-prune`, 04:20 daily). Each month’s figures are stored separately and kept.',
        'At 07:00 UTC on the 1st, job `hub-slo-report` reports every ended month not reported yet: a missed run is caught up within 72 hours, and up to 12 months back are filled in. Each app’s owners get one report for their app, and every Hub administrator gets one fleet summary, in-app and by email. A month is never sent twice: each app is marked as sent before its owners are told. Switch the messages off in Rules and targets; the monthly figures are still stored.',
        'Targets are percentages: a default (99.5 % unless changed) and an optional target per environment.'
      ]
    },
    { type: 'h2', id: 'hub-fleet-alerts', text: 'Version drift alerts' },
    {
      type: 'p',
      text: 'Hub administrators set the rules under Rules and targets in the fleet header. Every rule starts off, and an administrator turns each one on. Job `hub-fleet-alerts` evaluates the enabled rules every 15 minutes. A rule opens at most one alert per environment. When it starts firing, the app’s owners and every Hub administrator are told once; each person gets one notification per run, however many alerts opened. A rule’s first run after it is turned on sends one summary line for that rule instead of a line per environment. When the condition clears, the alert closes without a message. An environment under a move or a running Hub deploy keeps its alerts as they are until it is back. Open alerts show as chips on the fleet rows.'
    },
    {
      type: 'table',
      head: ['Rule', 'Fires when'],
      rows: [
        [
          'Releases behind the newest',
          'An environment runs N or more known releases behind the newest. It can be limited to some environment keys, e.g. `production`. Suggested: 5.'
        ],
        [
          'Two environments apart',
          'Two environments of the same app (by key, e.g. staging vs production) are MORE than N known releases apart. The alert is on the second environment. Suggested: staging vs production, 3.'
        ],
        [
          'Not deployed for days',
          'An environment has not been deployed for N days or more: no successful Hub deploy and no version change seen. Suggested: 30.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'An environment whose version is unknown or unverified never fires. The rules, the targets and the report switch are stored in `nivaro_extension_settings` (`nivaro-core` / `hub_fleet`). What the jobs remember between runs (rules already run once, months already summarised, the cached release list) is in `nivaro-core` / `hub_fleet_state`. Neither needs a migration. Saving the rules is logged.'
    },
    { type: 'h2', id: 'hub-fleet-audit', text: 'Audit timeline' },
    {
      type: 'p',
      text: 'Apps → Audit (Hub administrators) lists every Hub action, newest first: promotions and rollbacks, moves and placements, stack changes, key and token rotations, shared upgrades, app creation, sign-in client changes, database actions and other Hub settings. Each row shows who, when, what, the app and environment where known, the result of a run (succeeded, failed, cancelled, rolled back…) and the reason or note when one was given.'
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
        [
          'GET /api/hub/fleet',
          'Admins; owners (their apps)',
          'The fleet rows, the newest known release'
        ],
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
          'POST /api/hub/fleet/check, GET /api/hub/fleet/check',
          'Admins',
          'Start a check: 202, or 409 CHECK_RUNNING while one runs (logged); then poll its state'
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
      text: 'Tables (migration 566, created everywhere, used only with `HUB=on`): `nivaro_hub_fleet_status`, `nivaro_hub_uptime_samples`, `nivaro_hub_uptime_hours`, `nivaro_hub_fleet_alerts`, `nivaro_hub_slo_reports`. The hub link (`GET /api/hub-link/status`) also returns `open_issues` from 0.3.215.'
    }
  ]
}
