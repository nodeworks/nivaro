import type { DocSection } from '../types.js'

export const envRefreshDocs: DocSection = {
  id: 'env-refresh',
  label: 'Environment refresh',
  content: [
    { type: 'h1', id: 'env-refresh', text: 'Environment refresh' },
    {
      type: 'p',
      text: "An environment refresh copies one environment's whole database over another — Production → Staging, Production → Development, Staging → Development — while the target keeps what belongs to it: where it sends mail, the partner endpoints and credentials it uses, its keys, switches and test accounts. Production is never a target."
    },
    {
      type: 'p',
      text: 'Open Environments → Runbooks → Refresh an environment. Pick a direction, press Dry run and read the plan; the host repeats the checks, and its finished dry run unlocks Run refresh for 24 hours. A real run asks you to type the target database name.'
    },
    { type: 'h2', id: 'env-refresh-plan', text: 'The dry-run plan' },
    {
      type: 'p',
      text: 'The dry run reads both databases and writes nothing anywhere. It lists, in plain words:'
    },
    {
      type: 'ul',
      items: [
        'Preflight checks: both databases online, the target app knows every migration in the source, space for both backups and for the larger files, nothing else running against the target.',
        'What is copied: every table of the source, with row counts. People and their data come across as they are — nothing is scrubbed.',
        "What the target keeps, with the target's current values. Credentials show only whether they are set.",
        'What is switched off or held afterwards (the safety pass).'
      ]
    },
    { type: 'h2', id: 'env-refresh-kept', text: 'What the target keeps' },
    {
      type: 'table',
      head: ['Kept', 'How'],
      rows: [
        [
          'Instance settings: mail, SMS, push, Teams, AI provider and keys, storage, directory and sign-in, maintenance state, job and integration switches, monitoring settings',
          'Columns of the settings row put back'
        ],
        ['Per-instance settings rows (caches, push relay, sign-in linking)', 'The whole table'],
        [
          'External APIs: base URL, credentials (including payload body secrets), headers, mocks, instance overrides, on/off',
          'Matched by name'
        ],
        ['Webhook targets, secrets and on/off', 'Matched by name'],
        ['Agent trigger targets, signing secrets and on/off; flows on/off', 'Matched by name'],
        [
          'Outbound settings inside flow steps — webhook URLs, headers, secrets, an external-API path override (the rest of each step follows the source)',
          'Matched by flow name + step key'
        ],
        ['Sign-in providers (SSO / OIDC)', 'Matched by key'],
        ['Partner sync jobs and scheduled report emails on/off', 'Matched by name'],
        [
          'Service, integration and bot accounts, and test accounts on reserved test domains (.test, .invalid, .example, .internal, example.com), with their API keys',
          'Rows put back by id'
        ],
        [
          'Environments registry, browser and phone push registrations, Teams conversations',
          'The whole table'
        ],
        [
          'The runbook queue and quality-check results, when the target is the database that holds them',
          'The whole table'
        ]
      ]
    },
    {
      type: 'p',
      text: 'An external API, webhook or job the source has and the target never had is new: the safety pass mocks it or switches it off.'
    },
    { type: 'h2', id: 'env-refresh-safety', text: 'The safety pass' },
    {
      type: 'p',
      text: 'It always runs once the copy has landed, even when a step after the restore failed:'
    },
    {
      type: 'ul',
      items: [
        'Mail, SMS, push and Teams test mode on (the target keeps its own recipients and allowlists).',
        "External APIs new from the source answer from a mock on the target's instance.",
        'Webhooks, partner sync jobs and scheduled report emails new from the source: off.',
        'Partner submissions waiting to be re-sent and pending event deliveries: held.',
        "Push registrations and Teams conversations that are not the target's own: removed.",
        'Agent triggers the target never had: off; their deliveries waiting to be sent: held.',
        'Flows the target never had that call out with a webhook step: off.',
        "Copied credentials of accounts the target does not keep: static tokens cleared, API keys switched off, the legacy session table emptied. Passwords and two-factor secrets stay so people can still sign in; OAuth, phone and session tokens live in each environment's own Redis and never arrive with the copy."
      ]
    },
    { type: 'h2', id: 'env-refresh-steps', text: 'The steps of a real run' },
    {
      type: 'table',
      head: ['Step', 'What happens'],
      rows: [
        ['preflight', 'The checks again; a failure stops the run before anything is written.'],
        ['save', 'What the target keeps is saved to a file on the host.'],
        ['backup', 'A COPY_ONLY backup of the target (for Roll back), then of the source.'],
        [
          'restore',
          "The target goes offline and the source's backup is restored over it, onto the target's own files. Recovery is set to simple and database users are re-mapped to their logins."
        ],
        ['migrate', "The target app's newer migrations run (only the ones it had run before)."],
        ['keep', 'What the target keeps is put back.'],
        ['safety', 'The safety pass.'],
        [
          'verify',
          'Test mode is on, business-table row counts are compared with the source, readiness is read.'
        ]
      ]
    },
    {
      type: 'p',
      text: "The target's maintenance page is up for the whole run. If a step fails after the restore, the page stays up; resume from the failed step or roll back."
    },
    { type: 'h2', id: 'env-refresh-rollback', text: 'Roll back' },
    {
      type: 'p',
      text: 'For 24 hours after a refresh, Roll back puts the target back from the backup taken at its start. It has its own dry run (it checks the backup exists and is recent) and asks for the database name too. Anything changed on the target after the refresh is lost.'
    },
    { type: 'h2', id: 'env-refresh-files', text: 'Files' },
    {
      type: 'p',
      text: "Uploaded files are not copied. Set FILES_FALLBACK_DIR on the target to a read-only mount of the source's uploads: when the target has no copy of a file, it reads the source's. Nothing is ever written there. The fallback is off in cloud mode."
    },
    { type: 'h2', id: 'env-refresh-extensions', text: 'For extension authors' },
    {
      type: 'p',
      text: 'An extension declares the environments, the allowed directions and the host runbooks with ctx.environments.registerRefresh, and adds what its environments keep with ctx.environments.registerKeep (a whole table, columns matched by a natural key, rows matching a predicate, or a delegate step with its own save and restore commands). The host runner reads the same declaration from the extension module named by --config.'
    },
    {
      type: 'pre',
      code: `ctx.environments?.registerKeep({
  id: 'my-ext:partner-tokens',
  label: 'Partner tokens',
  reason: 'Each environment talks to its own partner tenant.',
  table: 'partner_settings',
  kind: 'columns',
  key: ['partner'],
  columns: ['token', 'endpoint'],
  secret_columns: ['token']
})`
    },
    {
      type: 'note',
      text: 'A guard test fails when a nivaro_* table is not classified or a settings column has no decision (kept by the target or follows the source), so a new setting cannot silently carry production values into staging.'
    }
  ]
}
