import type { DocSection } from '../types.js'

// Hub third-party providers, Task 33: Wave 2 providers inside the Hub's own flows (promote, Create
// app, DNS, database servers, notify routes, the vulnerability tab). Facts are from the code:
// api/src/services/hub/providers/hooks/{promote-release,secret-cleanup,ecr-findings}.ts,
// providers/notify.ts, notify-hook.ts, create/provider-{parts,step}.ts, create/dns*.ts,
// db/servers.ts. Nothing here ran against a live provider account yet.

export const hubProvidersWave2HooksDocs: DocSection = {
  id: 'hub-providers-wave2-hooks',
  label: 'Providers in Hub flows (Wave 2)',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-wave2-hooks',
      text: 'Providers in Hub flows (Wave 2) — Hub mode only'
    },
    {
      type: 'p',
      text: 'Every write below is a resource change planned through the change engine and carried by the Hub run that makes it (a promotion or a creation): the engine checks, at plan, start and resume, that the run is still running for that app and environment, and lets through only the actions that run may do. A promotion carries updates (and adoptions) of the app’s own resources — the promoted environment’s or app-level ones — and never widens which connections the app may use. No hook calls a provider directly.'
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-promote', text: 'Promote' },
    {
      type: 'ul',
      items: [
        '**Sentry release.** After a promotion or rollback succeeded, while its row is still running, each managed `sentry.project` of the app (app-level, or the promoted environment’s) gets one update with `record_release`, `release_version` = the version, `release_environment` = the Hub environment key and `release_url` = the environment’s https address. Sentry is read before it is written: a release or deploy that already exists is not made twice. An Apply now records nothing (the version did not change). It never fails the promotion: a refusal or an approval wait is a warning in the run log.',
        '**Rotated Entra secret clean-up.** After any successful run (an Apply now included), an `entra.client_secret` of this environment with older secrets gets the one-shot `remove_older` — only when every place the secret goes holds the current value (same fingerprint, no push error) and has applied it: this environment’s stack binding was written before the run started, another environment’s before a successful run there started. Otherwise the older secrets stay. The run’s success stands for the removal’s typed confirmation.',
        '**GitHub environment approval.** An `approve_deployment` that is not carried by a running promotion (`ORIGIN_INVALID`), or that names another GitHub environment than the promoted one maps to (`TARGET_MISMATCH`), is now refused when it is planned — it shows as a blocker — and still at start.'
      ]
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-notify', text: 'Notify routes' },
    {
      type: 'ul',
      items: [
        '**On the app page.** Each app’s page has its own Notify routes card for its owners and administrators: that app’s routes, who each one reaches in plain words (“Emails this app’s 3 owners”, “Reaches everyone who can read #shop-alerts”), Test, On/Off and delete. A new route there is for that app and sends through one of the app’s own sending resources (administrators may also pick a shared one). A route an administrator pointed at a shared sender is shown to owners but only administrators change it.',
        '**Who an email sender mails.** A sending type that mails people (a SendGrid sender) gets the route’s audience: the active Hub administrators for a Hub-wide route; the app’s active owners for an app route (its Hub administrators when it has none). People only, never machine accounts, at most 50. A recipient list on the sender itself still wins. Other senders (Slack, Teams, PagerDuty, Twilio) never get anyone’s address.',
        '**Incidents.** Opening an incident sends `incident.opened` (dedup key `incident:<id>`, action open); changing its title, severity or summary, or adding a note, sends the new event `incident.updated` (action update; a note’s text never leaves the Hub); resolving sends `incident.resolved` (action resolve). PagerDuty re-triggers and resolves the same incident; Slack replies in the incident’s thread.',
        '**Failed deploys.** A failed run sends `deploy.failed` with the dedup key `deploy:<id>` (action open). When the environment’s next run succeeds, the `deploy.failed` routes hear that the earlier failure is resolved (same key, action resolve, severity info) — a PagerDuty incident closes.',
        '**Threads survive a restart.** The first message of a dedup key on a route that threads (Slack) is remembered per route in `nivaro_extension_settings` (extension `nivaro-hub`, key `notify-thread:<route>:<hash>`; no migration). A resolve forgets it, rows unused for 30 days are dropped, deleting the route drops its rows.'
      ]
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-create', text: 'Create app' },
    {
      type: 'p',
      text: 'Each environment may name up to six provider parts. New in Wave 2: `entra.app_registration`, `upstash.redis_database`, `redis-cloud.database`, `sentry.project` and `anthropic.workspace`. The Create app form offers them all (the stack-bound ones on a Docker creation only) and says before the preview what the Hub would refuse together: two Entra registrations or two Redis databases in one environment, or a managed Redis while the stack’s Redis is bundled. When every environment has an Entra part, the Sign-in section says it is optional and an empty one is left out of the request.'
    },
    {
      type: 'table',
      head: ['Part', 'What the Hub does'],
      rows: [
        [
          '`entra.app_registration`',
          'Docker creations only. Makes the registration (web redirect `<address>/api/auth/callback`, sign-out URL = the address, when left out) and, in the same change, a client secret `nivaro-<app>-<env>` valid 12 months. Binds `client_id` → stack setting `OIDC_CLIENT_ID` and `client_secret` → stack secret `OIDC_CLIENT_SECRET`; the stack step writes `OIDC_ISSUER` = `https://login.microsoftonline.com/<tenant>/v2.0` from the connection’s tenant. When every environment has one, the app’s sign-in fields may be left out — this replaces the manual app registration step.'
        ],
        [
          '`upstash.redis_database`, `redis-cloud.database`',
          'Docker creations only, and the stack’s Redis must be external. Binds `redis_url` → stack secret `REDIS_URL`. One per environment.'
        ],
        [
          '`sentry.project`',
          'Makes the project (name its team as a ref). Each promotion then records a release on it. No DSN binding: Nivaro reads no `SENTRY_DSN` setting; bind a client key’s DSN by hand where your app reads one.'
        ],
        [
          '`anthropic.workspace`',
          'Makes the workspace. Its API key is pasted later (Anthropic cannot make keys by API).'
        ]
      ]
    },
    {
      type: 'p',
      text: 'The bindings are the engine’s own (the same checks as the Outputs card). The values are written once the stack step has saved the stack settings — before the first deploy — and never deploy anything themselves. A retry makes nothing twice.'
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-dns', text: 'DNS mode cloudflare' },
    {
      type: 'p',
      text: 'Docker drivers, GitLab targets and GitHub targets take `dns_mode: "cloudflare"` with `dns_zone_resource_id` naming a managed, shared `cloudflare.zone` whose name covers `wildcard_domain`, and an edge address. Names are made as in automatic mode; the providers step makes each environment’s `cloudflare.dns_record` (an address → A / AAAA, a name → CNAME; not proxied, TTL automatic). A zone of the other kind, or one that does not cover the domain, is refused (`DNS_ZONE_MISSING`). In the admin, the driver and target forms list every DNS mode the API accepts; a managed mode shows a zone picker of its own provider (a hosted zone for Route 53, a Cloudflare zone for Cloudflare), and switching provider clears the zone picked for the other.'
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-db', text: 'Database servers on a Neon branch' },
    {
      type: 'p',
      text: 'A database server’s `resource_id` may name a managed `neon.branch`. The engine must be Postgres (`ENGINE_MISMATCH`), TLS is required (`ssl_mode` defaults to require; disable answers `BAD_SSL`), an empty host comes from the branch’s `host` output (port 5432). Create app then makes the app’s database on it the usual way. Deleting a branch that still holds another app’s databases is refused `SHARED_IN_USE`.'
    },
    { type: 'h2', id: 'hub-providers-wave2-hooks-ecr', text: 'ECR scan findings' },
    {
      type: 'p',
      text: '`GET /api/hub/security/vulnerabilities` answers `repositories`: for each managed `aws.ecr_repository` the reader may see (administrators: all; owners: their apps’), the latest pushed image, its scan status and its finding counts by severity (source `ecr`), read live through the repository’s connection — at most 25 repositories, 8 seconds each. A repository that cannot be read answers its reason (scrubbed) instead of counts. The Security tab shows them in **Registry scans**, grouped by source, beside the scanner’s pinned images and the Snyk card: worst severities first, scan state, when the image was pushed, and the reason a repository could not be read.'
    },
    {
      type: 'note',
      text: 'Not built yet: GitLab targets that name a `gitlab` connection instead of a token (a connection’s rotated token must reach the drivers created from the target first).'
    }
  ]
}
