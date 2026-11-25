import type { DocSection } from '../types.js'

export const hubVerifyDocs: DocSection = {
  id: 'hub-verify',
  label: 'Hub smoke checks and extension versions',
  content: [
    { type: 'h1', id: 'hub-verify', text: 'Hub smoke checks and extension versions' },
    {
      type: 'p',
      text: 'Two Apps hub tabs check what a deploy left behind. Smoke checks (`/hub/smoke`) runs a few cheap checks against an environment after every promotion, rollback, Apply now, extension deploy, move and shared upgrade, and tells the app’s people when one fails. Extensions (`/hub/extensions`) shows which extension each environment runs, which environments are behind the one before them, and promotes one extension on its own. Hub administrators see and change everything; an app’s owners read their own apps — suites, runs and the extension matrix with its pins (image digests) — and change nothing.'
    },
    { type: 'h2', id: 'hub-verify-smoke', text: 'Smoke checks' },
    {
      type: 'p',
      text: 'Each environment has at most one suite of up to 20 checks, at most 10 of them signed-in reads and saved queries together (the app runs no more in one go: three at a time, 15 s each; the Hub waits that long plus 15 s). A run is queued for every deploy, move and shared upgrade of the environment that finished after the suite was saved (at most 6 hours back), and starts `Wait after the deploy` seconds after it finished (0–600, default 30). Run now runs it at once. The `hub-verify-smoke` job (every minute, one Hub process, at most 45 s of runs a minute; the rest wait for the next) queues and runs them; a run is never queued twice for the same deploy.'
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
          'A GET of an `/api/` path, run by the APP over its hub link as its smoke identity (never a person’s token).',
          'A status, a row count range of the answer’s `data`, a time limit'
        ],
        [
          'Saved query',
          'A custom query by slug with its parameters, run by the app itself (never through its execute route) inside a transaction that is always rolled back. Only a query whose access is Signed in or Public, whose SQL is ONE statement starting with SELECT or WITH and using none of the words that write or reach outside (INSERT, UPDATE, DELETE, MERGE, INTO, EXEC, DDL, SET, DECLARE, OPENROWSET…), and whose every table the smoke role may read. The Hub asks the app before it saves the suite, and the app judges it again on every run (SMOKE_QUERY_*).',
          'A row count range (required), a status, a time limit'
        ]
      ]
    },
    {
      type: 'warn',
      text: 'An environment on a private address (10.x, 192.168.x, a .local or .internal name) needs its host in SSRF_ALLOW_HOSTS on the Hub, or its page checks fail with “its address is private”. Signed-in reads and saved queries need the hub link (a hub token; on a shared deployment, the deployment link) and an app on 0.3.215 or later.'
    },
    { type: 'h3', id: 'hub-verify-identity', text: 'The smoke identity' },
    {
      type: 'ul',
      items: [
        'The app makes it on first use: a role `Hub smoke check` (no administration, app access off, one policy: read every collection) and an account of its own kind (`hub_smoke`, an address `hub-smoke-…@nivaro.local`). Their ids are stored in the app (extension setting `nivaro-core` / `hub_smoke_identity`); the account is never looked up by address. No administrator can give an account that kind.',
        'Each signed-in read uses a temporary API key for it — scope read only, 3 minutes, never leaving the app — and the key is deleted after the run. A read still running when its 15 s are up is answered TIMEOUT at once and finishes in the background (it ends 401 once its key is gone). The answer is facts only: status, milliseconds, a row count and a short code, never a body or a value.',
        'An account of kind `hub_smoke` never signs in: password, token sign-in, password setup, Microsoft / OIDC / SAML, OAuth and phone sign-in all refuse it, a session naming it is ended, View-as answers HUB_SMOKE_ACCOUNT and SCIM cannot change it. Every other account kind, service logins included, signs in as before.',
        'When the stored account is no longer what the app made — another kind, given a password, an Entra id, an identity-provider id or a static token, moved to another role, suspended — or the role was given administration, sign-in or a write policy, every run is refused with a SMOKE_IDENTITY_* / SMOKE_ROLE_* code and nothing is repaired. Remove the stored setting row to start over.',
        'An environment refresh copies the source’s smoke account, role and stored setting together (the kind is not one the refresh keeps on the target).'
      ]
    },
    { type: 'h3', id: 'hub-verify-failure', text: 'When a check fails' },
    {
      type: 'table',
      head: ['Run', 'Meaning', 'What happens'],
      rows: [
        ['Passed', 'Every check held.', 'Nothing.'],
        [
          'Failed',
          'At least one check failed on the app’s own answer: a status, a time limit, the page text or a row count.',
          'Hub administrators and the app’s owners get a notice naming each failed check (urgent on production). With “let the rollback rule roll back”, a failed run after a PROMOTION that finished inside the rule’s window is a breach for the environment’s automatic rollback rule (Releases tab), which rolls back exactly as for its own figures.'
        ],
        [
          'Not judged',
          'Checks failed only because they could not be judged: no link, the link token refused, the app unreachable or too old, a timeout, maintenance, the smoke identity or a query refused, or the Hub stopped during the run.',
          'The people are told; nothing is ever rolled back for it.'
        ]
      ]
    },
    {
      type: 'p',
      text: 'Without an enabled rule watching that promotion the notice says it was not rolled back. A rollback, Apply now, extension deploy, move or upgrade is never rolled back for a smoke failure. The editor warns when the wait plus the longest run can outlast the rule’s window.'
    },
    { type: 'h2', id: 'hub-verify-extensions', text: 'Extension versions' },
    {
      type: 'p',
      text: 'Every 30 minutes (`hub-verify-extensions`, or Read now — one app at once, every app in the background) the Hub asks each environment’s app which extensions it loaded — id, status, manifest version and build — and reads what it pins there: a Docker stack’s extension pins, a GitLab environment’s pin file `extensions/<id>.pin` beside the driver’s pin file on the deploy branch (one line, `<repository>@sha256:<64 hex>`), or a shared deployment’s pins.'
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
        'Promote… takes the pin of the environment before (or another one you pick), shows the pin now and the pin it becomes, and starts after you type the environment key. Only an extension the app lists or one of its environments runs (UNKNOWN_EXTENSION otherwise).',
        'Docker: the pin is written inside the environment’s promotion lock as part of Apply now (a normal Hub deploy: freeze windows, verify, history, a smoke run after it). A deploy already running refuses it before anything is written; a start or a deploy that fails puts the old pin back, so a retry starts clean.',
        'GitLab: under the environment’s promotion lock and its branch’s lock the pin file is committed, a deploy record (kind `extension`) is written and the repository’s pipeline is watched like a promotion’s (the before job, then the deploy job, played when manual). Success → a smoke run follows; failure → the deploy fails and the people are told, like a failed promotion. The commit stays in git.',
        'Refused on a shared deployment (EXTENSION_ON_SHARED: its pins are the deployment’s, changed with an upgrade), while a move or an app creation of the environment is open (MOVE_OPEN, CREATION_OPEN), in a freeze window (FROZEN) and while the environment deploys (LOCKED). The plan shows each of these before you start.'
      ]
    }
  ]
}
