import type { DocSection } from '../types.js'

// Written from the phase-6 plan and the task reports. Every spot that depends on a task that was
// not merged when this was written carries a `T19-CHECK: Task N` comment, so a touch-up pass can
// verify it against the merged code (Tasks 5, 10, 15, 16, 17, 18; 22 is the module-state guard).

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
          'Writes the stack (one web service, replicas by size, bundled or external Redis), applies it, and upgrades and rolls it back. The stack is owned by the deployment key, never by an app. The Hub makes `SESSION_SECRET` and `ENCRYPTION_KEY` once and keeps them sealed.'
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
      text: 'Mode and key cannot be changed after the deployment is created. Create the deployment on the Shared deployments tab of the Apps hub (Hub administrators). The key is 1 to 63 characters (lowercase letters, digits and dashes). The link address must be https, or http for a loopback or private address, with no user, password or path.'
    },
    // T19-CHECK: Task 17 (the tab is called "Shared deployments" and sits after Apps in the Apps hub; create and edit are inline panels)
    { type: 'h2', id: 'hub-shared-token', text: 'The token and the environment block' },
    {
      type: 'p',
      text: 'Creating a deployment shows its token once, with the environment block to copy. Later the token reads as ••••••. The one token works both ways: the deployment uses it to ask the Hub for its tenant list, and the Hub uses it to call the deployment link. The Hub never sends the token itself to the link: both sides derive a bearer from it (HMAC-SHA256 of the token over a fixed label), so a sniffed link call cannot open the tenants route.'
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
          'The token, at least 32 characters. A stack secret, never a plain environment variable. `_FILE` works.'
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
          'Needed behind a proxy so the app is picked from the real `Host` (see Deployment modes). A docker-mode stack sets it.'
        ]
        // T19-CHECK: Task 5 (renderSharedSpec sets TRUST_PROXY on shared stacks; carried from the Task 7 review)
      ]
    },
    {
      type: 'p',
      text: 'Rotating the token shows the new one once. The previous token keeps working for 24 hours so replicas can be rolled over. In docker mode the Hub applies the stack again with the new token. After 24 hours a replica that still sends the old token is refused, and the failed-token brake counts per address: replicas behind one egress address that all send an expired token lock that address out for a minute at a time (20 tries). Rotate, then roll the new token out to every replica inside the 24 hours.'
    },
    // T19-CHECK: Task 5 (docker-mode rotation re-applies the stack, ruling R7)
    { type: 'h2', id: 'hub-shared-extensions', text: 'Extensions: HUB_SHARED_EXTENSIONS' },
    {
      type: 'ul',
      items: [
        'A shared deployment loads only the extensions listed in `HUB_SHARED_EXTENSIONS`. It never scans the extension folder for others, and an unlisted folder is never imported.',
        'On a shared deployment the extension folder must be named by the extension id. A listed folder whose extension declares another id is not loaded.',
        'A listed extension must also declare `shared: true` in its definition. It promises that every cache, module variable and connection it keeps is held per app. An unflagged listed extension is refused: it is not loaded, the extension registry shows it as an error, and the readiness check `shared-extensions` fails and names it with the reason.',
        'The contents of a listed folder are trusted. Its module is imported before its id and flag are compared, so list only folders you control.',
        'An app whose extensions are not all in the list cannot be placed (`EXTENSION_NOT_ALLOWED`). An app that pins another version of a listed extension than the deployment runs gets `EXTENSION_VERSION_DIFFERS`. The deployment reports what it loaded; the detail page warns when that differs from the Hub list.',
        'efp-ops is not safe on a shared deployment yet. Its module caches are not held per app (erp-record, integration-user, forecast-worksheet, send-back-flag and priority-guard), so it does not declare `shared: true`, and an app that uses it cannot be placed on a shared deployment until it is audited and flagged.',
        'The `shared` field is part of `@nivaro/extension-kit`. A kit release has to be published (or the kit rebuilt) wherever an extension type-checks against a released kit, before it can declare the flag.'
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
        "A shared stack has no `realtime` role (`ROLE_NOT_SHARED`), and the stack's environment must name its own key (`SHARED_KEY_MISMATCH`). These two agent field codes join the others in Docker driver and Hub agent.",
        'An agent from before phase 6 answers `UNKNOWN_FIELD` for `host_pattern` and `REQUIRED` for an empty `hostnames` list. Update the agent before deploying a shared stack.'
      ]
    },
    // T19-CHECK: Task 5 (pattern + explicit hosts in the rendered spec; HUB_URL_PROBLEM and MULTI_NODE_VOLUMES warnings)
    { type: 'h2', id: 'hub-shared-pool', text: 'Pool budget' },
    {
      type: 'p',
      text: 'Each placement on a shared deployment carries a pool size (1 to 20 connections, default 5; a shared placement needs at least 2, because one connection holds the migration lock while another migrates). The deployment has a pool budget (default 60, range 1 to 500). A placement that would take the sum of pool sizes over the budget is refused with `POOL_BUDGET`. The budget is per process: with three replicas the database sees up to three times the sizes. Per-process fairness for the heavy-read slots between apps is not built; the budget only caps connections.'
    },
    { type: 'h2', id: 'hub-shared-migrations', text: 'Per-app migrations and the not-ready page' },
    {
      type: 'ul',
      items: [
        "When an app enters the list, or the deployment's version changes, the deployment migrates that app's database, at most 2 apps at a time. It takes the per-engine advisory lock (a transaction advisory lock on Postgres, an application lock on SQL Server). MySQL and MariaDB take a server-wide lock, so two apps on one MySQL server migrate one after the other, not together.",
        'After the migrations it makes sure the default workspace row exists and runs the schema steps of each allowed extension.',
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
        "Storage scope. Where files live in the deployment storage (the env-driven provider), every object key is prefixed `apps/<tenant id>/`. The prefix applies to saved-settings S3 and Azure drivers too. So two apps with copied databases (a development copy of production) can never read or delete each other's objects. New keys are flat inside the scope. A key with `..`, a leading `/`, a backslash or a NUL is refused.",
        "Encryption key. Each app's sealed values (stored credentials, tokens) were written with that app's `ENCRYPTION_KEY`. On a shared deployment the app's own key is used, from the Hub's tenant list. If an app has no key a seal or open fails with `APP_KEY_MISSING` (503). It never falls back to the deployment's key or to another app's. A value that belongs to the deployment itself, like the sealed copy of the tenant list in Redis, uses the deployment key (`encryptForDeployment`).",
        'Where the Hub gets the key: the key entered for the environment first; then, once, the Docker stack settings key (copied into the entry); a new key is generated only for a database known to be empty (made by the Hub, or without a `nivaro_migrations` table). An adopted database that already holds an installation, with no known key, is refused (`APP_KEY_UNKNOWN`): an administrator enters the key. A GitLab-created app has to have its key entered.',
        'Fingerprints. The Hub and the app compare `keyFingerprint(key)` (a keyed hash, first 32 hex characters). The key itself never crosses the hub link. Saving a key that differs from the one the app reports is refused (`APP_KEY_MISMATCH`); replacing a stored key needs a positive match (`APP_KEY_UNVERIFIED` otherwise); an app that has already served on a shared deployment refuses a different key (`APP_KEY_IMMUTABLE`).',
        "Origin. Links in job mail, the phone app and the OAuth issuer use the app's own origin (the origin of its Hub base URL), not the deployment's.",
        'Credentials. Sessions, run-as keys, socket tickets, media tickets, export links and similar signed values are bound to their app, so a value minted in one app is refused in another even when the two databases are copies. The scan that proves it lists every Redis key and every signing site.',
        "Module state. Caches that hold an app's configuration (collections, fields, permissions, workflows, pipelines, templates, flows) are kept per app on a shared deployment. A guard test fails when new module-level state is added without being keyed per app or listed with a reason."
        // T19-CHECK: Task 22 (the module-state guard test and its fixes; confirm the wording and the list of areas)
      ]
    },
    {
      type: 'note',
      text: 'Placing two environments of one app on one deployment is allowed (the usual case is development, staging and production together). The plan warns `SAME_APP_ON_DEPLOYMENT` and nothing more: the protections above are what keep copied databases apart.'
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
        // T19-CHECK: Task 10 (file routes appended under /apps/:id/: files/ticket, files/pull, files/pull/:runId)
        [
          '`POST /api/hub-deployment/apps/:id/files/ticket`, `files/pull`, `GET files/pull/:runId`',
          'Mints a transfer ticket for one app, starts a file pull into it, and reads the pull state. Used by moves (Moving an environment).'
        ]
      ]
    },
    { type: 'h2', id: 'hub-shared-tenants', text: 'The tenants contract, with phase 6 additions' },
    {
      type: 'p',
      text: 'The Hub serves the call described in Deployment modes: `GET /api/hub/shared/<key>/tenants` with the bearer. Phase 6 adds two optional fields to each tenant, so an old deployment keeps working with the new Hub and the other way round: `origin` (the origin of the environment\'s base URL; a value that is not an http(s) origin is dropped, not the tenant) and `encryption_key` (64 hex characters; a bad key drops that tenant with the reason "bad encryption key").'
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
      text: 'An environment that has never served can be placed straight on a shared deployment: Apps → the environment → Place on shared deployment, or `POST /api/hub/environments/:envId/place-shared` with `{shared_id, database_id, pool_max?, first_admin: {email, first_name?, last_name?}}`. An environment that has served moves instead (Moving an environment); a refusal says `USE_MOVE`.'
    },
    // T19-CHECK: Task 18 (the "Place on shared deployment…" action name on the environment row)
    {
      type: 'ul',
      items: [
        'Before anything is written: the deployment must exist, not be retired and not be busy (`SHARED_RETIRED`, `SHARED_BUSY`); the app must not sign in via the Hub (`SIGNIN_VIA_HUB`) and its extensions must be allowed (`EXTENSION_NOT_ALLOWED`); the database record must be ready and not in use by another environment (`DATABASE_NOT_READY`, `DATABASE_IN_USE`); the pool must be 2 or more (`POOL_TOO_SMALL`) and inside the budget (`POOL_BUDGET`). A Hub database record is never SQLite.',
        "The run (a job run): make the placement and set the environment's database, pin and status `provisioning`; ask every replica to re-read; wait up to 2 minutes for every live replica to hold the list that names the app; wait up to 10 minutes for the app's schema to be `ok` (a failed schema stops the run and names the app's own error); seed the first administrator; set the environment `active`.",
        'A failed run leaves the environment `provisioning` on its placement: place it again to retry.',
        'The Hub keeps no app key it cannot prove: it uses the one it knows, or generates one only for a database known to be empty.'
      ]
    },
    { type: 'h2', id: 'hub-shared-guards', text: 'What a shared-placed environment refuses' },
    {
      type: 'p',
      text: "An environment placed on a shared deployment is never promoted, stacked or created directly. Promote plans block with `SHARED_PLACEMENT`; the stack routes, and creation on it, answer 409 `SHARED_PLACEMENT`. Change its version by upgrading the deployment, or move it. Changing its placement through the environment edit answers `USE_MOVE`. 'Forget stack' (`POST /api/hub/placements/:id/forget-stack` with `{confirm: <stack name>}`) lets an environment drop a Docker stack that is gone for good: it answers 409 `STACK_RUNNING` while the agent still reports the stack."
    },
    { type: 'h2', id: 'hub-shared-upgrade', text: 'Upgrades and rollback' },
    // T19-CHECK: Task 5 (whole section: plan blockers, run steps, route names and codes)
    // T19-CHECK: Task 17 (upgrade panel in the deployment detail: version Combobox, per-app blockers, typed key, live steps)
    {
      type: 'p',
      text: 'In docker mode the Hub upgrades the whole deployment in one run. A registered deployment is upgraded by whoever runs it; the plan says `SHARED_NOT_HUB_DEPLOYED`.'
    },
    {
      type: 'table',
      head: ['Plan check', 'Meaning'],
      rows: [
        [
          '`SHARED_NOT_HUB_DEPLOYED`',
          'The deployment is registered, so the Hub cannot upgrade it.'
        ],
        [
          '`BUSY`',
          'The deployment or one of its environments holds a lock (a move, a placement or another upgrade).'
        ],
        [
          '`VERSION_UNKNOWN`, `AGENT_UNREACHABLE`',
          'The version is not in the image registry the Hub watches, or the agent does not answer.'
        ],
        [
          '`ORDER`',
          'The previous environment of an app has not run this version successfully. A Hub administrator may override it per app; the override is listed in the run and logged.'
        ],
        [
          '`PREFLIGHT_FAILING`',
          "An app's own preflight is failing before the upgrade. A Hub administrator may override it, and the override is logged."
        ],
        [
          '`HUB_URL_PROBLEM`, `MULTI_NODE_VOLUMES`',
          'Warnings: the Hub address would be refused at boot, or the stack has bundled volumes on a swarm with more than one node.'
        ]
      ]
    },
    {
      type: 'p',
      text: "The run asks you to type the deployment key, and lists every app on it. Then, holding the deployment lock and every placed environment lock: render the stack, apply it through the agent, wait up to 30 minutes until every live replica reports the new version, wait up to 10 minutes until every app's schema is `ok`, and check each app's public name answers `/api/version` at the new version. On success every placed environment gets the new version pin and one deploy row of kind `shared`, and one job run is written."
    },
    {
      type: 'ul',
      items: [
        'If it fails, the run is `failed` and names the apps that failed. Nothing is reverted by itself: the pins stay unchanged and the other apps keep serving. A rollback is a new run of the previous version (kind `rollback`) with its own plan.',
        'Cancel is possible while the run waits for the version. A run whose heartbeat is older than 2 minutes after a Hub restart shows as `interrupted`.',
        'While a move into or out of the deployment is waiting (a manual route can wait up to 24 hours), an upgrade is refused with `BUSY` and the deployment page says which move it waits for.'
      ]
    },
    {
      type: 'p',
      text: 'Routes (Hub administrator): `POST /api/hub/shared/:id/upgrade/plan`, `POST /api/hub/shared/:id/upgrade` (202; `409 PLAN_CHANGED` carries the new plan), `GET /api/hub/shared-deploys/:id`, `POST /api/hub/shared-deploys/:id/cancel`.'
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
          'Reads the fingerprint, or saves the key (64 hex). The body never reaches the API log or the Traffic Map capture.'
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
      text: 'Each item below is deferred. The Hub enforces it when a dedicated app moves in: a blocker stops the move, a warning is shown in the plan. A new environment placed straight on a shared deployment has none of these features from the start.'
    },
    {
      type: 'table',
      head: ['Gap', 'What happens', 'Move check'],
      rows: [
        [
          'Staged imports (file upload, import drainer)',
          'The upload answers 409 `IMPORTS_NOT_ON_SHARED`. Imports that run inside the request still work.',
          'blocker `STAGED_IMPORTS`'
        ],
        [
          'Row schedules (scheduled reports, retention policies, sync jobs, scheduled flows)',
          'Per-app hydration is missing. Silent loss is worse than no move.',
          'blocker `ROW_SCHEDULES`'
        ],
        ['GitLab issue sync', 'Off.', 'blocker `ISSUE_TRACKERS`'],
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
          'Objects in an env-driven S3 or Azure provider',
          "A move copies only the objects the deployment storage holds (the `local` provider). Settings-driven S3 and Azure (the app's own bucket) are unaffected.",
          'blocker `ENV_OBJECT_STORAGE`'
        ],
        [
          'Sign-in via the Hub, and the switcher pushes',
          "An app on shared signs in directly with the deployment's primary OIDC.",
          'blocker `SIGNIN_VIA_HUB`'
        ],
        [
          'Per-app OIDC client',
          "Phase 6 uses the deployment-wide client; the app's own client record is not used. Each app's callback address must be registered on that one Entra app.",
          'checklist item `callbacks_registered`'
        ],
        [
          'Microsoft directory lookups and sync',
          'The directory reads as not configured.',
          'warning `DIRECTORY_SYNC`'
        ],
        [
          'Phone sign-in and push, Teams bot, automatic mail retry, huddle relay (TURN)',
          'Off on shared, as in cloud.',
          'warnings `PHONE_PUSH`, `TEAMS_BOT`, `MAIL_RETRY`, `HUDDLE_TURN`'
        ],
        [
          'Mail settings from the environment (`SMTP_*`)',
          'An app uses its own saved mail settings.',
          'warning `ENV_SMTP`'
        ],
        [
          'Session replays',
          'Not moved by a move.',
          'warnings `SESSION_REPLAYS`, `REPLAYS_NOT_MOVED`'
        ],
        [
          'Help-video renders queued before a restart',
          'They render again on the next publish.',
          'warning `HELP_VIDEO_RENDERS`'
        ],
        // T19-CHECK: Task 15 (preflight R15: SLA_FLIPS, WEEKLY_DIGESTS, RETENTION_PASS readiness warnings; confirm they were built, else drop the code names)
        [
          'Live SLA flips, weekly digests, the per-app retention pass, boot passes against a database',
          'Off on multi-tenant processes.',
          'readiness warnings `SLA_FLIPS`, `WEEKLY_DIGESTS`, `RETENTION_PASS`'
        ],
        [
          'Deployment-wide process jobs (pool monitor, socket sample)',
          'No deployment store yet. The figures are live on the deployment link status.',
          '-'
        ],
        ['Config epochs per app', 'The metadata cache expires on its own TTL, as in cloud.', '-'],
        ['Per-process heavy-read slots per app', 'Only the pool budget caps connections.', '-'],
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
      text: 'A move takes an environment that serves today and runs it from somewhere else: from a dedicated stack to a shared deployment, from a shared deployment to a dedicated stack, or from one shared deployment to another. The database never moves: the new placement opens the same database the old one used. Files are copied. A move is a recorded, locked and resumable run of fixed steps, and every step before release can be rolled back. Moves are for Hub administrators.'
    },
    // T19-CHECK: Task 16 (the whole page: steps, budgets, statuses, route names) and Task 18 (the Move… panel)
    {
      type: 'ul',
      items: [
        'A move never changes the version. The new placement must run the same version as the old one (`VERSION_DIFFERS`). Upgrade first, or promote after.',
        'The environment is in maintenance for part of the move (below), so choose a quiet time. Starting a move asks you to type `<app key>/<environment key>`.',
        'A move holds the environment lock (holder `move`) and the lock of every shared deployment it touches. Promotions, stack changes and other moves of that environment are refused (`BUSY`) and an upgrade of a touched deployment is refused (`SHARED_BUSY` on the move plan).',
        'A move writes one deploy row (kind `move`, the version unchanged) and a job run, so the environment history reads "Moved".'
      ]
    },
    { type: 'h2', id: 'hub-moves-steps', text: 'Kinds and steps' },
    {
      type: 'table',
      head: ['Kind', 'Steps in order'],
      rows: [
        [
          '`to_shared`',
          '`check`, `files_warm`, `maintenance_on`, `wait_idle`, `files_delta`, `place_on_target`, `target_ready`, `route`, `verify`, `release`, `retire_source`, `done`'
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
        ['`check`', 'Reads the plan again and the source over its link. Stops at a blocker.'],
        [
          '`files_warm`',
          'Copies the files while the source is still serving. The first warm copy is a full copy.'
        ],
        [
          '`maintenance_on`',
          'Puts the source into maintenance (and waits for every replica to hold it). On a shared source that is the Hub status `maintenance`, held until every live replica has the new list. On a dedicated source it is a strict maintenance write over the hub link: no administrator is exempt. The step then waits 16 seconds so every replica of the source enforces it.'
        ],
        [
          '`wait_idle`',
          'Waits up to 10 minutes until the source has no running imports, exports or renders.'
        ],
        [
          '`files_delta`, `files_full`',
          'Copies what changed since the warm copy (shared target), or everything (a dedicated target exists only now).'
        ],
        [
          '`deploy_target`',
          "Writes the pin at the current version and deploys the dedicated target: a Docker stack through the agent (booted in maintenance, `HUB_BOOT_MAINTENANCE=<move id>`), or the placement's deploy job for GitLab. The target stack starts with no host names; `route` adds them."
        ],
        [
          '`place_on_target`',
          'On a shared target, lists the environment on the deployment, held in maintenance.'
        ],
        [
          '`target_ready`',
          'Up to 10 minutes: the target opens the same database (identity checked), its schema is `ok`, its preflight passes, and for a dedicated target the retire marker from an earlier move is cleared. The encryption key fingerprint must match. A mismatch rolls the move back.'
        ],
        [
          '`route`, `verify`',
          'Switches the public name, then checks that the name answers `/api/version` at the version, with `shared_deployment` equal to the target key (to shared) or absent (to dedicated), and the right tenant.'
        ],
        [
          '`release`',
          "The point of no return. Sets the environment's placement and version pin, turns the target's maintenance off, and sets the environment `active`."
        ],
        [
          '`retire_source`',
          "Retires a dedicated source over its hub link (below), removes a Docker source stack (volumes kept), or drops the tenant from a shared source's list."
        ]
      ]
    },
    {
      type: 'p',
      text: 'With manual routing the order changes, so the app keeps serving while you wait for a person to switch the name: the target is prepared first (`place_on_target` or `deploy_target`, the target held in maintenance, a warm file copy), then the route is waited for while the source still serves, and only then `maintenance_on`, `wait_idle`, `files_delta`, `target_ready`, `release`, `retire_source`. A target held in maintenance does not run jobs, so jobs never run twice.'
    },
    { type: 'h2', id: 'hub-moves-routing', text: 'Automatic and manual routing' },
    {
      type: 'p',
      text: "Routing is automatic only when every route change is the Hub's to make. Otherwise it is manual: the Hub shows the exact request and waits up to 24 hours. Both modes end in the same check: the public name must answer."
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
          "Drops the host from A if explicit; adds it to B unless it is under B's pattern."
        ],
        [
          'Any side on GitLab, a registered deployment, a publish edge (no Traefik) or another driver',
          'any',
          'Manual: the request names the host, the target (link address or stack) and the TLS need; you confirm when it is done.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The waiting card has Check now: the Hub tries the public name and continues when it answers as the target. Nothing is switched by the Hub in manual routing. If the 24 hours pass without a confirmed name, the move fails and rolls back.'
    },
    // T19-CHECK: Task 15 (the decision table and the manual step order, ruling B8)
    { type: 'h2', id: 'hub-moves-files', text: 'Files' },
    {
      type: 'ul',
      items: [
        "The target pulls the files. It never goes through the Hub: bytes flow from the source app to the target app. The source authorises the pull with a transfer ticket (`nvt_…`, valid 6 hours) it minted on the Hub's request. The ticket is bound to one app, never appears in a log or an error, and the Hub revokes it when the move ends.",
        "What is copied: every file in the app's files table whose provider is the deployment-storage (`local`) provider. Objects keep their keys. An object already there at the same size is skipped, so a copy is resumable. A source answer larger than 5 GB for one object fails that file. A file the source says is missing is listed as missing (up to 50 ids), not as failed.",
        "Not copied: objects in an env-driven S3 or Azure provider (a blocker, `ENV_OBJECT_STORAGE`), the app's own saved-settings bucket (it is the same bucket on both sides), session replays and image transform caches (replays warn `REPLAYS_NOT_MOVED`; transforms are made again).",
        'A pull stalls if nothing moves for 10 minutes, and then fails. A failed pull keeps what it copied; Resume continues.',
        'A pull streams each object into a temporary file under the system temporary folder (`<tmpdir>/nivaro-hub-transfer/`) and only then stores it, so a failed object never leaves a half-written one. Temporary files older than 24 hours are removed when the next pull starts. A stack with a small `/tmp` should give the folder a volume; there is no setting for it yet.',
        "The one plain (not SSRF-pinned) fetch to an address another system named: when the source is a private IP literal (for example the Hub's own network), the pull fetches it with no redirects. A literal cannot be rebound. A source named by an https host name that resolves to a private address is refused unless it is listed in `SSRF_ALLOW_HOSTS`. Give the target either an origin that resolves publicly, or a private IP address.",
        "A source with S3 or Azure as the env provider but rows saying `local` (files from before a driver switch) is read through the source's storage, whole objects in memory on the source. Big files make the source use memory."
      ]
    },
    // T19-CHECK: Task 10 (ticket TTL, 5 GB cap, stall rule, temp folder, SSRF note) and Task 16 (ticket revoked at move end, first warm copy full)
    { type: 'h2', id: 'hub-moves-rollback', text: 'Rollback, resume and interrupted runs' },
    {
      type: 'ul',
      items: [
        "Any failure or Cancel before `release` rolls the move back, undoing the completed steps in reverse: `route` goes back, the placement on the target is removed, a deployed target stack is removed (volumes kept), and the source leaves maintenance. Copied files stay on the target. The move ends `rolled_back` and the environment returns to the status it had before. The app is then served by the source, never by both and never by neither past a step's budget.",
        'After `release` nothing is rolled back. If `retire_source` fails the move is `success` with a warning, and the checklist item `retire_source` stays open: retire or stop the old placement yourself.',
        'A run whose heartbeat is older than 2 minutes (the Hub restarted, or the process died) shows as `interrupted`, with Resume (continues from the stored step) and Roll back. Restarting the Hub marks such runs by itself.',
        'Cancel is a two-press confirm. Its text says "rolls back" before `release` and what it cannot undo after.',
        'Every rollback and every release sends the move id with its maintenance-off call. A dedicated target boots in strict maintenance with `HUB_BOOT_MAINTENANCE=<move id>`; only a maintenance-off call that names that move id lifts it, and a restart enters it again until then.',
        'If the Hub has lost the move and a container stays stuck in maintenance: remove `HUB_BOOT_MAINTENANCE` from the stack, then send `POST /api/hub-link/maintenance` with `{"on": false}` and no move id (or delete the `nvr:maintenance` key in that app\'s Redis). A move id that is not the held one answers 409 `MAINTENANCE_OTHER_MOVE` and lifts nothing.',
        "The source and the target of a move must not share one Redis database with the same key prefix (and the same `HUB_TOKEN`). They would read each other's retire and maintenance markers. The plan checks this."
      ]
    },
    { type: 'h2', id: 'hub-moves-retire', text: 'Retiring the old placement' },
    {
      type: 'p',
      text: 'A dedicated source is retired over its hub link, whatever driver runs it. A retired app stops running scheduled jobs and its background drainers (renders, imports, exports, media, reminders), closes open sockets and streams, refuses new socket connections, and answers `503 APP_MOVED` on every path except `/api/hub-link/*`, `/api/hub-transfer/*`, `/api/version`, `/api/ready` and `/api/health`. The state is kept in its Redis, so a restart stays retired. A Docker source stack is then removed with its volumes kept; a GitLab source is never stopped by the Hub, and the checklist item "Stop the old stack" stays. A move back to the same process clears the marker first (`DELETE /api/hub-link/retire`). The retire state reads as retired while it cannot be read, so an unknown state never serves.'
    },
    { type: 'h2', id: 'hub-moves-checklist', text: 'Checklist' },
    {
      type: 'table',
      head: ['Item', 'When', 'Required to start'],
      rows: [
        [
          '`callbacks_registered`',
          "Moving to shared. Lists `https://<host>/api/auth/callback` for each name; add them to the deployment's Microsoft app registration.",
          'yes'
        ],
        ['`route_ticket`', 'Manual routing. The request is done at the edge.', 'yes'],
        [
          '`old_stack_stopped`',
          'A GitLab source. Stop the old stack after the move.',
          'no (it stays open after `retire_source`)'
        ]
      ]
    },
    // T19-CHECK: Task 15 (checklist ids) and Task 18 (the checklist renders in the move panel)
    { type: 'h2', id: 'hub-moves-blockers', text: 'Blockers' },
    {
      type: 'p',
      text: 'The plan is read-only and lists blockers (the Start button stays disabled) and warnings. The plan carries a hash; if anything changes before you start, the start is refused with `PLAN_CHANGED` and the new plan.'
    },
    {
      type: 'table',
      head: ['Code', 'Plain meaning'],
      rows: [
        ['`SAME_PLACEMENT`', 'The target is where the environment already is.'],
        [
          '`NOT_HUB_LINKED`, `LINK_UNREACHABLE`',
          'The source app has no hub token, or its hub link does not answer. The plan reads the source over its link.'
        ],
        ['`VERSION_DIFFERS`', 'The target runs another version. Moves never change a version.'],
        [
          '`EXTENSION_NOT_ALLOWED`, `EXTENSION_VERSION_DIFFERS`',
          'The shared deployment does not allow, or pins another version of, an extension the app uses.'
        ],
        [
          '`NO_DATABASE_RECORD`',
          'The environment has no database record in the Hub, so the target cannot open it.'
        ],
        [
          '`DATABASE_DIFFERS`, `DB_UNREACHABLE_FROM_TARGET`',
          'The target would open another database than the source serves, or cannot reach it. Rechecked at `target_ready`.'
        ],
        [
          '`APP_KEY_UNKNOWN`, `APP_KEY_MISMATCH`',
          "The Hub does not know the app's encryption key, or the key it knows does not match the app's fingerprint. Sealed values would be unreadable."
        ],
        ['`SIGNIN_VIA_HUB`', 'The app signs in via the Hub. Not supported on shared yet.'],
        [
          '`ISSUER_DIFFERS`',
          "The deployment's sign-in issuer is in another Entra tenant than the app's, so accounts would not match."
        ],
        ['`POOL_BUDGET`', 'The shared deployment would pass its pool budget.'],
        [
          '`BUSY`, `SHARED_BUSY`, `SHARED_NOT_ACTIVE`',
          'A lock is held on the environment or the deployment, or the deployment is retired or not active.'
        ],
        [
          '`TARGET_UNREACHABLE`, `HOSTNAME_TAKEN`, `DRIVER_UNSUPPORTED`',
          'The target agent or link does not answer; another stack routes one of the names; the driver cannot do this kind of move.'
        ],
        [
          '`STAGED_IMPORTS`, `ROW_SCHEDULES`, `ISSUE_TRACKERS`, `EXEC_SCRIPT_FLOWS`, `SQLITE`, `ENV_OBJECT_STORAGE`',
          'The app uses something a shared app cannot do yet (see Shared deployments). Detail gives counts and kinds, never records.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-moves-warnings', text: 'Warnings' },
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
          'Links signed with the session secret stop working, because the two placements have different secrets. That includes submission status links (valid 90 days), help-video links and message-action links.'
        ],
        [
          '`SAME_APP_ON_DEPLOYMENT`',
          'Another environment of the same app is on the target deployment.'
        ],
        ['`REPLAYS_NOT_MOVED`', 'Session replays and image transform caches stay behind.'],
        [
          '`MANUAL_ROUTE`, `OLD_STACK_STOP`',
          'A person has to do the route change, or to stop the old GitLab stack.'
        ],
        [
          '`MULTI_NODE_VOLUMES`',
          'The stack has bundled volumes on a swarm with more than one node.'
        ],
        [
          '`DIRECTORY_SYNC`, `PHONE_PUSH`, `TEAMS_BOT`, `MAIL_RETRY`, `HUDDLE_TURN`, `ENV_SMTP`, `SESSION_REPLAYS`, `HELP_VIDEO_RENDERS`',
          'Features a shared app does not have (see Shared deployments).'
        ]
      ]
    },
    // T19-CHECK: Task 15 (final code list: SIGNED_LINKS_RESET, DATABASE_DIFFERS, ENV_OBJECT_STORAGE, PREFLIGHT_FAILING; check names against types.ts)
    { type: 'h2', id: 'hub-moves-notice', text: 'What people notice' },
    {
      type: 'ul',
      items: [
        'A maintenance page ("This app is being updated", retry in 30 seconds) for browsers and `503 APP_MAINTENANCE` for the API, from `maintenance_on` until `release`.',
        'Everyone signs in again once, and signed links (above) stop working.',
        'Writes during maintenance are refused for every person, administrators included: the freeze is strict.',
        'The names stay the same. With automatic routing nobody has to do anything.'
      ]
    },
    { type: 'h2', id: 'hub-moves-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route (Hub administrators)', 'Does'],
      rows: [
        [
          '`POST /api/hub/environments/:envId/move/plan`',
          'Body `{to}`: `{kind: "shared", shared_id, pool_max?}` or `{kind: "dedicated", placement_id}`. Answers the plan.'
        ],
        [
          '`POST /api/hub/environments/:envId/move`',
          'Body `{to, plan_hash, confirm, checklist}`. 202 `{move_id}`. `PLAN_CHANGED` 409, `CONFIRM_MISMATCH` 400, `CHECKLIST_OPEN` 400, `BUSY` 409.'
        ],
        [
          '`GET /api/hub/moves/:id`, `GET /api/hub/environments/:envId/moves`',
          'One move with its steps, or the history of an environment.'
        ],
        ['`POST /api/hub/moves/:id/cancel`', 'Cancel (rolls back before `release`).'],
        ['`POST /api/hub/moves/:id/resume`', 'Resume an interrupted move.'],
        [
          '`POST /api/hub/moves/:id/confirm-route`',
          'Check the public name now (manual routing). `{serving}`.'
        ],
        ['`POST /api/hub/moves/:id/checklist`', 'Body `{item, done}`.']
      ]
    },
    {
      type: 'p',
      text: 'Hub link routes on a dedicated app, mounted with `HUB_TOKEN` exactly as before, carry the move: `POST /api/hub-link/maintenance` (`{on, message?, move_id?}`), `POST` and `DELETE /api/hub-link/retire`, `GET /api/hub-link/shared-readiness`, and the file routes `POST /files/ticket`, `POST /files/pull`, `GET /files/pull/:runId`; `GET /status` adds `maintenance` and `retired`. The source serves the files on `GET /api/hub-transfer/files/:id`, authorised by a transfer ticket (`Authorization: Transfer <ticket>`) and nothing else. These routes extend the read-only link of phase 1: they carry counts and kinds and file bytes between the two apps, never records and never through the Hub.'
    },
    // T19-CHECK: Task 16 (route names and answers; activity actions hub-move-start|done|rolled-back|cancel)
    // T19-CHECK: Task 18 (the Move… panel and history labels "Moved" and "Shared upgrade")
    {
      type: 'note',
      text: 'The move activity rows are `hub-move-start`, `hub-move-done`, `hub-move-rolled-back` and `hub-move-cancel`. None contains a token, ticket, key or connection.'
    }
  ]
}
