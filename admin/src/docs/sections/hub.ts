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
      text: 'The Hub is built in phases. It adopts apps that already run and shows their status and deploy history, promotes and rolls back builds of GitLab-driven apps, and signs people in to apps that choose sign-in via the Hub (with direct Microsoft sign-in as the fallback and an app switcher). It cannot yet create databases or new apps, run apps through the Hub agent, or place an app on a shared deployment. Those arrive in later phases.'
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
          "The Hub's origin, for sign-in through the Hub and the app switcher (see Sign-in via the Hub)."
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
      text: "An environment is deployed in one or more components, run in order. Each component has its own GitLab driver, source branch, target branch, deploy job and a check address. The API component is the Nivaro image; the frontend component is the portal in front of it. Each component is merged, then deployed, then checked before the next one starts. The API always comes before the portal, and the portal is deployed only after the API's deploy passed."
    },
    {
      type: 'ul',
      items: [
        'API component: the Hub merges the newest deploy commit on the source branch whose subject ends with `nivaro <version>` into the target branch, then adds one commit that pins the version. The pin is three lines: the version, the image digest and, when both are real, the slim image digest. It is refused when the image or its digest is not on the registry.',
        "Frontend component: the Hub merges the commit that the environment before this one is serving. That commit must already be on the component's source branch.",
        'A Hub administrator adds components to an environment under its settings. An environment with none stored uses its placement driver as a single API component.'
      ]
    },
    { type: 'h2', id: 'hub-promotions-run', text: 'Promoting' },
    {
      type: 'p',
      text: "Open the environment, choose Promote, and pick a version. The Hub lists versions the previous environment runs or ran, newer than the one here. It shows the plan in plain words and any reason it cannot start. To start, type the environment's key to confirm."
    },
    {
      type: 'ul',
      items: [
        'Hub administrators and the owners of the app may promote and roll back. Anyone else gets nothing, as if the environment did not exist.',
        "Verify: after each deploy the Hub reads each component's check address. It must answer the planned version (API) or commit (frontend) twice in a row. The Hub asks every 15 seconds, at most 40 times, then the step fails.",
        'Only one promotion runs per environment at a time.',
        'Cancel stops the run at the next step boundary. It never stops between a merge and its pin commit, so a branch is never left merged but unpinned.',
        'If the Hub restarts in the middle of a run, the run is marked Interrupted and the temporary branches it made are deleted. Nothing already deployed is undone: check the environment, then start again.'
      ]
    },
    { type: 'h2', id: 'hub-promotions-rollback', text: 'Rolling back' },
    {
      type: 'p',
      text: 'Roll back goes only to a version this environment previously deployed successfully. It is confirmed the same way as a promotion.'
    },
    {
      type: 'ul',
      items: [
        'API: the Hub pins the older image again and deploys it.',
        "Frontend: the Hub reruns that older commit's own deploy job in GitLab. If GitLab no longer has a build for that commit, the rollback stops with `FRONTEND_ROLLBACK_NO_BUILD` and changes nothing."
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
          'The environment before this one never ran the version, now or in a successful deploy. Promote it there first.'
        ],
        ['`ALREADY_RUNS`', 'This environment already runs that version.'],
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
          'The Hub cannot tell which frontend commit the environment before this one serves. Its check address must answer with a commit.'
        ],
        [
          '`FRONTEND_NOT_ON_SOURCE`',
          "The frontend commit the previous environment serves is not on the component's source branch. Merge it there first."
        ],
        [
          '`IMAGE_MISSING`',
          'The image for that version is not published on the registry the Hub reads.'
        ],
        [
          '`IMAGE_NO_DIGEST`',
          'The registry has the image but gave no digest, which the pin needs.'
        ],
        ['`NO_COMPONENTS`', 'The environment has nothing to deploy. Add a driver or components.'],
        ['`NO_DRIVER`', 'A component has no GitLab driver. Pick one for it.'],
        ['`BAD_VERSION`', 'The version is not in the form 0.3.210.']
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
          'Versions that can be promoted here, and older ones that can be rolled back to.'
        ],
        [
          '`POST /api/hub/environments/:envId/promote/plan`',
          'Body `{ version, kind }`, kind `promote` or `rollback`. Read-only: the plan with its steps and every blocker.'
        ],
        [
          '`POST /api/hub/environments/:envId/promote`',
          'Body `{ version, kind, confirm }`; `confirm` is the environment key. Answers 202 with the run id, or 409 with the blockers.'
        ],
        [
          '`GET /api/hub/environments/:envId/deploys/hub`',
          "The Hub's own promotions here, newest first."
        ],
        ['`GET /api/hub/promotions/:id`', 'One run with its plan and log.'],
        [
          '`POST /api/hub/promotions/:id/cancel`',
          'Cancel a running promotion at the next step boundary.'
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
        '1. Add components for EFP production: an API component on the deploy repository and a portal frontend component. Check their jobs: the deploy job names must match the ones the laptop script runs, and each check address must answer its version or commit.',
        '2. Run a plan-only promote for the version staging runs (Promote, then read the plan, and do not confirm). Compare each step with the output of `promote-production.mjs --dry-run`: same commits, same pin, same jobs. Stop and fix anything that differs.',
        '3. Switch `hub_managed` on for production.',
        '4. Set `production.enabled: false` in `release-chain.config.json`, so the laptop release chain stops promoting production.',
        '5. Make the first real promotion, and watch it from start to Succeeded: the merge, the pin, the deploy and both checks.',
        '6. If it goes wrong, use Roll back to the previous version. If the Hub itself is unusable, set `production.enabled` back to true and use the laptop script.'
      ]
    },
    {
      type: 'note',
      text: 'The laptop script stays as the fallback until two Hub promotions to production have succeeded. Do not delete it before then.'
    }
  ]
}

