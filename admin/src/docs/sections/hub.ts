import type { DocSection } from '../types.js'

export const hubOverviewDocs: DocSection = {
  id: 'hub-overview',
  label: 'Nivaro Hub',
  content: [
    { type: 'h1', id: 'hub-overview', text: 'Nivaro Hub' },
    {
      type: 'p',
      text: "Nivaro Hub is Nivaro running in hub mode: one place that lists every Nivaro app an organisation runs, with each app's environments (development, staging, production), the version each one runs, whether it answers, and who owns it. Every app keeps its own database, its own users and its own admin. The Hub never reads an app's records and never signs in to an app as a person."
    },
    {
      type: 'warn',
      text: 'The Hub is built in phases. It adopts apps that already run and shows their status and deploy history, promotes and rolls back versions through GitLab, and creates databases and new apps. It does not yet place an app on a shared deployment or sign people in to apps; those arrive in later phases.'
    },
    { type: 'h2', id: 'hub-overview-on', text: 'Turning hub mode on' },
    {
      type: 'p',
      text: 'Hub mode is off by default. With HUB unset an installation is an ordinary Nivaro: no Hub routes, no Apps item in the navigation, empty Hub tables. Hub mode is refused in cloud mode (CLOUD_META_DB_URL set): the routes are not mounted and the hub feature is not advertised.'
    },
    {
      type: 'warn',
      text: "Two Hubs must not share one Redis database. The keys of promotion and creation locks (`nvr:hub:promote:<environment id>`), job logs and readiness carry no instance prefix (`REDIS_CHANNEL_PREFIX` covers pub/sub channels only), so two Hubs on one Redis database take each other's locks and read each other's logs by id. Give each Hub its own Redis database (or its own Redis)."
    },
    {
      type: 'table',
      head: ['Variable', 'Where', 'Meaning'],
      rows: [
        [
          '`HUB`',
          'The Hub deployment',
          '`on` (also `true` or `1`) turns the deployment into the Hub. Mounts `/api/hub/*`, adds `hub` to the features that `GET /api/app-info` lists, and shows Apps in the admin navigation.'
        ],
        [
          '`HUB_TOKEN`',
          'An app (any Nivaro instance the Hub watches)',
          'At least 32 characters. Mounts the read-only `GET /api/hub-link/status` route on that app, which answers only to this token as a bearer. Unset or shorter: the route is not mounted. The same value is saved in the Hub on that environment as its hub token. `HUB_TOKEN_FILE` works like every other setting that can be read from a file.'
        ],
        [
          '`HUB_URL`',
          'An app',
          'Reserved for phase 7 (sign-in through the Hub and the app switcher). Setting it does nothing in phase 1.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'Hub tokens and driver tokens are stored encrypted and need `ENCRYPTION_KEY` on the Hub. Without it, saving one answers 400 `HUB_NEEDS_ENCRYPTION_KEY` and nothing is stored in plain text. Every GET shows a saved secret as ••••••; sending •••••• back on a save keeps the stored value, and sending an empty value clears it.'
    },
    { type: 'h2', id: 'hub-overview-adopt', text: 'Adopting an app' },
    {
      type: 'p',
      text: 'Adopting records an app that already runs. Open Apps → Adopt existing app (Hub administrators only) and give the app a key (lowercase letters, digits and dashes, for example `efp`) and a name, then one row per environment: its key, its base URL (scheme, host and optional port, no path) and, optionally, its hub token. Choose a GitLab driver and branch if you want its deploy history to show.'
    },
    {
      type: 'ul',
      items: [
        'Adopting never redeploys, restarts or writes to the app. The Hub only reads: `GET /api/hub-link/status` with the hub token, or the public `GET /api/version` and `GET /api/health` without one.',
        'A GitLab driver holds the API URL, project, branch, pin file, deploy job name and a token (stored encrypted). In phase 1 it is used only to read pipelines and their deploy job; nothing is pushed or played.',
        "Deploy history lists the last pipelines on the driver's branch, with the deploy job result and the Nivaro version read from the commit subject (for example `chore: sync for nivaro 0.3.208`).",
        'An app can be deleted only after its environments are removed.'
      ]
    },
    { type: 'h2', id: 'hub-overview-status', text: 'Environment status' },
    {
      type: 'p',
      text: 'Each environment shows one status. The Hub asks every environment at the same time with an 8 second limit, so one environment that does not answer never stops the others from showing. Answers are kept for 30 seconds; Refresh asks again at once.'
    },
    {
      type: 'table',
      head: ['Shown as', 'State', 'Meaning'],
      rows: [
        ['Running', '`ok`', 'The app answered and its checks are healthy.'],
        [
          'Running with warnings',
          '`degraded`',
          'The app answered, but its preflight or health is not healthy, or it answered with an unexpected HTTP status.'
        ],
        [
          'Not answering',
          '`unreachable`',
          'No answer within 8 seconds, the connection failed, or the saved base URL is not a valid http(s) address.'
        ],
        [
          'Hub link refused',
          '`link_refused`',
          'The app answered, but the hub link cannot be used. The Hub never falls back to treating the app as healthy. See the error codes below.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'An environment with a hub token is read through the hub link. An environment saved without one is read through the public version and health routes (source `public`) and shows the version and the health verdict only. An app that has no `HUB_TOKEN` is read publicly only if the environment was saved without a token; saved with a token, it shows `link_refused` / `HUB_LINK_MISSING`.'
    },
    {
      type: 'p',
      text: 'The error shown with a status is one of these codes. The environment row says the cause in a short line under the status (for example "The app has no HUB_TOKEN" or "No answer"); the status chip carries the same words for screen readers.'
    },
    {
      type: 'table',
      head: ['State', 'Error', 'Cause'],
      rows: [
        [
          '`link_refused`',
          '`HUB_LINK_REFUSED`',
          "The app answered 401 or 403, or 429 with this code (its failed-token brake). The token saved in the Hub does not match the app's `HUB_TOKEN`."
        ],
        [
          '`link_refused`',
          '`HUB_LINK_MISSING`',
          'The app answered 404: it has no `HUB_TOKEN`, so no hub link. The most common case when adopting.'
        ],
        [
          '`link_refused`',
          '`HUB_LINK_REDIRECT`',
          'The app answered with a redirect. The token is never sent on to another address.'
        ],
        [
          '`link_refused`',
          '`HUB_SECRET_UNREADABLE`, `HUB_SECRET_NOT_SEALED`',
          'The saved token cannot be decrypted (wrong `ENCRYPTION_KEY`) or is not encrypted. Enter it again.'
        ],
        ['`unreachable`', '`TIMEOUT`', 'No answer within 8 seconds.'],
        ['`unreachable`', '`UNREACHABLE`', 'The connection failed.'],
        [
          '`unreachable`',
          '`BAD_BASE_URL`',
          'The base URL is not a valid http(s) address. Shown at once, nothing is requested.'
        ],
        [
          '`degraded`',
          '`HTTP_<n>`',
          'The hub link or a public route answered with another HTTP status, n.'
        ],
        [
          '`degraded`',
          '`HEALTH_<verdict>`',
          'The public health route answered 200 with a verdict other than `ok`.'
        ]
      ]
    },
    {
      type: 'p',
      text: "Through the hub link, the app's preflight status decides the state: `ok` and `warn` count as healthy (Running); anything else is Running with warnings. Two values besides the usual ones: `timeout` (the app's preflight took over 4 seconds; its readiness score is then null) and `unknown` (its preflight threw). When the app names failing preflight checks, the status carries their ids as `failing` (at most 20, ids only, never a check's detail) and the environment row shows them as \"Failing checks: …\"."
    },
    { type: 'h2', id: 'hub-overview-who', text: 'Who can do what' },
    {
      type: 'ul',
      items: [
        'Hub administrators (administrators of the Hub deployment) see every app, adopt and delete apps, manage environments, drivers and owners.',
        "An app owner, assigned on the app's Owners list, sees only the apps they own, with their environments, status and deploy history. Another app's id answers 404, as if it did not exist.",
        "Inside an app nothing changes. Being a Hub administrator or an app owner grants nothing in the app; the app's own roles decide everything."
      ]
    },
    { type: 'h2', id: 'hub-overview-api', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET /api/hub/apps`, `GET /api/hub/apps/:id`',
          'List apps (administrators: all; others: the apps they own) and read one with its environments and owners.'
        ],
        [
          '`POST/PATCH/DELETE /api/hub/apps`, `PUT /api/hub/apps/:id/owners`',
          'Create, edit, delete and set owners (administrators). Deleting an app that still has environments answers 409 `HAS_ENVIRONMENTS`.'
        ],
        [
          '`POST /api/hub/apps/:id/environments`, `PATCH/DELETE /api/hub/environments/:envId`',
          "Manage an app's environments (administrators). Deleting an environment, or moving it off its placement, also deletes its dedicated placement unless another environment still names it."
        ],
        [
          '`GET /api/hub/apps/:id/status`, `GET /api/hub/environments/:envId/status`',
          'Read status. `?fresh=1` skips the 30 second cache.'
        ],
        [
          '`GET /api/hub/environments/:envId/deploys?limit=20`',
          "Read-only deploy history from the environment's GitLab driver. `limit` is capped at 50. An environment with no placement or driver answers 200 `{ data: [], reason: 'NO_DRIVER' }`. Answers are kept for 60 seconds per environment and limit (refusals never); `?fresh=1` skips that, and editing the environment, its placement or its driver forgets it."
        ],
        [
          '`GET/POST/PATCH/DELETE /api/hub/drivers`, `POST/GET/PATCH/DELETE /api/hub/placements`',
          'GitLab drivers and dedicated placements (administrators). Deleting a driver answers 204 and also deletes its placements no environment names; while an environment names one of its placements it answers 409 `IN_USE`. Deleting a placement answers 204, or 409 `IN_USE` while an environment names it.'
        ]
      ]
    },
    { type: 'h3', id: 'hub-overview-errors', text: 'Route errors' },
    {
      type: 'table',
      head: ['Status', 'Code', 'When'],
      rows: [
        [
          '400',
          '`HUB_NEEDS_ENCRYPTION_KEY`',
          'A secret was saved but the Hub has no `ENCRYPTION_KEY`.'
        ],
        [
          '400',
          '`SECRET_REQUIRED`',
          'An environment save changes the base URL origin while a hub token is stored and the token is not entered again; or a GitLab driver save changes its API origin or project while a token is stored and the token is not entered again. A stored token never follows a changed address, so it cannot reach a new host without being typed again.'
        ],
        [
          '400',
          '`BAD_SECRET`',
          'A hub token (environment) or token (driver) that is neither text nor null. An environment token of only spaces clears it.'
        ],
        [
          '400',
          '`BAD_PLACEMENT`',
          'An environment save names a `placement_id` that is not a placement id, or no such placement exists.'
        ],
        ['404', '`NOT_FOUND`', 'Hub mode is off, or the app is not one the caller owns.'],
        [
          '409',
          '`KEY_TAKEN`',
          'An app key, or an environment key within its app, is already used.'
        ],
        ['409', '`HAS_ENVIRONMENTS`', 'Deleting an app that still has environments.'],
        [
          '409',
          '`PLACEMENT_IN_USE`',
          'An environment save names a placement another environment already uses (a dedicated placement belongs to one environment).'
        ],
        ['409', '`IN_USE`', 'Deleting a driver or a placement an environment still uses.'],
        [
          '409',
          '`DRIVER_MISCONFIGURED`, `HUB_SECRET_UNREADABLE`, `HUB_SECRET_NOT_SEALED`',
          'Reading deploy history: the driver is incomplete, or its saved token cannot be read.'
        ],
        ['502', '`GITLAB_UNREACHABLE`', 'Reading deploy history: GitLab did not answer.']
      ]
    },
    {
      type: 'p',
      text: 'Every write adds a row to the activity log. All Hub routes answer 404 when hub mode is off.'
    }
  ]
}

export const hubLinkDocs: DocSection = {
  id: 'hub-link',
  label: 'Hub link',
  content: [
    { type: 'h1', id: 'hub-link', text: 'Hub link' },
    {
      type: 'p',
      text: 'The hub link is the one door an app opens to its Hub. It is a single read-only route, `GET /api/hub-link/status`, mounted only when the app has `HUB_TOKEN` set (32 characters or more). The Hub sends that token as `Authorization: Bearer <token>`; any other caller, or no token, gets 401 `HUB_LINK_REFUSED`. The answer is never cached (`Cache-Control: no-store`) and the preflight behind it is reused for 15 seconds. No session, API key or OAuth token opens it.'
    },
    { type: 'h2', id: 'hub-link-returns', text: 'What it returns' },
    {
      type: 'table',
      head: ['Field', 'Content'],
      rows: [
        ['`version`', 'The Nivaro version the app runs.'],
        ['`environment`, `instance`', 'The environment label and instance name.'],
        [
          '`preflight`',
          '`status` (`ok`, `warn`, `timeout` or `unknown`, among others) and the names of any failing checks.'
        ],
        [
          '`readiness_score`',
          'The cached readiness score, never a live run; null while not yet computed or when the preflight timed out.'
        ],
        ['`process`', 'Uptime, memory in MB and database pool figures (used, free, pending).']
      ]
    },
    { type: 'h2', id: 'hub-link-never', text: 'What it never returns' },
    {
      type: 'ul',
      items: [
        'Records, counts from business tables, field values or file contents.',
        'Users, roles, sessions, settings or credentials.',
        'Anything that changes the app: the route cannot restart it, pause it, write config or create users.'
      ]
    },
    {
      type: 'note',
      text: 'Phase 1 only reads. Maintenance on and off, seeding a first admin and sign-in events over the link belong to later phases and are not available now. An app that does not set HUB_TOKEN has no hub link at all: the route answers 404, which the Hub shows as `link_refused` / `HUB_LINK_MISSING` for an environment saved with a token. An environment saved without a token is read through the public version and health routes instead.'
    }
  ]
}

export const hubPromotionsDocs: DocSection = {
  id: 'hub-promotions',
  label: 'Hub promotions',
  content: [
    { type: 'h1', id: 'hub-promotions', text: 'Hub promotions' },
    {
      type: 'p',
      text: 'A promotion moves a version that one environment already runs on to the next environment (for example staging to production), through GitLab. The Hub plans it, shows you the plan, waits for you to confirm, then runs it step by step and checks that the environment really answers with the new version. A rollback goes back to a version the environment ran before.'
    },
    {
      type: 'warn',
      text: "Until a Hub administrator switches on 'The Hub deploys this environment' (the `hub_managed` setting) for an environment, it cannot be promoted or rolled back from the Hub. It is off by default, so adopting an app never changes how it is deployed."
    },
    { type: 'h2', id: 'hub-promotions-components', text: 'Components' },
    {
      type: 'p',
      text: "An environment is deployed in one or more components, run in order. Each component has its own GitLab driver, source branch, target branch, deploy job and a check address. The API component is the Nivaro image; the frontend component is the portal in front of it. Each component is merged, then deployed, then checked before the next one starts. Within one promotion the API is deployed first, and the portal only after the API's deploy passed. The Hub does not stop a promotion that moves only the portal while the API stays on an older version: when a portal needs a newer API, promote the API first."
    },
    {
      type: 'ul',
      items: [
        'API component: the Hub takes the newest deploy commit on the source branch whose subject ends with `nivaro <version>` and a pin of the version. The pin is three lines: the version, the image digest and, when both are real, the slim image digest. It is refused when the image or its digest is not on the registry.',
        'The target branch moves once per component. For the API, the Hub builds the merge of the deploy commit and the pin on a temporary branch, then merges that branch into the target branch in one merge. A deploy job that runs on every push therefore runs once, on the deploy commit and its pin together. When the target branch already holds the deploy commit, the pin is one commit on it.',
        "Frontend component: the Hub merges the commit that the environment before this one is serving. That commit must already be on the component's source branch. When the target branch already holds it, the Hub deploys the target branch's current head: the plan names that head, and the run stops without changing anything if the head moved since the plan, or if the commit reached the branch only after a plan that expected to merge it, or left the branch after a plan that saw it there.",
        "A Hub administrator adds components to an environment under its settings. An environment with none stored uses its placement driver as a single API component, deploying to the placement's branch; adding a component stores that one first, with the same branch."
      ]
    },
    { type: 'h2', id: 'hub-promotions-run', text: 'Promoting' },
    {
      type: 'p',
      text: "Open the environment, choose Promote, and pick a version. The Hub lists versions the previous environment runs or ran, newer than the one here: what it answers now, what the Hub deployed there, and what its own successful deploy jobs in GitLab ran (the pin file at each job's commit, newest 50 jobs), so a staging deployed by the release chain that has moved on still offers the older version. It shows the plan in plain words and every reason it cannot start, each with the planner's own details. To start, type the environment's key to confirm. The start carries the plan you saw: the Hub plans again, and if anything it would do changed (a commit, a pin, a version, a component, the driver or repository that deploys it, or its check address), it starts nothing, shows the new plan and asks you to check it again."
    },
    {
      type: 'ul',
      items: [
        'Hub administrators and the owners of the app may promote and roll back. Anyone else gets nothing, as if the environment did not exist.',
        'A run is bound to the repositories its drivers named when it started. If a Hub administrator points a driver at another repository while it runs, the next step that would use it stops with `DRIVER_CHANGED` and nothing more is written; the run never deletes branches in the other repository either.',
        'An app the Hub created is checked again at the start of each step in its own deploy repository: the project must still read its CI configuration from the pinned template and keep pipeline variables locked. If someone changed that, the step stops with `CI_CONFIG_REFUSED` before anything is written there; the Hub does not put the setting back during a promotion (saving the target does).',
        "Verify: after each deploy the Hub reads each component's check address. The API must answer the planned version. A frontend must answer the planned commit or the commit its deploy job actually ran on (a merge commit, or the branch's current head when the branch already held the commit). Each must answer twice in a row. The Hub asks every 15 seconds, at most 40 times, then the step fails.",
        'The Hub records the commit and pipeline each deploy job ran on in the run. A rollback redeploys exactly that build.',
        'Only one promotion runs per environment at a time, even if Redis loses the lock: a running promotion also writes a heartbeat to its run every minute, and a start is refused while that heartbeat is fresh.',
        'Cancel stops the run at the next step boundary, right before a merge into a target branch, or while the Hub waits for a deploy job. The Hub asks again right before it reads and plays a manual deploy job, so a cancel made on another Hub server is seen too, and the job is never played after a cancel. A deploy job GitLab already started keeps running in GitLab.',
        'A promotion that stopped between components (cancelled or failed) can be finished: the version list offers the version the environment already runs, marked as finishing the stopped promotion. Components already deployed with that version are skipped (an API whose branch already holds the deploy commit and the same pin is not deployed again), and the rest run. The Hub never rewrites the pin of the version that is running: if the image for that version changed since it was deployed, the plan is refused with `PIN_CHANGED`.',
        'A run whose server stopped shows Interrupted within a few minutes: once its lock has run out and its heartbeat is stale, the next look at the run or the history marks it, and Cancel marks it at once. Its job is marked failed too, and the temporary branches it made are deleted. Nothing already deployed is undone: check the environment, then start again.'
      ]
    },
    { type: 'h2', id: 'hub-promotions-rollback', text: 'Rolling back' },
    {
      type: 'p',
      text: 'Roll back goes only to a version the Hub itself deployed here successfully, with the build of every component recorded: the commit its deploy job ran on and, for the API, that pipeline. Versions deployed before the Hub took over are never offered. Roll back is confirmed the same way as a promotion. A rollback redeploys exactly the recorded builds; it never merges, never commits a pin and does not read the registry.'
    },
    {
      type: 'ul',
      items: [
        "API: the Hub reruns the deploy job of the build it deployed with that version: the commit that carried that version's pin, in its own pipeline. That pipeline builds the extension of the same commit, so Nivaro and the extension go back together. If the Hub did not record that pipeline, the plan is refused with `ROLLBACK_NOT_RECORDED`.",
        "The target branch keeps the newer pin, so promoting the newer version again moves the environment forward: the branch already holds it and its deploy job already passed, so the Hub checks what the environment runs (as the plan reads it) and, when that is not the version being promoted, reruns that deploy job. When the environment already runs it, nothing is rerun. A portal with no check address cannot be read, so it is rerun only when the Hub's own record shows it last deployed a different build there (after a rollback). A new push to the branch also deploys forward. If GitLab refuses that rerun, the run fails with `REDEPLOY_REFUSED_BY_GITLAB`.",
        'Order: a rollback redeploys the portal first, then the API (a promotion goes the other way). People never get the newer portal against the older API while the portal redeploys, and if GitLab refuses to rerun the portal build the API has not moved.',
        "Frontend: the Hub reruns the deploy job of the exact build it deployed with that version (the merge commit's pipeline). The plan checks that build first: if the commit is no longer on the target branch, GitLab no longer has the build, or its deploy job cannot be rerun, the plan is refused with `FRONTEND_ROLLBACK_NO_BUILD` and nothing runs, so the API is never rolled back alone. A rollback never merges an old commit back into the branch.",
        "If GitLab refuses to rerun a deploy job, the run fails with `ROLLBACK_REFUSED_BY_GITLAB`. The usual cause is the project setting 'Prevent outdated deployment jobs': allow job retries for rollback deployments in the project's CI/CD settings, or roll back by hand."
      ]
    },
    { type: 'h2', id: 'hub-promotions-blockers', text: 'Why a promotion cannot start' },
    {
      type: 'p',
      text: 'The plan lists every reason at once. Fix them and plan again.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`NOT_HUB_MANAGED`',
          "The environment is not switched on for the Hub. A Hub administrator turns on 'The Hub deploys this environment'."
        ],
        [
          '`PROMOTION_RUNNING`',
          'A promotion of this environment is already running. Wait or cancel it.'
        ],
        [
          '`NO_PREVIOUS_ENVIRONMENT`',
          'This is the first environment, so there is nothing to promote from.'
        ],
        [
          '`PREVIOUS_NEVER_RAN`',
          'The environment before this one never ran the version: not now, not in a Hub deploy, and not in one of its newest 50 successful deploy jobs in GitLab. Promote it there first.'
        ],
        [
          '`ALREADY_RUNS`',
          'This environment already runs that version, and every component was deployed with it. Two exceptions are not refused: a run that stopped between components (promote the version again to finish it), and a re-stamp, where the release commit for that version is not yet on the target branch: an extension-only change released again under the same version tag.'
        ],
        ['`OLDER_THAN_CURRENT`', 'The version is older than the one running here. Use Roll back.'],
        [
          '`NOT_DEPLOYED_BEFORE`',
          'Rollback only: this environment never deployed that version successfully.'
        ],
        [
          '`NO_SOURCE_COMMIT`',
          "API: no commit on the source branch has a subject ending with `nivaro <version>`. The release must land on the deploy repository's source branch first."
        ],
        [
          '`FRONTEND_UNKNOWN`',
          'Promote: the Hub cannot tell which frontend commit the environment before this one serves. Its check address must answer with a commit.'
        ],
        [
          '`ROLLBACK_BUILD_UNKNOWN`',
          'Roll back only: the Hub has no record of the frontend build it deployed with that version, so it cannot redeploy it. Nothing runs.'
        ],
        [
          '`FRONTEND_NOT_ON_SOURCE`',
          "The frontend commit the previous environment serves is not on the component's source branch. Merge it there first."
        ],
        [
          '`ROLLBACK_NOT_RECORDED`',
          'Roll back only: the Hub has no record of the API build it deployed with that version (the commit or its pipeline), so it cannot rerun it. Nothing runs.'
        ],
        [
          '`ROLLBACK_NO_BUILD`',
          "Roll back only: the API build the Hub deployed with that version is no longer on the target branch, GitLab no longer has its pipeline, or its deploy job can't be rerun. Nothing runs."
        ],
        [
          '`FRONTEND_ROLLBACK_NO_BUILD`',
          "Roll back only: the frontend build the Hub deployed with that version is no longer on the target branch, GitLab no longer has it, or its deploy job can't be rerun. Nothing runs."
        ],
        [
          '`HEAD_UNKNOWN`',
          'The target branch already holds the frontend commit, so the Hub would deploy the branch head, but GitLab did not say which commit that is. The Hub deploys only a head it names in the plan. Plan again.'
        ],
        [
          '`PIN_CHANGED`',
          'Promoting the version that already runs here would rewrite its pin: the image for that version changed since it was deployed (the plan shows the pinned and the new digests), or the target branch has no pin for it at all. The Hub never writes a pin for the version that is running. Publish a new version instead.'
        ],
        [
          '`IMAGE_MISSING`',
          'Promote only: the image for that version is not published on the registry the Hub reads.'
        ],
        [
          '`IMAGE_NO_DIGEST`',
          'Promote only: the registry has the image but gave no digest, which the pin needs.'
        ],
        ['`NO_COMPONENTS`', 'The environment has nothing to deploy. Add a driver or components.'],
        ['`NO_DRIVER`', 'A component has no GitLab driver. Pick one for it.'],
        ['`BAD_VERSION`', 'The version is not in the form 0.3.210.']
      ]
    },
    { type: 'h2', id: 'hub-promotions-gitlab', text: 'GitLab prerequisites' },
    {
      type: 'p',
      text: "The Hub works only through GitLab's API, as the driver's token. Check each deploy repository and portal repository before the first promotion."
    },
    {
      type: 'ul',
      items: [
        'Merge method: the project must allow merges that are not fast-forward (merge commit), and must not require squash. Every Hub merge is a merge request with a merge commit; a fast-forward-only or squash-required project cannot be promoted.',
        "'Pipelines must succeed' refuses the Hub's merge: the Hub waits only about 30 seconds for a merge request's pipeline. Turn it off on these projects, or make sure merge requests from `hub/promote-*` branches get no pipeline that has to pass.",
        'The token must be allowed to merge into the protected target branch (for example production): Maintainer, or named in the branch protection as allowed to merge.',
        'CI rules: a push of a `hub/promote-*` branch is a branch push. Check that the rules run no deploy job on those branches (deploy jobs only on the target branches).',
        "Artifacts: a rollback reruns only the deploy job of the earlier pipeline. If that job needs build_extension's artifacts and GitLab has expired them, the rerun cannot rebuild the old extension. Set the artifact expiry of deploy-repository builds at least as long as you may want to roll back, or keep the artifacts of deployed pipelines (GitLab can keep the artifacts of the latest successful pipeline per branch).",
        "'Prevent outdated deployment jobs' refuses a rollback: GitLab will not rerun an older deploy job. Turn on 'Allow job retries for rollback deployments' in the project's CI/CD settings, or roll back by hand (see the runbook). The Hub stops with `ROLLBACK_REFUSED_BY_GITLAB` when this happens."
      ]
    },
    { type: 'h2', id: 'hub-promotions-script', text: 'Differences from promote-production.mjs' },
    {
      type: 'ul',
      items: [
        'No `--bootstrap` and no `--portal-only`: a promotion always takes every component of the environment.',
        'Verify always runs when a component has a check address (the script ran it only at ROUTE_PRIORITY 3 or higher).',
        'The release commit is looked up among the newest 100 commits of the source branch; an older one is refused with `NO_SOURCE_COMMIT`.',
        'Every merge goes through a temporary branch and a merge request, so it leaves a merge commit, and pipelines, merge method, approvals and protected-branch rights apply (see GitLab prerequisites).',
        'Order per component: each component is merged, then deployed, before the next one. If the API fails, the portal is never merged. (The script pushed both, then deployed.)',
        'The same version again: when the image for it changed or its pin is missing, the plan is refused with `PIN_CHANGED`; the Hub never rewrites the pin of the version that is running. A stopped promotion is finished instead.',
        'Like the script, a merge lands on whatever the target branch holds at that moment: the target head is not bound for merges. Only a frontend the target branch already holds has its head named in the plan and checked.',
        'Logs: the last step and the error stay on the run; the job log is kept for 24 hours.'
      ]
    },
    { type: 'h2', id: 'hub-promotions-settings', text: 'Settings' },
    {
      type: 'table',
      head: ['Setting', 'Meaning'],
      rows: [
        [
          '`HUB_IMAGE`',
          'The Docker Hub repository the Hub reads image digests from. Default `nodeworks/nivaro`.'
        ],
        [
          '`NODE_EXTRA_CA_CERTS`',
          'Path to a company certificate bundle. Set it on the Hub when GitLab sits behind a company certificate the Hub does not trust by default.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-promotions-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET /api/hub/environments/:envId/promotable`',
          'Versions that can be promoted here, and older ones that can be rolled back to (Hub deploys with every component recorded). `finish` names the version running here when its Hub promotion stopped between components; it is listed in `promote` too.'
        ],
        [
          '`POST /api/hub/environments/:envId/promote/plan`',
          'Body `{ version, kind }`, kind `promote` or `rollback`. Read-only: the plan with its steps, every blocker and its `plan_hash`. Answers during maintenance too.'
        ],
        [
          '`POST /api/hub/environments/:envId/promote`',
          'Body `{ version, kind, confirm, plan_hash }`; `confirm` is the environment key, `plan_hash` the one the plan route answered (400 `PLAN_HASH_REQUIRED` without it). Answers 202 with the run id, 409 with the blockers, or 409 `PLAN_CHANGED` with the new `plan` when the plan is no longer the one you saw (nothing starts).'
        ],
        [
          '`GET /api/hub/environments/:envId/deploys/hub`',
          "The Hub's own promotions here, newest first."
        ],
        [
          '`GET /api/hub/promotions/:id`',
          'One run with its plan and log. This read and the history read first mark a run whose server stopped as interrupted.'
        ],
        [
          '`POST /api/hub/promotions/:id/cancel`',
          'Cancel a running promotion at the next step boundary. A run whose server stopped is marked interrupted at once (`status: interrupted` in the answer).'
        ]
      ]
    },
    { type: 'h2', id: 'hub-promotions-cutover', text: 'Cutover runbook: EFP production' },
    {
      type: 'p',
      text: 'Do this once, in order, to hand production promotions from the release script on the laptop to the Hub.'
    },
    {
      type: 'ul',
      items: [
        '0. Set `NODE_EXTRA_CA_CERTS` on the Hub to the company certificate bundle (GitLab and the check addresses sit behind the company certificate), restart the Hub, then test each driver from its page. Check the GitLab prerequisites above on both repositories.',
        "1. Add components for EFP production: an API component on the deploy repository and a portal frontend component. Check their jobs: the deploy job names must match the ones the laptop script runs, and each check address must answer its version or commit. Add a portal frontend component to the staging environment too, whose check address answers the portal commit staging serves: production's plan reads the portal commit from it, and without it the plan is refused with `FRONTEND_UNKNOWN` (the Hub can only guess staging's address from production's when both are on the same host, which EFP's are not).",
        '2. Run a plan-only promote for the version staging runs (Promote, then read the plan, and do not confirm). Compare each step with the plan the laptop script prints: `node scripts/promote-production.mjs --version <version>` (without `--go` it only prints the plan and changes nothing). Check the same deploy commit, the same pin, the same portal commit and the same jobs. Stop and fix anything that differs.',
        '3. Switch `hub_managed` on for production.',
        '4. Set `production.enabled: false` in `release-chain.config.json`, so the laptop release chain stops promoting production.',
        '5. Make the first real promotion, and watch it from start to Succeeded: the merge, the pin, the deploy and both checks.',
        "6. If it goes wrong, roll back by hand: the laptop script cannot roll back (it refuses a version older than the one production runs). In the deploy repository, on the production branch, revert the pin commit (or edit the driver's pin file back to the previous version and its digest lines) and commit it. In GitLab, open the pipeline that commit started and run its deploy job (deploy_production), then watch it pass its canary and gates. (Rerunning the deploy job of the earlier production pipeline that deployed the previous version also works, as the Hub's own rollback does, unless 'Prevent outdated deployment jobs' refuses it.) For the portal, rerun the deploy job of its previous production pipeline in GitLab. The Hub offers Roll back only to versions it deployed itself, so Roll back in the Hub becomes available after the first successful Hub promotion. Whenever the Hub itself is unusable, set `production.enabled` back to true and promote forward with the laptop script."
      ]
    },
    {
      type: 'note',
      text: 'The laptop script stays as the fallback until two Hub promotions to production have succeeded. Do not delete it before then.'
    }
  ]
}

export const hubDatabasesDocs: DocSection = {
  id: 'hub-databases',
  label: 'Hub databases',
  content: [
    { type: 'h1', id: 'hub-databases', text: 'Hub databases' },
    {
      type: 'p',
      text: "The Databases tab of the Hub (Hub administrators only) keeps the database servers the Hub knows and the databases it has made, requested or adopted. A database belongs to one environment of one app. The Hub never reads an app's records: it only creates the database, hands it to a login the app uses, and later checks that it still answers and is still the right kind of database."
    },
    {
      type: 'note',
      text: 'Every secret here is sealed with `ENCRYPTION_KEY` and shown as ••••••. A provisioning login, an app login password and a database connection are never answered, logged or written into an error. Without `ENCRYPTION_KEY` saving any of them answers `HUB_NEEDS_ENCRYPTION_KEY`.'
    },
    { type: 'h2', id: 'hub-databases-servers', text: 'Servers and modes' },
    {
      type: 'p',
      text: "A server is an engine, a host, a port and a mode. Engines: SQL Server (`mssql`), Postgres (`pg`), MySQL (`mysql2`) and MariaDB (`mariadb`). SQLite is a file on the app's own host, so the Hub cannot make one: a SQLite server is refused with `ENGINE_NOT_PROVISIONABLE`."
    },
    {
      type: 'table',
      head: ['Mode', 'What the Hub does', 'Provisioning login'],
      rows: [
        [
          '`automatic`',
          'Creates the app login and the database on the server, hands the database to the login, then checks it as that login.',
          'Required: a user and password that may create databases and logins. Sealed; never answered.'
        ],
        [
          '`manual`',
          'Records the request and shows a DBA checklist. The DBA creates the database and login by hand, and the connection is entered in the Hub. The Hub only checks it.',
          'Optional. When saved it is used only to test that the server answers, never to create anything.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Server settings: name (unique, case-insensitive), engine, host (a name or an IP, never a URL), port (blank = the engine default: 1433, 5432, 3306), TLS mode (`disable`, `require`, `verify-ca`, `verify-full`) and, for SQL Server, whether to trust the server certificate, the SQL Server collation for new databases (default `SQL_Latin1_General_CP1_CI_AS`), the MySQL and MariaDB account host the app login is created for (default `%`) and free notes. Test connects with the provisioning login and says what is missing:'
    },
    {
      type: 'table',
      head: ['Engine', 'Oldest release', 'Rights the provisioning login needs'],
      rows: [
        ['SQL Server', 'SQL Server 2019 (15)', '`CREATE ANY DATABASE` and `ALTER ANY LOGIN`.'],
        ['Postgres', '14', '`CREATEDB` and `CREATEROLE`, or a superuser.'],
        [
          'MySQL',
          '8.0.13',
          '`GRANT OPTION`, `CREATE USER`, and every privilege that `GRANT ALL PRIVILEGES ON <database>.*` hands over (or `ALL` on `*.*`).'
        ],
        [
          'MariaDB',
          '10.11',
          'The same rights as MySQL. The server flavour must match the engine you chose.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Azure SQL Database and Azure SQL Managed Instance cannot be provisioned by the Hub: use a manual server for them.'
    },
    {
      type: 'ul',
      items: [
        "Changing a server's engine, host or port is refused with `SERVER_IN_USE` while any database on it has ownership markers or is not yet ready. Add a new server instead.",
        'Changing the engine, host, port or TLS settings without entering the provisioning login again is refused with `SECRET_REQUIRED`: a stored login never follows a server somewhere else.',
        'A server cannot be deleted while a database row names it (`IN_USE`).'
      ]
    },
    { type: 'h2', id: 'hub-databases-names', text: 'Names and what each engine gets' },
    {
      type: 'p',
      text: 'For an environment the Hub proposes database `nivaro_<app>_<env>` and login `<app>_<env>` (a default login that does not start with a letter gets `u_` in front, and the Create app plan also puts `u_` in front of a default login that would be a reserved name; long names are shortened with a 4-character hash). You may type your own. A database name is lower-case letters, digits and `_`, 2 to 63 characters, starting with a letter. A login name follows the same rule and holds at most 32 characters on MySQL and MariaDB, 63 on Postgres, 128 on SQL Server. Reserved names are refused on every engine: `sa`, `root`, `postgres`, `master`, `msdb`, `model`, `tempdb`, `mysql`, `sys`, `information_schema`, `performance_schema`, `template0`, `template1`, `public`, `dbo`, `guest`, `admin`, `administrator`, `system`, `default`, and anything starting `pg_` or `mysql`.'
    },
    {
      type: 'p',
      text: 'The app login password is generated by the Hub (32 characters), sealed when the database is recorded, and reused by every retry. Each engine gets the same shape: one empty database, one login that owns only that database and has no server-wide rights.'
    },
    {
      type: 'table',
      head: ['Engine', 'Database', 'Login and rights'],
      rows: [
        [
          'SQL Server',
          '`CREATE DATABASE … COLLATE <collation>`, `READ_COMMITTED_SNAPSHOT ON`.',
          'A SQL login (`CHECK_POLICY = ON`), a user in the database for it, member of `db_owner`. No server roles. A retry runs `ALTER LOGIN … WITH PASSWORD` with the same password; under a domain minimum password age that may be refused (error 15114, not verified on a domain-joined server): wait out the policy, or have a DBA reset the login, then retry.'
        ],
        [
          'Postgres',
          "`CREATE DATABASE … ENCODING 'UTF8' TEMPLATE template0`, `CONNECT` revoked from `PUBLIC`.",
          'A role with `LOGIN` that owns the database. No superuser, `CREATEDB` or `CREATEROLE`. The role gets a SCRAM-SHA-256 verifier the Hub computes, never the password itself, so a logged `CREATE ROLE` never shows it.'
        ],
        [
          'MySQL',
          '`CHARACTER SET utf8mb4`, collation `utf8mb4_0900_ai_ci`.',
          "`CREATE USER '<login>'@'<account host>'` and `GRANT ALL PRIVILEGES` on that one database. Nothing on `*.*`."
        ],
        [
          'MariaDB',
          '`CHARACTER SET utf8mb4`, collation `utf8mb4_unicode_ci`.',
          'The same as MySQL.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-databases-lifecycle', text: 'Status of a database' },
    {
      type: 'table',
      head: ['Status', 'Meaning'],
      rows: [
        ['`requested`', 'Asked of a DBA on a manual server. No connection yet.'],
        ['`creating`', 'The Hub is making it on an automatic server.'],
        [
          '`ready`',
          'Made (or connected) and checked: empty, or an existing Nivaro install when adopted. Only a ready database can be given to an environment.'
        ],
        [
          '`failed`',
          'Creation or a DBA connection failed. The last check says why. Retrying a creation, or entering a connection again, starts over.'
        ],
        [
          '`dropping`',
          'Fenced by a delete with drop. It cannot be attached or opened; if the drop fails it stays here until the delete is repeated.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Making a database is safe to repeat. The Hub writes to a database or login only when its own marker says it made that object, and the marker is stored together with the engine, host and port it was made on. A database or login with the same name that the Hub did not make is never touched: creation stops with `DATABASE_EXISTS` or `LOGIN_EXISTS`. After creating, the Hub connects as the new login and the database must read as empty, and no other Hub record may already use the same server and database.'
    },
    { type: 'h2', id: 'hub-databases-manual', text: 'Manual servers: the DBA checklist' },
    {
      type: 'p',
      text: "While a database on a manual server is not ready, its detail shows what the DBA must make: the server, the database name, the collation or character set, the login and how it is created, the rights (owner of this database only), `READ_COMMITTED_SNAPSHOT ON` on SQL Server, the instruction to leave it empty, any server notes, and then where to enter the connection: the Connection card (on the app's creation panel, or under Databases → the database) and Save and check. The DBA, or the app's owner, enters the connection (host, port, database, login, password, TLS) in the Hub; the form starts from the server's own TLS settings. The Hub checks it before it becomes ready. Check now appears once a connection is saved; before that there is nothing to check. A creation that waits for the database continues by itself within 5 minutes of the database becoming ready, or at once when Save and check or Check now makes it ready."
    },
    {
      type: 'warn',
      text: "An app owner (not a Hub administrator) may set a connection and press Check now only on a database attached to an environment of their own app, and only against that database's own server. The host and port they send must be the server's (compared as the server compares them: case, a trailing dot and the engine default port do not matter), otherwise the Hub answers `HOST_NOT_SERVER`. The TLS settings are the server's, whatever the owner sends. Each owner has 10 tries per 10 minutes per database; the next answers 429 `TOO_MANY_TRIES`. Without this, the Hub would try logins against any host for any owner."
    },
    { type: 'h2', id: 'hub-databases-checks', text: 'Checks' },
    {
      type: 'p',
      text: "A check connects as the app's own login and reads only: the version, whether the login may build tables, how many tables there are and whether the Nivaro migration ledger exists. It stores the result and the time on the database."
    },
    {
      type: 'table',
      head: ['State', 'Meaning', 'Refusal code'],
      rows: [
        [
          '`unreachable`',
          'The connection failed (wrong login, host, port, TLS, or the server is down).',
          '`DATABASE_UNREACHABLE`'
        ],
        [
          '`too_old`',
          'The server is older than the oldest release in the table above, or the server is MariaDB while the engine says MySQL (or the other way round).',
          '`DATABASE_TOO_OLD`'
        ],
        [
          '`no_rights`',
          'Connected, but the login cannot build tables (SQL Server: not `db_owner`; Postgres: neither owner nor `CREATE` on schema `public`; MySQL and MariaDB: neither `ALL` nor `CREATE`, `ALTER`, `INDEX` and `DROP`), or the migration ledger cannot be read.',
          '`DATABASE_NO_RIGHTS`'
        ],
        ['`empty`', 'Connected, no tables. What a new app needs.', 'none'],
        [
          '`nivaro`',
          'Connected and it holds a Nivaro install (the number of migrations and the last one are shown). Accepted only by Adopt.',
          '`DATABASE_NOT_EMPTY` anywhere an empty database is required'
        ],
        [
          '`foreign`',
          'Connected, but it holds tables that are not a Nivaro install. Never accepted.',
          '`DATABASE_NOT_NIVARO` (Adopt), `DATABASE_NOT_EMPTY` (creation)'
        ]
      ]
    },
    {
      type: 'p',
      text: 'A failure the Hub itself recorded (for example a failed creation) shows as state `error` with its code. Check now on a waiting manual database whose result is `empty` makes it ready.'
    },
    { type: 'h2', id: 'hub-databases-adopt', text: 'Adopting a database' },
    {
      type: 'p',
      text: 'Adopt a database records one that already exists (Databases → Adopt a database): engine, host, port, database, login, password, TLS. The Hub checks it and accepts only an empty database or an existing Nivaro install; a database with other tables is refused (`DATABASE_NOT_NIVARO`). An existing Nivaro install is accepted with a plain warning (`warning` in the answer, and on Create app a warning line in the preview, never a blocker): an app given that database starts on its data and users, and its first administrator is made only if it has none, so make sure no other app still uses it. Adopting never creates or changes anything on the server. An adopted database is linked to a server row when its engine, host and port match one. Two records may never point at the same database: the Hub compares host and name, and also the server identity the database itself reports (so an alias, an IP and a name for the same server count as one), and refuses with `DATABASE_IN_USE`.'
    },
    { type: 'h2', id: 'hub-databases-delete', text: 'Detach and drop' },
    {
      type: 'p',
      text: 'Delete always needs the database name typed as `confirm` (`CONFIRM_REQUIRED` otherwise). It is refused with `IN_USE` while an environment uses the database: detach it from the environment first (deleting the environment does that).'
    },
    {
      type: 'ul',
      items: [
        'Detach (default): the Hub forgets the record and its sealed connection. The database and login stay on the server.',
        'Detach and drop (`drop: true`): also drops the database and the login on the server. Allowed only for a database the Hub made itself on a server that is still `automatic` and still where the markers were made, and only for what its markers say it made (a login the Hub did not create is never dropped). A database adopted or requested from a DBA is `DROP_NOT_ALLOWED`: detach it. If the server now points somewhere else the answer is `SERVER_MOVED` and nothing is dropped.',
        'A drop fences the row first (`dropping`), then touches the server. If the drop fails the row stays on record so the leftovers are not forgotten, and repeating the delete retries it.'
      ]
    },
    { type: 'h2', id: 'hub-databases-routes', text: 'Routes' },
    {
      type: 'p',
      text: "All under `/api/hub`, hub mode only. Every write is a Hub administrator's except where the second column says an app owner may act. A person who may not reach a database gets 404, never 403. Every write adds an activity row."
    },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET /db-servers`, `POST /db-servers`, `PATCH/DELETE /db-servers/:id`',
          'List, add, edit, delete servers. The provisioning login is the mask in every answer.'
        ],
        [
          '`POST /db-servers/:id/test`',
          'Connect and report version, whether the login can create, and what is missing.'
        ],
        [
          '`GET /databases`',
          'Every database with its server, status, last check and environment (administrators).'
        ],
        [
          '`GET /databases/:id`',
          'One database, with the DBA checklist while a manual one is not ready. App owners: only a database of their own app.'
        ],
        [
          '`POST /databases/adopt`',
          'Adopt a database (body is the connection, or `{ connection }`).'
        ],
        [
          '`PUT /databases/:id/connection`',
          "Set the DBA's connection on a requested or failed manual database. App owners: own app only, own server only, rate limited. Answers `{ data, check, creation }`; `creation` says a waiting creation was started."
        ],
        [
          '`POST /databases/:id/check`',
          'Check now. App owners: own app only, own server only, rate limited. Answers `{ data, creation }`.'
        ],
        ['`DELETE /databases/:id`', 'Body `{ confirm, drop? }`: detach, or detach and drop.']
      ]
    },
    { type: 'h2', id: 'hub-databases-errors', text: 'Every refusal code' },
    {
      type: 'p',
      text: "The Hub answers `{ error, code }`. The text is the Hub's own and never a driver's: a driver error can carry a login or a host. Anything the Hub does not recognise is a fixed 500 `HUB_ERROR` and only its name is logged. The Databases tab keeps plain words for each code and a test compares them with this list."
    },
    { type: 'h3', text: 'Input' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        ['`BAD_NAME`', 'A server needs a name of at most 200 characters.'],
        ['`BAD_ENGINE`', 'The engine must be `mssql`, `pg`, `mysql2` or `mariadb`.'],
        ['`BAD_HOST`', 'The host must be a host name or an IP address, not a URL.'],
        ['`BAD_PORT`', 'The port must be a whole number from 1 to 65535.'],
        ['`BAD_MODE`', 'The mode must be `automatic` or `manual`.'],
        [
          '`BAD_SSL`',
          '`ssl_mode` is not one of `disable`, `require`, `verify-ca`, `verify-full`, or `trust_server_cert` is not true or false.'
        ],
        ['`BAD_COLLATION`', 'The collation is not a collation name.'],
        [
          '`BAD_USER_HOST`',
          'The MySQL or MariaDB login host must be `%`, a host name, an address or a pattern.'
        ],
        ['`BAD_NOTES`', 'Notes must be text of at most 1000 characters.'],
        ['`BAD_SECRET`', 'On a manual server, the saved login must be a user and a password.'],
        [
          '`BAD_CONNECTION`',
          'The connection is not valid (missing part, spaces, control characters, a bad URL, an unsupported engine).'
        ],
        ['`BAD_DROP`', '`drop` must be true or false.']
      ]
    },
    { type: 'h3', text: 'Servers and logins' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        ['`ADMIN_REQUIRED`', 'An automatic server needs a provisioning login (user and password).'],
        [
          '`SECRET_REQUIRED`',
          'The engine, host, port or TLS changed: enter the provisioning login again.'
        ],
        [
          '`LOGIN_HALF_MASKED`',
          'The login was sent with a half that still holds the mask (••••••) or any of its • characters (typed around it). Send both user and password again, or neither. Sealing the mask would lock the server out.'
        ],
        [
          '`SERVER_IN_USE`',
          'The Hub made or is making databases on this server, so its engine, host and port cannot change.'
        ],
        [
          '`IN_USE`',
          'A server is still named by a database row, or an environment still uses the database, or another environment already uses it.'
        ],
        ['`NAME_TAKEN`', 'A server with that name already exists.'],
        [
          '`SERVER_MOVED`',
          'The server now points somewhere else than where this database was made. Nothing was changed or dropped.'
        ],
        [
          '`NOT_AUTOMATIC`',
          'Only a database the Hub creates on an automatic server can be provisioned, and the server must still be automatic.'
        ],
        [
          '`NOT_MANUAL`',
          'Only a database requested from a DBA takes a connection; the Hub manages this one itself.'
        ],
        [
          '`ENGINE_MISMATCH`',
          'The connection is for another engine than the one the database was requested on.'
        ],
        [
          '`ENGINE_NOT_PROVISIONABLE`',
          'The Hub makes databases on SQL Server, Postgres, MySQL and MariaDB only.'
        ]
      ]
    },
    { type: 'h3', text: 'Names' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`DATABASE_NAME_INVALID`',
          'Lower-case letters, digits and `_`, 2 to 63 characters, starting with a letter, not a reserved name.'
        ],
        [
          '`LOGIN_NAME_INVALID`',
          'Lower-case letters, digits and `_`, starting with a letter, short enough for the engine, not reserved.'
        ],
        [
          '`UNSAFE_IDENTIFIER`',
          'A name, password, collation or login host that is not safe to put into a statement was refused before it reached the server.'
        ],
        ['`RESERVED_NAME`', 'That name is reserved on database servers.'],
        [
          '`LOGIN_EXISTS`',
          'A login with this name exists on the server and the Hub did not make it for this record. Nothing was changed.'
        ],
        [
          '`DATABASE_EXISTS`',
          'A database with this name exists on the server and the Hub did not make it for this record. Nothing was changed.'
        ],
        ['`NOT_OWNED`', 'The Hub changes or drops only an object its own marker says it made.'],
        ['`DATABASE_RECORDED`', 'The Hub already records a database with this name on this host.'],
        ['`DATABASE_IN_USE`', 'Another Hub record already uses this database on this server.']
      ]
    },
    { type: 'h3', text: 'State' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        ['`NOT_FOUND`', 'No such database or server (or the caller may not see it).'],
        ['`NOT_READY`', 'The database is not ready yet.'],
        ['`DATABASE_NOT_READY`', 'Only a ready database can be given to an environment.'],
        ['`NOT_WAITING`', 'This database already has a working connection.'],
        ['`NO_CONNECTION`', 'No connection is saved for this database yet.'],
        ['`DATABASE_DROPPING`', 'This database is being dropped.'],
        [
          '`PROVISION_RUNNING`',
          'This database is being created or dropped right now. Try again when that finishes.'
        ],
        [
          '`LOCK_UNAVAILABLE`',
          '503. The Hub cannot reach Redis to be sure only one change runs on this database. Try again shortly.'
        ],
        [
          '`STATE_CHANGED`',
          'The database changed while this ran (another action finished first). Reload and try again.'
        ],
        [
          '`CONNECTION_UNREADABLE`',
          'The stored connection cannot be read (check `ENCRYPTION_KEY`).'
        ],
        [
          '`HUB_SECRET_UNREADABLE`',
          'A saved secret cannot be decrypted (wrong key or damaged value).'
        ],
        ['`HUB_SECRET_NOT_SEALED`', 'A stored secret is not encrypted.'],
        [
          '`HUB_NEEDS_ENCRYPTION_KEY`',
          'Set `ENCRYPTION_KEY` (64 hex characters) on the Hub before saving a secret.'
        ]
      ]
    },
    { type: 'h3', text: 'Delete, checks and owners' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        ['`CONFIRM_REQUIRED`', 'Type the database name to confirm.'],
        [
          '`DROP_NOT_ALLOWED`',
          'The Hub drops only a database or login it created itself on an automatic server. Detach instead.'
        ],
        ['`DATABASE_UNREACHABLE`', 'The check could not connect.'],
        [
          '`DATABASE_TOO_OLD`',
          'The server is older than the oldest release Nivaro supports, or it is the other flavour (MySQL / MariaDB).'
        ],
        ['`DATABASE_NO_RIGHTS`', 'Connected, but the login cannot build tables.'],
        ['`DATABASE_NOT_NIVARO`', 'The database holds tables that are not a Nivaro install.'],
        [
          '`DATABASE_NOT_EMPTY`',
          'An empty database is required here and this one holds tables (creation, or a database that is a Nivaro install).'
        ],
        ['`HOST_NOT_SERVER`', "An app owner may point a check only at the database's own server."],
        [
          '`TOO_MANY_TRIES`',
          '429, with `Retry-After`. More than 10 owner tries in 10 minutes on this database.'
        ],
        [
          '`DB_ERROR`',
          '502. The database server answered with an error. The text is scrubbed of logins and passwords.'
        ],
        ['`HUB_ERROR`', '500. The Hub could not do that; see the server log.']
      ]
    }
  ]
}

export const hubCreateDocs: DocSection = {
  id: 'hub-create-app',
  label: 'Creating apps from the Hub',
  content: [
    { type: 'h1', id: 'hub-create-app', text: 'Creating apps from the Hub' },
    {
      type: 'p',
      text: "Apps → Create app (Hub administrators) makes a new Nivaro app end to end: a database for each environment, a GitLab deploy repository, the settings and secrets the deploy needs, the first deploy on the Docker swarm, the app's name, the Hub link and the first administrator. The result is an ordinary environment the Hub can promote and roll back like any adopted one."
    },
    {
      type: 'warn',
      text: 'Creating apps needs GitLab 17.1 or newer (the Hub sets `restrict_user_defined_variables` together with `ci_pipeline_variables_minimum_override_role` on every deploy repository and refuses to deploy when GitLab does not keep them), a Docker swarm with Traefik v3, and a Hub with `ENCRYPTION_KEY` set. The Hub never makes DNS names on a name server, Microsoft app registrations, or swarm users: those are listed below as what you do yourself.'
    },
    { type: 'h2', id: 'hub-create-targets', text: 'Targets: where new apps go' },
    {
      type: 'p',
      text: 'A target (the Targets tab of the Hub, administrators only: Apps · Drivers · Targets · Databases) holds everything about one place apps are created. Only kind `gitlab` exists. Settings:'
    },
    {
      type: 'table',
      head: ['Setting', 'Meaning'],
      rows: [
        [
          'Token',
          'A GitLab token with the `api` scope, as a Maintainer of the namespace. Sealed; shown as ••••••. Changing the GitLab address or namespace needs it entered again (`SECRET_REQUIRED`).'
        ],
        [
          '`api`',
          'The GitLab address. https only (http only for localhost). No user, query or fragment.'
        ],
        [
          '`namespace`',
          "The GitLab group (or the token's own user) the deploy repositories are created in. A repository is `<namespace>/<app>-deploy`."
        ],
        [
          '`template_project`, `template_ref`',
          'The deploy repository template (below) and the pinned ref its deploy job is read from: a version tag such as `v1.2.0`, or a full 40-character commit sha. A branch name is refused, so the job cannot change under an app.'
        ],
        ['`pin_file`', 'Where the version pin is committed. Default `.hub/nivaro-version`.'],
        ['`deploy_job`', 'The job name the deploy runs under. Default `deploy`.'],
        [
          '`deploy_host`',
          'The swarm manager the deploy connects to by ssh: `host`, `user@host` or `host:port`.'
        ],
        [
          '`manager_known_hosts`',
          "The manager's ssh host keys (`ssh-keyscan -t ed25519 <manager>`; `[host]:port` entries when the port is not 22). Must hold a key for `deploy_host`. The deploy connects with strict host key checking and refuses any other key."
        ],
        ['`proxy_network`', 'The external overlay network Traefik reads. Default `proxy`.'],
        [
          '`dns_mode`',
          '`automatic`: the Hub derives every hostname under a wildcard domain. `manual`: you give each hostname and the Hub waits until a person has made the DNS name.'
        ],
        [
          '`wildcard_domain`',
          'Required for `automatic`, for example `apps.example.com`. Every hostname must end in it.'
        ],
        [
          '`edge_address`, `cert_note`',
          'Used only in the manual-name ticket text: where the name must point, and a free note about the certificate.'
        ],
        [
          '`scheme`, `port`',
          'https (default) or http, and an optional port. Plain http is allowed only when the wildcard domain is `localhost` or ends in `.test`.'
        ]
      ]
    },
    {
      type: 'p',
      text: "Test checks, one by one: the token works, the namespace exists and the token user is a Maintainer there (or the namespace is the token user's own), and the template project can be seen. A target cannot be deleted while an app was created on it (`IN_USE`). Saving a target gives every app created on it its CI path and project variables again, one app at a time (the answer says which, and `pending` for any that finish in the background). A new token also replaces the token copy on the driver the Hub made for each of those apps, as long as that driver still held the previous token (`driver_token: updated` in the answer), so promotions of created apps keep working after a rotation."
    },
    { type: 'h3', text: 'Target refusals' },
    {
      type: 'p',
      text: 'Saving a target answers 400 with `{ error, code }`; the text says which setting. Test never refuses: it answers one line per check (`token`, `namespace`, `template`), and a failed token skips the other two.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        ['`BAD_KIND`', 'The target kind must be `gitlab`.'],
        ['`BAD_NAME`', 'A target needs a name of at most 200 characters.'],
        [
          '`BAD_CONFIG`',
          'A setting is missing or not valid; the text names it. Unknown keys; an `api` that is not https (http only for localhost) or carries a user, query or fragment; a namespace, template project or pin file that is not a path; a `deploy_host` that is not `host`, `user@host` or `host:port`; a `template_ref` that is not a version tag or a full commit sha; `manager_known_hosts` that are not ssh host-key lines, or that hold no key for the deploy host; a deploy job, proxy network, `edge_address` or `cert_note` that is empty or too long; a `dns_mode` that is not `automatic` or `manual`; a `port` that is not a whole number from 1 to 65535.'
        ],
        [
          '`BAD_WILDCARD`',
          'The wildcard domain must be a DNS name like `apps.example.com`, and an automatic target needs one.'
        ],
        [
          '`BAD_SCHEME`',
          'Plain http is allowed only when the wildcard domain is `localhost` or ends in `.test`.'
        ],
        ['`BAD_SECRET`', 'The token must be text.'],
        ['`SECRET_REQUIRED`', 'The GitLab address or namespace changed: enter the token again.'],
        ['`HUB_NEEDS_ENCRYPTION_KEY`', 'Set `ENCRYPTION_KEY` on the Hub before saving a token.'],
        ['`NOT_FOUND`', '404. No such target.'],
        ['`IN_USE`', '409, on delete. An app was created on this target.'],
        ['`TARGET_MISCONFIGURED`', '409. The target has no GitLab address.'],
        [
          '`FETCH_REDIRECT`',
          'In a Test line: GitLab redirected the call (check the address); the Hub refuses to follow it. Other Test lines: no token saved, the token was refused (wrong, expired or revoked), the token lacks the `api` scope or role, GitLab did not answer, or the saved token cannot be read (check `ENCRYPTION_KEY`).'
        ]
      ]
    },
    { type: 'h2', id: 'hub-create-template', text: 'The deploy repository template' },
    {
      type: 'p',
      text: 'The Hub forks one deploy repository per app from a template that ships in this repository (`deploy/hub-app-template/`). Import it once into GitLab, protect its tags, tag a commit `v<major>.<minor>.<patch>` and name the project and tag in the target. Its README is the operator manual; this is the summary.'
    },
    {
      type: 'ul',
      items: [
        "Nothing the app repository changes can decide what runs. At fork the Hub sets the app project's CI configuration path to `ci/deploy.yml@<template_project>:<template_ref>`, so GitLab reads the deploy job from the Hub-owned template at the pinned ref and ignores the app repository's own `.gitlab-ci.yml`. It also sets the project so nobody may set pipeline variables by hand. These are checked again before every deploy and whenever the target changes; a project that does not keep them stops with `CI_CONFIG_REFUSED`.",
        "One deploy key per app. The Hub makes an ed25519 key pair when it creates the repository and pushes the private half once as the project's masked, protected variable `DEPLOY_SSH_KEY`. It is never stored by the Hub. The public half and its fingerprint are what an operator installs on the manager. A key can reach only that app's stacks and hostnames.",
        "The manager runs a forced command. The key may run only `nivaro-hub-deploy`, with three verbs (check who owns a stack, create a secret, deploy a stack) for the exact stack names and hostnames in that app's key file, one proxy network and one image by digest. There is no shell and no Docker socket forwarding.",
        'The image is pinned by digest. The pin file holds the Nivaro version and the image digest; `latest` and a pin without a digest are refused.'
      ]
    },
    {
      type: 'p',
      text: "What the Hub sets on each app repository. Project variables for every environment (protected): `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` (base64, masked), `HUB_HOST_SUFFIX` (the wildcard domain, only when the target has one) and `HUB_PIN_FILE` when the pin file is not the default. Per environment (scoped to it, masked, protected, each the base64 of its value): `NIVARO_DB_URL_B64`, `NIVARO_HUB_TOKEN_B64`, `NIVARO_SESSION_SECRET_B64`, `NIVARO_ENCRYPTION_KEY_B64`, `NIVARO_OIDC_CLIENT_SECRET_B64`. The deploy turns each into a swarm secret and the app reads it through its `<SETTING>_FILE`, so no value reaches a command line, an environment or a log. On the environment branch the Hub commits `.hub/app.env` with only these settings (never a secret), the version pin and the app's `.gitlab-ci.yml`: `APP_KEY`, `ENV_KEY`, `STACK_NAME`, `APP_HOSTS`, `PUBLIC_URL`, `ADMIN_URL`, `HUB_URL`, `NIVARO_ENVIRONMENT`, `DB_CLIENT`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_REDIRECT_URI`, `PROXY_NETWORK`, `TRUST_PROXY`. The deploy refuses any other key in that file."
    },
    {
      type: 'warn',
      text: 'The session secret and the encryption key are made once and never overwritten, on a retry or any later run. A new session secret signs everyone out; a new encryption key makes every sealed value in the app unreadable.'
    },
    { type: 'h2', id: 'hub-create-host', text: 'Host prerequisites' },
    {
      type: 'ul',
      items: [
        'A swarm manager running Traefik v3 with the swarm provider on the external proxy network. Entry points `websecure` (https) and `web` (http).',
        'On an automatic target the wildcard DNS record must already point at the edge that reaches Traefik: the Hub waits for the name to resolve but never makes DNS records.',
        "The wildcard certificate must be Traefik's default certificate. The app's router asks for TLS with no certificate resolver, so Traefik answers every name with its default certificate. With manual names, the same holds for the names a person adds.",
        'On the manager, once per template major: the `nivaro-hub-deploy` wrapper, its configuration folder and the stack file (see the template README). Per app: its key file and its `authorized_keys` line, which the Hub shows (see "Waiting for the deploy key").',
        "`HUB_IMAGE` on the Hub (the image whose digests it pins) and `image=` in each app's key file on the manager (default `nodeworks/nivaro`) must name the same image: the manager deploys only the image its key file names. If you change `HUB_IMAGE`, change `image=` in every key file.",
        'Created apps run one node: web, worker and Redis share an uploads volume and are placed on manager nodes. Extensions are not part of a created app.'
      ]
    },
    { type: 'h2', id: 'hub-create-form', text: 'What you enter' },
    {
      type: 'table',
      head: ['Field', 'Rule'],
      rows: [
        [
          'App key and name',
          'The key is lower-case letters, digits and single dashes, starting with a letter, no `--` and not ending in `-`. It makes the repository `<key>-deploy`. The name is one line, 200 characters at most.'
        ],
        ['Owners', 'People who may see the app (and act on its creation): they must exist.'],
        [
          'First administrator',
          'An email address, and optionally a first and last name. The new app is told to make this person its administrator.'
        ],
        [
          'Target',
          'The target the app is created on. It must be complete (token, namespace, a pinned template ref, host keys that cover the deploy host, a DNS mode, https).'
        ],
        [
          'Version',
          '`x.y.z`. Its image must exist on Docker Hub (`HUB_IMAGE`, default `nodeworks/nivaro`) with a digest. Created apps start with no extensions.'
        ],
        [
          'Sign-in',
          "The issuer (https), client id and client secret of the Microsoft app registration the new app signs people in with. The secret is sealed and goes only to the app. You add each environment's redirect URI (`<base URL>/api/auth/callback`) to the registration yourself; the plan lists them."
        ],
        [
          'Environments',
          'One to six, in promotion order. Each key is a branch name and follows the key rule. The first branches from `main`; each later one is promoted from the one before it. `production` gets the host `<app>`, any other `<app>--<env>`, under the wildcard domain. On a manual target you type each hostname; on an automatic target you may type one directly under the wildcard.'
        ],
        [
          'Database, per environment',
          'A server (the Hub makes the database on an automatic server, or asks a DBA on a manual one) with an optional database and login name, or an existing ready database not used by another environment.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Plan (a read that writes nothing) shows, per environment, the hostname, base URL, the ticket text for a manual name, the redirect URI, the branch, the swarm stack name (`<app>--<env>`, shortened with a hash past 40 characters), the database and, for a DBA, the checklist, and lists every problem at once. Create plans again inside a lock that only one creation at a time holds, so two creations never take the same key, hostname or stack name. It writes the app, owners, environments, database records and one creation per environment in one transaction, and answers 202.'
    },
    { type: 'h2', id: 'hub-create-steps', text: 'The eight steps' },
    {
      type: 'p',
      text: "Each environment is walked through the same steps in the background, in position order. Every step can be repeated safely, so Retry starts again at the first unfinished step and never plans again. A creation holds the environment's promotion lock, so a promotion and a creation never run on one environment together."
    },
    {
      type: 'table',
      head: ['Step', 'What it does'],
      rows: [
        [
          '`database`',
          "Makes the database on an automatic server (see Hub databases), or waits for the DBA's connection, or uses the existing ready one."
        ],
        [
          '`repository`',
          "Forks the template into `<namespace>/<app>-deploy` (once per app, however many environments), sets the CI path and locks pipeline variables, makes and pushes the app's deploy key, and records a GitLab driver for it. A project already at the path is adopted only if it is the one this app recorded, or its description carries this app's own mark and it was created by the target's token user; otherwise the step stops with `PROJECT_EXISTS`."
        ],
        ['`variables`', "Sets the project variables and this environment's five secret variables."],
        [
          '`config`',
          'Protects and creates the environment branch, commits `.hub/app.env`, the pin and `.gitlab-ci.yml` (subject exactly `nivaro <version>`, so a later promotion finds it as its source commit; `hub: create <app>/<env>` is in the body), and gives the environment its placement and an `api` component whose check address is `<base URL>/api/version`, so promotions and rollbacks work afterwards.'
        ],
        [
          '`deploy`',
          "Waits for the operator to install the app's key, then runs the deploy job once and waits for it (up to 60 minutes)."
        ],
        [
          '`name`',
          'Waits until the hostname resolves and `<base URL>/api/version` answers the version being created. Automatic names: 20 looks, 15 seconds apart. Manual names: waits for as long as it takes.'
        ],
        ['`link`', 'Waits until the app answers the Hub link (10 looks, 15 seconds apart).'],
        [
          '`admin`',
          'Asks the app, over the Hub link, to make the first administrator (up to 20 tries 15 seconds apart for "not ready yet" answers).'
        ]
      ]
    },
    {
      type: 'p',
      text: "The environment is `provisioning` while it is created, `waiting_for_name` while a hand-made name is awaited, and becomes `active` when every step is done. A creation is `queued`, `running`, `waiting`, `done`, `failed`, `interrupted` or `cancelled`. Progress, the log, the made repository, driver, placement and database, the ticket, the checklist and the manager lines are on the environment's creation panel; none of them contains a secret."
    },
    { type: 'h2', id: 'hub-create-waits', text: 'Waits' },
    {
      type: 'table',
      head: ['Waiting for', 'Why', 'How it ends'],
      rows: [
        [
          '`database`',
          'A manual server: a DBA must make the database and the connection must be entered.',
          'The connection is saved and checks empty (or Check now says so). The Hub also looks again every 5 minutes.'
        ],
        [
          '`operator`',
          "The app's deploy key is not installed on the swarm manager yet.",
          'Press Installed (below). There is no timeout and no automatic deploy.'
        ],
        [
          '`name`',
          'A manual target: a person must make the DNS name and the certificate.',
          'The name resolves and serves the version. The Hub looks again every 5 minutes and on Check now. There is no timeout.'
        ]
      ]
    },
    { type: 'h3', id: 'hub-create-waits-operator', text: 'Waiting for the deploy key' },
    {
      type: 'p',
      text: "After the repository step the creation shows what the operator installs on the manager: the `authorized_keys` line for the app's key (a forced command, `restrict`) and the text of `/etc/nivaro-hub-deploy/keys/<app>.conf` with the exact `stack=` and `host=` lines of all the app's environments, plus the network and image. Install both, then press Installed. The Hub then runs the deploy once for every environment of that app that was waiting. If the manager refuses the key (not installed, or the stack is already bound to another key) the job exits with code 77 after printing the single line `NIVARO_HUB_KEY_NOT_INSTALLED`; the Hub reads only that line and goes back to waiting, with the press spent. Every other deploy failure fails the step (`DEPLOY_FAILED`); Retry runs the job again. Installed is allowed to the app's owners too. The config push already starts the deploy job in GitLab, before anyone could install the key: that first pipeline of each environment fails with exit code 77 (and GitLab may mail its failure). That is expected; the Hub reruns the job after Installed."
    },
    { type: 'h3', id: 'hub-create-waits-name', text: 'Manual names: the ticket' },
    {
      type: 'p',
      text: "On a manual target the creation shows a ready-to-paste request: create the DNS name, pointing at the edge address of the target (or the edge that serves the swarm), with a certificate that covers it, routed to the swarm's Traefik by name; plus the target's certificate note. Hand it to whoever makes names. Check now looks at once: whether the name resolves, and whether it serves the version. The name check sends no credential, follows no redirect and is bounded to a few seconds."
    },
    { type: 'h2', id: 'hub-create-admin', text: 'The first administrator' },
    {
      type: 'p',
      text: "An app made by the Hub has `HUB_TOKEN` set, which mounts `POST /api/hub-link/first-admin` on it (never in cloud mode, and not at all without a hub token). The Hub calls it with the app's hub token as the bearer. It works only while the app has no active administrator:"
    },
    {
      type: 'ul',
      items: [
        'No user has the email: one is created, in the oldest role with admin access, active, with no external id (the first Microsoft sign-in links it by email).',
        'A fresh app has no roles at all (migrations seed none): the call first makes the `Administrator` role (admin and app access, as cloud provisioning does), in the same transaction as the person. A refused call writes neither. An app that has roles but none with admin access answers 409 `NO_ADMIN_ROLE` and nothing is written.',
        'A person already has the email: they are moved to that role (`created: false`). A person not yet started (draft, invited, pending, unverified) is made active; one disabled on purpose is refused.',
        'Once an administrator exists every call answers 409 `HAS_ADMIN` and writes nothing: the Hub counts that as done.',
        'Exactly one call wins, however many race. The call is a write, so the maintenance freeze applies. It adds an activity row and a security alert in the app.'
      ]
    },
    { type: 'h2', id: 'hub-create-control', text: 'Retry, check, cancel and delete' },
    {
      type: 'ul',
      items: [
        'Retry (administrators): a failed, interrupted or cancelled creation starts again at its first unfinished step.',
        "Check now (administrators and the app's owners): looks at the waited thing once. If it is there the creation continues. If a promotion holds the environment the creation stays waiting, with a note, and continues when the environment is free.",
        'Installed: see "Waiting for the deploy key".',
        'Cancel (administrators): a waiting or queued creation stops at once; a running one stops at its next step boundary.',
        'A creation whose Hub stopped mid-step becomes `interrupted` once its heartbeat is stale (2 minutes): when a Hub starts (and once more about 2.5 minutes after the start, for a run killed just before), when its creation panel is read or its environment is deleted (even with `CRON_TICKS=off`), and at the latest with the 5-minute job. Its job run is closed as failed at the same time, so the Jobs tray stops showing it running. Retry continues it (it waits while the lock of the stopped run lives on, up to 5 minutes). The 5-minute job `hub-creation-waits` also starts waiting creations whose database or name is ready, and creations that found their environment busy.',
        'Only one creation step runs per environment, even if Redis loses the lock: a running creation also writes a heartbeat every minute, and while it is fresh (2 minutes) nothing takes the creation over or marks it interrupted. Retry, the 5-minute job and a delete of the environment leave it alone (the delete answers `CREATION_RUNNING`). A running creation that finds its own lock gone stops its current wait at once and becomes `interrupted`; Retry continues it.'
      ]
    },
    {
      type: 'warn',
      text: "Deleting an environment or an app in the Hub removes only the Hub's records (and the creation rows and the environment's dedicated placement). It does not touch anything it made outside the Hub. Left behind: the GitLab deploy repository and its branches and variables, the GitLab driver, the database and login (the database row stays on the Databases tab, now attached to nothing: detach it, or detach and drop it there), the swarm stack and its secrets on the manager, the app's key file and `authorized_keys` line on the manager, the DNS name and certificate, and the redirect URI in the Microsoft app registration. Deleting is refused with `CREATION_RUNNING` while a creation step or a promotion holds the environment."
    },
    { type: 'h2', id: 'hub-create-routes', text: 'Routes' },
    {
      type: 'p',
      text: 'Under `/api/hub`, hub mode only. Administrators unless stated; an app owner reaches only their own environments (anything else is 404).'
    },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET/POST /targets`, `PATCH/DELETE /targets/:id`, `POST /targets/:id/test`',
          'Targets. The token is the mask. PATCH answers `sync` (one result per app made on the target: `ok`, `code`, `pending`, and `driver_token: updated` when a new token reached its driver) or `sync_error: SYNC_READ_FAILED`; the target is saved either way.'
        ],
        ['`POST /apps/create/plan`', 'The plan with every blocker. Read only.'],
        [
          '`POST /apps/create`',
          'Start. 202 `{ data: { app_id, environments } }`, or 409 with `blockers` and the first blocker as `code`.'
        ],
        [
          '`GET /environments/:envId/creation`',
          "The creation: steps, status, waiting reason, log, ticket, checklist, database, deploy key lines. Administrators and the app's owners."
        ],
        ['`POST /environments/:envId/creation/retry`', 'Retry.'],
        ['`POST /environments/:envId/creation/check`', 'Check now (administrators and owners).'],
        [
          '`POST /environments/:envId/creation/installed`',
          'The deploy key is installed (administrators and owners). 202.'
        ],
        [
          '`POST /environments/:envId/creation/cancel`',
          'Cancel. 409 `NOT_RUNNING` unless it is running, waiting or queued.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-create-blockers', text: 'Blocker codes' },
    {
      type: 'p',
      text: 'Plan and Create list every blocker at once; fix them all and plan again. A blocker with an `env` belongs to that environment.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`BAD_KEY`',
          'The app key is not lower-case letters, digits and single dashes starting with a letter (no `--`).'
        ],
        ['`KEY_TAKEN`', 'An app with that key exists.'],
        ['`BAD_NAME`', 'The app needs a one-line name of at most 200 characters.'],
        ['`BAD_OWNER`', 'Owners must be a list of existing people.'],
        [
          '`BAD_EMAIL`',
          'The first administrator needs an email like ada@example.com; names must be one line.'
        ],
        [
          '`BAD_TARGET`',
          'No target picked, or the target is incomplete (the text says what is missing: token, namespace, template ref, host keys, DNS mode, scheme, wildcard domain).'
        ],
        ['`BAD_VERSION`', 'The version is not `x.y.z`.'],
        [
          '`IMAGE_MISSING`',
          'The image for that version is not on Docker Hub, or Docker Hub did not answer.'
        ],
        [
          '`IMAGE_NO_DIGEST`',
          'Docker Hub lists the version without a digest, which the pin needs.'
        ],
        [
          '`BAD_SIGNIN`',
          'The sign-in issuer must be an https URL, the client id one word, and the client secret present.'
        ],
        ['`EXTENSIONS_UNSUPPORTED`', 'Created apps start with no extensions.'],
        [
          '`NEEDS_ENCRYPTION_KEY`',
          "Set `ENCRYPTION_KEY` on the Hub: it seals the new apps' tokens and connections."
        ],
        ['`NO_ENVIRONMENTS`', 'Add at least one environment.'],
        ['`TOO_MANY_ENVIRONMENTS`', 'At most six environments.'],
        ['`BAD_ENV_KEY`', 'An environment key breaks the key rule.'],
        ['`DUPLICATE_ENV`', 'An environment key is listed twice.'],
        ['`HOSTNAME_REQUIRED`', 'A manual target: enter the hostname for this environment.'],
        [
          '`HOSTNAME_INVALID`',
          'Not a hostname (an IP, one label, bad characters, a label of 64 or more characters, `xn--`, or plain http for a name that is not `localhost` or `.test`).'
        ],
        [
          '`HOSTNAME_OUTSIDE_WILDCARD`',
          'The name must be one label directly under the wildcard (automatic), or end in the wildcard (manual).'
        ],
        [
          '`HOSTNAME_TAKEN`',
          'Another environment, another environment in this request, or the Hub itself already uses that name.'
        ],
        [
          '`STACK_NAME_TAKEN`',
          "The swarm stack name is already another environment's: pick another environment key."
        ],
        [
          '`BAD_SERVER`',
          'No database server picked, or the server is not usable (not provisionable, an automatic server with no login, a bad collation or login host).'
        ],
        ['`DATABASE_NOT_READY`', 'The existing database named does not exist or is not ready.'],
        [
          '`DATABASE_IN_USE`',
          'The existing database already belongs to an environment, or is given to two.'
        ],
        [
          '`DATABASE_NAME_INVALID`',
          'A database or login name is not accepted (see Hub databases).'
        ],
        [
          '`DATABASE_RECORDED`',
          'The Hub already records that database on that server, or two environments get the same database or login.'
        ],
        [
          '`DATABASE_EXISTS`',
          'The automatic server already has a database of that name: pick another name, or adopt it.'
        ],
        [
          '`SERVER_UNREACHABLE`',
          'The automatic server did not answer when the Hub looked for the name.'
        ],
        [
          '`PROJECT_EXISTS`',
          'GitLab already has a project at `<namespace>/<app>-deploy`. The Hub creates the repository itself.'
        ],
        ['`GITLAB_UNREACHABLE`', 'GitLab did not answer when the Hub looked for that project.'],
        [
          '`NO_HUB_URL`',
          'The Hub has no address to give the apps (`HUB_URL`, else `ADMIN_URL`, else `PUBLIC_URL`), or it is not https (http only for localhost and `.test`), or it is local to the machine while the apps are not.'
        ]
      ]
    },
    { type: 'h3', text: 'Refusals while it runs' },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`CREATION_STARTING`',
          '409. Another app is being created right now (the start lock); try again in a moment.'
        ],
        ['`NOT_FOUND`', '404. No creation for that environment.'],
        [
          '`NOT_RESUMABLE`',
          '409. Retry works on a failed, interrupted or cancelled creation; Check now on a waiting one.'
        ],
        [
          '`ENVIRONMENT_BUSY`',
          '409. A promotion or a creation step holds the environment; try again shortly.'
        ],
        ['`NOT_WAITING_FOR_OPERATOR`', '409. The creation is not waiting for the deploy key.'],
        ['`NOT_RUNNING`', '409. Cancel works on a running, waiting or queued creation.'],
        [
          '`CREATION_RUNNING`',
          '409. A creation step or a promotion holds the environment: wait for it or cancel it before deleting.'
        ],
        ['`TARGET_MISCONFIGURED`', '409. The target has no GitLab address.']
      ]
    },
    { type: 'h3', text: 'Why a step failed' },
    {
      type: 'p',
      text: "A failed step shows `CODE: text` as its note and as the creation's error. Database codes are listed under Hub databases."
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`PROJECT_EXISTS`',
          "A GitLab project exists at the path (or the recorded one) and is not this app's deploy repository."
        ],
        [
          '`PROJECT_NOT_OURS`',
          "Only in a target save's `sync` answer for one app: its deploy repository could not be shown to be the one the Hub made (or the record of it is gone), so its CI settings were not touched."
        ],
        [
          '`STEP_FAILED`',
          'A step failed with an error that has no code of its own. See the creation log.'
        ],
        [
          '`REPOSITORY_BUSY`',
          'Another environment of this app held the repository too long; retry.'
        ],
        [
          '`FORK_UNFINISHED`, `IMPORT_FAILED`, `IMPORT_TIMEOUT`',
          'GitLab did not finish copying the template (stopped, failed, or too slow). Retry resumes the same project.'
        ],
        [
          '`GITLAB_REFUSED`, `GITLAB_BAD_ANSWER`, `GITLAB_BAD_NAME`',
          'GitLab refused a call or answered something the Hub cannot use.'
        ],
        [
          '`GITLAB_NO_TOKEN`, `GITLAB_UNAUTHORIZED`, `GITLAB_FORBIDDEN`, `GITLAB_UNREACHABLE`',
          'No token, a refused token (wrong, expired, revoked), a token without the `api` scope or role, or GitLab did not answer.'
        ],
        [
          '`CI_CONFIG_REFUSED`',
          "The deploy repository's CI path or pipeline-variable setting is not what the Hub set, or GitLab (older than 17.1) would not keep it. Nothing deploys from it."
        ],
        ['`VARIABLE_REFUSED`', 'GitLab refused a CI variable.'],
        [
          '`PLAN_MISSING`, `PROJECT_MISSING`, `DRIVER_MISSING`, `DATABASE_MISSING`, `COMMIT_MISSING`, `HUB_TOKEN_MISSING`, `OIDC_SECRET_MISSING`',
          'What an earlier step should have recorded is missing. Retry; start again if it persists.'
        ],
        ['`IMAGE_NO_DIGEST`', 'The image planned for the creation has no digest.'],
        [
          '`DEPLOY_FAILED`',
          'The deploy job did not succeed; its page is linked in the log. The deploy script rolls back.'
        ],
        [
          '`PIPELINE_NOT_CREATED`, `JOB_TIMEOUT`, `JOB_RETRY_REFUSED`, `DEPLOY_JOB_UNEXPECTED`',
          'GitLab never created the pipeline, the job did not finish in 60 minutes, GitLab refused to retry it, or it was in a state the Hub did not expect.'
        ],
        [
          '`NAME_NOT_SERVING`',
          'Automatic names: the hostname never resolved and served the new version within the looks.'
        ],
        ['`LINK_REFUSED`', "The app refused the Hub link: its `HUB_TOKEN` is not the Hub's."],
        ['`LINK_UNREACHABLE`', "The app's Hub link never answered."],
        [
          '`BAD_EMAIL`, `NO_ADMIN_ROLE`, `PERSON_DISABLED`, `AMBIGUOUS_EMAIL`, `FIRST_ADMIN_FAILED`',
          'The app refused the first administrator: the email is not valid; the app has roles but none with admin access (a fresh app with no roles gets the Administrator role instead); the person with that email was disabled on purpose; two people differ only in the case of the email; or the app could not save it.'
        ],
        [
          '`HUB_LINK_REFUSED`, `HUB_LINK_MISSING`, `HUB_LINK_REDIRECT`, `HUB_TOKEN_MISSING`, `BAD_BASE_URL`, `BAD_ANSWER`, `HTTP_<status>`',
          'The first-administrator call was refused (wrong token or too many wrong ones), the app has no hub link route (no `HUB_TOKEN`, or an older app), it redirected, the environment has no hub token, the base URL is not usable, the app answered something unreadable, or it answered another HTTP status.'
        ],
        [
          '`MAINTENANCE`, `TIMEOUT`, `UNREACHABLE`, `HTTP_502`, `HTTP_503`, `HTTP_504`',
          'Not an error yet: the Hub asks again (up to 20 times) before it fails the step. `HUB_LINK_MISSING` is also asked again, but only for the first 4 tries (a just-deployed app may not answer yet); after that it fails the step.'
        ]
      ]
    }
  ]
}
