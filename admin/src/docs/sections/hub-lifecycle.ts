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
      text: 'A copy carries structure, never values that talk to the outside world — this is decided **in the source app**, before anything leaves it. Deny by default: in flow trigger options and step options, in transition and rule actions that reach outside (webhook, HTTP, external API, mail, chat), and in payload templates, every text value becomes the placeholder `{{fill in on the new app}}` and every address with it; only structural values stay (field and collection names, keys, method, operators, conditions, filters, mappings). Each copied flow arrives inactive with a **Needs values** line in its description naming every placeholder. Everywhere else, as a second line of defence: a value under a key whose name holds a credential word (password, secret, token, key, sig, signature, code, auth, credential, cert, private, bearer — camelCase, `_`, `-` and `.` split, so `clientSecret` and `db_password_2` count) is emptied; header values are emptied (names kept); URLs anywhere in a text lose user info, fragment and every query value (a SAS or signed URL keeps only its parameter names); `Bearer …` / `Basic …` / `SharedAccessSignature …` tokens, JWTs and `password=…` pairs inside any text lose their value. The answer lists what changed by path only, never the value; the copy’s page shows them under **Values to fill in**. The Hub checks again on arrival. A body secret placeholder (`⟦nvr-secret:<name>⟧`) is a name and stays; its value lives only in the external API configuration, which is never read.'
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
          'A database backup and a files backup per environment, through Backups & data (the database server’s own backup; the app copies its files to the policy’s backup target). The step waits for them. A part the Hub cannot back up (no database record, no files target) is skipped with a reason.',
          'Nothing to take back: the backups are kept'
        ],
        [
          '3. Final notice',
          'The notice goes, in the app and by email, to the people who signed in to the app through the Hub, its owners and the Hub administrators; the maintenance page shows it.',
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
        'Undo takes back the last done step; Cancel undoes every done step, newest first, and closes the retirement. Neither waits on a freeze, a window or a checklist. Neither is offered once Stop and remove has been signed off (`NOT_UNDOABLE`, `NOT_CANCELLABLE`).',
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
