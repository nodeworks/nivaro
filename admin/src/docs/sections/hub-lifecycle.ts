import type { DocSection } from '../types.js'

export const hubLifecycleDocs: DocSection = {
  id: 'hub-lifecycle',
  label: 'Hub app cloning and retirement',
  content: [
    { type: 'h1', id: 'hub-lifecycle', text: 'Hub app cloning and retirement' },
    {
      type: 'p',
      text: 'The Clone & retire tab (`/hub/lifecycle`, Apps hub) does two things at the ends of an app’s life. **Copy an app** starts a new app from an existing one’s structure. **Retire an app** switches an app off in five signed-off steps. Hub administrators do both; an app’s owners read their own app’s retirements and change nothing.'
    },
    { type: 'h2', id: 'hub-lifecycle-clone', text: 'Copying an app’s structure' },
    {
      type: 'p',
      text: 'Pick an app and the environment to copy from (its production environment by default), then Copy structure. The Hub reads the app’s structure over its hub link (`GET /api/hub-link/clone/blueprint`; on a shared deployment the deployment link) and keeps it in the template library as an ordinary template named `Clone of <app> · <environment>`, version `clone-<UTC date-time>`. **Create app from it** opens Create app with that template picked, and the creation’s Template step installs it into the new app exactly like any other template — the same sanitizer and the same installer, on the new app.'
    },
    {
      type: 'table',
      head: ['Copied', 'Never copied'],
      rows: [
        [
          'Collections, fields and relations; workflows and pipelines with their owner dimensions; layouts; queues; rules (switched off); roles with their permissions (policies on the app’s own collections, and reads of people and files); flows with their steps (inactive); the payload templates transition actions name (as drafts)',
          'Records, files, people (users, owner groups, owner seats), settings, external API connections, and every secret'
        ]
      ]
    },
    {
      type: 'p',
      text: 'A copy carries structure, never values that talk to the outside world — this is decided **in the source app**, before anything leaves it. **Denied outright**: every transition action, rule action and flow step whose type is not on the in-app allow-list (set field, create record, create task, in-app notice, reading and writing records, conditions, sub-flows, chat posts …) — `erp_submit`, external API calls, webhooks, mail, scripts and any type the Hub does not know — and any object anywhere that carries an address, an external API name, an endpoint path or a payload template: every text in them becomes `{{fill in on the new app}}`; only their type stays. **Structure only**: the JSON settings of collections, fields, layouts, sections, transitions and states, in-app actions and flow options keep field and collection names, keys, operators, types, colours (identifier-shaped) and labels; every other text becomes the placeholder. Every copied action arrives switched off and every flow inactive, each flow naming what it needs in a **Needs values** line; a webhook flow arrives with bearer auth and a fresh random secret. **Everywhere else** a second line of defence: values under credential-named keys (any part of the name: password, secret, token, key, sig, code, auth, credential, cert, private, bearer — also Kennwort, contraseña, mot de passe) are emptied, object keys are scanned, and texts lose URL user info and query values, `?code=` style query strings, auth-scheme tokens, JWTs, PEM private keys, known key prefixes, base64 blobs, `name=value` and `"name": "value"` pairs, XML `<Password>` elements, escaped JSON and Liquid string literals. Roles that had administrator access arrive **without** it, unless an administrator on their own session ticks “keep administrator access” for that role on Create app (logged); the same holds for Promotion → Blueprints installs. The answer lists what changed by path only, never the value; the copy’s page shows them under **Values to fill in**. The Hub checks again on arrival. A body secret placeholder (`⟦nvr-secret:<name>⟧`) is a name and stays; its value lives only in the external API configuration, which is never read.'
    },
    {
      type: 'note',
      text: 'Both apps need Nivaro 0.3.215 or later: the source for the structure export (`SOURCE_TOO_OLD` otherwise), the new app for installing roles and flows. A structure larger than 8 MB (`TOO_LARGE`) or with more parts than a template may hold (`TOO_MANY_PARTS`: 100 collections, 3,000 fields, 100 roles, 200 flows …) is refused.'
    },
    { type: 'h2', id: 'hub-lifecycle-retire', text: 'Retiring an app' },
    {
      type: 'p',
      text: 'Pick the app and read the plan: every live environment, whether it counts as production (the Hub’s production rule), how the Hub reaches it, and what each step will do there. Open the retirement on that plan (it is bound to the plan you read: `PLAN_STALE` when the app changed). Then sign off each step in turn; each runs in the background and shows on the run track.'
    },
    {
      type: 'table',
      head: ['Step', 'What it does', 'Undo'],
      rows: [
        [
          '1. Freeze writes',
          'A Hub freeze for the app (every promotion, Apply now and move of it is refused while it lasts; it is app-scoped and never holds back the upgrade of a shared deployment the app sits on), and strict maintenance on each environment over its hub link — nobody writes, administrators included. A shared-placed environment is served in maintenance by its deployment. An environment without a hub link is put in maintenance by hand and ticked.',
          'Maintenance lifted, freeze ended'
        ],
        [
          '2. Export data',
          'First the Hub waits for the freeze to reach every replica (16 s; a shared deployment’s tenant refresh + 5 s) and checks that each linked app reports its maintenance on (`MAINTENANCE_NOT_LIVE`). Then a database backup and a files backup per environment, through Backups & data: the database backup is always VERIFIED (whatever the policy says) and the files set must be complete with no failed file (`EXPORT_UNVERIFIED`). Their size and fingerprint are recorded and checked again before the removal (`EXPORT_CHANGED` refuses it). Only a part the Hub cannot back up (no database record, no files target) is skipped, with a reason and the typed app key.',
          'Nothing to take back: the backups are kept'
        ],
        [
          '3. Final notice',
          'The notice (at most 500 characters) goes to the Hub inbox and by email of the people who signed in to the app through the Hub, its owners and the Hub administrators — once per retirement — and shows on the maintenance page. People who sign in to the app directly see only the maintenance page.',
          '“Called off” to the same people'
        ],
        [
          '4. Stop and remove',
          'Each Docker stack is removed through the Hub agent (its volumes and the database stay); a shared-placed environment is taken off its deployment; an environment the Hub cannot stop is stopped by hand and ticked. Every environment becomes suspended.',
          'None — from here nothing goes back'
        ],
        [
          '5. Archive',
          'Every environment is archived and the app marked retired; the retirement’s freeze ends. From then on every start on the app — promote, Apply now, rollback, schedule, train step, move, config or extension promotion, scaling, restart — is refused with `ENV_ARCHIVED`.',
          'None'
        ]
      ]
    },
    {
      type: 'ul',
      items: [
        'Every step start is judged again: steps go in order (`STEP_OUT_OF_ORDER`); an open move (`MOVE_OPEN`) or creation (`CREATION_OPEN`); freezes — an incident’s included — and deploy windows with the action `retire` (`FROZEN`, `OUTSIDE_WINDOW`; the retirement’s own freeze never stops it).',
        'The pre-deploy checklist: items opt in to Retirements on the Changes tab. The first step claims the ticked checklist of every production environment (`CHECKLIST_REQUIRED` / `CHECKLIST_INCOMPLETE` until then).',
        'Typed confirm: the app key to freeze an app that has production, and always to stop and remove (`CONFIRM_REQUIRED`). Both sit in the production frame.',
        'Undo takes back the last done step (or a step left half-way); Cancel undoes every done step, newest first, lifts the maintenance and the freeze, records why and closes the retirement. Both work from an interrupted retirement too, and neither waits on a freeze, a window or a checklist. Neither is offered once Stop and remove has been signed off (`NOT_UNDOABLE`, `NOT_CANCELLABLE`). One retirement per app is open at a time (two opens at once: one wins). The retirement’s own freeze cannot be edited or deleted by hand (`FREEZE_OWNED`); Archive archives only the environments the plan stopped (`NEW_ENVIRONMENT` for one added later), and a retired app’s data care and placement are refused (`ENV_ARCHIVED`).',
        'A step whose Hub process stopped shows Stopped: the `hub-lifecycle-tick` job (every 2 minutes) marks it and tells the app’s people; Resume continues it with what it was signed off with. A runner holds the retirement by a lease: one that lost it stops before its next write, so two Hub processes never run a step together.'
      ]
    },
    { type: 'h2', id: 'hub-lifecycle-routes', text: 'Routes' },
    {
      type: 'table',
      head: ['Route', 'Who', 'What'],
      rows: [
        ['GET /api/hub/lifecycle/clones', 'admin', 'Recent structure copies'],
        ['POST /api/hub/environments/:envId/clone', 'admin', 'Copy the structure into the library'],
        ['GET /api/hub/retirements(/:id)', 'admin, owner', 'Retirements (owners: their apps)'],
        ['POST /api/hub/apps/:id/retire/plan', 'admin', 'The plan'],
        ['POST /api/hub/apps/:id/retire', 'admin', 'Open a retirement {plan_hash, notice?}'],
        [
          'POST /api/hub/retirements/:id/steps/:step',
          'admin',
          'Sign off a step {note, confirm, manual, skip, reason, notice, checklist_runs}'
        ],
        [
          'POST /api/hub/retirements/:id/undo | cancel | resume',
          'admin',
          'Go back, close, continue'
        ],
        [
          'GET /api/hub-link/clone/blueprint',
          'Hub bearer',
          'The app side: its structure, secrets emptied (also /api/hub-deployment/clone/apps/:id/blueprint)'
        ]
      ]
    }
  ]
}
