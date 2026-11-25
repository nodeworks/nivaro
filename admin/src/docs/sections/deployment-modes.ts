import type { DocSection } from '../types.js'

export const deploymentModesDocs: DocSection = {
  id: 'deployment-modes',
  label: 'Deployment modes',
  content: [
    { type: 'h1', id: 'deployment-modes', text: 'Deployment modes' },
    {
      type: 'p',
      text: 'A Nivaro process runs in one of three modes. Self-hosted (one process, one app, one database) and Nivaro Cloud (the hosted product: tenants and their databases listed in a meta database) behave exactly as before. A Hub shared deployment is new: one process serves many apps, each with its own database, and the list of apps comes from a Nivaro Hub.'
    },
    {
      type: 'table',
      head: ['Mode', 'How it is switched on', 'Apps per process', 'Where the app list comes from'],
      rows: [
        ['Self-hosted', 'Nothing set', '1', 'The one static database in `DB_*` / `DB_URL`'],
        [
          'Nivaro Cloud',
          '`CLOUD_META_DB_URL` set',
          'Many',
          "The cloud meta database's `cloud_tenants` table"
        ],
        [
          'Hub shared deployment',
          '`HUB_SHARED_DEPLOYMENT=<key>`',
          'Many',
          "The Hub's tenants list for that deployment key"
        ]
      ]
    },
    {
      type: 'note',
      text: 'Cloud and self-hosted are unchanged. With HUB_SHARED_DEPLOYMENT unset, nothing in this section applies and every check that used to read CLOUD_META_DB_URL answers exactly as it did.'
    },
    { type: 'h2', id: 'deployment-modes-predicates', text: 'The questions the code asks' },
    {
      type: 'p',
      text: 'The code no longer reads CLOUD_META_DB_URL directly. One module (`services/deployment-mode.ts`) answers two questions about the deployment (a third, `perAppJobs()`, derives from them), and every place that used to test the variable now asks the one it means.'
    },
    {
      type: 'table',
      head: ['Predicate', 'True when', 'Use it for'],
      rows: [
        [
          '`isMultiTenant()`',
          'Nivaro Cloud, or a Hub shared deployment',
          'Anything that exists because one process serves many apps: no static database, a tenant per request, per-app caches and Redis keys, process settings one app must not own, and protections against a tenant admin on a shared process.'
        ],
        [
          '`isNivaroCloud()`',
          'Nivaro Cloud only',
          'Anything that is the hosted product: the meta database, the cloud operator routes, cloud extensions, the cloud edge and billing pages.'
        ],
        [
          '`perAppJobs()`',
          'A Hub shared deployment only',
          'Scheduled jobs that run once per app instead of once per process. False in cloud, so the cloud extensions keep their cross-tenant crons.'
        ]
      ]
    },
    {
      type: 'p',
      text: '`GET /api/health` and `GET /api/version` gain an additive `multi_tenant` field (true in cloud and on a shared deployment). The existing `cloud` field of `/api/health` still means Nivaro Cloud.'
    },
    { type: 'h2', id: 'deployment-modes-rules', text: 'What each mode means in practice' },
    {
      type: 'p',
      text: 'Every place that tested the cloud variable was classified by a rule. T rules go with `isMultiTenant()` and apply on a shared deployment as well. C rules go with `isNivaroCloud()` and stay cloud-only.'
    },
    {
      type: 'table',
      head: ['Rule', 'Predicate', 'In plain words'],
      rows: [
        [
          'T1',
          'multi-tenant',
          'No static database. Boot does not read one, open the background pool or a read replica, run migrations, create the default workspace row, wait on database dependencies, or register hooks, flows and extensions that read it.'
        ],
        [
          'T2',
          'multi-tenant',
          'A request or socket resolves its tenant first. The tenant hook, the socket tenant, the tenant-free paths and the refusal of the realtime-only role belong here.'
        ],
        [
          'T3',
          'multi-tenant',
          'State is keyed by tenant: caches, Redis keys, socket rooms, the realtime board, leak audits.'
        ],
        [
          'T4',
          'multi-tenant',
          'Process configuration one app cannot own: the hub link (`HUB_TOKEN`), the Teams bot registration, socket roles, import/export/media hand-off workers, the render peer, file fallback, and refusing Hub mode.'
        ],
        [
          'T5',
          'multi-tenant',
          'Operator infrastructure an app admin must not see: Docker, Traefik and GitLab health, stack drift, the Infrastructure page, the telemetry store, trace export, the env viewer, ops console, chaos, restore drills, config drift, SQL checks and cross-tenant Traffic Map lenses.'
        ],
        [
          'T6',
          'multi-tenant',
          'Off in every multi-tenant process today and not safe to turn on yet. Each has a note in the inventory saying what a shared deployment would need (see the list below).'
        ],
        [
          'T7',
          'multi-tenant',
          'Protections against tenant admins on a shared process: outbound hosts a tenant may not choose, and process-wide credentials a tenant may not read or set.'
        ],
        [
          'C1',
          'cloud',
          'The meta database, `cloud_tenants`, `getMetaDb`, the meta URL as a connection.'
        ],
        [
          'C2',
          'cloud',
          'Cloud operator routes (`/admin/provision`, `/admin/migrate`, migration status, configure-storage, push-relay, traffic-tenants) and the `nivaro_template` migrations.'
        ],
        ['C3', 'cloud', 'Cloud extensions: `loadCloudExtensions`, `ctx.cloud`, cloud UI bundles.'],
        [
          'C4',
          'cloud',
          'The cloud edge and domains: `CLOUD_BASE_DOMAIN` canonical origin, `CLOUD_MARKETING_URL`, `EDGE_AUTH_SECRET`, `X-Tenant-Host` trust, and the billing suspended and provisioning pages.'
        ],
        [
          'C5',
          'cloud',
          'Protections for untrusted customers that an operator-run deployment does not need: `/api/health` `cloud`. `SSRF_ALLOW_HOSTS` is an operator list and is honoured on a shared deployment.'
        ]
      ]
    },
    { type: 'h3', id: 'deployment-modes-t7', text: 'Rule T7: tenant-admin protections' },
    {
      type: 'p',
      text: 'On a shared deployment an app admin must not be able to point the process at hosts or credentials that belong to the operator. These protections apply on a shared deployment exactly as in cloud:'
    },
    {
      type: 'ul',
      items: [
        'Huddle media servers: in Nivaro Cloud they come from the platform `HUDDLE_LIVEKIT_URL`, `HUDDLE_TURN_URLS` and `HUDDLE_STUN_URLS`. A shared deployment (0.3.215) is run by one operator for their own apps, so each app uses the servers it saved; what the deployment itself dials (the media server test and clean-up calls, Test TURN) goes through the SSRF guard, and `ws://` to the same computer is refused.',
        "There is no env push-relay key: `MOBILE_PUSH_RELAY_KEY` is ignored on a shared deployment. An app admin connects the app's own push relay in Settings → Mobile app, and phone push runs per app.",
        'The SSRF guard applies to URLs an app admin sets (webhooks, link preview, the flow webhook operation): pinned address, every redirect re-checked.',
        'Ending maintenance in one app does not end the operator deployment-wide freeze (see Per-app jobs and maintenance below).'
      ]
    },
    { type: 'h3', id: 'deployment-modes-sessions', text: 'Sign-ins belong to one app' },
    {
      type: 'p',
      text: 'The apps of a shared deployment share one Redis and one `SESSION_SECRET`, and they are often copies of each other (development, staging and production with the same user ids). So a session belongs to the app it was started on: it carries that app, and another app reads it as no session at all (401 `NOT_SIGNED_IN`), never uses, changes, lists or signs it out. A session from before this rule carries no app and asks for a new sign-in once. Sockets and GraphQL subscriptions follow the same rule: a socket cookie, a live-connection token or a View-as token from another app (or one that names no app) signs nothing in.'
    },
    {
      type: 'p',
      text: 'The app is chosen by the `Host` header. `X-Forwarded-Host` counts only when the request comes through a proxy that `TRUST_PROXY` trusts (a hop count such as `1`, or the proxy addresses), and then only its last entry, the one that proxy added (requests, sockets and GraphQL subscriptions alike); with `TRUST_PROXY` unset a client cannot pick another app with that header. Cloud keeps its edge rule (`X-Tenant-Host`) unchanged.'
    },
    { type: 'h2', id: 'deployment-modes-env', text: 'Shared deployment variables' },
    {
      type: 'table',
      head: ['Variable', 'Meaning'],
      rows: [
        [
          '`HUB_SHARED_DEPLOYMENT`',
          'The deployment key (1 to 64 characters: lowercase letters, digits, dashes). Setting it turns the process into a shared deployment. It cannot be combined with `CLOUD_META_DB_URL` or with `HUB=on`; boot refuses with a plain sentence. Set it as a plain environment variable: the image healthcheck reads `HUB_SHARED_DEPLOYMENT` itself and does not read `HUB_SHARED_DEPLOYMENT_FILE`.'
        ],
        [
          '`HUB_URL`',
          "The origin of the Nivaro Hub that lists this deployment's apps: an https origin with no path, user or password; plain http only for localhost, 127.0.0.1 and [::1], and never when NODE_ENV is production. A blank value counts as unset; any other value that breaks the rule is ignored with one boot warning (it never stops a self-hosted boot), and a shared deployment, which needs its Hub, then refuses to start with that rule. Every reader of HUB_URL uses the one check in `services/deployment-mode.ts` (`hubUrlCheck`). (In phase 1 this variable was reserved and did nothing; with HUB_SHARED_DEPLOYMENT it is required.)"
        ],
        [
          '`HUB_DEPLOYMENT_TOKEN`',
          'At least 32 characters. Sent as a bearer token to the Hub tenants call. It never appears in a log, an error or a readiness text. `HUB_DEPLOYMENT_TOKEN_FILE` works like every other setting that can be read from a file.'
        ],
        [
          '`HUB_TENANTS_REFRESH_MS`',
          'How often the list is refreshed. Default 30000, minimum 5000. An unknown host forces one extra refresh, at most once per 5 seconds.'
        ],
        [
          '`TENANT_JOB_CONCURRENCY`',
          'How many apps one scheduled-job fan-out runs at once. Default 4, range 1 to 16.'
        ],
        [
          '`HUB_TOKEN`',
          'The token an app answers the Hub link with (`GET /api/hub-link/status`). It is not honoured on a shared deployment (rule T4): the hub link routes are not mounted there, and the log says so ("HUB_TOKEN is set on a deployment that serves many apps").'
        ]
      ]
    },
    {
      type: 'note',
      text: 'A shared deployment also needs a Redis, an ENCRYPTION_KEY if it should keep the last good app list across a restart, and SESSION_SECRET, as in every mode. SQLite apps cannot be served on a shared deployment. The release image healthcheck probes `/api/ready` on a shared deployment, as in cloud: a probe to 127.0.0.1 names no app, so `/api/version` would answer 503 or 404 and the container would be restarted in a loop.'
    },
    { type: 'h2', id: 'deployment-modes-hub-source', text: 'The Hub tenants contract' },
    {
      type: 'p',
      text: 'A shared deployment asks its Hub which apps it serves: `GET {HUB_URL}/api/hub/shared/{deployment}/tenants` with `Authorization: Bearer <HUB_DEPLOYMENT_TOKEN>`. The Hub serves it from its shared deployments (see Shared deployments), which also adds two optional fields (`origin`, `encryption_key`).'
    },
    {
      type: 'pre',
      code: `{
  "data": {
    "deployment": "shared-eu-1",
    "generated_at": "2026-11-21T18:00:00Z",
    "tenants": [
      {
        "id": "acme-prod",
        "app_key": "acme",
        "env_key": "production",
        "name": "Acme",
        "status": "active",
        "hostnames": ["acme.example.com"],
        "db": { "client": "pg", "connection": "postgres://..." },
        "pool_max": 5
      }
    ]
  }
}`
    },
    {
      type: 'table',
      head: ['Field', 'Rule'],
      rows: [
        [
          '`id`',
          '1 to 64 characters of lowercase letters, digits and dashes. Unique in the list. Per-app jobs, caches and Redis keys use it, never the app key (an app key repeats across environments).'
        ],
        [
          '`status`',
          '`active`, `maintenance`, `suspended` or `provisioning`. Active and maintenance apps are served and listed for jobs (a job then skips an app whose own maintenance setting is on); the others get a neutral blocked page.'
        ],
        ['`db.client`', '`mssql`, `pg`, `mysql2` or `mariadb`.'],
        ['`pool_max`', 'Optional, 1 to 20. Omitted = the default tenant pool size.'],
        [
          '`hostnames`',
          'At least one. A listed port is kept for the app origin only; routing matches the bare hostname.'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'The answer carries every app database connection. Nothing in Nivaro writes a connection string into a log line, an error or a readiness check, and the stored copy of the list is sealed.'
    },
    { type: 'h3', id: 'deployment-modes-hub-rules', text: 'How the list is applied' },
    {
      type: 'ul',
      items: [
        'TLS is always verified for the Hub call. NODE_TLS_REJECT_UNAUTHORIZED=0 (set in some dev environments) cannot switch it off.',
        'Before the first list has loaded (from the Hub, or from the sealed copy in Redis), every app answers 503.',
        'The last good list is kept through a Hub outage: a 5xx, a timeout, a refused token or a body that is not a tenant list never empties the deployment. The list is also kept sealed in Redis (`nvr:tenancy:hub:<deployment>`), so a restart during an outage still serves. Without ENCRYPTION_KEY the copy is memory-only and readiness warns.',
        "An answer for another deployment key never replaces this deployment's list.",
        'Ports are stripped for routing. A hostname listed as `a.example.com:8443` matches requests and sockets on `a.example.com`.',
        'Clashes drop BOTH tenants: two apps claiming one id, one hostname or one database connection are all left out, so a broken entry can never hand its hostname or database to another app. Dropped apps are named, with a plain reason and never the connection, in the process log (`[tenancy]` lines); readiness shows only how many were dropped.',
        'A body larger than 2 MB, or a call slower than 10 seconds, is treated as a failed refresh.'
      ]
    },
    {
      type: 'p',
      text: 'Readiness check `tenant-registry` fails when no list was ever loaded, and warns when the list has not been confirmed for 5 minutes, when it is held in memory only, when the Hub listed apps this deployment cannot serve, or when the list holds 0 apps. It only runs on a Hub shared deployment.'
    },
    { type: 'h2', id: 'deployment-modes-jobs', text: 'Per-app jobs and maintenance' },
    {
      type: 'p',
      text: 'A shared deployment (`perAppJobs()`) schedules the app-scoped core jobs; Nivaro Cloud schedules none of them, as before. Some core jobs return at once on any multi-tenant process (GitLab issue sync, huddle crons) and are not registered there either.'
    },
    {
      type: 'ul',
      items: [
        "App jobs read or write one app's database, files or people. The job fires once, and the fan-out runs it once for every active app, each run inside that app's tenant context, at most `TENANT_JOB_CONCURRENCY` apps at a time. One app failing or hanging never stops the others. Job-run rows land in that app's own database. An app in maintenance mode is skipped, and an app whose previous run is still going is skipped.",
        "No deployment-wide (`process`) core job runs on a shared deployment yet. The two there are (the pool monitor and the socket-count sample) only write to the static database, so they are registered self-hosted only until a deployment store exists for them. Every job's scope is listed in `services/cron-scope.ts`; a test fails when a core job is missing from it, and the boot log names any job registered without a scope.",
        "Some core jobs only make sense self-hosted and are not registered on a shared deployment (`SELF_HOSTED_ONLY_CRONS` in `services/cron-scope.ts`, each with its reason): the restore drill, fault drills, Docker host and Traffic Map history jobs, huddle crons, the help-video render sweep (no app owns a queue there: each publish renders its own video in its own app, and publishes from two apps render one after the other through the deployment-wide heavy slot), and the storage snapshot (it walks the upload folder on disk, outside the per-app scope). File cleanup and session recording tiering run per app, because every object key is under that app's own prefix. The import drainer, live SLA flips, the cumulative-flow rollup, automatic mail retry, the daily retention pass and (from 0.3.215) the outside-write watch run per app; the watch looks at SQL Server apps only, each look of an app held to about 4 seconds (the rest is read next look). The boot warn line `[cron] shared deployment` counts the app jobs and the jobs left out.",
        "Extension jobs default to `app`. An extension job that serves the process passes `scope: 'process'` in `ctx.cron.schedule(id, expression, fn, { scope })`. The option is ignored in cloud and self-hosted, so existing extensions need no change.",
        "An app admin can pause and resume a job for their own app only. The pause is that app's own `paused_crons` setting; the process-wide paused set is never touched. Pausing a process-scoped job answers 409.",
        "Schedules, time zones, chains and overrides are deployment-wide: `PATCH /api/cron/:id` and the revert route answer 409 `SCHEDULE_IS_DEPLOYMENT_WIDE`, and an app's `sla_timezone` does not move the cron zone.",
        "Per-app housekeeping on a shared deployment: a daily `job-runs-prune` app job keeps each app's job-run history to the self-hosted rule (30 days, newest 50 per job), and 30 seconds after boot the restart clean-ups run once per app (job runs and Data Integrity runs a restart left 'running' are closed), best-effort.",
        'The miss detector skips process jobs (they have no per-app run to miss) and skips jobs the current app paused.',
        "Run now runs an app job for the caller's app only. Run now or a dry run of a process job from an app answers 409 `SCHEDULE_IS_DEPLOYMENT_WIDE`, like pausing it.",
        "In cloud, core and cloud-extension crons do NOT fan out per tenant (`perAppJobs()` is false), so the cloud extensions' cross-tenant crons keep working."
      ]
    },
    {
      type: 'p',
      text: "Maintenance is per app: an app admin turns their own maintenance banner or page on and off with their own settings, and the cached answer is kept per tenant. The operator can still freeze the whole deployment with the Redis key `<REDIS_CHANNEL_PREFIX>nvr:maintenance` (just `nvr:maintenance` when the deployment sets no prefix). On a multi-tenant process an app admin's End maintenance only ends their app's own setting; it never deletes the operator's deployment-wide freeze."
    },
    { type: 'h2', id: 'deployment-modes-not-yet', text: 'Not yet on shared deployments' },
    {
      type: 'p',
      text: "Phase 6 closed the gaps that made a shared deployment unsafe or lossy: each app is migrated on its own, with its own default workspace and the allowed extensions' schema steps; the extension allow-list; core record hooks (activity log, revisions, webhooks, alerts) and event flows per app; files under a per-app prefix; the app's own encryption key and origin; credentials bound to their app; and a per-app copy of the config caches. What is still off is a short deferred list. It is kept in one place, with the check the Hub makes when an app that uses the feature is moved in: see What a shared app cannot do yet in Shared deployments. The inventory of every site is `api/src/test/fixtures/cloud-flag-inventory.json` (look for `phase6`)."
    },
    {
      type: 'ul',
      items: [
        'GitLab issue sync and the flow `exec-script` operation. Staged imports, row schedules, the Microsoft directory, the Teams bot, phone push and automatic mail retry work per app on a shared deployment (each app saves its own directory registration, bot and push relay); they stay off in Nivaro Cloud.',
        'Config epochs per tenant (`CACHE_EPOCH`): the metadata caches expire on their own TTL.',
        'The self-hosted-only jobs above. Boot passes against a database run once per app when it becomes ready.'
      ]
    },
    {
      type: 'note',
      text: 'A few messages still say "cloud mode" on a shared deployment too (the Teams bot reason, and the leak-audit, socket-capture and export-limit refusals). The behaviour is correct; only the wording is still to be tidied.'
    },
    { type: 'h2', id: 'deployment-modes-guard', text: 'For developers: the cloud-flag ratchet' },
    {
      type: 'p',
      text: 'Never read `CLOUD_META_DB_URL` (or `HUB_SHARED_DEPLOYMENT`) yourself. Call `isMultiTenant()` (one process, many apps) or `isNivaroCloud()` (Nivaro Cloud the product); `services/deployment-mode.ts` is the one module allowed to read the variables. `api/src/test/unit/cloud-flag-guard.test.ts` fails otherwise.'
    },
    {
      type: 'p',
      text: 'The guard scans api/src (tests and migrations excluded) for every test of the cloud flag. Each one is an entry in `test/fixtures/cloud-flag-inventory.json` with a `meaning` (multiTenant or nivaroCloud), a `rule` (T1 to T7, C1 to C5, above), a one-line `why`, its batch, and a `phase6` note for every T6. The checks:'
    },
    {
      type: 'ul',
      items: [
        '(a) every scanned site is in the inventory and every entry is still there;',
        '(b) every entry is classified: C rules go with nivaroCloud, T rules with multiTenant, T6 carries `phase6`;',
        "(c) a converted file contains no raw reads and exactly the predicate calls its inventory classifies (new calls written after the inventory are declared in the test's `EXTRA_CALLS` with a comment saying why);",
        '(d) only `deployment-mode.ts` reads `HUB_SHARED_DEPLOYMENT` and `HUB_DEPLOYMENT_TOKEN`;',
        '(e) the ratchet is closed: every batch is converted, so a new raw read anywhere fails the test.'
      ]
    },
    { type: 'h3', id: 'deployment-modes-guard-add', text: 'Adding a new site' },
    {
      type: 'ul',
      items: [
        'Ask which question you mean. "Does this exist because many apps share a process?" is `isMultiTenant()`. "Is this the hosted product?" is `isNivaroCloud()`. A per-call read stays per-call; a module-level constant stays module-level.',
        'A block that guards two things with different meanings is split, so each statement carries its own predicate.',
        'If the new code is an additional predicate call in a file the inventory already covers, bump the count in `EXTRA_CALLS` with a comment; otherwise add an inventory entry.',
        'Regenerate the skeleton with `cd api && node --import tsx ../scripts/cloud-flag-inventory.mts` (new entries come out with `meaning: null`), then classify by hand: rule, why, and `phase6` for every T6.',
        'A new route that reads a process-wide credential or an outbound host a tenant admin could set is a T7 site.'
      ]
    },
    { type: 'h3', id: 'deployment-modes-guard-limits', text: 'What the scanner does not see' },
    {
      type: 'p',
      text: 'The scanner lexes TypeScript into code, comments, strings, template text and regex literals, so a `//` inside a string is not mistaken for a comment. It finds raw reads, `process.env` parameters, file-local helpers (one-line arrows or functions of at most three lines returning the read), boolean module constants, helpers left behind, and calls of exported helpers. Known limits:'
    },
    {
      type: 'ul',
      items: [
        'A read that is destructured, used with `in`, or reached through another object is not a site; a token backstop (`strayTokens`) refuses any other mention of the variable names, except on comment lines and in message strings.',
        'Regex versus division after `)` is a heuristic.',
        'A multi-line export of a flag, and a key split across two strings, can escape the backstop.',
        'A flag exported to other modules is refused outright, because importers are not scanned.'
      ]
    }
  ]
}
