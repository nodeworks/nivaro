import type { DocSection } from '../types.js'

// Phase 6 operator docs, checked against the merged code (Tasks 1 to 18 and 22). Codes, routes
// and step names here are the real ones from api/src/services/hub/{shared,move}, the routes
// hub-shared*.ts and hub-move.ts, and admin/src/pages/hub/{shared,move}.

export const hubSharedDocs: DocSection = {
  id: 'hub-shared',
  label: 'Shared deployments',
  content: [
    { type: 'h1', id: 'hub-shared', text: 'Shared deployments' },
    {
      type: 'p',
      text: 'A shared deployment is one Nivaro process (or a few replicas of it) that serves many apps. The Hub keeps the list of apps it serves, hands each app its own database, encryption key, origin and pool size, and upgrades the deployment as a whole. Each app keeps its own database, users, files and settings: nothing an app holds is shared with another app. This page is for the people who run the Hub and its shared deployments. How a shared deployment behaves as a process is in Deployment modes.'
    },
    {
      type: 'warn',
      text: 'A shared deployment holds the database connection of every app it serves, and every app runs in the same Node process. Put only apps that trust each other\'s operators on one deployment. An app that needs a feature in "What a shared app cannot do yet" stays on its own stack until that feature exists.'
    },
    { type: 'h2', id: 'hub-shared-modes', text: 'Two modes: registered and docker' },
    {
      type: 'table',
      head: ['Mode', 'Who runs it', 'What the Hub does'],
      rows: [
        [
          '`docker`',
          'The Hub, through the agent, on a Docker driver.',
          'Writes the stack (role `all` at small, separate web, worker, importer and exporter services at medium and large; bundled or external Redis), applies it, and upgrades and rolls it back. The stack is owned by the deployment key, never by an app. The Hub makes `SESSION_SECRET` and `ENCRYPTION_KEY` once and keeps them sealed.'
        ],
        [
          '`registered`',
          'Someone outside the Hub, for example your own pipeline.',
          'Gives you the environment block and the token, shows what the deployment reports, and records a version change it notices as an observed deploy. It never deploys or upgrades the deployment. Upgrades driven by GitLab are not built: a deployment run from a GitLab pipeline is registered and upgraded by that pipeline.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Mode and key cannot be changed after the deployment is created. A Docker deployment is created without a version (`BAD_VERSION` otherwise): its first upgrade sets it. Create the deployment on the Shared deployments tab of the Apps hub (the tab after Apps; Hub administrators only): the New button opens an inline panel in the detail pane, and editing uses the same panel. The key is 2 to 63 characters (lowercase letters, digits and dashes) and starts with a letter. The link address must be https, with no user, password or path. Plain http is accepted only for a loopback or private address, and only when the Hub does not run with `NODE_ENV=production`: on a production Hub an http link address is refused, so use https (or a name with a certificate).'
    },
    { type: 'h2', id: 'hub-shared-token', text: 'The token and the environment block' },
    {
      type: 'p',
      text: 'Creating a deployment shows its token once, with the environment block to copy. Session replay and Report a problem screenshots record a blank box where it shows, never the token itself. Later the token reads as ••••••. The one token works both ways: the deployment uses it to ask the Hub for its tenant list, and the Hub uses it to call the deployment link. The Hub never sends the token itself to the link: both sides derive a bearer from it (HMAC-SHA256 of the token over a fixed label), so a sniffed link call cannot open the tenants route.'
    },
    {
      type: 'table',
      head: ['Variable', 'Meaning'],
      rows: [
        [
          '`HUB_SHARED_DEPLOYMENT`',
          'The deployment key. Setting it turns the process into a shared deployment. Set it as a plain variable, not a file.'
        ],
        [
          '`HUB_URL`',
          "The Hub's https address. The Hub puts its own `HUB_URL` (or `PUBLIC_URL` when that is unset) in the block and says which one it used; set `HUB_URL` on the Hub so the block is right."
        ],
        [
          '`HUB_DEPLOYMENT_TOKEN`',
          'The token, at least 32 characters. A secret, never a plain environment variable: in docker mode the Hub keeps it sealed and passes it to the stack as a swarm secret; in registered mode put it in your own secret store and pass it as a file (`HUB_DEPLOYMENT_TOKEN_FILE`) or a secret. `_FILE` works.'
        ],
        [
          '`HUB_SHARED_EXTENSIONS`',
          'Comma list of extension ids this deployment may load (below). The Hub sets it in docker mode; you set it in registered mode.'
        ],
        [
          '`SESSION_SECRET`, `ENCRYPTION_KEY`, `REDIS_URL`',
          "As in every mode. `ENCRYPTION_KEY` is the deployment's own key (it seals the kept copy of the tenant list); each app's own values use that app's key. There is no `DB_*` setting: a shared deployment has no database of its own."
        ],
        [
          '`TRUST_PROXY`',
          'Needed behind a proxy so the app is picked from the real `Host` (see Deployment modes). A docker-mode stack sets `TRUST_PROXY=1` itself; in registered mode you set it.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Rotating the token shows the new one once. The previous token keeps working for 24 hours so replicas can be rolled over. In docker mode the Hub applies the stack again with the new token. After 24 hours a replica that still sends the old token is refused, and the failed-token brake counts per address: replicas behind one egress address that all send an expired token lock that address out for a minute at a time (20 tries). Rotate, then roll the new token out to every replica inside the 24 hours. In docker mode the stack only learns the new token when it is applied again, so the rotation answer carries `reapply` and `reapply_reason`: the Hub starts that apply itself (`started`), or says why it did not (`reapply_reason`: for example `NOT_DEPLOYED` before the first deploy, `LAST_RUN_FAILED` after a failed or interrupted run, when applying the pin again would be an unasked rollback, or the first plan blocker). A registered deployment answers `manual`: you apply the new token yourself. While the stack of a Docker deployment still runs with the old token, its page warns `TOKEN_NOT_APPLIED` until a run started after the rotation succeeds: upgrade it at the version it runs before the 24 hours end, or it loses its app list and its link.'
    },
    { type: 'h2', id: 'hub-shared-extensions', text: 'Extensions: HUB_SHARED_EXTENSIONS' },
    {
      type: 'ul',
      items: [
        'A shared deployment loads only the extensions listed in `HUB_SHARED_EXTENSIONS`. It never scans the extension folder for others, and an unlisted folder is never imported.',
        'On a shared deployment the extension folder must be named by the extension id. A listed folder whose extension declares another id is not loaded.',
        'A listed extension must also declare `shared: true` in its definition. It promises that every cache, module variable and connection it keeps is held per app. An unflagged listed extension is refused: it is not loaded, the extension registry shows it as an error, and the readiness check `shared-extensions` fails and names it with the reason.',
        'The contents of a listed folder are trusted. Its module is imported before its id and flag are compared, so list only folders you control.',
        'An edit that drops an extension an app on the deployment still uses is refused (`EXTENSION_IN_USE`, naming the app and the extension): move that app off first, or keep the extension.',
        'An app whose extensions are not all in the list cannot be placed (`EXTENSION_NOT_ALLOWED`). An app that pins another version of a listed extension than the deployment runs gets `EXTENSION_VERSION_DIFFERS`. The deployment reports what it loaded; the detail page warns when that differs from the Hub list.',
        "An extension keeps its state per app through `ctx.apps`: `key()` names the app a request or job serves (empty self-hosted and outside any app), `many()` says the process serves many apps, `origin()` is the app's own origin for links it sends, and `registerKeyed(container)` lets the core drop an app's entries when the app leaves the deployment. A cache, memo, guard or in-flight promise that does not put `key()` into its key may answer one app with another's data, often a copy with the same record and user ids. The core's own portal links (notifications, mail, `ctx.links`) follow the same rule: an app links to its own `portal_url` only, never to a portal an extension registered from the deployment's environment at boot; without one they open the app's own admin, and the core logs `portal_url is unset` once per app. A core that provides `ctx.apps` says so before it imports any extension (extension-kit `coreProvidesApps()`); an extension that relies on it declares `shared: true` only then, so an older core refuses it.",
        "efp-ops declares `shared: true` only on a core that provides `ctx.apps`, and refuses to register on a multi-app process without it. Per app on a shared deployment: every cache, memo, guard and in-flight promise it keeps (its own guard test lists each one, and each is dropped when the app leaves); the integration user and its token; its payload templates (seeded into each app by the core, see Per-app migrations); the admin-digest column (a schema step); email links (the app's own `portal_url` setting, else the app's own admin origin with one warning per app in the log, never `EFP_PORTAL_URL`); LinX obligation attribution (each LinX kind is registered once and names the app's own LinX row, resolved per app when it is used, so the kinds list shows each kind once per app). Not run on a shared deployment: the data repairs (they run a script against the process's own database) and the start-up hold-age recompute (the nightly job runs per app). The same for every app on the deployment: environment settings such as `EFP_NUVOLO_USER`, `EFP_INTEGRATION_USER` (each app's `integration_user` setting wins), `EFP_OPS_TAKEOVER`, `EFP_MATCH_TOLERANCE_*` and `MAIL_TEST_MODE`.",
        "An in-process call made inside an app reaches that app: an extension's `ctx.app.inject`, the core's call-as-caller (item actions such as Push to Fusion, bulk pushes) and any other `.inject` on the process. When the call names no Host, `authority` or absolute URL, the core adds the app's own host (its verified origin, else the first host the Hub lists for it). A call made outside any app goes as written and serves no app; the chain form `inject().get(\u2026)` is not covered. Nivaro Cloud and self-hosted deployments are unchanged.",
        'The `shared` field is part of `@nivaro/extension-kit`. A kit release has to be published (or the kit rebuilt) wherever an extension type-checks against a released kit, before it can declare the flag.',
        'Extension pins are in image form only: `<repo>@sha256:<64 hex digits>`. A version string such as `1.4.0` is refused (`BAD_EXTENSIONS`), because a shared deployment installs exactly the image the pin names. A listed extension with no pin makes the plan stop with `EXTENSION_UNPINNED`, and the Hub agent must allow the image repository (`EXTENSION_NOT_ALLOWED` and `IMAGE_NOT_ALLOWED` in the upgrade plan).'
      ]
    },
    { type: 'h2', id: 'hub-shared-names', text: 'Host pattern and explicit hosts' },
    {
      type: 'p',
      text: 'A deployment can carry a host pattern such as `*.apps.example.com`. In docker mode the stack answers every name under the pattern with one router, so a new app under it needs no stack change. A name outside the pattern is listed as an explicit host on the stack (at most 10).'
    },
    {
      type: 'ul',
      items: [
        'Shared deployments need Traefik v3. The pattern is a Traefik v3 `HostRegexp` rule with priority 1, so any exact `Host()` rule from another stack wins over it.',
        "A wildcard name needs a wildcard certificate. If the stack's router uses a certificate resolver, the wildcard needs a DNS-01 challenge (an HTTP challenge cannot issue a wildcard). Or make the wildcard certificate Traefik's default certificate, as the Hub does for apps it creates.",
        'The pattern must sit under the agent host suffixes (`HUB_AGENT_HOST_SUFFIXES`). A second stack that claims the same pattern is refused (`HOSTNAME_TAKEN`, field `host_pattern`).',
        "A shared stack's roles are `all` alone or a split with both `web` and `worker`, a `realtime` role allowed beside them from agent 0.2.2 (`ROLE_NOT_SHARED`); the stack's environment must name its own key (`SHARED_KEY_MISMATCH`). These two agent field codes join the others in Docker driver and Hub agent.",
        'An agent older than 0.2.0 answers `UNKNOWN_FIELD` for `host_pattern` and `REQUIRED` for an empty `hostnames` list. Update the agent before deploying a shared stack.'
      ]
    },
    {
      type: 'p',
      text: 'The Hub agent image has to be 0.2.0 or later (`nodeworks/nivaro-hub-agent`; publish the tag `@hub-agent-0.2.0` first, the release step is in Docker driver and Hub agent). A plan against an older agent stops with `AGENT_TOO_OLD`. A medium or large stack (split into web, worker, importer and exporter) needs agent 0.2.2 or later (`@hub-agent-0.2.2`): an older agent refuses the split and the exporter role, so its plan stops with `AGENT_TOO_OLD` too; small (one `all`) still needs only 0.2.0. The stack size sets the services (`settings.size`, default small). The stack sets no sticky cookie on a multi-replica service: clients connect over websockets first, and the long-polling fallback may bounce between replicas. If you front the stack with a proxy that needs stickiness, add it there.'
    },
    {
      type: 'table',
      head: ['Size', 'Services (replicas)', 'Notes'],
      rows: [
        [
          'small',
          '`all` ×1',
          'One process does everything: serves, ticks crons, drains imports and media.'
        ],
        [
          'medium',
          '`web` ×2, `worker` ×1, `importer` ×1, `exporter` ×1',
          "Web runs with `CRON_TICKS=off`. The worker is the only process that ticks crons, so every app's scheduled jobs, row schedules and 10-second import tick run there. The importer runs every app's staged imports, the exporter every app's background exports."
        ],
        [
          'large',
          '`web` ×3, `worker` ×1, `importer` ×1, `exporter` ×1',
          'As medium, with a third web replica.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Every service serves every app on the deployment: the same variables (`HUB_SHARED_DEPLOYMENT` and the deployment-wide `settings.env` included), the same secrets and the same extensions. Only `NIVARO_ROLE` differs. Each service gets 2 CPUs and 4 GB per replica.',
        "The importer drains an app when an upload kicks it, and also passes over every ready app every 10 seconds, so a run put back after its process died starts without a new upload. It runs no migrations: it drains an app only once the migrating services have stored that app's schema as ok at this version. While it checks in for an app, the worker leaves that app's imports to it; when it stops, the worker takes over within 90 seconds.",
        "The exporter runs background exports the same way, app by app: a web process hands an app's export to it while it checks in for that app, a kick starts it at once, and it passes over every ready app every 10 seconds. Like the importer it runs no migrations and reads each app's stored schema state. While it checks in for an app, the importer and the worker leave that app's exports to it; when it stops, the importer takes them over, then the worker, within 90 seconds.",
        'A large stack also runs `realtime` ×2 (1 CPU and 2 GB per replica): the live connections of every app (Socket.io, graphql-ws and the event streams), each resolved to its app by the host it was opened on, while web runs `SOCKETS=off`. It needs an image from 0.3.212, the Traefik edge with v3 labels and agent 0.2.2; otherwise (and at medium) web keeps sockets on. The agent routes the live paths of the host pattern to it with a pattern router of its own (priority 2, above the web pattern router, below any explicit name).',
        'Changing the size is an upgrade: the plan lists the services it deploys (`roles`), what the last run deployed (`roles_from`, `all` for a run before the split) and warns `ROLES_CHANGE` with the services added and removed. The agent creates the new services before it removes the old ones. Only an upgrade changes the services: an apply that is not one (after a token rotation or a new Redis address, or a move adding or removing a name) keeps the services the stack runs, and every successful run records the services it applied. A stack that runs web, worker and importer gains the exporter on its next upgrade (`ROLES_CHANGE` adds exporter). Stats such as live replicas count every process, importer, exporter and worker included.'
      ]
    },
    {
      type: 'p',
      text: 'Bundled Redis is the default. With external Redis (stack setting `redis: external`) set the address as a write-only secret: `PATCH /api/hub/shared/:id` with `{secrets: {REDIS_URL: "rediss://…"}}` (a `redis://` or `rediss://` address; `null` or an empty string clears it). It is kept sealed, read back only as `••••••`, never logged, and it applies on the next stack apply (the PATCH starts one, like a token rotation). Give each shared deployment its own Redis database: the maintenance flags and other per-database keys are not scoped to a deployment, so two deployments (or a deployment and an app) on one database would read each other\'s, and one would stop the other\'s scheduled jobs. A different channel prefix does not help: most keys carry none. The plan stops with `REDIS_DB_SHARED` when another stack the Hub runs uses the same database (host, port and database number), and with `REDIS_URL_MISSING` without the secret.'
    },
    {
      type: 'p',
      text: "Plan blockers about routing: `PATTERN_NOT_ALLOWED` (the pattern is outside the agent host suffixes), `HOSTNAME_NOT_ALLOWED`, `TOO_MANY_HOSTNAMES`, `NO_ROUTE` (no pattern, no explicit name and no publish port), `PUBLISH_PORT_NOT_ALLOWED`, and `HUB_URL_UNUSABLE` (the address the stack would get as `HUB_URL` is not an https origin a deployment accepts). Warnings: `HUB_URL_PROBLEM` (the Hub's own `HUB_URL` is ignored and its public address is used instead) and `MULTI_NODE_VOLUMES` (the swarm has several nodes and local volumes: uploads and bundled Redis stay on the node a task first ran on)."
    },
    { type: 'h2', id: 'hub-shared-pool', text: 'Pool budget' },
    {
      type: 'p',
      text: 'Each placement on a shared deployment carries a pool size (2 to 20 connections for a shared placement, default 5: one connection holds the migration lock while another migrates, and fewer than 2 is refused with `POOL_TOO_SMALL`). The deployment has a pool budget (default 60, range 1 to 500). A placement that would take the sum of pool sizes over the budget is refused with `POOL_BUDGET`. The budget is per process: with three replicas the database sees up to three times the sizes. Inside a process the apps also share the heavy-read slots fairly (see Per app on a shared deployment).'
    },
    { type: 'h2', id: 'hub-shared-migrations', text: 'Per-app migrations and the not-ready page' },
    {
      type: 'ul',
      items: [
        "When an app enters the list, or the deployment's version changes, the deployment migrates that app's database, at most 2 apps at a time. It takes the per-engine advisory lock (a transaction advisory lock on Postgres, an application lock on SQL Server). MySQL and MariaDB take a server-wide lock, so two apps on one MySQL server migrate one after the other, not together.",
        'After the migrations it makes sure the default workspace row exists, runs the schema steps of each allowed extension, then the per-app seeds: rows an extension writes at boot (its payload templates) reach each app here, because boot runs outside any app on a shared deployment. The seeds also run when the deployment adopts an app another replica (or an earlier process) migrated, so a release that changes a template reaches every app. They insert what is missing and update registrar-owned metadata, never a body someone published; a failed seed is logged and does not block the app.',
        'Until that finishes the app answers `503 APP_NOT_READY` ("This app is getting ready"), as a plain page for browsers and as JSON for the API. `/api/version` still answers for that app, so the Hub can check it. Scheduled jobs skip the app with the reason `not_ready`.',
        'A failure blocks only that app. The other apps keep serving. The error is scrubbed of connection strings and logins, at most 300 characters, and the app is tried again no sooner than 5 minutes later. "Another process is migrating" is not a failure: the app stays pending and is tried again after 30 seconds.',
        'The state is kept in Redis under `nvr:tenancy:schema:<tenant id>:<version>`, so a restarted replica adopts it instead of migrating again. A stored "ok" is checked against the newest migration every 5 minutes, so a database that was replaced or restored behind the deployment is migrated again. The key carries the version so a rolling upgrade does not make two versions fight over one value.',
        "Readiness: `app-schemas` shows the app's own state inside an app and, outside any app, warns naming the tenant ids that failed. `shared-extensions` fails for a refused extension. The deployment link `status` lists every app's schema state."
      ]
    },
    { type: 'h2', id: 'hub-shared-storage', text: 'Files, encryption key and origin: per app' },
    {
      type: 'ul',
      items: [
        "Storage scope. Where files live in the deployment storage (the env-driven provider), every object key is prefixed `apps/<tenant id>/`. The prefix applies to saved-settings S3 and Azure drivers too: an app with its own bucket keeps its objects under `apps/<tenant id>/` in that bucket while it runs on a shared deployment, and at the bucket root while it runs on a dedicated stack. So two apps with copied databases (a development copy of production) can never read or delete each other's objects. New keys are flat inside the scope. A key with `..`, a leading `/`, a backslash or a NUL is refused.",
        "Encryption key. Each app's sealed values (stored credentials, tokens) were written with that app's `ENCRYPTION_KEY`. On a shared deployment the app's own key is used, from the Hub's tenant list. If an app has no key a seal or open fails with `APP_KEY_MISSING` (503). It never falls back to the deployment's key or to another app's. A value that belongs to the deployment itself, like the sealed copy of the tenant list in Redis, uses the deployment key (`encryptForDeployment`).",
        'Where the Hub gets the key: the key entered for the environment first; then, once, the Docker stack settings key (copied into the entry); a new key is generated only for a database known to be empty (made by the Hub, or without a `nivaro_migrations` table). A database that already holds an installation has served an app, so placing it is refused (`USE_MOVE`), with or without a known key: move the environment instead (Moving an environment). A GitLab-created app has to have its key entered.',
        'Fingerprints. The Hub and the app compare `keyFingerprint(key)` (a keyed hash, first 32 hex characters). The key itself never crosses the hub link. Saving a key that differs from the one the app reports is refused (`APP_KEY_MISMATCH`); replacing a stored key needs a positive match (`APP_KEY_UNVERIFIED` otherwise); an app that has already served on a shared deployment refuses a different key (`APP_KEY_IMMUTABLE`). There is no operator override in this phase, on purpose: everything the app sealed with its old key (stored credentials, tokens, partner secrets) becomes unreadable under a new one. If you hit `APP_KEY_IMMUTABLE`, do not look for a way around it. Enter the key the app really runs with (check it against the fingerprint the page shows), or, if the key is lost or has to change, contact support: re-keying a live shared app is a support action, and the people who use the app will have to enter its stored credentials again.',
        "Origin. Links in job mail, the phone app and the OAuth issuer use the app's own origin (the origin of its Hub base URL), not the deployment's.",
        'Credentials. Sessions, run-as keys, socket tickets, media tickets, export links and similar signed values are bound to their app, so a value minted in one app is refused in another even when the two databases are copies. The scan that proves it lists every Redis key and every signing site.',
        'Module state. Everything the process remembers for an app (configuration caches, sessions and sign-in state, settings, follow and presence sets) is kept in a slot of its own per app, and a test fails the build when new process-wide state is added without one. When an app leaves the deployment (unplaced, or moved away) its slots are dropped, so a later return starts clean.',
        "What an app administrator cannot see: on a shared deployment the screens that show or act on the whole process answer `403 SHARED_OPERATOR_ONLY`: heap snapshots and their download, restart, the pool, runtime, roster, caches, boot, degradation, clock and in-flight panels, the database and Redis panels of the Database hub (deadlocks, expensive SQL, long transactions, pool, metadata cache, Redis keys, memory and storage), server logs (`swallows`, `env`), the realtime pipeline, probe and delivery panels, `/health/slo` and `/health/detailed`, Telemetry, Infrastructure and the metrics endpoint. They would show one app every other app's data or let it disturb all of them. The deployment operator reads them through the Nivaro Hub. Self-hosted and Nivaro Cloud are unchanged."
      ]
    },
    {
      type: 'note',
      text: "Placing two environments of one app on one deployment is allowed (the usual case is development, staging and production together). The plan warns `SAME_APP_ON_DEPLOYMENT` and nothing more: the protections above are what keep copied databases apart. A copy carries the original's saved Teams bot and directory registration, so turn the bot off on the copy if it should not answer."
    },
    { type: 'h2', id: 'hub-shared-maintenance', text: 'Maintenance and not-ready apps' },
    {
      type: 'p',
      text: 'An environment in maintenance gets "This app is being updated" for browsers and `503 APP_MAINTENANCE` for the API, with a retry hint of 30 seconds. `GET /api/version` for that app still answers (with `shared_deployment` and `tenant`), so the Hub can verify it. A suspended app stays refused on every path. Scheduled jobs skip an app in Hub maintenance (reason `maintenance`) and take no claim on it.'
    },
    { type: 'h2', id: 'hub-shared-link', text: 'The deployment link' },
    {
      type: 'p',
      text: 'The deployment link is the narrow set of routes the Hub uses on a shared deployment, the twin of the per-app hub link. It mounts only on a Hub shared deployment. The bearer is the derived value described above, compared timing-safe. Every route has the failed-auth limiter (20 bad tries a minute, then 429), answers with `Cache-Control: no-store`, and never returns a record, a name or a connection string. It never mounts on a dedicated app or in cloud mode.'
    },
    {
      type: 'table',
      head: ['Route', 'Answers'],
      rows: [
        [
          '`GET /api/hub-deployment/status`',
          'The version, this instance, the list the deployment holds (count, loaded time, etag, stale, apps it dropped and why), every app with its schema state, the extensions it loaded, and the sign-in issuer host and Entra tenant.'
        ],
        [
          '`GET /api/hub-deployment/apps/:id/status`',
          'One app: version, preflight (status and failing check names), readiness score, busy work counts (imports, exports, renders), files (count, bytes, local), the key fingerprint, and whether it is in maintenance. `404 UNKNOWN_APP`.'
        ],
        [
          '`POST /api/hub-deployment/apps/:id/first-admin`',
          'Seeds the first administrator inside that app, the same answers as the hub link route.'
        ],
        [
          '`POST /api/hub-deployment/refresh`',
          'Asks every replica to re-read its tenant list now (202). At most one fetch a second per replica.'
        ],
        [
          '`POST /api/hub-deployment/db-check`',
          'Opens a one-connection pool to a database, reads the migration ledger, closes it. Errors are scrubbed of the connection.'
        ],
        [
          '`POST`, `DELETE /api/hub-deployment/apps/:id/files/ticket`, `POST files/pull`, `GET files/pull/:runId`',
          'Mints (and revokes) a transfer ticket for one app, starts a file pull into it, and reads the pull state: the same three calls the hub link has for a dedicated app. Used by moves (Moving an environment).'
        ]
      ]
    },
    {
      type: 'h2',
      id: 'hub-shared-tenants',
      text: 'The tenants contract, with the optional fields'
    },
    {
      type: 'p',
      text: 'The Hub serves the call described in Deployment modes: `GET /api/hub/shared/<key>/tenants` with the bearer. This release adds two optional fields to each tenant, so an old deployment keeps working with the new Hub and the other way round: `origin` (the origin of the environment\'s base URL; a value that is not an http(s) origin is dropped, not the tenant) and `encryption_key` (64 hex characters; a bad key drops that tenant with the reason "bad encryption key").'
    },
    {
      type: 'ul',
      items: [
        'Which apps are listed: every environment placed on this deployment, plus an environment mid-move out of it until the source is retired, plus an environment mid-move into it from the step where the target is placed. Archived environments are left out. An environment whose database record cannot be opened is left out, with a log line naming only its tenant id.',
        'Status on the wire: `active`, `maintenance` (an environment in maintenance, or a target held during a move), `provisioning`, `suspended`.',
        'The tenant id is `<first 48 characters of the app key>-e<environment id>`. It stays the same across moves and is never reused, because environment ids are never reused. (After a restore of the Hub database from a backup that predates an environment, an id could come back. Restore with that in mind.)',
        'The answer has an ETag (a hash of the body without its time). `If-None-Match` equal answers 304. The body is at most 2 MB. An answer is never logged.',
        'Replicas. Each call carries `X-Nivaro-Version` and `X-Nivaro-Instance` (one value per process). The Hub keeps a sighting per instance: its version and which list (etag) it holds. "Every live replica holds the new list" means every instance seen in the last 2 minutes holds the etag. The Hub waits for that before it goes on to a step that depends on it (for example, putting an app into maintenance), and the refresh kick shortens the wait. Sightings are kept in Redis; without Redis they are per process and one warning says so.',
        'A failed token counts against the address, and the failed-token limiter answers 429 after 20 in a minute. Unknown key and bad token give the same 401.'
      ]
    },
    { type: 'h2', id: 'hub-shared-place', text: 'Placing a new environment' },
    {
      type: 'p',
      text: 'An environment that has never served can be placed straight on a shared deployment: Apps → the app → the environment row → Place… (tooltip "Place on shared deployment…"; shown only for an environment still `provisioning`), or `POST /api/hub/environments/:envId/place-shared` with `{shared_id, database_id, pool_max?, first_admin: {email, first_name?, last_name?}}`. An environment that has served moves instead (Moving an environment); a refusal says `USE_MOVE`.'
    },
    {
      type: 'ul',
      items: [
        'Only an environment that has never served: no Hub deploy that succeeded, no finished creation (`CREATION_RUNNING` while one is open), no current dedicated placement (clear it first if it never ran), and, when it has a hub token, an app that does not answer over its hub link. Any answer from that link (even a refused token) means it runs, and so does a database that already holds an install: both answer `USE_MOVE`, so move it instead. No answer, or a database the Hub cannot look at, is `SERVING_UNKNOWN` and never a pass: if the app is gone for good, clear its hub token, then place it again.',
        'A Docker shared deployment must have been deployed first (`NOT_DEPLOYED`: upgrade it to a version), and every name of the environment must already be routed by its stack, under its host pattern or among the names its last run routed (`NAME_NOT_ROUTED`; a place never re-applies the stack, which would restart every app on it). An agent that does not answer is never read as routed. A published-port edge routes no names.',
        'An open move of the environment refuses it (`MOVE_OPEN`, naming the move: resume it or roll it back first).',
        'Before anything is written: the deployment must exist, not be retired and not be busy (`SHARED_RETIRED`, `SHARED_BUSY`); an app that signs in via the Hub needs a deployment at 0.3.215 or later (`SIGNIN_VIA_HUB`) and its extensions must be allowed (`EXTENSION_NOT_ALLOWED`); the database record must be ready and not in use by another environment (`DATABASE_NOT_READY`, `DATABASE_IN_USE`); the pool must be 2 or more (`POOL_TOO_SMALL`) and inside the budget (`POOL_BUDGET`). A Hub database record is never SQLite.',
        "The run (a job run): make the placement and set the environment's database, pin and status `provisioning`; ask every replica to re-read; wait up to 2 minutes for every live replica to hold the list that names the app; wait up to 10 minutes for the app's schema to be `ok` (a failed schema stops the run and names the app's own error); seed the first administrator; set the environment `active`.",
        'A failed run leaves the environment `provisioning` on its placement: place it again to retry.',
        'The Hub keeps no app key it cannot prove: it uses the one it knows, or generates one only for a database known to be empty.'
      ]
    },
    { type: 'h2', id: 'hub-shared-guards', text: 'What a shared-placed environment refuses' },
    {
      type: 'p',
      text: "An environment placed on a shared deployment is never promoted, stacked or created directly. Promote plans block with `SHARED_PLACEMENT`; the stack routes, and creation on it, answer 409 `SHARED_PLACEMENT`. While a move of an environment is open (running, waiting or interrupted), everything that would re-deploy or re-route it answers 409 `MOVE_OPEN` and names the move: a promotion or rollback (plan and start, owners included), Apply now, Restart, an environment edit of its placement, key, names, base URL, version pin or hub token, and placing it on a shared deployment. Removing its stack is not refused, because a halted move may ask for it. The move's own run is never refused by its own move. Change its version by upgrading the deployment, or move it. Changing its placement through the environment edit answers `USE_MOVE`. 'Forget stack' (`POST /api/hub/placements/:id/forget-stack` with `{confirm: <stack name>}`) lets an environment drop a Docker stack that is gone for good: it answers 409 `STACK_RUNNING` while the agent still reports the stack."
    },
    { type: 'h2', id: 'hub-shared-upgrade', text: 'Upgrades and rollback' },
    {
      type: 'p',
      text: 'In docker mode the Hub upgrades the whole deployment in one run: Apps hub → Shared deployments → the deployment → Upgrade (a version picker, then the plan). A registered deployment is upgraded by whoever runs it; the plan says `SHARED_NOT_HUB_DEPLOYED`. The same panel rolls back: pick Roll back and a version this deployment ran successfully through the Hub. A rollback restores the image and the extension pins of that recorded run, not the stack settings (size, Redis mode, host pattern, publish port): those come from the deployment as it is now. The first deploy of a deployment has nothing to roll back to (`NOT_DEPLOYED_BEFORE`).'
    },
    {
      type: 'table',
      head: ['Plan check', 'Meaning'],
      rows: [
        [
          '`SHARED_NOT_HUB_DEPLOYED`, `SHARED_RETIRED`, `BAD_VERSION`',
          'The deployment is registered (the Hub cannot upgrade it) or retired, or the version is not `x.y.z`.'
        ],
        [
          '`BUSY`, `LOCK_UNAVAILABLE`',
          'The deployment or one of the environments on it holds a lock (a move, a placement, another run), or the Hub could not read a lock because Redis did not answer. The plan never treats an unreadable lock as free.'
        ],
        [
          '`VERSION_UNKNOWN`, `AGENT_UNREACHABLE`, `AGENT_TOO_OLD`',
          'The version has no image in the registry the Hub watches, the agent does not answer, or the agent is older than 0.2.0 (0.2.2 for a medium or large stack).'
        ],
        [
          '`NO_DRIVER`, `NO_STACK_NAME`, `IMAGE_NOT_ALLOWED`, `EXTENSION_NOT_ALLOWED`, `EXTENSION_UNPINNED`',
          'The deployment names no Docker driver or stack, the agent does not allow the image or an extension image, or a listed extension has no image pin.'
        ],
        [
          '`PATTERN_NOT_ALLOWED`, `HOSTNAME_NOT_ALLOWED`, `TOO_MANY_HOSTNAMES`, `NO_ROUTE`, `PUBLISH_PORT_NOT_ALLOWED`',
          'The routing the stack would get is not one the agent accepts (see Host pattern and explicit hosts). An agent set for Traefik v2 (`HUB_AGENT_TRAEFIK_VERSION=2`) cannot route a host pattern: the plan blocks `PATTERN_NOT_ALLOWED` until the agent is on Traefik v3 or the pattern is removed.'
        ],
        [
          '`REDIS_NOT_AVAILABLE`, `REDIS_URL_MISSING`, `REDIS_DB_SHARED`, `HUB_URL_UNUSABLE`',
          'Bundled Redis asked for but the agent has no Redis image, external Redis chosen without its address, or the Hub address the stack would get is not a usable https origin.'
        ],
        [
          '`MOVE_OPEN`',
          'A move into or out of this deployment is running, waiting or interrupted; the plan names it. Resume it or roll it back first. The start refuses with 409 `MOVE_OPEN`, and a token rotation does not re-apply the stack meanwhile.'
        ],
        [
          'Per app: `EXTENSION_MISSING`',
          "The app uses an extension the deployment does not load. Never overridable, checked for every kind (a re-apply answers `APP_BLOCKED`): add the extension to the deployment's list."
        ],
        [
          'Per app: `ORDER`',
          'The previous environment of an app has not run this version successfully (the rule that the previous environment of an app must have run this version). A Hub administrator may override it per app in the panel; each override is logged. A previous environment on this same deployment is upgraded in the same run and never counts. Not checked for a rollback or when the version does not change.'
        ],
        [
          'Per app: `PREFLIGHT_FAILING`',
          "The app's own preflight fails on the deployment now, before the upgrade. Overridable per app and logged; not checked for a rollback."
        ],
        [
          'Warnings: `HUB_URL_PROBLEM`, `MULTI_NODE_VOLUMES`, `APPS_AFFECTED`, `ROLLBACK_SCHEMA_AHEAD`',
          "The Hub's own `HUB_URL` is ignored; the swarm has several nodes with local volumes; every app listed is restarted by the run; a rollback restores the build, not the schema, so apps the newer version migrated keep its schema under the older one."
        ]
      ]
    },
    {
      type: 'p',
      text: "The run asks you to type the deployment key, and lists every app on it. Then, holding the deployment lock and the lock of every environment on it (the holder shows as `shared`): render the stack (the deployment's `SESSION_SECRET` and `ENCRYPTION_KEY` are made once and kept sealed), apply it through the agent, wait up to 30 minutes until every replica seen in the last 2 minutes reports the new version and swarm says the stack converged (a swarm that rolls back or pauses the update fails the run at once), wait up to 10 minutes until every app's schema is `ok`, and wait up to 5 minutes for each app's public name to answer `/api/version` at the new version. On success every environment placed here gets the new version pin and one deploy row of kind `shared`, and one job run is written."
    },
    {
      type: 'ul',
      items: [
        'If it fails, the run is `failed` and names the apps that failed (`VERSION_TIMEOUT`, `SCHEMA_FAILED`, `SCHEMA_TIMEOUT`, `VERIFY_FAILED`, `SWARM_ROLLED_BACK`, `SWARM_UPDATE_PAUSED`, `AGENT_UNREACHABLE`). Nothing is reverted by itself: the stack may run the new image while the pins stay unchanged, and the other apps keep serving. A rollback is a new run of the previous version (kind `rollback`) with its own plan.',
        'Cancel is possible while the run waits. A run that has stopped reporting for 2 minutes after a Hub restart shows as `interrupted`; a lost lock stops it the same way.',
        'While a move into or out of the deployment is waiting (a manual route can wait up to 24 hours), the plan is `BUSY` and the deployment page says which move it waits for.'
      ]
    },
    {
      type: 'p',
      text: 'Routes (Hub administrator): `POST /api/hub/shared/:id/upgrade/plan` (`{version, kind?}`), `POST /api/hub/shared/:id/upgrade` (`{version, kind?, plan_hash, confirm, overrides?}`; 202; `409 PLAN_CHANGED` carries the new plan, `BLOCKED` and `APP_BLOCKED` say what holds it back, `400 CONFIRM_MISMATCH`), `GET /api/hub/shared/:id/upgrade/versions` (the versions the picker offers), `GET /api/hub/shared/:id/deploys`, `GET /api/hub/shared-deploys/:id`, `POST /api/hub/shared-deploys/:id/cancel` (409 `NOT_RUNNING`).'
    },
    { type: 'h2', id: 'hub-shared-observed', text: 'Observed versions' },
    {
      type: 'p',
      text: "A registered deployment tells the Hub its version on every tenants call. When every instance seen in the last 2 minutes agrees on a version different from the deployment's pin, the Hub records one `observed` shared deploy, adds a `shared` deploy row to each placed environment, and moves the pin. During a rolling upgrade, when replicas still disagree, nothing is recorded. The record is written once per version."
    },
    { type: 'h2', id: 'hub-shared-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route (Hub administrators)', 'Does'],
      rows: [
        ['`GET /api/hub/shared`', 'Lists deployments with the app count and the live replicas.'],
        [
          '`GET /api/hub/shared/:id`',
          'One deployment: placed apps with tenant ids and wire status, live sightings, and the environment block (registered mode; the token only in the create answer).'
        ],
        ['`POST /api/hub/shared`', '201 `{row, token, env_block}`. The token is shown once.'],
        [
          '`PATCH /api/hub/shared/:id`',
          'Name, link address, host pattern, extensions and pins, pool budget, settings. Mode or key: 400 `IMMUTABLE`. A retired deployment: `SHARED_RETIRED`.'
        ],
        [
          '`POST /api/hub/shared/:id/token`',
          'Rotates the token. 24 hours of grace for the old one.'
        ],
        [
          '`DELETE /api/hub/shared/:id`',
          '409 `SHARED_IN_USE` while an environment is placed on it. A deployment that never served is deleted; one with history is retired, so its deploy history is kept.'
        ],
        [
          '`GET /api/hub/shared/:id/status`',
          "The deployment's own status over the link, kept 30 seconds. `{state: 'unreachable', code}` when the link fails."
        ],
        [
          '`GET`, `PUT /api/hub/environments/:envId/app-key`',
          "Reads the fingerprint, or saves the key (64 hex). The body never reaches the API log or the Traffic Map capture. While the environment's move is stopped at `retire_source`, the key is judged against what the new home reports (see Moving an environment)."
        ],
        ['`POST /api/hub/environments/:envId/place-shared`', 'Places a new environment (above).']
      ]
    },
    {
      type: 'p',
      text: 'Every write leaves an activity row (`hub-shared-create`, `-update`, `-token`, `-delete`, `hub-app-key`) with no token, key or connection in it.'
    },
    { type: 'h2', id: 'hub-shared-not-yet', text: 'What a shared app cannot do yet' },
    {
      type: 'p',
      text: 'Each item below is deferred. The Hub enforces it when a dedicated app moves in: a blocker stops the move, a warning is shown in the plan. A new environment placed straight on a shared deployment has none of these features from the start. Staged imports, row schedules, directory lookups, the Teams bot, phone push, mail retry, GitLab issue sync and the other per-app jobs are not in this table: they work per app (see Per app on a shared deployment below).'
    },
    {
      type: 'table',
      head: ['Gap', 'What happens', 'Move check'],
      rows: [
        [
          'Flows with the `exec-script` operation',
          'Needs a per-app sandbox.',
          'blocker `EXEC_SCRIPT_FLOWS`'
        ],
        [
          'SQLite apps',
          'A shared deployment serves SQL Server, Postgres, MySQL and MariaDB.',
          'blocker `SQLITE`'
        ],
        [
          'Per-app direct Microsoft sign-in',
          "Direct sign-in (and the fallback while the Hub is down) uses the deployment's one primary OIDC client: each app's callback address must be registered on that one Entra app. An app that signs in via the Hub (see Per app below) still needs it: it is the fallback while the Hub is down.",
          'checklist item `callbacks_registered`'
        ],
        [
          'Help-video renders queued before a restart',
          'They render again on the next publish.',
          'warning `HELP_VIDEO_RENDERS`'
        ],
        [
          'Creating a new app on a Docker target (`nivaro_hub_targets` has the GitLab kind only)',
          'A later phase. Place a new environment, or move an existing one.',
          '-'
        ],
        [
          'Upgrades driven by GitLab',
          'A GitLab-run deployment is registered and upgraded by its pipeline.',
          '-'
        ],
        [
          'More than one swarm node with bundled volumes',
          'Same limit as dedicated stacks.',
          'warning `MULTI_NODE_VOLUMES`'
        ]
      ]
    },
    { type: 'h2', id: 'hub-shared-per-app', text: 'Per app on a shared deployment' },
    {
      type: 'p',
      text: 'These work on a shared deployment, each app with its own data, settings and schedule. A move no longer reports them as blockers or warnings when the app runs 0.3.212 or later.'
    },
    {
      type: 'ul',
      items: [
        'Staged file imports (upload and drainer). Rows load with inserts: the bulk loader (`IMPORT_LOADER=bulk`, SMB share) is not available on shared, so a `bulk` loader falls back to inserts with a note and a `bulk_only` import fails saying so. Each app keeps its own queue, attempts and leases.',
        'Row schedules (scheduled reports, retention policies, scheduled audit and activity views, sync jobs, scheduled flows). An edit reaches every replica, and a 5-minute `row-schedules-resync` job per app is the backstop. An app that leaves the deployment loses its jobs.',
        'Automatic mail retry (`MAIL_RETRY=off` still turns it off for the whole deployment), live SLA status changes, the cumulative-flow rollup and the weekly AI summary in the daily digest.',
        'The daily retention pass (03:30, one job per app) and the boot passes (owner-group warm, integrity checks, cache warms, readiness warm, db-tuning sweep). They run once per app when it becomes ready. Retention status shows per app. Stale help-video import folders are swept once a day per process (deployment-wide, not per app).',
        'Microsoft directory lookups and sync. The app uses its own Microsoft app registration, saved in Settings → Microsoft directory (tenant id, client id, client secret; the secret is sealed with the app key). The server `GRAPH_*` and `OIDC_*` variables and the directory keys of `NIVARO_SETTINGS_OVERRIDES` are never used on shared.',
        "The Teams bot. The app uses only the bot saved in its own Settings. `TEAMS_BOT_*`, `MICROSOFT_APP_*`, the sign-in app fallback and the `teams_bot_*` override keys are ignored. `TEAMS_BOT=off` still disables the bot on the whole deployment, but `TEAMS_BOT=on` does not switch an app on: each app saves its own switch. Register each bot with that app's host as its messaging endpoint.",
        "Phone push. An app admin connects the app's push relay in Settings → Mobile app. The server `MOBILE_PUSH_RELAY_KEY` is not used on shared. Phone sign-in was already per app.",
        "GitLab issue sync (0.3.215 or later). Each app keeps its own connections (tokens sealed with the app key), rules, links, queued GitLab writes and switch (Issue trackers tab, stored in the app's own database); the sweep, send queue, reconcile and prune jobs run once per app. GitLab's webhook calls the app's own address (`https://<app host>/api/tracker-hooks/gitlab/<id>`, the URL the tab shows): the host picks the app, so a connection id never reaches another app. `ISSUE_TRACKERS=off` on the deployment turns sync off for every app, but `ISSUE_TRACKERS=on` does not switch an app on. GitLab calls go through the SSRF guard: a GitLab on a private address needs its host in the deployment's `SSRF_ALLOW_HOSTS`. A move of an app with sync on warns `ISSUE_TRACKERS` (it blocks only a target before 0.3.215). It also warns when sync is off only by the server's `ISSUE_TRACKERS=off` while the app's own switch is on (sync would start on the shared deployment: store the switch off first, which is allowed while the server keeps it off), and when the switch is stored under a custom `NIVARO_INSTANCE`. A copy of an app carries its GitLab connections (`SAME_APP_ON_DEPLOYMENT` says so), and a downgrade or rollback of the deployment below 0.3.215 says sync stops for every app on it.",
        "Sign-in via the Hub and the app switcher (from 0.3.215). The Hub hands each app its own sign-in client (only while the app is in Hub mode and the client is on), its environment hub token and the Hub's Microsoft client id in the tenant list (sealed with the app's key, which binds each value to its app; the list itself is what keeps them secret: it is fetched over TLS with the deployment token, never cached or logged). `HUB_CLIENT_*` and `HUB_TOKEN` on the deployment are never used for an app. The app calls back on its own address (the Hub already knows it from the environment), checks the evidence against the deployment's primary `OIDC_ISSUER`, and falls back to direct sign-in through the deployment's primary OIDC. `HUB_SIGNIN=off` on the deployment turns it off for every app. A placed environment gets a hub token when it first serves (one moved in keeps its own). Creating, rotating or switching a client, or changing an app's mode, asks the deployment to re-read its list at once. A move of an app in Hub mode needs the target at 0.3.215 or later and an active client for the environment (`SIGNIN_VIA_HUB` otherwise); `callbacks_registered` stays required: direct sign-in through the deployment's sign-in app is the fallback while the Hub is down, and the only path if the deployment is rolled back below 0.3.215 (the downgrade and rollback plans name the apps that would fall back). A move onto a shared deployment issues a hub token too when the environment has none.",
        "The Traffic Map, for the app's administrators: the map, its live frames, the inspector and the traffic section of the daily summary show only that app's requests, callers, partners, sockets and people, read from the app's own store and its own request log. The parts that read the process as a whole stay with the operator, as in Nivaro Cloud: minute history and baselines, the investigation and request-trace lenses, database, Redis, node and capacity panels, circuit breakers and timed actions. They answer 404 inside an app.",
        "Configuration changes reach every replica at once. A configuration write in an app (fields, relations, layouts, roles, rules, pipelines and the other configuration tables) is announced on the deployment's own Redis channel (`<REDIS_CHANNEL_PREFIX>nvr:app-config:<deployment key>`, the app id and the process only) as soon as it starts and again 2 seconds after the last write of the run; every other process of the deployment, realtime processes included, clears its caches for that app only (other apps keep theirs). A bust from Database → Caches is announced the same way. `CACHE_EPOCH=off` turns it off; without Redis the caches expire on their TTL. The database's own configuration number (`nivaro_cache_epochs`) stays off on a shared deployment.",
        "Heavy reads share the process fairly. The apps of one process share its heavy-read budget (`HEAVY_READ_CONCURRENCY`). One app holds at most `HEAVY_READ_PER_APP` slots (default half the budget, at least 1) and never more than its own pool size minus one, and a freed slot goes to the waiting app that holds the fewest. So one busy app cannot take every slot, and another app's first heavy read waits for at most one release.",
        "Pool and socket figures. Each app's own pool is judged every 5 minutes (`app-pool-monitor`, the self-hosted pool-monitor rule) and an issue is raised in that app's issue log when it is under pressure; each app's own sockets and people are sampled into its Realtime console chart (`app-concurrency-sample`). The process's own figures (sockets and people across every app, the heavy-read budget in use, every app pool summed; counts only, no app named) are on the deployment link status, for the Hub operator.",
        'From 0.3.215 — the outside-write watch (the safety net that notices rows other systems wrote straight into the database). The process that runs scheduled jobs walks the SQL Server apps in turn, each in its own database with its own Realtime → Outside writes setting and counts; Postgres and MySQL apps are skipped as on a dedicated stack. One look of one app is held to about 4 seconds as a whole (collections, the tables that belong to open records and file lookups; each read waits at most 1 second on a lock) and carries on with what it did not read at its next look, and an app that leaves the deployment is no longer walked. Each app’s look reads the deployment-wide realtime journal and keeps only its own entries (there is no per-app index yet).',
        'From 0.3.215 — huddle media servers. Each app uses the STUN, TURN and media server (LiveKit) it saved in Settings → Huddles, as on a dedicated stack; the TURN secret, TURN password and LiveKit secret are stored sealed with the app key. The platform variables `HUDDLE_LIVEKIT_URL`, `HUDDLE_TURN_URLS` and `HUDDLE_STUN_URLS` stay Nivaro Cloud only. What the deployment itself dials stays guarded: the media server test and the room clean-up calls go through the SSRF guard, and Test TURN resolves each address once, refuses a private or reserved one the operator has not allowed with `SSRF_ALLOW_HOSTS` (browsers still use it), and connects to exactly the address it checked. The every-5-minutes TURN probe stays off on shared; Server health shows the last manual test.',
        "From 0.3.215 — per-instance settings (Settings → This instance: huddle media servers, the outside-write watch, the daily report, caches …). A shared deployment reads an app's row under the deployment's own instance name (`NIVARO_INSTANCE`). When a move from a dedicated stack puts the app in maintenance, the Hub passes that name and the app copies its OWN row to it (never another environment's row in the same database); a row already there keeps its values (only empty keys are filled, and the run log names the keys that differ). The app's own row is left as it was, so a rollback changes nothing. The plan says `INSTANCE_SETTINGS_CARRIED`, or `INSTANCE_SETTINGS_STAY` when a side is older or the move is from a shared deployment (then enter them again).",
        "From 0.3.215 — mail from an app that sent with its server's `SMTP_*` / `MAIL_FROM` (or a mail test mode its environment forces, `MAIL_TEST_MODE` / `MAIL_TEST_RECIPIENT`). In the same maintenance call the app saves what it sends with into the carried instance row (only what nothing saved already holds; the password sealed with the app key; a forced test mode stays on with its recipient), never into the settings row other instances of the same database read. A failure stops the move before maintenance (503). The plan shows `ENV_SMTP_KEPT` instead of `ENV_SMTP` when both the app and the target run 0.3.215 or later, with a checklist item to confirm it in the run log; if the app does not confirm, the run log says `ENV_SMTP`. On shared an app with a saved relay signs in only with its own saved user and password, never the deployment's `SMTP_USER` / `SMTP_PASSWORD`; an app with nothing saved at all still uses the deployment's own `SMTP_*`."
      ]
    },
    {
      type: 'p',
      text: 'From 0.3.215 (on both sides of a move) a move also copies what used to block or stay behind:'
    },
    {
      type: 'ul',
      items: [
        'Objects in an env-driven S3 or Azure provider (`STORAGE_PROVIDER`), on either side: re-keyed between the bucket root (dedicated) and `apps/<id>/` (shared), streamed, resumable, with the same counts and failure reasons as the other files. Into a dedicated stack on the same bucket, the bucket copies them itself. `ENV_OBJECT_STORAGE` is then a note the app sends, not a blocker; it still blocks while either side runs an older version (see Moving an environment → Files).',
        'Session replays. A replay still being watched often lives in the database, which the move keeps; an older one sits as one object in file storage, and the move copies that object with the files. `SESSION_REPLAYS` and `REPLAYS_NOT_MOVED` then go away.'
      ]
    },
    {
      type: 'p',
      text: 'Nivaro Cloud is unchanged: the Teams bot, phone push, mail retry and GitLab issue sync stay off there, and push stays cloud-managed.'
    },
    {
      type: 'p',
      text: 'Before or after a move, save what the app needs on its own. The plan warns `DIRECTORY_ENV_CREDENTIALS` when the directory credentials come only from the environment, `TEAMS_BOT_ENV_CREDENTIALS` when the bot comes from the environment (or is on only by `TEAMS_BOT=on`), `PUSH_RELAY_ENV` when push uses the server relay key, `SETTINGS_ENV_OVERRIDES` when the app’s `NIVARO_SETTINGS_OVERRIDES` sets keys a shared deployment does not apply, and `ISSUE_TRACKERS` when GitLab sync is on (its detail says when only the server’s `ISSUE_TRACKERS=on` switches it on: switch it on again on the Issue trackers tab after the move). `SAME_APP_ON_DEPLOYMENT` notes that a copy carries the original saved Teams bot and directory registration.'
    },
    {
      type: 'note',
      text: 'The cloud-flag inventory lists each remaining site with a `phase6` note. Deployment modes keeps the list of per-site behaviours; this table is the list an operator needs.'
    }
  ]
}

export const hubMovesDocs: DocSection = {
  id: 'hub-moves',
  label: 'Moving an environment',
  content: [
    { type: 'h1', id: 'hub-moves', text: 'Moving an environment' },
    {
      type: 'p',
      text: 'A move takes an environment that serves today and runs it from somewhere else: from a dedicated stack to a shared deployment (`to_shared`), from a shared deployment to a dedicated stack (`to_dedicated`), or from one shared deployment to another (`between_shared`). The database never moves: the new placement opens the same database the old one used. Files are copied. A move is a recorded, locked and resumable run of fixed steps, and every step before release can be rolled back. Moves are for Hub administrators. Start one from Apps → the app → the environment row → Move… (an environment that has never served is placed instead, see Shared deployments).'
    },
    {
      type: 'ul',
      items: [
        'A move never changes the version. The new placement must run the same version as the old one (`VERSION_DIFFERS`). Upgrade first, or promote after.',
        'The environment is in maintenance for part of the move (below), so choose a quiet time. The Move… panel shows the plan first (blockers, warnings, the checklist, the steps) and starts only after you tick every required checklist item and type `<app key>/<environment key>`.',
        'The plan is read-only and carries a hash. Starting a move plans again and refuses with `409 PLAN_CHANGED` (and the new plan) if anything changed, `409 PLAN_BLOCKED` while a blocker is left, and `409 CHECKLIST_INCOMPLETE` (naming the open items) while a required item is not ticked.',
        'A move holds the environment lock (holder `move`) and the lock of every shared deployment it touches, for the whole run, a manual route wait included. Promotions, stack changes and other moves of that environment are refused (`BUSY`), and an upgrade of a touched deployment is refused (`SHARED_BUSY` on the move plan).',
        'A move writes one deploy row (kind `move`, the version unchanged) and a job run, so the environment history reads "Moved". An upgrade of a shared deployment reads "Shared upgrade".',
        'A plan never treats a check that could not run as a pass. When the Hub cannot read something it says so (`GATHER_FAILED` blocks; the `*_UNVERIFIED` warnings below each come with a required checklist item that says what you vouch for).'
      ]
    },
    { type: 'h2', id: 'hub-moves-steps', text: 'Kinds and steps' },
    {
      type: 'table',
      head: ['Kind', 'Steps in order (automatic routing)'],
      rows: [
        [
          '`to_shared`',
          '`check`, `place_on_target`, `files_warm`, `maintenance_on`, `wait_idle`, `files_delta`, `target_ready`, `route`, `verify`, `release`, `retire_source`, `done`'
        ],
        [
          '`between_shared`',
          "The same as `to_shared`. The files come from the source deployment's link address."
        ],
        [
          '`to_dedicated`',
          '`check`, `maintenance_on`, `wait_idle`, `deploy_target`, `target_ready`, `files_full`, `route`, `verify`, `release`, `retire_source`, `done`'
        ]
      ]
    },
    {
      type: 'table',
      head: ['Step', 'What it does'],
      rows: [
        [
          '`check`',
          'Checks the environment still sits on the placement the move started from, and notes which database the source serves (as a hash) so the target can be proven to open the same one.'
        ],
        [
          '`place_on_target`',
          'On a shared target, lists the environment on the deployment, held in maintenance (the target pulls files only for apps it lists, and a target held in maintenance runs no jobs, so jobs never run twice).'
        ],
        [
          '`files_warm`',
          'Copies the files while the source is still serving. The first warm copy is always a full copy.'
        ],
        [
          '`maintenance_on`',
          'The environment status becomes `maintenance` and the source is put into maintenance. A shared source is set through the Hub list, and the step waits (up to 3 minutes) until every live replica holds the new list. A dedicated source gets a strict maintenance write over its hub link (no administrator is exempt) and the step then waits 16 seconds so every replica enforces it.'
        ],
        [
          '`wait_idle`',
          'Waits up to 10 minutes until the source has no running imports, exports or renders (`WAIT_IDLE_TIMEOUT` otherwise).'
        ],
        [
          '`files_delta`, `files_full`',
          'Copies what changed since the warm copy (shared target), or everything (a dedicated target exists only now). A file that fails inside maintenance stops the move and rolls it back, so none is lost.'
        ],
        [
          '`deploy_target`',
          "Writes the pin at the current version and deploys the dedicated target: a Docker stack through the agent, booted in maintenance (`HUB_BOOT_MAINTENANCE=<move id>`), or the placement's deploy jobs for GitLab (the pin carries a last line `boot-maintenance=<move id>`; the job runs by itself or is played, and the move waits for it as a promotion does). A Docker target starts on its own per-move name only, never the public one; `route` adds the real names, and the per-move name stays until the move ends."
        ],
        [
          '`target_ready`',
          "Up to 10 minutes: a dedicated target's retire marker from an earlier move is cleared; the target opens the same database (the identity is compared with the one noted at `check`, `DATABASE_DIFFERS` otherwise); a shared target's schema is `ok`; the preflight passes (`PREFLIGHT_FAILING`); a dedicated target answers the version. The encryption key fingerprint must match the app's (`APP_KEY_MISMATCH`, `APP_KEY_UNKNOWN`): a mismatch rolls the move back."
        ],
        [
          '`route`, `verify`',
          'Switches the public name (below), then checks that the name answers `/api/version` at the version, with `shared_deployment` equal to the target key (to shared) or absent (to dedicated), and the right tenant. Up to 10 minutes (`ROUTE_TIMEOUT`, `VERIFY_FAILED`). For a Docker target `route` adds the real names beside the per-move name; it does not remove that name yet.'
        ],
        [
          '`release`',
          "The point of no return. The source is already frozen. The environment's placement, version pin and `active` status switch to the target first; only then is the target's maintenance lifted (a Docker target's boot maintenance is released for good with the move id; a shared target's replicas re-read their list). The step is marked done only after the lift. If the Hub dies in between, the step stays open and a rollback proves the target frozen again before anything else; after a done `release` nothing is rolled back."
        ],
        [
          '`retire_source`',
          "Retires a dedicated source over its hub link (below), removes a Docker source stack (volumes kept), or drops the tenant from a shared source's list."
        ]
      ]
    },
    {
      type: 'p',
      text: 'The move row is `planned`, `running`, `waiting` (for a manual route), `interrupted`, `success`, `rolled_back`, `cancelled` or `failed`; each step is `pending`, `running`, `done`, `failed`, `undone` or `undo_failed`. `failed` is only for a rollback that could not undo something.'
    },
    {
      type: 'p',
      text: 'With manual routing the order changes, so the app keeps serving while you wait for a person to switch the name: `check`, the target is prepared (`place_on_target` or `deploy_target`, held in maintenance), `files_warm`, then `route` (the Hub does its own half, then waits for the name) and `verify` while the source still serves, and only then `maintenance_on`, `wait_idle`, `files_delta`, `target_ready`, `release`, `retire_source`, `done`. The Hub does its own source-side route change only after the name verifies on the target. In a manual `to_dedicated` move the target is deployed first and gets a warm copy (`files_warm`), then the same delta copy (`files_delta`) inside maintenance as a shared target; the full copy (`files_full`) belongs to the automatic order only.'
    },
    {
      type: 'h2',
      id: 'hub-moves-addresses',
      text: 'Addresses the Hub talks to, checked at the start'
    },
    {
      type: 'p',
      text: 'Before anything is written, the move resolves and probes an address of its own for each dedicated side. It must not depend on the public name, because after the name moves, the public name reaches the other side. A refusal here changes nothing.'
    },
    {
      type: 'ul',
      items: [
        'A dedicated source must answer its hub link now. A GitLab source needs an API check address (`verify_url`) that is not its public name. A Docker source on the publish edge uses `http://<agent host>:<published port>`, and the hub token goes over plain http only to this machine or a `.test` or `.localhost` name. A Docker source on the Traefik edge is reached only on its public name: that is accepted only with automatic routing (the Hub moves that name itself and puts it back first on a rollback). Otherwise the start is refused with `SOURCE_UNREACHABLE`; with a manual route the plan blocks it already, because the Hub could not reach the source afterwards to put it in maintenance or roll back. Move it to a target on the same Docker driver, or give the source a published port.',
        "A dedicated Docker target on the Traefik edge is deployed first on a per-move name, `hub-move-e<environment id>-<random>.<first agent host suffix>`. That name must resolve now, so the agent suffix needs wildcard DNS, and its certificate must be valid for it (a wildcard certificate for the suffix, as for the apps the Hub creates). The `route` step adds the environment's real names beside it. The per-move name is removed at the end of the move, once the app lives on the target: the Hub applies the stack again without it (and without the boot maintenance setting) and checks that it no longer serves the app. If that fails the move is still a success, and the checklist item `temp_host` stays open. A target on the publish edge uses the agent host and the published port (this machine or a `.test` name only). A GitLab target uses its API check address, which must also resolve. With none, the start is refused with `TARGET_UNREACHABLE`.",
        'Files (see Files below): the address the target pulls from must be one its pull may fetch, or the start is refused with `LINK_URL_NOT_PULLABLE` (a shared source) or `SOURCE_NOT_PULLABLE` (a dedicated source).'
      ]
    },
    { type: 'h2', id: 'hub-moves-routing', text: 'Automatic and manual routing' },
    {
      type: 'p',
      text: "Routing is automatic only when every route change is the Hub's to make: both sides are on a Docker driver behind a Traefik edge, and they are the same driver (one edge, so a name moves between two routers of one Traefik). Otherwise it is manual: the Hub shows the exact request and waits up to 24 hours. Both modes end in the same check: the public name must answer from the target."
    },
    {
      type: 'table',
      head: ['From to', 'The name is', 'The Hub does'],
      rows: [
        [
          'Docker dedicated to Docker shared, same driver, Traefik edge',
          'under the target pattern',
          'Updates the source stack so it drops the host (the pattern router takes the name).'
        ],
        [
          'Docker dedicated to Docker shared, same driver',
          'outside the pattern',
          'Drops the host on the source; adds it as an explicit host on the target.'
        ],
        [
          'Docker shared to Docker dedicated, same driver',
          'any',
          'Drops the host from the source if it was explicit; applies the target stack, which claims the host.'
        ],
        [
          'Docker shared A to Docker shared B, same driver',
          'any',
          "Drops the host from A if explicit; adds it to B unless it is under B's pattern (a name both patterns cover is added to B as an explicit host, because an explicit Host rule outranks a pattern and two equal pattern routers would both match)."
        ],
        [
          'Any side on GitLab, a registered deployment, a publish edge (no Traefik), another driver, or an agent the Hub could not read',
          'any',
          'Manual: the request names the host, the target (link address or stack) and the TLS need; you confirm when it is done.'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        "Adding a name outside a shared target's pattern re-applies the whole shared stack, so swarm restarts every replica, and every app on it, one by one. The plan warns `STACK_REAPPLY_ALL`.",
        'The waiting card shows the request (Copy the request) and a Check now button: the Hub tries the public name and continues when it answers as the target. It also looks by itself every 5 minutes. Nothing is switched by the Hub in manual routing. If the 24 hours pass without a name that answers from the target, the move fails and rolls back.',
        'Point the name back. If a person already pointed the name at the target and the move is then rolled back, the Hub cannot undo that half. The move ends with a required checklist item `repoint_name` that says which names to point back to which placement ("Point <names> back to <source>: the move was rolled back and the target no longer serves this app"). Do it at the edge and tick the item.'
      ]
    },
    { type: 'h2', id: 'hub-moves-files', text: 'Files' },
    {
      type: 'ul',
      items: [
        "The target pulls the files. They never go through the Hub: bytes flow from the source app to the target app. The source authorises the pull with a transfer ticket (`nvt_…`, valid 6 hours) it minted on the Hub's request. The ticket is bound to one app, never appears in a log or an error, and the Hub revokes it after each copy and again when the move ends (a revoke that fails is kept for the move end).",
        "What is copied: every file in the app's files table whose provider is the deployment-storage (`local`) provider. Objects keep their keys. An object already there at the same size is skipped, so a copy is resumable. The first warm copy of a move is always a full copy (a manifest left by an earlier move would make a delta skip rows); later ones are deltas. An object over 5 GB fails that file. A file the source says is missing (404) is listed as missing (up to 50 ids) and never blocks: it was gone before the move. A file whose stored size was stale is copied as the source has it and counted, not failed.",
        'A file that failed is named (up to 50 ids) and counted under a plain reason: the source could not read it (`503 SOURCE_READ_FAILED`), the source\'s `FILES_FALLBACK_DIR` is missing or empty, the source did not answer, the answer was not usable, the bytes arrived incomplete, the target\'s temporary folder could not take them (full or not writable), or the target could not store it. Only the transfer route\'s own "not found" (it carries `X-Nivaro-Transfer-Missing: 1`) counts as missing: a 404 from anything else on the way (a proxy, another route) fails the file. A source on 0.3.209 answers a plain 404 without the marker: a move never pairs it with a newer target (the plan refuses `VERSION_DIFFERS`), and if it ever did, its missing files would fail and the move would roll back, never release without them. A failure in the warm copy is only a warning (the delta inside maintenance tries it again); inside maintenance it stops the move with `FILES_NOT_COPIED`, which names the files and the reasons ("3 file(s) could not be copied (…): the source could not read 3"), and the move rolls back. A failed file is never stored on the target or counted as copied, so the next move copies it again.',
        "A source that reads files through `FILES_FALLBACK_DIR` (after an environment refresh): only a key that is not in a readable fallback folder is missing. A file or folder there that cannot be read (`EACCES`, `EIO`, `ESTALE`) is a read error: `503 SOURCE_READ_FAILED` with no path. So is a fallback folder that is not there, or that is there but EMPTY: an unmounted share or volume usually leaves its mount point behind as an empty folder (`reason: FALLBACK_FOLDER_UNAVAILABLE`). Either way the move rolls back instead of moving on without those files. Fix the mount or the permissions, then start the move again. If the source's uploads really are empty while its files table has rows, unset `FILES_FALLBACK_DIR` on the source; the move's text says so.",
        "Env-driven S3 or Azure (`STORAGE_PROVIDER=s3|azure`, 0.3.215 on both sides): files whose provider is `s3` or `azure` are copied too, whichever side keeps them there (source, target or both). The source streams each object from its bucket (never whole in memory) and says which of its stores held it (`X-Nivaro-Transfer-Store: env | settings`), so the target writes it to its own env provider or its own saved-settings driver; `s3` is written by both, and the answer settles which. Keys are re-keyed like every key on a shared deployment: `apps/<id>/<key>` there, `<key>` at the bucket root elsewhere. When the source's bucket is also the target's env bucket (the source sends a hash of endpoint or region and bucket, never the name), the target asks the bucket to copy it (S3 CopyObject, Azure Copy Blob): no byte passes through either app. The target decides from a header-only probe of the source (`X-Nivaro-Transfer-Probe: 1`, answered 204 from a HEAD of the object, which is never opened). An Azure copy that stays pending is polled until the per-object timeout (10 minutes), then cancelled and its blob removed before the object is streamed instead; one that ends in anything but success is handled the same way. The source key is never taken from the source's answer: the target rebuilds it from where the Hub says the source keeps this app's objects (`source_scope`: the bucket root for a dedicated source, `apps/<id>/` for a shared one) and the file's own key, and copies only when the source's stored-key header agrees. Storage itself refuses a copy source with `..`, a leading `/`, a backslash or a control character, a root-form key inside `apps/`, or another app's folder. A shared target never copies server-side (a shared bucket's root and other apps' folders are not its own): it streams. If the bucket refuses (the target's credentials cannot read the source key), the object is streamed instead. The same full key on both sides is already there and is skipped. Counts, failure reasons, the 5 GB cap and resume are the same as for local files. A side before 0.3.215 still blocks with `ENV_OBJECT_STORAGE`.",
        "Session replays (0.3.215 on both sides): a replay older than the cold-storage setting (default 3 days) keeps its recording as one object in file storage (`session-replays/<year>/<month>/<id>.ndjson.gz`); the pull copies those from the source's `GET /api/hub-transfer/replays/:id` with the files. A failed or missing one is named `replay:<id>`. Newer replays and the 24-hour reload cache live in the database, which the move keeps. Before 0.3.215 the plan warns `REPLAYS_NOT_MOVED` (and the app's `SESSION_REPLAYS`).",
        'Not copied: image transform caches (generated image sizes are made again when asked for).',
        "Saved-settings S3 or Azure bucket. On a shared deployment every object of such an app sits under `apps/<id>/` in its bucket; on a dedicated stack it sits at the bucket root. A move to or from a shared deployment therefore changes every key, so the pull copies those objects too (files whose provider is `s3` or `azure-blob`), written through the target's own saved-settings driver, whether or not both sides name the same bucket. The plan warns `STORAGE_PREFIX_CHANGES`: the objects are copied, not shared, and the bucket holds both copies until the old ones are removed. A move between two shared deployments keeps the prefix (one app id) and copies nothing there. Files on any other provider block the move with `STORAGE_LAYOUT_DIFFERS` (the copy cannot handle them), and an app that does not say which storage its files are on blocks it with `STORAGE_COUNT_UNKNOWN`.",
        'A pull stalls if nothing moves for 10 minutes, and then fails. A failed pull keeps what it copied; Resume continues.',
        'A pull streams each object into a temporary file under the system temporary folder (`<tmpdir>/nivaro-hub-transfer/`) and only then stores it, so a failed object never leaves a half-written one. Temporary files older than 24 hours are removed when the next pull starts. A stack with a small `/tmp` should give that folder a volume; there is no setting for it yet. Separately, local storage writes each object to `<key>.nvr-part-<random>` beside its final name and renames it; a process killed mid-write leaves that file behind. It is never served and nothing sweeps it: delete leftovers by hand when no process is running.',
        "The one plain fetch (not address-checked) to an address another system named: when the source is a private IP literal (loopback or RFC 1918, for example the Hub's own network), the pull fetches it with no redirects, and a literal cannot be rebound. A source named by an https host name goes through the check that stops a server calling private addresses: a name that resolves to a private address is refused unless the target lists it in its `SSRF_ALLOW_HOSTS` setting. Give the target either an origin that resolves publicly, or a private IP address.",
        '`LINK_URL_NOT_PULLABLE` (between shared deployments, the source deployment\'s link address is a name that resolves to a private address) and `SOURCE_NOT_PULLABLE` (a dedicated source whose own address is such a name — on a company network, most app names) can be overridden: tick "The target deployment allows this host (it is in its SSRF_ALLOW_HOSTS)" (that setting lists hosts the private-address check lets through; on a shared deployment set it in its settings.env) in the start panel. The start then carries the refused code in `overrides` and the activity row records it. If the target does not really allow the host, the first file copy fails and the move rolls back.',
        'A source with S3 or Azure as the env provider but rows saying `local` (files from before a driver switch) is read from that bucket too. Before 0.3.215 the source read such an object whole into memory; from 0.3.215 it streams it.'
      ]
    },
    { type: 'h2', id: 'hub-moves-writer', text: 'One writer at a time' },
    {
      type: 'ul',
      items: [
        'The target never takes writes while the source can. A shared target lists the app as `maintenance` from `place_on_target`; a Docker target boots in strict maintenance (`HUB_BOOT_MAINTENANCE=<move id>`) and never serves the public name before release; a GitLab target boots in maintenance when its template reads the move id from the pin, and is asked to hold maintenance right after its deploy either way. Release commits the environment switch first and lifts the target second.',
        'A dedicated target boots in strict maintenance with `HUB_BOOT_MAINTENANCE=<move id>`. Only a maintenance-off call that names that move id lifts it, so a restart enters it again until then. The variable is read only by a hub-linked dedicated app, never by a shared deployment.',
        "GitLab boot window. A GitLab target's deploy job runs by itself on the pin commit, so a move never sends a pipeline variable: the pin file gets a last line `boot-maintenance=<move id>`. The app template's deploy job reads that line (a `HUB_BOOT_MAINTENANCE` pipeline variable still wins; anything but a move id stops the deploy before it reaches the manager) and forwards it to the manager, whose wrapper (`nivaro-hub-deploy`) and stack file must pass it into the app. Update all three together: the template tag (`deploy/hub-app-template`, then move each target's `template_ref` and re-pin its apps), the manager wrapper and the stack file. An app counts as booting in maintenance only when its pinned template reads the pin line and the manager files pass it on. An adopted app, an older template (one that only forwards the variable) or a template the Hub could not read is unproven: the plan warns `GITLAB_BOOT_WINDOW` and adds the required item `gitlab_boot_window`, and the old placement is then frozen for the length of the deploy, until the Hub has switched the new app's maintenance on (people see the maintenance page meanwhile). The failure is closed: an old wrapper refuses the new variable, and a new wrapper refuses it when its stack file does not pass it, so the deploy fails and the move rolls back rather than booting writable.",
        "The pin keeps the `boot-maintenance` line after the move. The Hub ignores that line when it compares pins, so it never blocks or forces a promotion, and the next promotion writes a pin without it. A redeploy of the move's own pin commit (a restart, a re-run of its job, a rollback to that build) still forwards the line, but the app finds the move's done marker in its Redis (`<REDIS_CHANNEL_PREFIX>nvr:hub:boot-maintenance-done:<tag>:<move id>`, written when the Hub released the move) and boots normally. If that marker is lost (a new or emptied Redis), the app boots in maintenance: lift it with the recovery steps below."
      ]
    },
    {
      type: 'h2',
      id: 'hub-moves-rollback',
      text: 'Rollback, resume and interrupted runs'
    },
    {
      type: 'ul',
      items: [
        "Any failure or Cancel before `release` rolls the move back, in a fixed order whatever order the steps ran in (ruling P6-26): (1) the target is frozen, and the Hub must prove it; (2) the target-side route changes are undone, without ever applying the target app's own stack again; (3) the target is stopped or removed (a Docker stack is removed with its volumes kept; a GitLab target is retired over its hub link; a shared target is unplaced and every replica must hold the list without it); (4) the source-side route changes are undone (the source gets its names back); (5) only then the source leaves maintenance and the environment returns to the status it had before. The step that failed is undone too (it may have half happened). Every route change is recorded before it is applied, so one that never converged is undone as well. Copied files stay on the target. The move ends `rolled_back` (or `cancelled`). A dedicated placement made for the target stays for reuse and is not deleted.",
        'After `release` nothing is rolled back (Cancel answers `409 TOO_LATE`). If `retire_source` fails the move is `success` with a warning, and the checklist item `retire_source` stays open: retire or stop the old placement yourself.',
        "One exception: `retire_source` first checks that the new home seals this app's values with the app's own key (its key fingerprint, retried for about a minute). If that check fails (`APP_KEY_MISMATCH`, `APP_KEY_UNKNOWN`), or the new home cannot be asked at all (a link error, a timeout), the old home is not retired (a shared source keeps listing the app, in maintenance) and the move stays open: `interrupted`, with that code and what to do, so other actions on the environment are refused with `409 MOVE_OPEN` and Roll back answers `409 TOO_LATE`. A new home that could not be asked is stored as `APP_KEY_UNCHECKED_UNREACHABLE` and only needs Resume. Every move answered carries `retire_stop` (`{kind, case, finish, key_entry, finish_refused}` or null): the one rule the Hub and the panel both use for whether the move is at this stop and which ways out can work. A run cut off mid-retire after the key had checked is not at this stop: Resume finishes it. Each way out is offered only where it can work (rulings P6-43, P6-45).",
        "Way 1, the key: enter the key the new home runs under App key on the environment. While a move is stopped here the App key PUT judges the key against what the NEW home reports, on a Docker and a shared target alike, and takes it only when the fingerprints match; this is how the Hub gets a verified copy of the key the app really runs. On a Docker target an accepted key also becomes the environment's sealed stack secret `ENCRYPTION_KEY` when that differs (the same sealed path the Stack panel saves through; nothing is deployed), so a later Apply now keeps the key the app runs; the answer says `stack_key: 'set'`. A mismatch is refused (`APP_KEY_MISMATCH`) naming the fingerprint the new home reports, the one entered and the one the Hub holds, never a key; a new home that reports no key, or cannot be asked, is `APP_KEY_UNVERIFIED`. On a shared target a key that differs from the one the Hub holds is still `APP_KEY_IMMUTABLE`: there, wait until the deployment's replicas re-read the Hub's list and report its key. Then Resume: the move checks again and, once it matches, retires the old home and ends `success`. The panel offers this way only for a dedicated new home that reports another key (`case: key_entry`); for a new home that reports no key the way is to make it report the app's key, and for a shared new home to wait for its replicas.",
        "Way 2, Finish and stop the old home (`POST /api/hub/moves/:id/finish-stop-source {confirm}`, typed `<app>/<env>`, ruling P6-45): the Hub STOPS the old home and proves it before the move ends; the old home is not deleted: its database, and on a Docker stack its volumes, stay, and it comes back only by moving the environment back to it. A shared old home: the app is dropped from that deployment's list (every replica must hold the list without it), so nothing there serves, upgrades or migrates it. A Docker old home: the agent (0.2.1 or later) removes the app's services first and the stack's Redis last (volumes kept; the Hub's stack settings and secrets kept), and its leftovers must show no service and no container of the stack still running or shutting down (`tasks_active` 0) within five minutes. An older agent cannot prove that, so Finish is refused until it is updated. A remove that fails part way, or a stop not proven in time, refuses Finish saying the old home is partly stopped and what still runs; Finish again (or a later retire) completes it. At a stop where the Hub could not reach the new home, Finish first checks that the public name answers from the new home (409 `NEW_HOME_NOT_SERVING` otherwise). Only then does the move end `success` with a warning, `MOVE_OPEN` lifts and the checklist item `retire_source` says to remove the old home when you are sure. A stop the Hub cannot prove refuses Finish with a plain reason (shown on the move, `finish_refused`) and nothing ends: the move stays at the stop, and a shared old home lists the app again. An old home the Hub cannot stop and prove stopped (a GitLab placement) has no Finish (409 `CANNOT_STOP_OLD_HOME`): enter the key the new home runs, then Resume. Refusals: 409 `NOT_RELEASED` before release, `NOT_STOPPED_AT_RETIRE` when the move is not at this stop, `MOVE_CHANGED` when it changed while asked.",
        "After a run stopped once the key had checked (the Hub restarted while retiring), Resume finishes the retire without checking again: the check is stored before the old home's retire starts.",
        "A run that has stopped reporting for 2 minutes (the Hub restarted, or the process died) shows as `interrupted`, with Resume (continues from the stored step) and Roll back. Restarting the Hub marks such runs by itself, and frees the dead run's lock so resume or rollback is not `BUSY` for minutes. A run that loses its locks stops at once and never undoes beside another runner: it is interrupted, and you roll back after it heals.",
        'Cancel is a two-press confirm. A running move rolls back at its next step boundary; an interrupted one rolls back at once. `409 MOVE_ENDED` once it ended, `ROLLING_BACK` while it undoes.',
        "Never two writers: a freeze is proven, not assumed. A shared target counts as frozen only when the Hub has written the environment as `maintenance` on its list and every replica it has seen holds that list (a refresh of a list that still says `active` is not a freeze, and no replica seen means keep waiting). A dedicated Docker target counts as frozen when its maintenance is switched on over its own address and read back. A GitLab target: the same, or a retire read back. Before `release` the target is frozen by construction (a Docker target boots in maintenance, a GitLab target is held right after its deploy, a shared target lists the placed app as maintenance), so it is not frozen again. Switching a target's maintenance on also drops the boot-maintenance done marker for this move in the target's Redis, so a stack that ever came back would boot in maintenance rather than writable.",
        'Halted: if the target (lifted at release) can be neither frozen nor stopped, the rollback stops with the source still in maintenance, one writer rather than availability. The move is `interrupted` with the code `HALTED_TARGET_LIVE` and a required checklist item `target_stopped` that says what to do for that kind of target. A shared target: stop the shared deployment (scale its services to 0). That stops every app on it, not just this one, until the rollback is done (the item names the deployment and how many other apps it serves); the rollback then drops this app from its list and the deployment can start again. A Docker target: remove the stack on its swarm (`docker stack rm <stack>`) and do not deploy it again. A GitLab target: remove its stack on its swarm manager (`docker stack rm`) and stop its pipeline from deploying it again. Resume is hidden in this state, and Roll back stays disabled until the box is ticked.',
        "Before you tick `target_stopped`, make sure that no process of this app runs at the target and that none can restart. Check it: open the target's public or link address and see that it no longer answers for this app (the stack is gone, the deployment is stopped, or the app is listed as maintenance on every replica). Ticking is taken as proof, with nothing re-checked: the Hub then restores the environment to the source and lifts the source's maintenance. A wrong tick opens writes on the old placement while the new one may still accept them, two writers on one database. After the tick press Roll back; the Hub retries the freeze first. `TARGET_NOT_STOPPED` is a different, narrower code: a GitLab target's retire call failed, so stop its stack by hand.",
        'Every rollback and every release carries the move id with its maintenance-off call. If the Hub has lost the move and a dedicated container stays stuck in maintenance: remove `HUB_BOOT_MAINTENANCE` from the stack (and the `boot-maintenance` line from a GitLab pin), then send `POST /api/hub-link/maintenance` with `{"on": false}` and no move id, with its hub token as the bearer. A move id that is not the held one answers 409 `MAINTENANCE_OTHER_MOVE` and lifts nothing. The halted or rolled-back move shows the same recovery text, worded for its source.',
        "If that call cannot reach the app, delete its maintenance key in its Redis. Which key depends on how the process runs (ruling P6-32). A dedicated app linked to the Hub (`HUB_TOKEN` set) keeps the Hub's freeze in its own key, `<REDIS_CHANNEL_PREFIX>nvr:maintenance:<tag>`, where `<tag>` is the first 16 hex characters of the SHA-256 of its hub token (`printf %s \"$HUB_TOKEN\" | sha256sum | cut -c1-16`; `redis-cli --scan --pattern '*nvr:maintenance:*'` lists it); deleting the plain `nvr:maintenance` there lifts nothing. On a shared deployment one app is in maintenance because the Hub lists it so, never through a key: use Apply now on the deployment (its stack carries the app's names again) and, if the app still shows maintenance, set the environment's status back to active on the Hub (the replicas re-read the list within 30 seconds). Never clear the deployment's own key, `<REDIS_CHANNEL_PREFIX>nvr:maintenance` (`nvr:maintenance` with no prefix): that is the operator's freeze of every app on it. Nivaro Cloud and a self-hosted app without `HUB_TOKEN` use exactly `nvr:maintenance`.",
        "The source and the target of a move must not share one Redis database, whatever their key prefixes (and they hold the same `HUB_TOKEN`). They would read each other's retire and maintenance markers and share one scheduled-jobs leader. The plan checks this (`REDIS_SHARED`, or `REDIS_UNVERIFIED` when it cannot see)."
      ]
    },
    {
      type: 'h2',
      id: 'hub-moves-retire',
      text: 'Retiring the old placement'
    },
    {
      type: 'p',
      text: 'A dedicated source is retired over its hub link, whatever driver runs it. A retired app stops running scheduled jobs and its background drainers (renders, imports, exports, media, reminders), closes open sockets and streams, refuses new socket connections, and answers `503 APP_MOVED` on every path except `/api/hub-link/*`, `/api/hub-transfer/*`, `/api/version`, `/api/ready` and `/api/health`. The state is kept in its Redis, so a restart stays retired. A Docker source stack is then removed with its volumes kept; a GitLab source is never stopped by the Hub, and the checklist item `old_stack_stopped` ("Stop the old stack") stays. A move back to the same process clears the marker first (`DELETE /api/hub-link/retire`). The retire state reads as retired while it cannot be read, so an unknown state never serves.'
    },
    {
      type: 'h2',
      id: 'hub-moves-checklist',
      text: 'Checklist'
    },
    {
      type: 'p',
      text: 'Each item is a statement you vouch for. The panel shows the checklist before the typed confirmation; the move starts only when every required item is ticked, and you can also tick later ones while it runs.'
    },
    {
      type: 'table',
      head: ['Item', 'When it appears', 'Must be ticked'],
      rows: [
        [
          '`callbacks_registered`',
          "Moving to a shared deployment. Lists `https://<host>/api/auth/callback` for each name; add them to the deployment's Microsoft app registration. For an app that signs in via the Hub (target 0.3.215 or later, active client) they serve direct sign-in while the Hub is down.",
          'yes'
        ],
        [
          '`route_ticket`',
          'Manual routing. The route request is filed with whoever runs the names (DNS, proxy, certificates).',
          'yes'
        ],
        [
          '`issuer_same`',
          "The Hub could not read the source's sign-in issuer (`ISSUER_UNVERIFIED`). You vouch both sides use the same Entra tenant.",
          'yes'
        ],
        [
          '`extension_builds_same`',
          'One side names no image pin for an extension (`EXTENSION_PIN_UNVERIFIED`). You vouch the app runs the same build as the deployment installs.',
          'yes'
        ],
        [
          '`gitlab_boot_window`',
          'A GitLab target that is not proven to start in maintenance (`GITLAB_BOOT_WINDOW`).',
          'yes'
        ],
        [
          '`volumes_one_node`',
          'The target Docker agent could not be read (`MULTI_NODE_UNVERIFIED`). You vouch its files sit on one node, or on volumes every node shares.',
          'yes'
        ],
        [
          '`redis_separate`',
          "The Hub cannot see one side's Redis (`REDIS_UNVERIFIED`). You vouch source and target do not share one Redis database and prefix.",
          'yes'
        ],
        [
          '`storage_local`',
          'The Hub cannot see where one side keeps files (`STORAGE_UNVERIFIED`; only before 0.3.215, which copies every provider). You vouch every file is on local storage.',
          'yes'
        ],
        [
          '`db_identity_checked`',
          "Other apps on the target could not be compared with this app's database (`DB_IDENTITY_UNCHECKED`). You vouch none uses the same server and name.",
          'yes'
        ],
        [
          '`old_stack_stopped`',
          'A GitLab source. Stop the old stack after the move.',
          'no (it stays open after `retire_source`)'
        ],
        [
          '`retire_source`',
          "Added by the run when the old placement could not be retired (the move is a success with a warning): retire or stop it yourself. When the new home's key did not check, the move stays interrupted instead and the item names the ways out that can work; the Hub ticks it once it retires the old home. After Finish and stop the old home the item says to remove the stopped old home when you are sure.",
          'no'
        ],
        [
          '`temp_host`',
          "Added by the run when the per-move name could not be removed from the target stack at the end. Apply the environment's stack again (Apply now renders only its own names), then check that the name no longer serves the app.",
          'no'
        ],
        [
          '`repoint_name`',
          'Added after a rollback of a move whose manual route a person already did: point the names back to the source.',
          'yes (to close the move)'
        ],
        [
          '`target_stopped`',
          'Added when a rollback halts (`HALTED_TARGET_LIVE`): what to stop, and the statement you vouch for.',
          'yes (the rollback waits for it)'
        ]
      ]
    },
    {
      type: 'h2',
      id: 'hub-moves-blockers',
      text: 'Blockers'
    },
    {
      type: 'p',
      text: 'Blockers keep the Start button disabled. A blocker names plain facts (versions, counts, kinds, names), never a record, token, ticket, key or connection.'
    },
    {
      type: 'table',
      head: ['Code', 'Plain meaning'],
      rows: [
        ['`SAME_PLACEMENT`', 'The target is where the environment already is.'],
        [
          '`NOT_HUB_LINKED`, `LINK_UNREACHABLE`',
          'The dedicated side has no hub token, or its hub link does not answer (an app older than moves need answers with no shared-readiness report). The plan reads the source over its link.'
        ],
        ['`VERSION_DIFFERS`', 'The target runs another version. Moves never change a version.'],
        [
          '`EXTENSION_NOT_ALLOWED`, `EXTENSION_VERSION_DIFFERS`',
          'The shared deployment does not load, or installs another image build of, an extension the app uses.'
        ],
        [
          '`NO_DATABASE_RECORD`',
          'The environment names no Hub database record, or it is not ready, so the target cannot be told which database to open. Fix: in the Databases tab open the database the app runs on (adopt it first if the Hub does not record it), then Attach to environment… on its Environment card, and Plan again. See Attach to an existing environment in Hub databases.'
        ],
        [
          '`DATABASE_DIFFERS`, `DB_UNREACHABLE_FROM_TARGET`, `DB_IDENTITY_SHARED`',
          'The target would open another database than the source serves, cannot confirm it, or cannot reach it; or another app on the target reports the same database identity so the Hub cannot prove which is which. Rechecked at `check` and `target_ready`.'
        ],
        [
          '`APP_KEY_UNKNOWN`, `APP_KEY_MISMATCH`',
          "The Hub does not know the app's encryption key, or the key it knows does not match the fingerprint the app reports (or the Docker stack settings hold another one). Sealed values would be unreadable."
        ],
        [
          '`SIGNIN_VIA_HUB`',
          'The app signs in via the Hub and the target runs before 0.3.215, or the environment has no active sign-in client at the Hub.'
        ],
        [
          '`ISSUER_DIFFERS`',
          "The deployment's sign-in issuer is in another Entra tenant than the app's, so accounts would not match."
        ],
        [
          '`POOL_BUDGET`, `POOL_TOO_SMALL`',
          'The shared deployment would pass its pool budget, or the connections asked are fewer than 2.'
        ],
        [
          '`BUSY`, `SHARED_BUSY`, `SHARED_NOT_ACTIVE`',
          'A lock is held on the environment or the deployment (also: an open move of this environment, or a lock the Hub could not read), an upgrade runs, or the deployment is retired or has not been deployed by the Hub yet.'
        ],
        [
          '`TARGET_UNREACHABLE`, `SOURCE_UNREACHABLE`, `TARGET_IN_USE`, `DRIVER_UNSUPPORTED`',
          'The target or source cannot be reached (also the Traefik-only Docker source with a manual route); a dedicated target placement is used by another environment; the driver cannot do this kind of move.'
        ],
        ['`HOSTNAME_TAKEN`', 'Another environment of the Hub already claims one of the names.'],
        ['`REDIS_SHARED`', 'Source and target use the same Redis database.'],
        [
          '`GATHER_FAILED`',
          'The Hub could not read part of what it needs to plan. Plan again shortly.'
        ],
        [
          '`ISSUE_TRACKERS`, `EXEC_SCRIPT_FLOWS`, `SQLITE`, `ENV_OBJECT_STORAGE`',
          'The app uses something a shared app cannot do yet (see Shared deployments), or keeps files in env-driven object storage. Detail gives counts and kinds, never records. `STAGED_IMPORTS` and `ROW_SCHEDULES` still apply only when the target deployment runs a version before 0.3.212 or one the Hub cannot read; `ENV_OBJECT_STORAGE` only while either side runs a version before 0.3.215 or one the Hub cannot read.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'A failing preflight on the new home is not a plan blocker: it fails `target_ready` (`PREFLIGHT_FAILING`) and the move rolls back.'
    },
    {
      type: 'h2',
      id: 'hub-moves-warnings',
      text: 'Warnings'
    },
    {
      type: 'table',
      head: ['Code', 'Plain meaning'],
      rows: [
        [
          '`SIGN_IN_AGAIN`',
          'Everyone signs in again after a move, because sessions live in the old Redis. Phone and MCP sign-ins too.'
        ],
        [
          '`SIGNED_LINKS_RESET`',
          'Links signed with the session secret stop working, because the two placements have different secrets. That includes submission status links (valid 90 days), help-video and export links and message-action links in mail. People can ask for new ones. Unsaved form drafts are dropped too (they are sealed with the same secret): ask people to save their open forms first.'
        ],
        [
          '`SAME_APP_ON_DEPLOYMENT`',
          "Another environment of the same app is already on the target deployment. A copy carries the original's saved Teams bot and directory registration: turn the bot off on the copy if it should not answer."
        ],
        [
          '`REPLAYS_NOT_MOVED`',
          'Before 0.3.215: session replays kept in file storage and image transform caches stay behind. From 0.3.215 the replays are copied.'
        ],
        [
          '`MANUAL_ROUTE`, `OLD_STACK_STOP`, `GITLAB_BOOT_WINDOW`, `STACK_REAPPLY_ALL`',
          'A person has to do the route change; the old GitLab stack must be stopped afterwards; a GitLab target may run briefly without maintenance; new names re-apply the whole shared stack.'
        ],
        [
          '`MULTI_NODE_VOLUMES`, `MULTI_NODE_UNVERIFIED`',
          'The target stack has local volumes on a swarm with several nodes (or the Hub could not read the agent to tell).'
        ],
        [
          '`ISSUER_UNVERIFIED`, `REDIS_UNVERIFIED`, `STORAGE_UNVERIFIED`, `DB_IDENTITY_UNCHECKED`, `EXTENSION_PIN_UNVERIFIED`',
          'A check could not be made. Each comes with a required checklist item (above).'
        ],
        [
          '`DIRECTORY_ENV_CREDENTIALS`, `TEAMS_BOT_ENV_CREDENTIALS`, `PUSH_RELAY_ENV`, `SETTINGS_ENV_OVERRIDES`, `HUDDLE_TURN`, `ENV_SMTP`, `SESSION_REPLAYS`, `HELP_VIDEO_RENDERS`',
          'Features a shared app does not have, or that behave differently (see Shared deployments). `DIRECTORY_SYNC`, `PHONE_PUSH`, `TEAMS_BOT` and `MAIL_RETRY` are reported only for a target before 0.3.212 or one the Hub cannot read; `HUDDLE_TURN` only for a target before 0.3.215; `ENV_SMTP` unless both the app and the target run 0.3.215 or later.'
        ],
        [
          '`ENV_SMTP_KEPT`, `INSTANCE_SETTINGS_CARRIED`, `INSTANCE_SETTINGS_STAY`',
          "The app's per-instance settings row is copied to the shared deployment's instance name when the move puts it in maintenance (or, `STAY`, not carried: enter them again), and its environment mail settings are kept in that row (the password sealed with the app key, a forced test mode kept on)."
        ]
      ]
    },
    {
      type: 'h2',
      id: 'hub-moves-notice',
      text: 'What people notice'
    },
    {
      type: 'ul',
      items: [
        'A maintenance page ("This app is being updated", retry in 30 seconds) for browsers and `503 APP_MAINTENANCE` for the API, from `maintenance_on` until `release`.',
        'Everyone signs in again once, signed links (above) stop working, and unsaved form drafts are dropped.',
        'Writes during maintenance are refused for every person, administrators included: the freeze is strict.',
        'The names stay the same. With automatic routing nobody has to do anything.'
      ]
    },
    {
      type: 'h2',
      id: 'hub-moves-routes',
      text: 'Routes'
    },
    {
      type: 'table',
      head: ['Route (Hub administrators)', 'Does'],
      rows: [
        [
          '`POST /api/hub/environments/:envId/move/plan`',
          'Body `{to}`: `{kind: "shared", shared_id, pool_max?}` or `{kind: "dedicated", placement_id}`. Answers the plan (`BAD_TARGET`, `BAD_POOL` and similar 400s for a bad body).'
        ],
        [
          '`POST /api/hub/environments/:envId/move`',
          'Body `{to, plan_hash, confirm, checklist, overrides?}`. 202 `{move_id}`. 400 `CONFIRM_MISMATCH`, `BAD_OVERRIDE`; 409 `PLAN_CHANGED`, `PLAN_BLOCKED`, `CHECKLIST_INCOMPLETE`, `BUSY`, `SHARED_BUSY`, `SOURCE_UNREACHABLE`, `TARGET_UNREACHABLE`, `LINK_URL_NOT_PULLABLE`, `SOURCE_NOT_PULLABLE`.'
        ],
        [
          '`GET /api/hub/moves/:id`, `GET /api/hub/environments/:envId/moves`',
          'One move with its steps, or the history of an environment (newest first). A read marks a run that stopped elsewhere as `interrupted`.'
        ],
        [
          '`POST /api/hub/moves/:id/cancel`',
          'Cancel (rolls back before `release`). 202. Also what Roll back sends for an interrupted move.'
        ],
        [
          '`POST /api/hub/moves/:id/resume`',
          'Resume an interrupted move (409 `NOT_INTERRUPTED` otherwise).'
        ],
        [
          '`POST /api/hub/moves/:id/confirm-route`',
          'Check the public name now (manual routing). Answers `{serving}`; 409 `NOT_WAITING`.'
        ],
        ['`POST /api/hub/moves/:id/checklist`', 'Body `{item, done}`. Answers the checklist.'],
        [
          '`POST /api/hub/moves/:id/finish-stop-source`',
          'Finish and stop the old home: body `{confirm}` (`<app>/<env>`). 202. 400 `CONFIRM_MISMATCH`; 409 `NOT_RELEASED`, `NOT_STOPPED_AT_RETIRE`, `CANNOT_STOP_OLD_HOME`, `NEW_HOME_NOT_SERVING`, `MOVE_CHANGED`, `MOVE_ENDED`.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Hub link routes on a dedicated app, mounted with `HUB_TOKEN` exactly as before, carry the move: `POST /api/hub-link/maintenance` (`{on, message?, move_id?}`), `POST` and `DELETE /api/hub-link/retire`, `GET /api/hub-link/shared-readiness`, and the file routes `POST` and `DELETE /files/ticket`, `POST /files/pull`, `GET /files/pull/:runId`; `GET /status` adds `maintenance` and `retired`. The source serves the files on `GET /api/hub-transfer/files/:id`, authorised by a transfer ticket (`Authorization: Transfer <ticket>`) and nothing else. These routes extend the read-only link of phase 1: they carry counts and kinds and file bytes between the two apps, never records and never through the Hub.'
    },
    {
      type: 'note',
      text: 'The move activity rows are `hub-move-start` (also a resume), `hub-move-done`, `hub-move-rolled-back`, `hub-move-cancel` (also a Roll back of an interrupted move), `hub-move-finish-stop` (Finish and stop the old home), `hub-move-route-confirm` and `hub-move-checklist`. None contains a token, ticket, key or connection. After a move ends the Move… panel keeps showing its result until you dismiss it (per browser); an ended move stays in the environment history as "Moved".'
    }
  ]
}
