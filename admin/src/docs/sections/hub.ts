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
      text: 'This is phase 1 of 7. The Hub can adopt an app that already runs and show its status and deploy history, read-only. It cannot yet deploy, upgrade or roll back an app, create databases, place an app on a shared deployment, or sign people in to apps. Those arrive in later phases.'
    },
    { type: 'h2', id: 'hub-overview-on', text: 'Turning hub mode on' },
    {
      type: 'p',
      text: 'Hub mode is off by default. With HUB unset an installation is an ordinary Nivaro: no Hub routes, no Apps item in the navigation, empty Hub tables. Hub mode is refused in cloud mode (CLOUD_META_DB_URL set): the routes are not mounted and the hub feature is not advertised.'
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
          'Roll back only: the Hub has no record of the API build it deployed with that version (the commit or its pipeline), or of the image a stack deploy of it ran, so it cannot redeploy it. Nothing runs.'
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

export const hubDockerDocs: DocSection = {
  id: 'hub-docker',
  label: 'Docker driver and Hub agent',
  content: [
    { type: 'h1', id: 'hub-docker', text: 'Docker driver and Hub agent' },
    {
      type: 'p',
      text: 'A Docker driver lets the Hub deploy a Nivaro app as a Docker swarm stack. The Hub never touches Docker itself. It calls the Hub agent, a small service that runs on a swarm manager and is the only Hub component that holds the Docker socket for writes. A stack component (kind `stack`) is placed on a Docker driver and promoted, rolled back, restarted and removed from the Apps hub like any other component.'
    },
    { type: 'h2', id: 'hub-docker-agent', text: 'What the agent does and never does' },
    {
      type: 'ul',
      items: [
        'It takes a stack spec the Hub validated and turns it into Docker Engine calls: secrets, volumes, services and labels. It lists, reads, restarts and removes only stacks it created itself (labelled `nivaro.hub.managed`), and every write re-reads the live labels first.',
        'It unpacks app extensions out of OCI images into a folder the app services mount read-only.',
        'It never runs a container for an app, execs into one or reads logs. Its only container is a short-lived one that is created but never started, used to read an extension out of an image. The Engine paths it may call are a fixed allow-list; anything else is refused inside the agent, before it reaches the socket.',
        'It never uses an image that is not in `HUB_AGENT_IMAGES` or is not pinned by digest, never binds a host path or device into an app service, and never touches a service, secret or volume it did not create.',
        'It never prints or stores a token, key or registry credential. A failed start prints only an error code, for example `TOKEN_MISSING`.',
        'The API process never holds a Docker socket. Docker writes go only through the agent.'
      ]
    },
    { type: 'h2', id: 'hub-docker-install', text: 'Installing the agent' },
    {
      type: 'p',
      text: 'The image is `nodeworks/nivaro-hub-agent`. Publishing the tag `@hub-agent-x.y.z` pushes `x.y.z`, and also `latest` only for a plain `x.y.z`; a prerelease such as `x.y.z-rc.1` never moves `latest`. Run it as a stack on a swarm manager using `deploy/hub-agent/stack.example.yml`.'
    },
    {
      type: 'ul',
      items: [
        '1. Create the secrets and the extensions folder (the top of `stack.example.yml` lists them).',
        '2. Edit `HUB_AGENT_IMAGES`, the edge settings and the host suffixes.',
        '3. Run `docker stack deploy -c stack.example.yml nivaro-hub-agent` on a manager.',
        '4. In the Hub, add a Docker driver with the agent address and the same token (below).'
      ]
    },
    {
      type: 'table',
      head: ['Variable', 'Default', 'Meaning'],
      rows: [
        [
          '`HUB_AGENT_TOKEN_FILE`',
          'required',
          'File with the bearer token: 32 or more characters, at least 8 different ones; generate one with `openssl rand -hex 32` (that floor lets a weak token through). `HUB_AGENT_HMAC_KEY_FILE` may hold a separate key for signed values (default: the token), made the same way.'
        ],
        [
          '`HUB_AGENT_LISTEN`',
          '`127.0.0.1:7480`',
          '`host:port` or `[ipv6]:port`. Without TLS the agent listens on loopback only; `HUB_AGENT_INSECURE_HTTP=1` allows another address on a private network.'
        ],
        [
          '`HUB_AGENT_TLS_CERT_FILE`, `HUB_AGENT_TLS_KEY_FILE`',
          'none',
          'Serve HTTPS. Both or neither. The Hub verifies the certificate, so use one its trust store accepts.'
        ],
        ['`HUB_AGENT_DOCKER_SOCKET`', '`/var/run/docker.sock`', 'The Engine socket path.'],
        [
          '`HUB_AGENT_IMAGES`',
          '`nodeworks/nivaro`',
          'Comma list of image repositories (no tag, no digest) a stack may name. The Nivaro image and every extension image share this one list.'
        ],
        [
          '`HUB_AGENT_EDGE`, `HUB_AGENT_EDGE_NETWORK`, `HUB_AGENT_ENTRYPOINTS`, `HUB_AGENT_CERT_RESOLVER`, `HUB_AGENT_HOST_SUFFIXES`',
          '`traefik`',
          'Edge `traefik` (needs the overlay network and the host suffixes, for example `.apps.example.com`; an app host must end in one; the agent sets both `traefik.docker.network` and `traefik.swarm.network` to that network, so either Traefik provider picks the right one) or `publish` (needs `HUB_AGENT_PUBLISH_PORTS`, a range inside 1024 to 65535).'
        ],
        [
          '`HUB_AGENT_REDIS_IMAGE`',
          'none',
          '`<repo>@sha256:<digest>` (a tag next to the digest, `redis:7.4-alpine@sha256:…`, is taken too: the digest pins it) to offer bundled Redis. Without it a stack that asks for bundled Redis is refused (`REDIS_NOT_CONFIGURED`).'
        ],
        [
          '`HUB_AGENT_VOLUME_DRIVER`, `HUB_AGENT_VOLUME_OPTS_FILE`',
          '`local`',
          'Driver and options for the uploads and Redis volumes, for example an NFS export. `o=bind` (also `rbind` and `remount`) and a `device` that is not an NFS export are refused at start.'
        ],

        [
          '`HUB_AGENT_EXTENSIONS_ROOT`, `HUB_AGENT_EXTENSIONS_HOST_ROOT`, `HUB_AGENT_EXTENSIONS_SHARED`',
          'see README',
          'Where extensions are unpacked, the same folder as the host sees it, and whether it is shared storage every node mounts (`on` drops the pin to one node).'
        ],
        [
          '`HUB_AGENT_REGISTRY_AUTH_FILE`',
          'none',
          'A docker `config.json` with `auths`, for private registries. Credentials go only to the registry that matches the image being pulled.'
        ],
        [
          '`HUB_AGENT_ENV_PREFIXES`',
          'none',
          'Comma list of key prefixes a stack may set on top of the keys Nivaro reads (see Stack settings). Each is upper-case segments ending with `_`, for example `EFP_` or `EFP_OPS_`.'
        ]
      ]
    },
    {
      type: 'note',
      text: 'The agent runs as root with `cap_drop: [ALL]` and a read-only root file system. Secret files it creates for an app are owned by uid and gid 1000 with mode 0400, because the Nivaro image steps down to uid 1000 before Node starts. `deploy/hub-agent/README.md` has the full variable list, token rotation, shared extension storage and registry auth.'
    },
    { type: 'h2', id: 'hub-docker-driver', text: 'The Docker driver' },
    {
      type: 'p',
      text: 'Apps → Drivers → Add driver → Docker (Hub administrators). The token is stored encrypted and shown as ••••••. Changing the agent address needs the token entered again: saving with the old token kept answers `SECRET_REQUIRED`.'
    },
    {
      type: 'table',
      head: ['Field', 'Meaning'],
      rows: [
        [
          'Agent URL',
          'The origin of the agent: https, no credentials, no path, query or fragment. Plain http only for a loopback, single-label or private address.'
        ],
        [
          'DNS mode',
          '`automatic`: a wildcard DNS name already points at the edge, so every stack name ends with the wildcard domain. `manual`: someone adds each name.'
        ],
        ['Wildcard domain', 'Automatic only, required there. A leading `*.` is dropped.'],
        [
          'Edge target',
          'Manual only, required there: the DNS name or address each new name must point at.'
        ],
        ['Agent token', 'The bearer token from `HUB_AGENT_TOKEN_FILE`.']
      ]
    },
    {
      type: 'p',
      text: 'The driver form shows what the agent reports (`GET /api/hub/drivers/:id/agent`, administrators only): its version, edge mode, allowed images, host suffixes and publish ports. A bad driver config answers 400 `BAD_CONFIG`, an unknown driver 404 `NOT_FOUND`, and a driver that is not a Docker one 409 `NOT_DOCKER`.'
    },
    { type: 'h2', id: 'hub-docker-dns', text: 'DNS modes and waiting for a name' },
    {
      type: 'ul',
      items: [
        'Automatic: every hostname of the stack must end with the wildcard domain (`HOSTNAME_NOT_UNDER_WILDCARD`), so no one has to do anything.',
        'Manual: the stack panel shows Names to request, one DNS name pointing at the edge target and one TLS certificate per hostname. Check name asks again at once (owners while the environment waits, administrators any time; at most one check per environment every 10 seconds, otherwise 429 `TOO_SOON`; a non-waiting environment answers 409 `NOT_WAITING_FOR_NAME` to owners).',
        'A name that has never resolved does not fail the deploy. The stack runs, the deploy ends with a warning, and the environment shows `waiting_for_name` until the name serves; then it becomes active.',
        'A live environment that goes dark is different. If the environment served its name before this deploy and the name no longer answers, the deploy fails with `VERIFY_FAILED`. A live name that answers wrong once, a 502 while the edge refreshes for instance, is verified like any other.'
      ]
    },
    { type: 'h2', id: 'hub-docker-settings', text: 'Stack settings' },
    {
      type: 'p',
      text: 'Each Docker environment has stack settings (administrators only): size, Redis mode, publish port, plain settings and secrets. Settings become environment variables of the app; secrets are stored encrypted and arrive as files at `/run/secrets/<KEY>`. Reads show every secret as ••••••; sending the mask back keeps it, and an empty value clears it.'
    },
    {
      type: 'table',
      head: ['Size', 'What runs'],
      rows: [
        ['`small`', 'One process with every role: 1 replica, 2 CPUs, 3072 MB.'],
        [
          '`medium`',
          '`web` 2 replicas (2 CPUs, 3072 MB) and `worker` 1 replica (2 CPUs, 4096 MB).'
        ],
        [
          '`large`',
          '`web` 3 replicas with sockets off (2 CPUs, 3072 MB), `worker` 1 (2 CPUs, 4096 MB), `realtime` 2 (1 CPU, 1024 MB) and `importer` 1 (2 CPUs, 4096 MB).'
        ]
      ]
    },
    {
      type: 'p',
      text: 'At size large web serves no sockets, so the agent routes every realtime path to the `realtime` role: `/socket.io/`, `/api/graphql-ws`, `/api/graphql/stream`, `/api/events/stream` and `/api/events/views/<id>/stream`, the same paths as `deploy/realtime`. That rule uses `PathRegexp`, so a large stack behind the traefik edge needs Traefik v3.'
    },
    {
      type: 'p',
      text: 'Templates apply from Nivaro 0.3.0 and are the full image only; an older version has no template (`TEMPLATE_NONE`). SQLite can only run at size small (`SQLITE_ONE_PROCESS`). The Hub adds `PUBLIC_URL`, `ADMIN_URL`, `NIVARO_ENVIRONMENT`, `NODE_ENV`, `MIGRATION_SAFE_MODE`, `TRUST_PROXY` (default `1`) and `HUB_URL` itself, and the environment hub token as the secret `HUB_TOKEN`; a setting or secret of the same name is refused (`RESERVED_SETTING`, or `ENV_SECRET_CLASH` when a secret collides with a value the Hub sets).'
    },
    {
      type: 'h3',
      id: 'hub-docker-generated',
      text: 'Generated secrets'
    },
    {
      type: 'p',
      text: '`SESSION_SECRET` and `ENCRYPTION_KEY` are generated on the first save, and so is the environment hub token when it has none. A save never regenerates one that exists. Neither key can be cleared (`SECRET_REQUIRED`), and replacing one needs `rotate: ["<KEY>"]` in the body. Rotating `ENCRYPTION_KEY` makes data encrypted with the old key unreadable.'
    },
    { type: 'h3', id: 'hub-docker-allow', text: 'Which keys a stack may set' },
    {
      type: 'p',
      text: 'Settings and secrets are an allow-list. A stack may set only the config keys Nivaro itself reads, plus keys under the prefixes the operator lists in `HUB_AGENT_ENV_PREFIXES` on the agent. Anything else is refused: the Hub when the settings are saved (400 `SETTING_INVALID`), the agent when a spec is applied (`SPEC_INVALID` with `ENV_NOT_ALLOWED` on the field). A refusal names the key and the field, never the value, and the editor marks that row.'
    },
    {
      type: 'ul',
      items: [
        'A prefix may have several segments (`EFP_OPS_`). It must be upper-case segments ending with `_`; otherwise the agent refuses to start (`ENV_PREFIXES_BAD`).',
        'A prefix that overlaps a refused key is refused (`ENV_PREFIX_DENIED` at agent start, ignored by the Hub). Never choose a prefix that loader or toolkit variables share, such as `GIO_`, `GTK_`, `GST_`, `QT_`, `MESA_` or `LD_`: those make the app, or programs it runs like Chromium and ffmpeg, load code from a path.',
        'Loader and program keys are never allowed: `PATH`, `LD_*`, `NODE_*` (except `NODE_ENV`) and the library loader paths.',
        'Every `<KEY>_FILE` key is refused. A secret arrives as `/run/secrets/<KEY>` instead.',
        '`SAMBA_USER`, `SAMBA_PASS` and `SAMBA_WORKGROUP` must be one line.',
        'The Hub reads the prefixes from the agent (`GET /v1/health`, `env_prefixes`). When it cannot reach the agent, or the agent is too old to report them, no prefix counts and the refusal says so. To let an extension read its own settings, add its prefix and restart the agent.',
        'The list of known keys is generated from the API sources. When the API gains an environment read, regenerate it with `node --import tsx ../scripts/hub-known-env.mts` from `api/`; a guard test fails until you do.'
      ]
    },
    {
      type: 'p',
      text: 'Other settings refusals: `BAD_KEY` (a name that is not A to Z, 0 to 9 and `_`, up to 64, or a `rotate` list naming something else), `BAD_VALUE` (not text, over 4 KB for a setting or 64 KB for a secret, the mask sent as a value, a weak `SESSION_SECRET` or an `ENCRYPTION_KEY` that is not 64 hex characters), `SECRET_IN_SETTINGS` (a key that looks like a credential, or `REDIS_URL` with a user name or password: store it as a secret), `SETTING_INVALID` (a multi-line value where one line is needed), `BAD_SIZE`, `BAD_REDIS`, `BAD_PUBLISH_PORT`, `BAD_DB_CLIENT` (use `mssql`, `pg`, `mysql2`, `mariadb` or `sqlite`) and `BAD_EXTENSION_PIN`.'
    },
    {
      type: 'p',
      text: 'A deploy also needs `DB_CLIENT` set, plus `DB_DATABASE` for SQLite, or `DB_HOST`, `DB_DATABASE`, `DB_USER` and the secret `DB_PASSWORD` for a database server, and the secret `REDIS_URL` when Redis is external. Anything missing blocks the plan as `STACK_SETTINGS_MISSING`.'
    },
    { type: 'h2', id: 'hub-docker-extensions', text: 'Extensions as images' },
    {
      type: 'p',
      text: 'An extension is an OCI image whose compiled extension is in `/extension`. Pin each one by id to `<repo>@sha256:<digest>` in the stack settings (at most 20, ids of lower-case letters, digits and dashes). Extension images share `HUB_AGENT_IMAGES` with the Nivaro image.'
    },
    {
      type: 'ul',
      items: [
        'The agent pulls the image by digest, creates (never starts) a container, reads only `/extension` through the archive endpoint and unpacks it into `<extensions root>/<stack>/<id>@<digest12>`. It refuses links, devices, absolute paths, `..`, anything outside `extension/`, more than 200 MB or too many entries. The services mount the folder read-only at `/app/api/extensions/<id>`.',
        'By default an app that uses extensions is pinned to the node that holds the folder. With shared storage (`HUB_AGENT_EXTENSIONS_SHARED=on`) the pin is dropped.',
        'A promotion installs the pins the environment holds (or, for a promote, the previous environment holds); a rollback reinstalls the pins its target deploy recorded. A missing pin blocks the plan as `EXTENSION_UNPINNED`.',
        'An image that holds no usable `/extension` folder is refused as `EXTENSION_INVALID`; one that cannot be pulled as `IMAGE_PULL_FAILED`.'
      ]
    },
    { type: 'h2', id: 'hub-docker-deploy', text: 'Deploy, verify and rollback' },
    {
      type: 'p',
      text: 'A promotion with a stack component is planned and run like any other (see Hub promotions), with a stack step in place of a merge, pin and job.'
    },
    {
      type: 'ul',
      items: [
        'Plan: the Hub asks the agent what it allows and what runs under the stack name now, reads the settings and renders the spec. Every blocker is listed at once.',
        'Run, start: everything is read again, and the agent limits are checked against the agent as it answers now. A change since the plan is refused before anything is sent.',
        'Apply: the agent creates or updates the stack. From the moment the apply is sent the step waits for swarm and cannot be cancelled.',
        'Converge: the Hub polls the stack every 10 seconds, for at most 30 minutes. Three polls in a row with no answer from the agent end the step with `AGENT_UNREACHABLE`; the update may still finish.',
        'Pins: once the stack converged, the Hub records the version and the extension pins on the environment, and what the stack runs on the deploy row (spec hash, image and extension pins), which a restart and a rollback read.',
        'Verify: `/api/version` of the environment must answer the wanted version twice in a row (up to 40 reads, 15 seconds apart), then the app preflight must not fail.',
        'Rollback redeploys the build the Hub recorded for that version here: the image digest the stack ran and the extension pins it installed. The registry is not read again, so a re-pushed tag, an unreachable registry or a changed `HUB_IMAGE` changes nothing; a recorded deploy without its image is refused as `ROLLBACK_NOT_RECORDED`. Swarm itself rolling a failed update back is reported as a failure (`SWARM_ROLLED_BACK`); the panel then offers Roll back, which works even though swarm already runs the older spec.',
        'Restart redeploys the same spec the stack runs (never one rebuilt from an inspect). It is refused when the Hub cannot tell which spec that is, and the panel offers it only while the agent reports the stack.',
        'Apply now: saved settings, secrets, size and extension pins reach a running stack only on its next deploy. Apply now (stack panel, owners and admins, typed environment key) deploys them now: the version the stack runs, with the image its newest recorded deploy converged to (also when that deploy then failed verify or preflight; refused with `STACK_STATE_UNKNOWN` when that deploy ran another version) and the saved settings and pins, run and checked like a promotion and listed in the promotion history as Apply settings. The confirm box names the saved size and the extension pins that change. A restart answers `SPEC_MISMATCH` and a promote of the running version `ALREADY_RUNS` while the saved settings differ from what runs; both point to Apply now.',
        'No orphaned stacks: while a stack runs for an environment (the Hub recorded it converged and it was not removed since, or a deploy of it is recorded and the agent reports it — an agent that cannot answer counts as running), the edits that would lose it are refused with 409 `STACK_RUNNING` and the `field`: the app key, the environment key, moving the environment to another placement, the placement’s stack name or driver, and `version_pin` (the Hub owns it while the stack runs). Remove the stack first. Deleting the environment is refused with `STACK_STILL_RUNNING` even when the stack’s labels no longer match, as long as the Hub’s record names it.'
      ]
    },
    {
      type: 'p',
      text: 'When the Hub restarts or loses a run while a docker step ran, healing never stops, deletes or re-applies anything on the Docker host. It only reads the stack from the agent, so the interrupted deploy row can say where swarm stands; the next plan reads the live stack anyway. While the agent is down, that read can add up to 10 seconds to a plan read.'
    },
    { type: 'h2', id: 'hub-docker-blockers', text: 'Why a stack promotion cannot start' },
    {
      type: 'p',
      text: 'These blockers come on top of the ones listed under Hub promotions. The plan shows all of them; fix them and plan again.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`KIND_DRIVER_MISMATCH`',
          'A stack component is on a GitLab driver, or an API or frontend component is on a Docker one.'
        ],
        ['`NO_STACK_NAME`', 'The placement names no swarm stack. Set its stack name.'],
        ['`AGENT_UNREACHABLE`', 'The Hub agent does not answer, or was not asked.'],
        [
          '`AGENT_REFUSED`',
          'The agent refused the Hub: check the token saved in the driver. Also shown when it answered with a redirect.'
        ],
        [
          '`AGENT_INCOMPATIBLE`',
          'The agent speaks another agent API than this Hub. Upgrade the agent or the Hub.'
        ],
        [
          '`IMAGE_NOT_ALLOWED`',
          'The agent does not allow the Nivaro image: add its repository to `HUB_AGENT_IMAGES`.'
        ],
        [
          '`EXTENSION_NOT_ALLOWED`',
          'The agent does not allow the image of an extension: add it to `HUB_AGENT_IMAGES`.'
        ],
        [
          '`EXTENSION_UNPINNED`',
          'An extension has no pin to install (for a promote, none on the previous environment; for a rollback, none recorded for that deploy), or the pins cannot be read.'
        ],
        [
          '`STACK_SETTINGS_MISSING`',
          'The environment has no stack settings yet, or lacks a required one (database keys, an external `REDIS_URL`).'
        ],
        [
          '`STACK_SETTINGS_INVALID`',
          'The settings cannot be rendered into a valid spec: a hostname the agent cannot route, too many hostnames (more than 10), no `publish_port` on the publish edge, or a secret that clashes with an env value.'
        ],
        [
          '`HOSTNAME_NOT_ALLOWED`',
          'A name is not a usable DNS name, is outside the wildcard domain (automatic DNS) or the agent host suffixes (Traefik), or there are too many names.'
        ],
        [
          '`HOSTNAME_TAKEN`',
          'Another Hub environment, or another stack on the swarm, already routes the name.'
        ],
        [
          '`PUBLISH_PORT_NOT_ALLOWED`',
          'The publish port is missing or outside `HUB_AGENT_PUBLISH_PORTS`.'
        ],
        [
          '`TEMPLATE_NONE`',
          'No stack template for this Nivaro version: Docker stacks need 0.3.0 or later.'
        ],
        [
          '`STACK_NOT_HUB`',
          'The swarm already runs a stack with this name that the Hub did not create, or one that belongs to another Hub app or environment. The agent never changes it.'
        ]
      ]
    },
    { type: 'h2', id: 'hub-docker-run', text: 'Why a deploy step fails' },
    {
      type: 'p',
      text: 'The run step refuses before it sends anything, or ends the step, with one of these. The deploy row shows the code and the sentence.'
    },
    {
      type: 'table',
      head: ['Code', 'Meaning'],
      rows: [
        [
          '`PLAN_STACK_INVALID`',
          'The plan does not name a usable stack, image or extension set. Plan again.'
        ],
        [
          '`STACK_CHANGED`',
          'The placement no longer deploys this stack name through this driver. Plan again.'
        ],
        [
          '`AGENT_CHANGED`',
          'The driver now points at another agent than the plan saw. Plan again.'
        ],
        [
          '`NO_DRIVER`, `NOT_FOUND`',
          'The driver, environment or app no longer exists, or the driver has no usable agent address.'
        ],
        [
          '`IMAGE_NOT_ALLOWED`, `EXTENSION_NOT_ALLOWED`, `HOSTNAME_NOT_ALLOWED`, `HOSTNAME_TAKEN`, `PUBLISH_PORT_NOT_ALLOWED`',
          'The agent limits no longer allow the stack, as the agent answers now. The text names each reason.'
        ],
        ['`STACK_SETTINGS_MISSING`', 'A required setting disappeared since the plan.'],
        [
          '`NO_HUB_TOKEN`',
          'The environment has no hub token. Save its stack settings once to make one.'
        ],
        ['`AGENT_INCOMPATIBLE`', 'The agent answered the apply without a spec hash.'],
        [
          '`AGENT_UNREACHABLE`',
          'The agent stopped answering during the update (3 misses in a row).'
        ],
        [
          '`SWARM_ROLLED_BACK`',
          'Swarm rolled the stack back to its previous spec: the new tasks did not become healthy.'
        ],
        [
          '`SWARM_UPDATE_PAUSED`',
          'Swarm paused the update because a new task failed. Roll back, or fix it and deploy again.'
        ],
        ['`STACK_DEPLOY_TIMEOUT`', 'The stack did not converge within 30 minutes.'],
        [
          '`PIN_NOT_RECORDED`',
          'The stack converged on the version, but the Hub could not record the version and extension pins.'
        ],
        [
          '`VERIFY_FAILED`',
          'The environment never answered the wanted version twice, or a name that served before this deploy has not answered since.'
        ],
        [
          '`PREFLIGHT_FAILED`',
          'The version is right, but the app preflight fails. The failing checks are named.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Agent refusals passed through as they are: `HOSTNAME_TAKEN` (another stack routes the name), `SPEC_INVALID` (with the refused fields, each as `field (code)`: `UNKNOWN_FIELD`, `REQUIRED`, `BAD_KEY`, `IMAGE_NOT_ALLOWED`, `IMAGE_NOT_PINNED`, `ENV_FORBIDDEN`, `ENV_NOT_ALLOWED`, `ROLE_BAD`, `REPLICAS_BAD`, `LIMIT_BAD`, `HOSTNAME_NOT_ALLOWED`, `TOO_MANY`, `TOO_LONG`, `PORT_NOT_ALLOWED`, `REDIS_NOT_CONFIGURED`, `EXTENSION_ID_BAD`, `SETTING_INVALID`), `SPEC_MISMATCH` (a restart: the stack does not run the spec sent), `STACK_NAME_INVALID`, `STACK_NOT_FOUND`, `STACK_NOT_HUB`, `STACK_OWNER_MISMATCH`, `EXPECT_INVALID`, `ENGINE_FORBIDDEN` (the agent guard refused an Engine call it built, so nothing reached Docker), `ENGINE_ERROR` (Docker refused a call), `REDIS_NOT_CONFIGURED`, `EXTENSION_INVALID` and `IMAGE_PULL_FAILED`. The Hub turns each into one plain sentence and never shows the agent body text.'
    },
    {
      type: 'warn',
      text: 'A swarm of more than one node and the default `local` volume driver: `local` volumes are per node, so each node a web, worker or importer task lands on keeps its own uploads, and a Redis task that moves to another node starts empty. Remove stack with its volumes deletes only the agent node’s copies. Pin the stack to one node (a placement constraint on the swarm) or set a shared volume driver (`HUB_AGENT_VOLUME_DRIVER`, `HUB_AGENT_VOLUME_OPTS_FILE`, for example an NFS export). The agent check shows the node count and the volume driver, and the stack panel warns when the swarm has more than one node and the volumes are local. Shared volumes managed by the Hub come in a later phase.'
    },
    {
      type: 'note',
      text: 'Images published before the hub link (Nivaro 0.3.208 and older) do not answer the Hub’s status read, so the Hub cannot tell which version such a stack runs: the panel shows no Roll back button, and Promote may also list versions older than the one running. Roll back still works when asked for directly. A stack shows the full Hub controls once it runs a release with the hub link.'
    },
    {
      type: 'p',
      text: 'Manual DNS: the stack panel lists the DNS names and TLS certificates to ask for. An address that is an IP (for example `http://127.0.0.1:18081` on a publish edge) needs neither, and the panel says so. After a run the Hub was stopped during, the panel shows the stack converged once every service runs all its replicas with no update in progress, even though the Hub did not record that spec.'
    },
    { type: 'h2', id: 'hub-docker-remove', text: 'Removing a stack and its volumes' },
    {
      type: 'ul',
      items: [
        'Administrators only. The body is `{ confirm: "<stack name>" }`; the Hub refuses with 400 `CONFIRM_REQUIRED` otherwise.',
        'Remove checks stack ownership first. The agent reads the labels, and a stack that names another app or environment is never removed (409 `STACK_OWNER_MISMATCH`).',
        'Removing the services is not always the end. When the agent finds no service left (status 404), remove still goes to the agent, which clears the leftovers it owns: secrets, the network, volumes and the extensions folder.',
        'Volumes stay unless asked for. `remove_volumes: true` also needs `confirm_volumes: "delete <stack name> data"` (400 `CONFIRM_REQUIRED`): both confirms, because the uploads and Redis data go.',
        'A remove with nothing to remove answers `{ removed: false, already_absent: true }`. After a remove the environment is `suspended` and the removal is logged.',
        'It runs under the environment promotion lock, so no promotion starts during it; a running promotion answers 409 `PROMOTION_RUNNING`.',
        'An environment cannot be deleted while its stack exists (409 `STACK_STILL_RUNNING`), or while leftovers remain on the swarm (409 `STACK_LEFTOVERS`: volumes, secrets or the network). Remove the stack first. When the agent cannot say, deleting is refused with `AGENT_UNREACHABLE`; a stack the Hub did not create, or one that belongs to another environment, never blocks the delete.'
      ]
    },
    { type: 'h2', id: 'hub-docker-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Who', 'Purpose'],
      rows: [
        [
          '`GET /api/hub/drivers/:id/agent`',
          'Admin',
          'What the agent reports: version, edge, images, suffixes, ports, prefixes.'
        ],
        [
          '`GET /api/hub/environments/:envId/stack`',
          'Owner, admin',
          'The stack name, DNS mode, names to request (manual) and the stack status: Converged, Updating, Rolled back, Paused or Degraded. `agent` says `ok`, `NO_STACK_NAME`, `STACK_OWNER_MISMATCH` or an agent code.'
        ],
        [
          '`GET`, `PUT /api/hub/environments/:envId/stack/settings`',
          'Admin',
          'Read and save the stack settings. A refusal answers 400 with `code` and, for a setting, `field`.'
        ],
        [
          '`POST /api/hub/environments/:envId/stack/restart`',
          'Owner, admin',
          'Body `{ confirm }`, the environment key. 202 with the services; 400 `CONFIRM_REQUIRED`, 409 `NO_STACK_NAME`, `NOT_DEPLOYED`, `STACK_STATE_UNKNOWN`, `PROMOTION_RUNNING`.'
        ],
        [
          '`POST /api/hub/environments/:envId/stack/apply`',
          'Owner, admin',
          'Apply now. Body `{ confirm }`, the environment key. 202 `{ deploy_id, job_run_id }`: a deploy run of the running version with the recorded image and the saved settings and pins. 400 `CONFIRM_REQUIRED`, 409 `NOT_DEPLOYED`, `PROMOTION_RUNNING` or any stack plan blocker (with `blockers`).'
        ],
        [
          '`POST /api/hub/environments/:envId/stack/remove`',
          'Admin',
          'Remove the stack, and with the two confirms its volumes.'
        ],
        [
          '`POST /api/hub/environments/:envId/stack/check-name`',
          'Owner (while waiting), admin',
          'Check now whether the name serves. Answers `{ state, status }`.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Common answers: 403 `ADMIN_ONLY`, 404 `NOT_FOUND`, 409 `NOT_DOCKER` (the environment is not deployed through a Docker driver). The agent not answering is 502, a refusal by the agent 409.'
    }
  ]
}
