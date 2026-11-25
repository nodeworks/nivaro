import type { DocSection } from '../types.js'

export const hubReleasesDocs: DocSection = {
  id: 'hub-releases',
  label: 'Hub release operations',
  content: [
    { type: 'h1', id: 'hub-releases', text: 'Hub release operations' },
    {
      type: 'p',
      text: 'On top of promotions, the Hub can run a version through an app’s environments in order (a release train), start a promotion or a train at a set time, refuse changes during freeze windows, roll an environment back on its own when it turns unhealthy after a promotion, and show what each promotion changes. Everything lives on the Apps hub’s Releases tab (`/hub/releases`); release notes also show in the Promote panel and in each environment’s Hub deploys.'
    },
    {
      type: 'note',
      text: 'Every promotion these features start is a normal Hub promotion run: the plan is judged again at the start, the environment lock, an open move and freeze windows apply, it gets a job run and a deploy row, and it shows in the deploy history. The person confirmed the version and the environments, not one plan, so a plan that changed in between is simply the plan of that moment.'
    },
    { type: 'h2', id: 'hub-releases-trains', text: 'Release trains' },
    {
      type: 'p',
      text: 'A train takes one version through chosen environments of one app, in the app’s order (for example development → staging → production). Each step promotes the environment, then holds: the soak time must pass after the deploy finished, then, when a minimum readiness is set, the app’s readiness score (read over its hub link) must reach it. A hold still short after its longest hold waits for a person, who skips the hold or aborts the train. A step whose environment already runs the version goes straight to its hold.'
    },
    {
      type: 'table',
      head: ['Step state', 'Meaning'],
      rows: [
        [
          'Waiting to start',
          'Not started yet, or waiting for a freeze to end, or trying again after a refusal that passes on its own (a lock, GitLab not answering).'
        ],
        ['Promoting', 'Its promotion run is running.'],
        ['Holding', 'Soaking, or waiting for the readiness score.'],
        ['Needs a person', 'The hold did not pass in time: Skip the hold, or Abort.'],
        [
          'Passed / Skipped',
          'Done; Skipped = a person skipped the step before it started (that environment was not promoted).'
        ],
        [
          'Failed',
          'The promotion failed or was refused, or the environment was rolled back during the hold. The train stops.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'One running train per app. Aborting stops the train; a promotion already running finishes on its own (cancel it from the Promote panel if needed).',
        'A step can be skipped only while it waits or holds, never while its promotion runs.',
        'The app’s owners and the person who started the train are told when it finishes, stops or needs a person.',
        'An environment placed on a shared deployment cannot be a step: its version follows the deployment.'
      ]
    },
    { type: 'h2', id: 'hub-releases-schedules', text: 'Scheduled promotions' },
    {
      type: 'p',
      text: 'A promotion of one environment, or a whole train, can be scheduled for a time. The Hub stores UTC and shows every time in the viewer’s own zone. Scheduling needs the typed environment key (a promotion) or app key (a train). At the time, the Hub judges the plan again and starts it as the person who scheduled it.'
    },
    {
      type: 'ul',
      items: [
        'Inside a freeze window: *Wait until it ends* (default) starts it once the freeze lifts; *Do not start* fails it and tells the owners.',
        'A refusal that passes on its own is tried again every minute (at most 30 times); any other refusal fails the schedule and tells the owners.',
        'A schedule the Hub finds more than 6 hours late (it was not running its schedule) is marked missed instead of deploying by surprise.',
        'A schedule can be cancelled until it starts.'
      ]
    },
    { type: 'h2', id: 'hub-releases-freezes', text: 'Freeze windows' },
    {
      type: 'p',
      text: 'While a freeze is on, the Hub refuses promotions, Apply now, shared deployment upgrades and moves with 409 `FROZEN` (naming the freeze and when it ends). A rollback — of an environment or of a shared deployment — is always allowed. A freeze belongs to one app or to every app (Hub-wide); an upgrade of a shared deployment is frozen when any app placed on it is.'
    },
    {
      type: 'table',
      head: ['Kind', 'When it is on'],
      rows: [
        ['Once', 'From its start until its end (two times).'],
        [
          'Every month end',
          'The last N days of each month through the first M days of the next, midnight to midnight in the time zone it was set in (the creator’s own zone by default).'
        ]
      ]
    },
    { type: 'h2', id: 'hub-releases-rollback', text: 'Automatic rollback' },
    {
      type: 'p',
      text: 'An automatic rollback rule belongs to one environment. For its watch window after each successful promotion (not Apply now), the Hub reads the app’s figures over its hub link every minute and, when one crosses, rolls back to the version the environment ran before — through the normal rollback path (the build the Hub recorded), never frozen — and tells the app’s owners.'
    },
    {
      type: 'table',
      head: ['Threshold', 'Crossed when'],
      rows: [
        [
          '5xx rate ≥ %',
          '5xx answers / requests since the deploy, once at least the minimum requests were answered.'
        ],
        ['Crashes ≥', 'Front-end crash reports since the deploy.'],
        [
          'Readiness <',
          'The readiness score is below it (a score not computed yet is not a breach).'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Each promotion gets one watch: Watching → Passed, Rolled back, Another deploy followed, or Could not judge or roll back.',
        'An environment without a hub link (no token, or placed on a shared deployment) cannot be judged: its watch ends without a rollback and says so.',
        'A rollback that cannot start (no recorded build, the environment busy past the window) is reported to the owners, who roll back by hand.'
      ]
    },
    { type: 'h2', id: 'hub-releases-notes', text: 'Release notes' },
    {
      type: 'p',
      text: 'The Promote panel’s *What changes* and each history row’s *Changes* show what a run changes, from data the Hub can read. A started run stores its notes once; an older run’s are worked out on request.'
    },
    {
      type: 'table',
      head: ['Part', 'From'],
      rows: [
        [
          'Commits',
          'GitLab compare (read-only) between the build the environment runs (the Hub’s last recorded deploy of that component) and the build the plan deploys, newest first, up to 50 listed.'
        ],
        [
          'Migrations in these commits',
          'Files the commits add under any `migrations/` folder (extension migrations).'
        ],
        ['New settings in env files', 'Setting names the commits add to `.env*` / `*.env` files.'],
        [
          'Nivaro migrations and settings',
          'The build facts of both Nivaro versions: the Hub learns a version from its own build and from every environment it reads with `?release_facts=1`. A version it has not seen yet says so.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'A rollback lists what goes away (the newer build’s commits) and says that migrations which ran stay: a rollback never undoes them.'
    },
    { type: 'h2', id: 'hub-releases-who', text: 'Who can do what' },
    {
      type: 'p',
      text: 'Administrators start trains, schedule, manage freezes and rules, skip and abort; every change is logged in Activity. An app’s owners see its trains, schedules, freezes, rules and release notes. The minute job `hub-release-ops` (one leader, only where scheduled jobs tick) moves everything on; its state is in the database, so a missed minute is picked up by the next.'
    },
    { type: 'h2', id: 'hub-releases-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          '`GET /api/hub/releases/overview`',
          'Signed in',
          'Apps, environments, trains, schedules, freezes (with the window on now / next), rules and recent watches the caller may see.'
        ],
        [
          '`POST /api/hub/apps/:id/trains/check`',
          'Admin or owner',
          'Checks a train body; answers its steps, a freeze on now and the first step’s blockers.'
        ],
        [
          '`POST /api/hub/apps/:id/trains`',
          'Admin',
          '`{version, steps:[{environment_id, soak_minutes, min_readiness, max_hold_minutes}], confirm: <app key>}`; 409 `TRAIN_RUNNING`.'
        ],
        [
          '`POST /api/hub/trains/:id/skip` · `/abort`',
          'Admin',
          '`{step}` = the current step index.'
        ],
        [
          '`POST /api/hub/schedules` · `/schedules/:id/cancel`',
          'Admin',
          '`{kind: promote|train, app_id, environment_id?, version, steps?, run_at, on_freeze: wait|fail, confirm}`.'
        ],
        [
          '`POST|PATCH|DELETE /api/hub/freezes(/:id)`',
          'Admin',
          '`{name, app_id|null, recurrence: none|month_end, starts_at, ends_at | days_before, days_after, time_zone}`.'
        ],
        [
          '`GET /api/hub/environments/:envId/freeze`',
          'Admin or owner',
          'The freeze on now, or null.'
        ],
        [
          '`GET|PUT|DELETE /api/hub/environments/:envId/rollback-rule`',
          'Read: admin or owner; write: admin',
          '`{enabled, window_minutes, max_error_pct, min_requests, max_crashes, min_readiness}`.'
        ],
        [
          '`POST /api/hub/environments/:envId/release-notes`',
          'Admin or owner',
          '`{kind, version}`: the notes of that plan (not stored).'
        ],
        [
          '`GET|POST /api/hub/deploys/:id/release-notes`',
          'Admin or owner',
          'A run’s stored notes; POST works them out when none are stored.'
        ]
      ]
    }
  ]
}
