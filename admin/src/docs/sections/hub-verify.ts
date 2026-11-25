import type { DocSection } from '../types.js'

export const hubVerifyDocs: DocSection = {
  id: 'hub-verify',
  label: 'Hub smoke checks and extension versions',
  content: [
    { type: 'h1', id: 'hub-verify', text: 'Hub smoke checks and extension versions' },
    {
      type: 'p',
      text: 'Two Apps hub tabs check what a deploy left behind. Smoke checks (`/hub/smoke`) runs a few cheap checks against an environment after every promotion, rollback, Apply now, move and shared upgrade, and tells the app’s people when one fails. Extensions (`/hub/extensions`) shows which extension each environment runs, which environments are behind the one before them, and promotes one extension on its own. Owners see their own apps; only Hub administrators change anything.'
    },
    { type: 'h2', id: 'hub-verify-smoke', text: 'Smoke checks' },
    {
      type: 'p',
      text: 'Each environment has at most one suite of up to 20 checks. A run is queued for every deploy, move and shared upgrade of the environment that finished after the suite was saved (at most 6 hours back), and starts `Wait after the deploy` seconds after it finished (0–600, default 30). Run now runs it at once. The `hub-verify-smoke` job (every minute, one Hub process) queues and runs them; a run is never queued twice for the same deploy.'
    },
    {
      type: 'table',
      head: ['Kind', 'What it does', 'Expect'],
      rows: [
        [
          'Page answers',
          'A GET of a path on the environment’s own address (never another host), through the Hub’s outbound guard. No credentials, redirects are not followed.',
          'A status (default 200), optionally a text the page contains, a time limit'
        ],
        [
          'Signed-in read',
          'A GET of an `/api/` path, run by the APP over its hub link as its smoke service identity (never a person’s token).',
          'A status, a row count range of the answer’s `data`, a time limit'
        ],
        [
          'Saved query',
          'A custom query by slug with its parameters, run the same way. Its access must be Signed in (an administrator-only query answers 404).',
          'A row count range (required), a status, a time limit'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'An environment on a private address (10.x, 192.168.x, a .local or .internal name) needs its host in SSRF_ALLOW_HOSTS on the Hub, or its page checks fail with “its address is private”. Signed-in reads and saved queries need the hub link (a hub token; on a shared deployment, the deployment link) and an app on 0.3.215 or later.'
    },
    { type: 'h3', id: 'hub-verify-identity', text: 'The smoke service identity' },
    {
      type: 'ul',
      items: [
        'The app makes it on first use: a role `Hub smoke check` (no administration, app access off, one policy: read every collection) and a service account in it (account_kind `service`, a random `hub-smoke-…@nivaro.local` address). Their ids are stored in the app (extension setting `nivaro-core` / `hub_smoke_identity`); the account is never looked up by address.',
        'Each run mints a temporary API key for it — scope read only, 3 minutes, never leaving the app — runs the reads in-process and deletes the key. The answer is facts only: status, milliseconds, a row count and a short code, never a body or a value.',
        'A service account never signs in: password, token sign-in, password setup, Microsoft / OIDC / SAML, OAuth and phone sign-in all refuse it, a session naming it is ended, View-as answers SERVICE_ACCOUNT and SCIM cannot change it.',
        'When the stored account is no longer what the app made — not a service account, given a password, an Entra id, an identity-provider id or a static token, moved to another role, suspended — or the role was given administration, sign-in or a write policy, every run is refused with a SMOKE_IDENTITY_* / SMOKE_ROLE_* code and nothing is repaired. Remove the stored setting row to start over.'
      ]
    },
    { type: 'h3', id: 'hub-verify-failure', text: 'When a check fails' },
    {
      type: 'p',
      text: 'Hub administrators and the app’s owners get a notice naming each failed check and why (urgent on production). With “Tell them, and let the rollback rule roll back”, a failed run after a PROMOTION is also a breach for the environment’s automatic rollback rule (Releases tab): the rule claims its watch and rolls back to the version the environment ran before, exactly as for its own figures. Without an enabled rule watching that promotion the notice says it was not rolled back. A rollback, Apply now, move or upgrade is never rolled back for a smoke failure. Keep the rule’s window longer than the wait plus the run.'
    },
    { type: 'h2', id: 'hub-verify-extensions', text: 'Extension versions' },
    {
      type: 'p',
      text: 'Every 30 minutes (`hub-verify-extensions`, or Read now) the Hub asks each environment’s app which extensions it loaded — id, status, manifest version and build — and reads what it pins there: a Docker stack’s extension pins, a GitLab environment’s pin file `extensions/<id>.pin` beside the driver’s pin file on the deploy branch (one line, `<repository>@sha256:<64 hex>`), or a shared deployment’s pins.'
    },
    {
      type: 'table',
      head: ['State', 'Meaning'],
      rows: [
        ['Leads', 'The first environment in the chain that has it.'],
        ['Same', 'Runs what the environment before it runs (pin, else build, else version).'],
        [
          'Behind',
          'Runs something else than the one before it, and not a newer x.y.z version. Promote… appears.'
        ],
        ['Ahead', 'Runs a newer x.y.z version than the one before it.'],
        ['Missing', 'The one before has it; this one did not load it.'],
        ['Not read', 'The Hub could not read it yet.']
      ]
    },
    { type: 'h3', id: 'hub-verify-promote', text: 'Promoting one extension' },
    {
      type: 'ul',
      items: [
        'Promote… takes the pin of the environment before (or another one you pick), shows the pin now and the pin it becomes, and starts after you type the environment key.',
        'Docker: the pin is written into the environment’s extension pins and Apply now redeploys the stack — a normal Hub deploy (lock, freeze windows, verify, history, and a smoke run after it). A start that is refused puts the old pins back.',
        'GitLab: the pin file is committed to the deploy branch (refused if it changed meanwhile); that repository’s CI deploys it. The Hub refuses it in a freeze window (FROZEN) or while the environment deploys (LOCKED).',
        'Refused on a shared deployment (EXTENSION_ON_SHARED: its pins are the deployment’s, changed with an upgrade) and while a move of the environment is open (MOVE_OPEN).'
      ]
    }
  ]
}
