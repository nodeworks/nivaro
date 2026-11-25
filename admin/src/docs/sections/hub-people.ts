import type { DocSection } from '../types.js'

export const hubPeopleDocs: DocSection = {
  id: 'hub-people',
  label: 'App owners and people',
  content: [
    { type: 'h1', id: 'hub-people', text: 'App owners and people' },
    {
      type: 'p',
      text: 'Three things the Hub does for the people around its apps: app owners run their own app day to day without being Hub administrators, Hub administrators see who can open which app and offboard a person from every app at once, and both hear about deploys and outages on their phone.'
    },

    { type: 'h2', id: 'hub-owner-self-service', text: 'What app owners may do' },
    {
      type: 'p',
      text: "An app owner is a person on an app's Owners list in the Hub. They see only their own apps. Being an owner grants nothing inside the app itself."
    },
    {
      type: 'table',
      head: ['Action', 'Owner', 'Hub administrator'],
      rows: [
        ['See status, versions, deploy history and run logs', 'Every environment', 'Every app'],
        [
          'Promote and roll back, cancel a running promotion',
          'Every environment but production',
          'Every environment'
        ],
        [
          'Restart a Docker stack, Apply now',
          'Every environment but production',
          'Every environment'
        ],
        [
          'See stack settings (secrets stay hidden)',
          'Every environment but production',
          'Every environment'
        ],
        ['Edit stack settings, remove a stack, move, place, edit environments', 'No', 'Yes']
      ]
    },
    {
      type: 'p',
      text: 'Production is worked out without any setting: an environment whose key is production, prod, prd or live, or the last environment of the app (by position, then by when it was added). An app with one environment has only production. For EFP (development, staging, production) owners deploy development and staging.'
    },
    {
      type: 'p',
      text: "A Hub administrator can turn on Owners may deploy production on the app's page (What owners may do). Then the owners deploy production too. The switch is logged."
    },
    {
      type: 'note',
      text: 'Every rule is checked by the Hub server, not by the page. An owner who calls a production route anyway gets 403 `PRODUCTION_ADMIN_ONLY` and nothing starts. A person who is neither owner nor administrator gets 404, as if the app did not exist.'
    },

    { type: 'h2', id: 'hub-people-directory', text: 'People' },
    {
      type: 'p',
      text: 'Apps → People (Hub administrators) lists everyone the Hub has seen sign in to one of its apps, from the same records the app switcher uses: sign-ins through the Hub, and sign-ins the apps report. Records older than 180 days are dropped. Pick a person to see where they were seen.'
    },
    {
      type: 'p',
      text: 'Check now asks every environment, over its own link, which account the person holds there and with which role. Apps match a person only by email (case does not matter) or by Microsoft object id, never by name, and never match service or placeholder accounts. An environment with no hub token says No link; check that app by hand. The lookup is logged on the Hub.'
    },

    { type: 'h2', id: 'hub-offboard', text: 'Offboard everywhere' },
    {
      type: 'p',
      text: "On a person's page, type their email and press Offboard everywhere. In this order:"
    },
    {
      type: 'ul',
      items: [
        '1. The Hub stops signing them in at once: their Hub account (if they have one) is suspended with every Hub session and phone sign-in ended, and the run itself blocks Hub sign-in by their account, email and Microsoft id, so an account made again is refused too.',
        '2. Every environment of every app (not archived) is asked to suspend their account. The app suspends it through its own user service, ends every session and phone sign-in there, and its API keys stop working with it. Nothing is deleted. The app logs it and tells its administrators the account was suspended by offboarding.',
        '3. An app refuses to suspend its last active administrator (`LAST_ADMIN`). Make someone else an administrator there and retry.',
        '4. Results come in one environment at a time: Suspended, Was suspended, No account, Refused, No link or Did not answer. Retry asks again only the environments that did not finish, and any added since.'
      ]
    },
    {
      type: 'p',
      text: 'You cannot offboard yourself, nor the Hub’s last active administrator. Lift Hub sign-in block lets the Hub sign the person in again; their accounts in the apps stay suspended until an administrator of each app restores them.'
    },
    {
      type: 'note',
      text: 'An app needs Nivaro 0.3.215 or later for the people link. An older app answers No link (or The app has no people link): suspend the person there by hand. On a shared deployment the deployment answers for each of its apps, inside that app.'
    },

    { type: 'h2', id: 'hub-phone', text: 'On the phone' },
    {
      type: 'p',
      text: 'Hub administrators and the owners of an app get a notification, in the app inbox and as a browser and phone push, when a deploy on that app finishes or fails. The Hub also sends auto-rollback, environment down / back up and drift notices when those checks are on. They follow each person’s Profile → Notification rules (category System) and quiet hours. A tap opens the app’s page in the Hub.'
    },
    {
      type: 'p',
      text: 'The Nivaro phone app can show the fleet with two read-only answers, under the person’s ordinary sign-in (a phone token reads like a session). Administrators see every app, owners their own.'
    },

    { type: 'h2', id: 'hub-people-api', text: 'API' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        [
          '`GET /api/hub/people?q=&limit=&offset=`',
          'Admin',
          '`{ data: [{ key, name, email, hub_user_id, last_seen, environments }], total }`. `key` is `u:<hub user id>` or `k:<id>`; an email never goes in a URL.'
        ],
        [
          '`GET /api/hub/people/:key`',
          'Admin',
          'The person, the identities apps are asked about, their offboard runs.'
        ],
        [
          '`GET /api/hub/people/:key/access`',
          'Admin',
          'Every environment asked live: `state` account / none / no_link / error, `accounts [{ status, role, admin }]`.'
        ],
        [
          '`POST /api/hub/people/:key/offboard`',
          'Admin',
          'Body `{ confirm }` (their email). 202 with the run. 400 `CONFIRM_REQUIRED`, 409 `OFFBOARD_RUNNING`, `OFFBOARD_SELF`, `LAST_HUB_ADMIN`, `NO_IDENTITY`.'
        ],
        [
          '`GET /api/hub/offboards`, `GET /api/hub/offboards/:id`',
          'Admin',
          'Runs with per-environment results.'
        ],
        ['`POST /api/hub/offboards/:id/retry`', 'Admin', 'Ask again what did not finish. 202.'],
        ['`POST /api/hub/offboards/:id/lift`', 'Admin', 'Lift the Hub sign-in block.'],
        [
          '`GET /api/hub/apps/:id/access`',
          'Owner, admin',
          '`{ admin, owner, owners_deploy_production, environments: [{ id, key, production, deploy }] }`.'
        ],
        ['`PUT /api/hub/apps/:id/owner-policy`', 'Admin', 'Body `{ owners_deploy_production }`.'],
        [
          '`GET /api/hub/mobile/summary`',
          'Signed in',
          '`{ apps: [{ id, key, name, owner, web_path, environments: [{ id, key, production, state, version, checked_at }] }], counts: { apps, environments, ok, down, degraded, unknown, running, failed_24h }, generated_at }`. Last known status only; the phone never makes the Hub call the apps.'
        ],
        [
          '`GET /api/hub/mobile/runs?limit=`',
          'Signed in',
          '`[{ id, app_key, app_name, environment_key, kind, version, from_version, status, step, started_at, finished_at, web_path }]`, newest first (at most 100).'
        ],
        [
          'App side: `POST /api/hub-link/people/lookup`, `POST /api/hub-link/people/suspend`',
          'The Hub (hub token)',
          'Body `{ emails?, entra?: [{ oid, tid? }] }`, at most 5 of each. Suspend answers `{ state: suspended | already | none, accounts }` or 409 `LAST_ADMIN`. On a shared deployment: `POST /api/hub-deployment/apps/:id/people/lookup|suspend`.'
        ]
      ]
    }
  ]
}
