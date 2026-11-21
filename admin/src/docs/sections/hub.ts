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
          'The app answered, but its preflight or health reports a problem. The failing checks are named.'
        ],
        [
          'Not answering',
          '`unreachable`',
          'No answer within 8 seconds, or the connection failed. The error is shown.'
        ],
        [
          'Hub link refused',
          '`link_refused`',
          "The app answered 401 to the hub token: the token saved in the Hub does not match the app's `HUB_TOKEN`, or the app has none. The Hub does not fall back to treating the app as healthy."
        ]
      ]
    },
    {
      type: 'p',
      text: 'An environment with no hub token is read through the public version and health routes (source `public`) and shows the version and the health verdict only.'
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
          'Create, edit, delete and set owners (administrators).'
        ],
        [
          '`POST /api/hub/apps/:id/environments`, `PATCH/DELETE /api/hub/environments/:envId`',
          "Manage an app's environments (administrators)."
        ],
        [
          '`GET /api/hub/apps/:id/status`, `GET /api/hub/environments/:envId/status`',
          'Read status. `?fresh=1` skips the 30 second cache.'
        ],
        [
          '`GET /api/hub/environments/:envId/deploys?limit=20`',
          "Read-only deploy history from the environment's GitLab driver."
        ],
        [
          '`GET/POST/PATCH/DELETE /api/hub/drivers`, `POST/PATCH /api/hub/placements`',
          'GitLab drivers and dedicated placements (administrators). A driver a placement uses cannot be deleted.'
        ]
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
      text: 'The hub link is the one door an app opens to its Hub. It is a single read-only route, `GET /api/hub-link/status`, mounted only when the app has `HUB_TOKEN` set (32 characters or more). The Hub sends that token as `Authorization: Bearer <token>`; any other caller, or no token, gets 401 `HUB_LINK_REFUSED`. No session, API key or OAuth token opens it.'
    },
    { type: 'h2', id: 'hub-link-returns', text: 'What it returns' },
    {
      type: 'table',
      head: ['Field', 'Content'],
      rows: [
        ['`version`', 'The Nivaro version the app runs.'],
        ['`environment`, `instance`', 'The environment label and instance name.'],
        ['`preflight`', '`status` and the names of any failing checks.'],
        ['`readiness_score`', 'The readiness score, or null while not yet computed.'],
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
      text: 'Phase 1 only reads. Maintenance on and off, seeding a first admin and sign-in events over the link belong to later phases and are not available now. An app that does not set HUB_TOKEN has no hub link at all, and the Hub reads its public version and health routes instead.'
    }
  ]
}
