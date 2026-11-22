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
        'The target branch keeps the newer pin. The next promotion, or the next deploy from the branch, moves the environment forward again.',
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
