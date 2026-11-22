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
          'File with the bearer token: 32 or more characters, at least 8 different ones. `HUB_AGENT_HMAC_KEY_FILE` may hold a separate key for signed values (default: the token).'
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
          '`<repo>@sha256:<digest>` to offer bundled Redis. Without it a stack that asks for bundled Redis is refused (`REDIS_NOT_CONFIGURED`).'
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
        'Rollback is a promotion of an older version with the pins recorded for it. Swarm itself rolling a failed update back is reported as a failure (`SWARM_ROLLED_BACK`).',
        'Restart redeploys the same spec the stack runs (never one rebuilt from an inspect). It is refused when the Hub cannot tell which spec that is, and the panel offers it only while the agent reports the stack.'
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
