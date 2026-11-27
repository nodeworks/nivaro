import type { DocSection } from '../types.js'

// Hub third-party providers, Wave 3 overview (Task 43): what the Wave 3 providers add to the Hub's
// own flows. Facts are from api/src/services/hub/providers/{health-tick,observe}.ts,
// hooks/renewal.ts, engine/gates.ts (origin renewal), promote-jira.ts, db/servers.ts,
// security/snyk.ts, create/provider-parts.ts and the Costs / Security pages.

export const hubProvidersWave3Docs: DocSection = {
  id: 'hub-providers-wave3',
  label: 'Wave 3 providers in the Hub',
  content: [
    {
      type: 'h1',
      id: 'hub-providers-wave3',
      text: 'Wave 3 providers in the Hub — Hub mode only'
    },
    {
      type: 'warn',
      text: 'Everything on this page exists only on a Nivaro Hub (`HUB=on`). A regular install, Nivaro Cloud and a Hub shared deployment have none of it.'
    },
    {
      type: 'p',
      text: 'Wave 3 adds LiveKit Cloud, Jira, Portainer, Let’s Encrypt / ACME, Azure SQL and Cost Management, Snyk, Amazon SNS, Mailgun, Firebase, AWS Cost Explorer, Route 53 Domains, Cloudflare Registrar and Namecheap (each has its own page). This page is what they change in the Hub’s own flows. Every hook below goes through the change engine with the run that carries it (its origin), so the usual gates, the audit trail and the person it acts for apply; none of them widens an app’s allowed connections.'
    },
    { type: 'h2', id: 'hub-providers-wave3-costs', text: 'Cost feed and domain watch' },
    {
      type: 'ul',
      items: [
        'Cost feeds (Anthropic, OpenAI, AWS Cost Explorer, Azure Cost Management) are read once a day; see Outside spend and domain expiry. Outside spend shows on Costs → Chargeback and, for Hub administrators, under the live figures on Costs → Now.',
        'Registrar domains (Route 53 Domains, Cloudflare Registrar, Namecheap) are listed under Domains on Security and warned 45 and 14 days before they end (the 45-day warning is skipped when the domain renews by itself).',
        'Budgets: once an hour the Hub asks every managed `azure.budget` and `aws.budget` for its health, so an Azure budget that went over sends its `cost.over_budget` notice. At most 50 a run, three at a time, 20 seconds each; one that fails never stops the others.'
      ]
    },
    { type: 'h2', id: 'hub-providers-wave3-renewal', text: 'Certificate renewal' },
    {
      type: 'p',
      text: 'Once an hour the Hub looks at every ACME certificate it ordered. One that ends within 30 days gets a renewal planned through the change engine, with origin `renewal`: a re-apply of that one certificate, and the engine refuses it unless every planned step is the renewal itself (a certificate whose names were also edited waits for a person). It acts for the person who made the certificate, judged as usual (production needs an administrator or the owners-deploy-production switch; a connection with no allowed domains makes every order an administrator’s). It starts on its own when nothing waits on a person; otherwise the change stays planned and the app’s owners and Hub administrators are told once (`cert.expiring`). It tries again at most every six hours, and the CA’s own limits still apply. Freezes stop it like any change; no pre-deploy checklist is asked for a renewal.'
    },
    { type: 'h2', id: 'hub-providers-wave3-promote', text: 'Jira release on a production promote' },
    {
      type: 'p',
      text: 'When a promotion to a production environment has deployed and passed its checks, every managed `jira.version` of the app (app-wide, or of that environment) named like the promoted version (`2.4.0` or `v2.4.0`, any case) that Jira does not show as released yet is marked released, carried by the promotion. A Jira refusal, an approval wait or a timeout (two minutes) is a warning line in the promotion’s log, never a failed promotion. Rollbacks and Apply now release nothing.'
    },
    { type: 'h2', id: 'hub-providers-wave3-db', text: 'Azure SQL as a database server' },
    {
      type: 'p',
      text: 'On Databases, a SQL Server database server may be linked to a managed `azure.sql_server` or `azure.sql_database` (beside an RDS instance). An empty host comes from the server’s address (for a database: its server’s, from the managed server, else `<server>.database.windows.net`), port 1433; another engine is refused `ENGINE_MISMATCH`. Deleting a linked Azure SQL server or database is refused `SHARED_IN_USE` while the record holds a database of another app.'
    },
    { type: 'h2', id: 'hub-providers-wave3-snyk', text: 'Snyk on Security' },
    {
      type: 'p',
      text: 'Under Image vulnerabilities, Hub administrators see each Snyk connection with its projects: open issues by severity, how many Snyk can fix by an upgrade or patch, and whether Snyk still monitors it (counts only, never issue text). Snyk projects are repositories and manifests, not image digests, so they are listed by connection and project and never mixed into the image rows. Read every night at 04:40 (with or without an image scanner) and again when an administrator starts a scan; a read that fails keeps the last counts and shows the error with secrets masked.'
    },
    { type: 'h2', id: 'hub-providers-wave3-create', text: 'Create app parts' },
    {
      type: 'ul',
      items: [
        '`livekit.api_key`: paste a LiveKit Cloud key pair; the Hub checks it, seals it and binds it to the app’s huddle settings (`huddle_livekit_url`, `huddle_livekit_key`, `huddle_livekit_secret`). The settings reach the app over its hub link once it answers; a binding that could not push yet shows its error on the resource.',
        '`acme.certificate`: a TLS certificate for the environment’s name (names default to its address), offered only on a Docker driver whose DNS names are made by hand — elsewhere the edge gets its own certificate (`BAD_PROVIDER_PART`). Bind its outputs to the stack secrets your edge reads; the Hub does not configure the edge.'
      ]
    }
  ]
}