export const hubSigninDocs: DocSection = {
  id: 'hub-signin',
  label: 'Sign-in via the Hub',
  content: [
    { type: 'h1', id: 'hub-signin', text: 'Sign-in via the Hub' },
    {
      type: 'p',
      text: 'The Hub is an OpenID Connect provider for the apps it manages. An app set to sign in through the Hub sends people to the Hub, the Hub sends them to Microsoft Entra once, and every other app they open that day signs them in without another Microsoft round trip. Each app still has its own users, roles and session: the Hub only proves who the person is. If the Hub is down, misconfigured or refuses, the app falls back to its own direct Microsoft sign-in.'
    },
    {
      type: 'note',
      text: 'Sign-in through the Hub is off for every app until you turn it on, app by app. Hub mode is refused in cloud mode, so none of this exists there: the routes are not mounted, `HUB_URL` is ignored and the app signs in directly as before.'
    },
    { type: 'h2', id: 'hub-signin-modes', text: 'Modes' },
    {
      type: 'table',
      head: ['Mode', 'What happens'],
      rows: [
        [
          'Direct (default)',
          'The app signs people in with its own Microsoft configuration, exactly as before. The Hub still records sign-ins the app reports for the switcher (when the app has `HUB_URL` and `HUB_TOKEN`).'
        ],
        [
          'Hub',
          "The app sends people to the Hub. This needs the app set to Hub on the Hub's Sign-in tab, an active client for that environment, an environment that is not archived or suspended, all five environment lines on the app, and a Hub that answers. Miss any of them and the app signs in directly, with no error."
        ]
      ]
    },
    { type: 'h2', id: 'hub-signin-flow', text: 'How a sign-in works' },
    {
      type: 'ul',
      items: [
        '1. The person opens the app and chooses Continue with Microsoft. The app checks that the Hub answers (a 1.5 second probe, remembered 15 seconds when up and 30 seconds when down) and redirects to `<Hub>/api/hub/oidc/authorize` with PKCE (S256), `state` and `nonce`.',
        "2. The Hub reads its own browser session only. With none, it sends the person through its normal Microsoft sign-in and back. With one, it issues a single-use code that lasts 60 seconds and is bound to the app's client, redirect address, PKCE challenge and nonce.",
        '3. The app exchanges the code at the Hub token endpoint with its client secret. The Hub answers an ES256 ID token that lives 5 minutes.',
        "4. The ID token carries the person's own Microsoft ID token as evidence (`idp_id_token`). The app checks the Hub token (Hub keys, exact issuer, audience, nonce) and then checks the evidence against the app's own Microsoft configuration: its keys, its exact tenant issuer, audience `HUB_IDP_AUDIENCE`, not expired, and the same object id and tenant as the Hub token. Name, email and groups come from the evidence only. A Hub signing key alone signs nobody in.",
        '5. The app links the account (see Linking), then runs every check it runs for a direct sign-in: suspended accounts, a role that may not sign in, two-factor codes.'
      ]
    },
    {
      type: 'p',
      text: "The Hub never sends roles. Roles stay inside each app. Group names reach the app only inside the Microsoft evidence, so the Hub's Microsoft app registration must emit the groups claim wherever the app maps groups to roles. A Hub account that is still waiting for access (First Access, Needs Authorization) is refused for apps: it can use the Hub's request-access screen only."
    },
    {
      type: 'p',
      text: 'The evidence has to have at least 2 minutes of life left when the Hub hands it on. An older Hub session sends the person through Microsoft again (usually silent) first. If Microsoft issues tokens that live under 2 minutes, or a Hub session that signed in within the last minute has no usable Microsoft evidence at all (for example a primary sign-in that is not Microsoft, or a token without object id and tenant id), the Hub answers the app `temporarily_unavailable` instead of sending the person through sign-in again: the app signs that person in directly once, and there is no redirect loop.'
    },
    { type: 'h2', id: 'hub-signin-setup', text: 'Setting it up' },
    {
      type: 'p',
      text: "On the Hub, open Apps, then Sign-in (a Hub administrator, or the owner of the app). The page shows the Hub's issuer address and the value to use as `HUB_IDP_AUDIENCE`. For each app:"
    },
    {
      type: 'ul',
      items: [
        '1. Create a client for each environment that should sign in through the Hub. The client id (`hubc_…`) and the secret (`hubs_…`) are shown once; the secret is never readable again, only rotated. The redirect addresses are worked out from the environment address and hostnames (`<origin>/api/auth/callback` and `<origin>/login`), so an owner can never point codes somewhere else.',
        '2. Put the environment lines (below) on that app and restart it.',
        '3. Set the app to Hub. Until the app answers the Hub probe and the lines are complete, it keeps signing in directly.',
        "4. Rotating a secret takes effect at once: the app's probe fails client authentication until its `HUB_CLIENT_SECRET` is updated, and people sign in directly meanwhile. A client can be turned off without deleting it.",
        '5. Deleting an environment (Apps) deletes its client, with the sealed secret, and its app-switcher rows in the same step.'
      ]
    },
    {
      type: 'p',
      text: 'The Hub itself needs `ENCRYPTION_KEY` (client secrets and signing keys are sealed with it) and a tenant-specific `OIDC_ISSUER` for its own Microsoft sign-in. Without a tenant-specific issuer the Hub captures no evidence and no app can sign in through it; it logs one warning and its probe answers `NO_TENANT_ISSUER`, so apps sign in directly.'
    },
    { type: 'h2', id: 'hub-signin-env', text: 'What an app needs' },
    {
      type: 'table',
      head: ['Variable', 'Meaning'],
      rows: [
        [
          '`HUB_URL`',
          "The Hub's origin. https only; plain http only for a loopback host outside production."
        ],
        [
          '`HUB_CLIENT_ID`',
          "This environment's client at the Hub (`hubc_…`). Shown on the Sign-in tab."
        ],
        [
          '`HUB_CLIENT_SECRET`',
          'Its secret, at least 32 characters. `HUB_CLIENT_SECRET_FILE` works. Shown once when the client is created or rotated.'
        ],
        [
          '`HUB_IDP_AUDIENCE`',
          "The Hub's own Microsoft client id: the audience of the evidence. Shown on the Sign-in tab."
        ],
        [
          '`HUB_TOKEN`',
          'The environment hub token, at least 32 characters (the same one the Hub uses to read this app). Not needed to sign in, but needed for the app switcher and for the app to report its direct sign-ins to the Hub.'
        ],
        [
          '`HUB_SIGNIN=off`',
          'Turns Hub sign-in off on this app only, whatever the Hub says. People sign in directly. Nothing changes on the Hub.'
        ]
      ]
    },
    {
      type: 'p',
      text: "Hub sign-in also uses the app's own `OIDC_ISSUER` and `OIDC_CLIENT_ID`: the evidence is checked against them. With any piece missing or unusable, the app does not use the Hub, and the readiness check Sign-in through the Hub (group Sign-in) names what to fix. It warns and never fails, because people can always sign in directly."
    },
    { type: 'h2', id: 'hub-signin-fallback', text: 'Fallback and the direct link' },
    {
      type: 'p',
      text: 'When the Hub cannot be reached, answers a server error or Microsoft cannot be reached, the app sends that person once, automatically, to direct sign-in. If the second attempt in the same session also fails that way, the sign-in page stops with `hub_unavailable` and offers a button. A second failure never loops. Only a failure this server saw itself (the Hub not answering) marks the Hub down for everyone on the app, for 60 seconds.'
    },
    {
      type: 'p',
      text: "The probe answers ok only when the Hub can finish a sign-in: the client authenticates and is usable (`CLIENT_AUTH_FAILED`, `CLIENT_INACTIVE`), the Hub's database and Redis answer (`DATABASE_UNAVAILABLE`, `REDIS_UNAVAILABLE`), `ENCRYPTION_KEY` works (`NO_ENCRYPTION_KEY`), the Hub's own Microsoft sign-in can capture evidence (`NO_TENANT_ISSUER`, `PRIMARY_SIGNIN_OFF`) and the origin the person is on is registered for the environment (`REDIRECT_NOT_REGISTERED`, see Deployment notes). Otherwise the app signs people in directly and logs the reason once each time it changes."
    },
    {
      type: 'p',
      text: 'The break-glass link is `/api/auth/login?direct=1` on the app (the sign-in page shows it as Trouble signing in? Sign in directly with Microsoft, and as a button after a Hub error). It never asks the Hub. Nothing on the sign-in page starts a sign-in by itself, so a Hub that is down cannot cause a redirect loop.'
    },
    { type: 'h3', id: 'hub-signin-errors', text: 'Sign-in page errors' },
    {
      type: 'table',
      head: ['`?error=`', 'Meaning and what to do'],
      rows: [
        [
          '`hub_unavailable`',
          'The Hub did not answer (or answered a server error) twice in one attempt. Use the direct link; check the Hub.'
        ],
        [
          '`hub_auth_failed`',
          'The Hub answered but its token or evidence did not check out, or the Hub refused the exchange (bad secret, expired code, mismatched evidence). One issue is filed with a code and no token text: low severity when the callback does not belong to this sign-in (a `state` or `nonce` from another attempt, a code the Hub does not know, which anyone can produce), high otherwise. Sign in directly and tell the administrator; check the client secret, `HUB_IDP_AUDIENCE` and the issuers.'
        ],
        [
          '`hub_access_denied`',
          "The Hub refused this account: suspended, redacted, or still waiting for access at the Hub. Nothing is filed. The person can sign in directly; the app's own account rules still apply."
        ],
        [
          '`hub_account_conflict`',
          'The Microsoft identity matches an account here that names a different tenant, or its Hub subject belongs to another account. Never forwarded to direct sign-in. An issue is filed; an administrator must check the account.'
        ],
        [
          '`account_link`',
          'The identity matches an account that is linked to a different sign-in. From the Hub path it appears only after the one automatic hop to direct sign-in did not resolve it. An administrator must check the account.'
        ],
        [
          '`provider_unavailable`, `oidc_disabled`, `suspended`, `sign_in_disabled`, `session_expired`, `auth_failed`',
          'The ordinary sign-in errors, unchanged: they come from the app itself, on the Hub path as on the direct one.'
        ]
      ]
    },
    {
      type: 'p',
      text: "A Hub error page (a page on the Hub, not on the app) appears when the app is not registered, the return address is not the registered one, or the request cannot be read. It never redirects anywhere. Its title says Cannot sign in or Cannot sign out, and when the app is registered it links Back to the app's own sign-in page (a registered address, never one taken from the request). Errors returned to the app follow OpenID rules: `access_denied`, `login_required` (`prompt=none` with no Hub session), `unauthorized_client` (the app is not in Hub mode right now), `server_error`. The token endpoint answers `invalid_client` (401, wrong secret), `invalid_grant` (a code used twice, expired, or bound to something else) and a bare `server_error`, with fixed wording."
    },
    { type: 'h2', id: 'hub-signin-linking', text: 'Linking accounts' },
    {
      type: 'p',
      text: "An app links a Hub sign-in to an existing account only by the Microsoft object id and tenant id (`entra_oid`, `entra_tid`), never by email. Someone whose object id was never captured (a person who has not signed in since that was recorded) is sent once, automatically, to direct sign-in. That sign-in applies the app's own linking rules and stores the object id, and from then on the Hub path links by it. If nobody holds the object id and no account has the email, a new account is created as on any first sign-in."
    },
    { type: 'h2', id: 'hub-signin-switcher', text: 'The app switcher' },
    {
      type: 'p',
      text: "The switcher lists the other apps a person uses in the same environment (production lists production), each with a link to that app's own sign-in. An app asks for it at `GET /api/hub-switcher`, which asks the Hub. The feature is `hub_switcher` in `GET /api/app-info`; the route is a 404 unless the app has `HUB_URL` and `HUB_TOKEN`."
    },
    {
      type: 'ul',
      items: [
        'The button shows only when the list has another app to open: a list holding just the current app (You are here) shows nothing.',
        'It answers only for people the Hub itself recorded: someone who signed in to that environment through the Hub. Sign-ins an app reports (direct sign-ins) never prove anyone. A direct-mode app shows an empty switcher until the person has signed in through the Hub once.',
        'Apps send the object id and tenant id of the account whenever they have them, plus the email. An email alone proves less: an email key counts only when exactly one Hub account holds it and no other Hub account was recorded with it, otherwise the switcher is empty.',
        'Only a person on their own browser session gets a list. View-as, API keys, connected apps, phone tokens and static tokens get an empty list and the Hub is never asked. The answer is cached for 5 minutes. When the Hub does not answer the list is empty with `unavailable: true`, and the app does not call again for 30 seconds.',
        'Each app reports a direct sign-in to the Hub at most once per person per 6 hours (a report that did not land is retried at a later sign-in, after 10 minutes). Rows the Hub has not seen for 180 days are deleted by the daily `hub-signins-prune` job (04:10, Hub only).'
      ]
    },
    {
      type: 'p',
      text: 'The Sign-in tab and each client panel count Sign-ins, last 30 days as people, each person once per app or environment (the Hub account, else the email, else the identity key). The exception: a row that has only a Microsoft object id and no email cannot be merged with anything, so such a person can count more than once.'
    },
    { type: 'h2', id: 'hub-signin-signout', text: 'Signing out' },
    {
      type: 'p',
      text: "Signing out of an app ends that app's session. When the session was signed in through the Hub, the app also returns a link to the Hub's end-session address carrying a `logout_hint` (a hash of the Hub session id). With the matching hint the Hub ends its own session at once and sends the person back to the app's sign-in page. Without it, the Hub asks Sign out of the Hub too? with a confirm button. Ending the Hub session does not end sessions in other apps; those stay until their own sign-out or time limit. The next sign-in to an app goes through Microsoft again."
    },
    { type: 'h2', id: 'hub-signin-keys', text: 'Signing keys' },
    {
      type: 'p',
      text: 'The Hub signs ID tokens with ES256 keys. The private half is sealed in the database. The public keys are at `<Hub>/api/hub/oidc/jwks`. A Hub administrator rotates the key and removes a key on the Sign-in tab (Rotate and Remove, two presses each). The key list shows each key as Signing, Published, signs from <time> (a new key), Published, not signing (an older key still published), Retiring (published until <time>) or Retired (no longer published).'
    },
    {
      type: 'ul',
      items: [
        'Rotate publishes a new key at once but does not sign with it yet. The current key keeps signing until the new key has been published for 6 minutes (apps cache the Hub key set for 5 minutes, plus a margin), so every app already knows the new key when the first token signed with it arrives. The answer and the key list say when the new key starts signing.',
        "The hand-over needs no job: on every sign-in each Hub replica reads the key table and picks the newest key published at least 6 minutes ago, judged by the database clock (never a replica's own clock). A rotation twice in a row hands over in order. The very first key, made when none exists, signs at once. Rotations and removals made at the same moment wait for each other, so they never leave the Hub without a key or let a key sign early.",
        'The key it replaces stays published for 24 hours after the new key starts signing (not after the rotation), so a token signed just before the hand-over still verifies.',
        'Remove takes a key out of the key set and out of signing at once, for a compromised key. Every Hub replica stops signing with it on its next sign-in, and apps stop trusting the key within 5 minutes (their key-set cache).',
        'The only key that can sign cannot be removed (409 `ONLY_SIGNING_KEY`): rotate first; retired keys never sign again. When the signing key is removed while a new key is waiting, the new key signs at once and the answer warns that apps which fetched the key set before it was published may refuse a sign-in briefly (`hub_auth_failed`): apps look up an unknown key again at most every 30 seconds, so trying again then works, and direct sign-in always works. To replace a compromised key, rotate, then remove the old key.',
        "A stolen Hub key alone still cannot sign anyone in, because every sign-in also needs the person's Microsoft evidence."
      ]
    },
    { type: 'h2', id: 'hub-signin-deploy', text: 'Deployment notes' },
    {
      type: 'ul',
      items: [
        '`PUBLIC_URL` must equal `ADMIN_URL` on an app. The callback and sign-out addresses the Hub allows are `<environment origin>/api/auth/callback` and `<origin>/login`, and the app builds them from the address the person came from.',
        "Register every origin people sign in on as a hostname of the environment on the Hub (the environment address counts already): for example an admin host beside a portal host, or an alias name. The app's probe names the addresses of the origin in use; an origin the Hub does not know answers `REDIRECT_NOT_REGISTERED`, people on it sign in directly, and the app logs it once. The app's readiness check Sign-in through the Hub probes `ADMIN_URL` and `PUBLIC_URL` and names an origin the Hub does not know. Signing out on such an origin still ends the Hub session, without a return address (the Hub shows Signed out).",
        '`OIDC_ISSUER` must be tenant-specific on the Hub and on every Hub-signed-in app (`https://login.microsoftonline.com/<tenant>/v2.0`, never `common`, `organizations` or `consumers`): the evidence is matched to the exact tenant issuer. Supported Microsoft hosts: `login.microsoftonline.com`, `sts.windows.net`, `login.microsoftonline.us`, `login.chinacloudapi.cn`, `login.partner.microsoftonline.cn`, `login.microsoftonline.de`. The minimum for an app is all five lines above plus a tenant-specific https `OIDC_ISSUER` on one of those hosts and an `OIDC_CLIENT_ID`.',
        'An Entra v1 issuer (`sts.windows.net`) works only when the Hub and the app are on the same token version, because the issuer inside the evidence differs between v1 and v2.0. The readiness check warns about v1. Prefer v2.0 on both.',
        'The Hub supports `prompt=none` only. `prompt=login`, `max_age` and similar are ignored: a person who already has a Hub session is not asked to sign in again.',
        "Many people behind one address (an office NAT, a proxy): set `TRUST_PROXY` so the Hub sees real addresses. The token endpoint and the probe block an address for a minute after 20 failed client authentications (429, `Retry-After: 60`) and the app link does the same after 20 wrong hub tokens a minute, per Hub process. The calls an app's server makes with its credentials (token exchange, probe, app link) count against `RATE_LIMIT_ANON_PER_MINUTE` only when the credentials fail: apps behind one egress address never use up that budget by signing people in, and a guessed secret is refused (429) once the address is over it. The discovery document and the key set are never counted. When the Hub's token endpoint answers 429 or 503, or does not answer within 5 seconds, the app treats the Hub as unavailable: the person goes to direct sign-in once and nothing is filed. People's own sign-ins use their session cookie, which the general limiter never refuses; only the first request of a sign-in, made without a session, counts against `RATE_LIMIT_ANON_PER_MINUTE` (300 a minute per address by default behind a proxy). Raise it on the Hub when a large site signs in together. The app link also caps each environment at 1200 calls and 120 reports a minute, and 5000 new people a day.",
        'Sign-in through the Hub keeps working while the Hub shows its maintenance page: the maintenance write freeze exempts `/api/hub/oidc/*` (the token request is a sign-in, not a data write) and the two app-link report routes.',
        'The Hub answers only on its configured `PUBLIC_URL` origin, never on the Host header.'
      ]
    },
    { type: 'h2', id: 'hub-signin-who', text: 'Who can do what' },
    {
      type: 'ul',
      items: [
        "Hub administrators see every app, rotate and remove signing keys and see the key list, and manage any app's mode, clients and secrets.",
        'App owners manage the sign-in of their own apps only: the mode, creating, rotating and turning off clients, and the sign-in counts. Another app answers 404. They do not see, rotate or remove signing keys.',
        "Creating or rotating a secret or key needs the person's own session or static token: View-as, run-as-key, named API keys and connected apps are refused (403). Removing a signing key needs a Hub administrator signed in as themselves in the browser; a static token is refused too (403 `OWN_SESSION_ONLY`). The maintenance write freeze applies to all of these. Every change is logged (`hub-signin-mode`, `hub-signin-client-create`, `-rotate`, `-toggle`, `hub-signin-key-rotate`, `hub-oidc-key-remove` with the key id only), and no log, activity row or later read ever holds a secret.",
        'Owning an app or administering the Hub grants nothing inside an app.',
        'A suspended Hub account, an archived or suspended environment or a turned-off client locks nobody out of an app. The person is refused on the Hub path (`hub_access_denied`) or the app goes direct, and direct Microsoft sign-in still works. Apps judge their own accounts, and existing app sessions are not ended by anything done on the Hub.'
      ]
    },
    { type: 'h2', id: 'hub-signin-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Purpose'],
      rows: [
        [
          '`GET /api/hub/oidc/.well-known/openid-configuration`, `/jwks`, `/ping?client_id=&redirect_uri=&post_logout_redirect_uri=`',
          'Discovery, public keys and the probe apps use. The probe authenticates as the client (HTTP Basic) and answers `{ ok, reason }`: true only when a sign-in can finish (see Fallback). Apps send `redirect_uri` and `post_logout_redirect_uri` of the origin in use. A wrong secret answers 401 `CLIENT_AUTH_FAILED`.'
        ],
        [
          '`GET /api/hub/oidc/authorize`, `POST /token`, `GET|POST /logout`',
          'Authorization code flow with PKCE, token exchange, end-session. Every response is no-store and cannot be framed.'
        ],
        [
          '`POST /api/hub/app-link/signins`, `POST /api/hub/app-link/switcher`',
          'An app reports a sign-in, or asks the switcher; bearer is the environment hub token. The identity travels in the body, never the URL.'
        ],
        [
          '`GET /api/hub/signin/settings`, `GET /overview`, `POST /keys/rotate`',
          'Issuer, audience and keys (admins; each with `status` signing | next | live | retiring | retired, `signs_from`, `published_until`, `removable`); the apps table with 30-day people counts; rotate the signing key (admins; answers `{ kid, signs_from }`).'
        ],
        [
          '`DELETE /api/hub/signin/keys/:kid`',
          'Remove a signing key at once (Hub administrator on their own browser session). Answers `{ kid, signing_kid, warning }`; 409 `ONLY_SIGNING_KEY` for the only key that can sign, 404 for an unknown key.'
        ],
        ['`PATCH /api/hub/signin/apps/:id/mode`', "Body `{ signin_mode: 'direct' | 'hub' }`."],
        [
          '`GET|POST|PATCH /api/hub/signin/environments/:envId/client`, `POST …/client/rotate`',
          'Read the client (secret masked) and the environment lines; create it (secret once, 201); turn it on or off; rotate the secret (once).'
        ],
        ['`GET /api/hub-switcher` (on an app)', 'The app switcher list: `{ apps, unavailable }`.']
      ]
    }
  ]
}
