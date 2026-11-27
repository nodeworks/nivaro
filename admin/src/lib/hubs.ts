import {
  Activity,
  AppWindow,
  ArrowRightLeft,
  BarChart2,
  BellDot,
  BookOpen,
  Braces,
  ClipboardCheck,
  Clock,
  Code2,
  Database,
  FileBarChart,
  HeartPulse,
  History,
  Link2,
  type LucideIcon,
  MailCheck,
  Plug,
  ScanSearch,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wrench
} from 'lucide-react'

/**
 * Hub pages: several related screens behind one nav entry, one tab per screen
 * (components/hub-page.tsx renders them; pages/Hubs.tsx maps each tab to
 * its screen). This file is data only, so the layout and nav can ask "is this
 * path a hub tab?" without loading any screen.
 *
 * A tab is a PATH segment under the hub's base, never a `?tab=` param, so each
 * tab keeps its own query string. `legacy` is the standalone path the screen
 * had before the merge. App.tsx redirects it onto the tab (query and hash
 * kept) unless the legacy path is itself a hub path now (/reports was the
 * audit report and is now the Reports hub). It is also the tab's PERMISSION
 * key: roles' ui_permissions store disabled paths, so a role that hid
 * /field-watches still has the Field watches tab hidden, and the Roles editor
 * lists hub tabs under their legacy paths.
 */
export type HubTabDef = {
  /** Path segment under the hub's base; '' for the first tab. */
  path: string
  label: string
  /** The screen's old standalone path: redirected here, and its permission key. */
  legacy?: string
  /**
   * What this tab is for, in one line. Only the standalone Hub look reads it: there the page
   * header names the tab (the top bar already names the hub); everywhere else the hub's own
   * title and hint stay.
   */
  hint?: string
  /** Words people search this page by (command palette, the Hub's Find): "dns", "postgres". */
  keywords?: string
  /**
   * Path segments of pages merged into this one. Each redirects here (query and hash kept). Not
   * a permission key: the tab keeps its own.
   */
  aliases?: string[]
}

/**
 * A named group of a hub's tabs. A hub with groups shows two strips: the groups, then the open
 * group's tabs. Only the Apps hub has them (40 tabs in one strip did not read); every other hub
 * keeps its one strip. The standalone Hub look shows the groups in its top bar instead.
 */
export type HubTabGroup = {
  /** DOM id part; stable. */
  key: string
  /** The short name navigation shows ("Domains"). */
  label: string
  /** The full name, where there is room ("Domains, DNS and certificates"); default = label. */
  title?: string
  /** Tab paths in this group, in strip order. Every tab is in exactly one group. */
  tabs: string[]
}

export type HubDef = {
  base: string
  title: string
  hint: string
  icon: LucideIcon
  tabs: HubTabDef[]
  /** Optional groups of `tabs` (two strips); see HubTabGroup. */
  groups?: HubTabGroup[]
  /**
   * A server feature (GET /api/app-info `features`) the hub needs. Without it the hub is left
   * out of the nav and its paths show "Not available on this server".
   */
  feature?: string
}

/**
 * Nivaro Hub (HUB=on): everything the Hub looks after, in homes named for what things ARE
 * (docs/superpowers/specs/2026-11-27-hub-navigation-design.md). The homes share one vocabulary
 * with the provider groups (api services/hub/providers/categories.ts): an outside account or
 * resource shows in the home of its kind, beside the Hub's own things of that kind, never in a
 * provider silo. Paths never changed when pages moved home, so every old link and every role's
 * ui_permissions key still holds; a page that was merged away keeps its path as an `alias`.
 */
export const APPS_HUB: HubDef = {
  base: '/hub',
  title: 'Apps',
  hint: 'The apps this Hub looks after: their environments, whether they are up and what was deployed.',
  icon: AppWindow,
  feature: 'hub',
  tabs: [
    // ── Apps ──
    {
      path: '',
      label: 'Apps',
      hint: 'Every app with its environments: status, deploys, owners and what it uses outside the Hub.',
      keywords: 'applications environments staging production promote rollback create adopt owners'
    },
    {
      path: 'usage',
      label: 'Usage',
      hint: 'How many people use each app: counts only, under a privacy floor.',
      keywords: 'people active users screens adoption'
    },
    {
      path: 'dependencies',
      label: 'Dependencies',
      hint: 'What each app depends on, and what a change would touch.',
      keywords: 'hosts impact outbound calls partners'
    },
    {
      path: 'services',
      label: 'App services',
      hint: 'Payments, AI, calls and other outside services your apps use.',
      keywords: 'stripe payments anthropic openai ai livekit video calls third party'
    },
    {
      path: 'templates',
      label: 'Templates',
      hint: 'App Blueprints a new app can start from.',
      keywords: 'blueprints starter new app'
    },
    {
      path: 'targets',
      label: 'New app defaults',
      hint: 'Where a new app goes: the GitLab group or GitHub account, template and hostnames it gets.',
      keywords: 'targets create app repository group hostnames gitlab github'
    },
    {
      path: 'lifecycle',
      label: 'Clone & retire',
      hint: 'Copy an app’s structure into a new app, or retire an app step by step.',
      keywords: 'lifecycle copy duplicate archive decommission delete app'
    },
    // ── Code and deploys ──
    {
      path: 'releases',
      label: 'Releases',
      hint: 'Release trains, scheduled promotions, freezes and automatic rollbacks.',
      keywords: 'deploy promote schedule train freeze rollback release notes version'
    },
    {
      path: 'changes',
      label: 'Change calendar',
      hint: 'Every planned change on one calendar, deploy windows and checklists.',
      keywords: 'changes calendar maintenance deploy windows checklist ics'
    },
    {
      path: 'smoke',
      label: 'Smoke checks',
      hint: 'Checks that run after every deploy, per environment.',
      keywords: 'post-deploy tests verify checks after deploy'
    },
    {
      path: 'extensions',
      label: 'Extensions',
      hint: 'Which extension version each environment runs.',
      keywords: 'extension versions pins plugins'
    },
    {
      path: 'config',
      label: 'Config promotion',
      hint: 'Move configuration from one environment of an app to another, with undo.',
      keywords: 'configuration promote layouts flows roles settings copy between environments'
    },
    {
      path: 'code',
      label: 'Code & pipelines',
      hint: 'Repositories, pipelines, image registries and mobile builds, with the accounts they live in.',
      keywords:
        'github gitlab vercel expo eas docker hub registry ecr repository repo ci pipeline actions build jira source'
    },
    // ── Hosting and servers ──
    {
      path: 'hosts',
      label: 'Hosts & regions',
      hint: 'Docker hosts grouped in regions, and what runs on each.',
      keywords: 'servers docker swarm region placement map machines'
    },
    {
      path: 'drivers',
      label: 'Deploy locations',
      hint: 'Where apps are deployed: a Docker host the Hub agent runs, or a GitLab project.',
      keywords: 'drivers agent docker host gitlab project deploy server'
    },
    {
      path: 'shared',
      label: 'Shared deployments',
      hint: 'One process serving many apps, each with its own database, files and key.',
      keywords: 'shared deployment multi-app tenants upgrade'
    },
    {
      path: 'capacity',
      label: 'Capacity',
      hint: 'How busy each shared deployment and app is, and which apps should move.',
      keywords: 'load limits rebalance move advisor busy'
    },
    {
      path: 'scale',
      label: 'Scaling',
      hint: 'Replicas and limits per role, and the rules that scale them.',
      keywords: 'replicas cpu memory autoscale autoscaling scale out'
    },
    {
      path: 'storage',
      label: 'Storage',
      hint: 'How full each host’s volumes and each environment’s files are.',
      keywords: 'disk volumes files space full nfs uploads'
    },
    {
      path: 'cloud',
      label: 'Cloud accounts',
      hint: 'AWS, Azure and other hosting accounts: their networks, servers, buckets and load balancers.',
      keywords:
        'aws azure portainer amazon ec2 vpc subnet s3 bucket load balancer security group network cloud r2 tunnel'
    },
    // ── Databases ──
    {
      path: 'databases',
      label: 'Databases',
      hint: 'Every database and the servers they are on, the Hub’s own and at providers like Neon, RDS and Azure SQL.',
      keywords:
        'database sql server postgres postgresql mysql mariadb sqlite neon rds azure sql redis upstash cache connection string'
    },
    {
      path: 'data',
      label: 'Backups & refresh',
      hint: 'Backups, restore drills and refreshes, per environment.',
      keywords: 'backup restore drill refresh copy production to staging rehearsal data'
    },
    // ── Domains, DNS and certificates ──
    {
      path: 'domains',
      label: 'Domains & certificates',
      hint: 'Every name your apps answer on: who registers it, where its DNS lives and when its certificate expires.',
      keywords:
        'dns domain domains certificate certificates tls ssl https expiry renew registrar zone record cloudflare route 53 route53 namecheap acme letsencrypt let’s encrypt hostname cname'
    },
    // ── Messaging and alerts ──
    {
      path: 'messaging',
      label: 'Channels & routes',
      hint: 'Where the Hub sends word: Slack, Teams, email, SMS and paging, and which events go where.',
      keywords:
        'slack teams pagerduty sendgrid mailgun twilio firebase push email mail sms notify routes notifications alerts channel webhook ses sns'
    },
    {
      path: 'on-call',
      label: 'On-call',
      hint: 'Who is paged first for each app, and the escalation after.',
      keywords: 'rota pager paging escalation override on call'
    },
    // ── Monitoring and security ──
    {
      path: 'fleet',
      label: 'Fleet',
      hint: 'Every environment at a glance: version, health and uptime.',
      keywords: 'overview all environments versions uptime slo drift behind status'
    },
    {
      path: 'health',
      label: 'Health',
      hint: 'A 0–100 score per environment, and what lowers it.',
      keywords: 'health score readiness'
    },
    {
      path: 'issues',
      label: 'Issues',
      hint: 'Crashes and server errors from every app, grouped by signature.',
      keywords: 'errors crashes bugs exceptions 500'
    },
    {
      path: 'incidents',
      label: 'Incidents',
      hint: 'Open incidents: freeze, banner, timeline and post-mortem.',
      keywords: 'incident outage post-mortem postmortem banner'
    },
    {
      path: 'status',
      label: 'Status pages',
      hint: 'Public or internal status pages for your apps.',
      keywords: 'status page public uptime page'
    },
    {
      path: 'security',
      label: 'Security',
      hint: 'Image and code vulnerabilities, error tracking and the compliance pack.',
      keywords: 'vulnerabilities cve scan snyk sentry compliance evidence image scan'
    },
    {
      path: 'ask',
      label: 'Ask the Hub',
      hint: 'Questions about your apps, answered from Hub data (read-only).',
      keywords: 'ai question assistant'
    },
    // ── Costs ──
    {
      path: 'costs',
      label: 'Costs',
      hint: 'What your apps cost now, the month so far and the forecast against budget; provider spend and chargeback.',
      keywords: 'cost spend budget budgets chargeback bill billing forecast department price'
    },
    // ── People and access ──
    {
      path: 'people',
      label: 'People',
      hint: 'Who can reach which app, and offboarding.',
      keywords: 'users directory offboard owners who has access leaver'
    },
    {
      path: 'signin',
      label: 'Sign-in',
      hint: 'How people sign in to your apps: the Hub’s own sign-in, and Entra or Auth0 applications.',
      keywords:
        'sso oidc openid login identity entra azure ad auth0 app registration client secret keys single sign-on'
    },
    {
      path: 'access',
      label: 'Access reviews',
      hint: 'Temporary admin access (break-glass) and access reviews of every app.',
      keywords: 'break-glass break glass temporary admin review evidence'
    },
    {
      path: 'secrets',
      label: 'Secrets',
      hint: 'Tokens and keys the Hub holds, and when each is due to rotate.',
      keywords: 'tokens keys rotate rotation credentials'
    },
    {
      path: 'connections',
      label: 'Outside accounts',
      hint: 'Every provider account the Hub holds, in one list, with what each shares between apps.',
      keywords:
        'connections providers accounts credentials shared infrastructure shared infra adopt unmanaged all connections',
      aliases: ['shared-infra']
    },
    {
      path: 'audit',
      label: 'Audit log',
      hint: 'Every change made through the Hub, by whom and when.',
      keywords: 'audit history who changed csv'
    }
  ],
  groups: [
    {
      key: 'apps',
      label: 'Apps',
      tabs: ['', 'usage', 'dependencies', 'services', 'templates', 'targets', 'lifecycle']
    },
    {
      key: 'deploys',
      label: 'Deploys',
      title: 'Code and deploys',
      tabs: ['releases', 'changes', 'smoke', 'extensions', 'config', 'code']
    },
    {
      key: 'hosting',
      label: 'Hosting',
      title: 'Hosting and servers',
      tabs: ['hosts', 'drivers', 'shared', 'capacity', 'scale', 'storage', 'cloud']
    },
    {
      key: 'databases',
      label: 'Databases',
      title: 'Databases and caches',
      tabs: ['databases', 'data']
    },
    {
      key: 'domains',
      label: 'Domains',
      title: 'Domains, DNS and certificates',
      tabs: ['domains']
    },
    {
      key: 'messaging',
      label: 'Messaging',
      title: 'Messaging and alerts',
      tabs: ['messaging', 'on-call']
    },
    {
      key: 'monitoring',
      label: 'Monitoring',
      title: 'Monitoring and security',
      tabs: ['fleet', 'health', 'issues', 'incidents', 'status', 'security', 'ask']
    },
    { key: 'costs', label: 'Costs', tabs: ['costs'] },
    {
      key: 'access',
      label: 'Access',
      title: 'People and access',
      tabs: ['people', 'signin', 'access', 'secrets', 'connections', 'audit']
    }
  ]
}

export const JOBS_HUB: HubDef = {
  base: '/jobs',
  title: 'Jobs',
  hint: 'Scheduled and background work: what runs, when it runs, and how it went.',
  icon: Activity,
  tabs: [
    { path: '', label: 'Runs & schedules', legacy: '/background-jobs' },
    { path: 'timeline', label: 'Timeline', legacy: '/cron-timeline' },
    { path: 'calendar', label: 'Calendar', legacy: '/ops-calendar' },
    { path: 'tasks', label: 'Repair tasks', legacy: '/ops-tasks' }
  ]
}

export const DATABASE_HUB: HubDef = {
  base: '/database',
  title: 'Database',
  hint: 'SQL Server, Redis and this process: live diagnostics, tuning and checks.',
  icon: Database,
  tabs: [
    { path: '', label: 'Overview', legacy: '/db-health' },
    { path: 'connections', label: 'Connections' },
    { path: 'tuning', label: 'Tuning', legacy: '/db-tuning' },
    { path: 'sql-checks', label: 'SQL checks', legacy: '/sql-checks' },
    { path: 'redis', label: 'Redis keys', legacy: '/ops-redis' },
    { path: 'caches', label: 'Caches' }
  ]
}

export const HEALTH_HUB: HubDef = {
  base: '/health',
  title: 'Health',
  hint: 'Uptime and checks for this instance, and the monitoring stack that watches it.',
  icon: HeartPulse,
  tabs: [
    { path: '', label: 'Status' },
    { path: 'monitors', label: 'Monitors', legacy: '/monitors' },
    { path: 'telemetry', label: 'Telemetry', legacy: '/telemetry' },
    { path: 'errors', label: 'Error clusters' },
    { path: 'request-story', label: 'Request story' },
    { path: 'daily-report', label: 'Daily report' }
  ]
}

export const ENVIRONMENTS_HUB: HubDef = {
  base: '/environments',
  title: 'Environments',
  hint: 'This instance among its environments: deploys, config drift and whether it is ready to ship.',
  icon: ServerCog,
  tabs: [
    { path: '', label: 'Environments', legacy: '/environments' },
    { path: 'config', label: 'Config diff', legacy: '/config-diff' },
    { path: 'changed-here', label: 'Changed here' },
    { path: 'readiness', label: 'Go-live readiness', legacy: '/readiness' },
    { path: 'quality', label: 'Quality checks', legacy: '/quality-checks' }
  ]
}

export const PROMOTION_HUB: HubDef = {
  base: '/promotion',
  title: 'Promotion',
  hint: 'Move schema, config and content between instances: export, preview, apply.',
  icon: ArrowRightLeft,
  tabs: [
    { path: '', label: 'Content', legacy: '/content-promotion' },
    { path: 'blueprints', label: 'Blueprints', legacy: '/blueprints' },
    { path: 'change-sets', label: 'Change sets', legacy: '/change-sets' },
    { path: 'schema', label: 'Schema snapshots', legacy: '/schema-snapshot' },
    { path: 'starter-kits', label: 'Starter kits', legacy: '/collection-presets' }
  ]
}

export const CONNECTIONS_HUB: HubDef = {
  base: '/connections',
  title: 'Connections',
  hint: 'How this instance talks to partner systems, out and in.',
  icon: Link2,
  tabs: [
    { path: '', label: 'External APIs', legacy: '/external-apis' },
    { path: 'webhooks', label: 'Webhooks', legacy: '/webhooks' },
    { path: 'sync-jobs', label: 'Sync jobs', legacy: '/sync-jobs' },
    { path: 'inbound', label: 'Inbound mappings', legacy: '/inbound-mappings' },
    { path: 'trackers', label: 'Issue trackers', legacy: '/issue-trackers' }
  ]
}

export const REPORTS_HUB: HubDef = {
  base: '/reports',
  title: 'Reports',
  hint: 'Reports built from widgets, the ones emailed on a schedule, team throughput and file downloads.',
  icon: FileBarChart,
  tabs: [
    { path: '', label: 'Report Studio', legacy: '/report-studio' },
    { path: 'scheduled', label: 'Scheduled', legacy: '/scheduled-reports' },
    { path: 'throughput', label: 'Team throughput', legacy: '/team-throughput' },
    { path: 'downloads', label: 'File downloads', legacy: '/file-downloads' }
  ]
}

export const ACTIVITY_HUB: HubDef = {
  base: '/activity',
  title: 'Activity',
  hint: 'Every change, as it happens and after the fact.',
  icon: History,
  tabs: [
    { path: '', label: 'Log', legacy: '/activity' },
    { path: 'live', label: 'Live', legacy: '/pulse' },
    { path: 'audit', label: 'Audit report', legacy: '/reports' },
    { path: 'history', label: 'Value history', legacy: '/revision-search' },
    { path: 'provenance', label: 'Provenance', legacy: '/provenance' }
  ]
}

export const AI_HUB: HubDef = {
  base: '/ai',
  title: 'AI',
  hint: 'What the AI features cost, how well they answer, and what they know.',
  icon: Sparkles,
  tabs: [
    { path: '', label: 'Usage', legacy: '/ai-analytics' },
    { path: 'quality', label: 'Quality', legacy: '/ai-quality' },
    { path: 'knowledge', label: 'Knowledge', legacy: '/ai-knowledge' }
  ]
}

export const USAGE_HUB: HubDef = {
  base: '/analytics',
  title: 'Usage',
  hint: 'How people and integrations use this instance.',
  icon: BarChart2,
  tabs: [
    { path: '', label: 'Pages', legacy: '/analytics' },
    { path: 'api', label: 'API', legacy: '/api-analytics' },
    { path: 'search', label: 'Search', legacy: '/search-analytics' },
    { path: 'replays', label: 'Session replays', legacy: '/session-replays' },
    { path: 'chat', label: 'Chat', legacy: '/chat-analytics' }
  ]
}

export const ALERTS_HUB: HubDef = {
  base: '/alerts',
  title: 'Alerts',
  hint: 'Thresholds and watches that notify people, and what notifies you.',
  icon: BellDot,
  tabs: [
    { path: '', label: 'Field alerts', legacy: '/alerts' },
    { path: 'metrics', label: 'Metric & widget alerts', legacy: '/alert-manager' },
    { path: 'watches', label: 'Field watches', legacy: '/field-watches' },
    { path: 'subscriptions', label: 'My subscriptions', legacy: '/notification-subscriptions' }
  ]
}

export const DELIVERY_HUB: HubDef = {
  base: '/delivery',
  title: 'Delivery',
  hint: 'What was sent, how it looks, and whether people read it.',
  icon: MailCheck,
  tabs: [
    { path: '', label: 'Mail log', legacy: '/mail-log' },
    { path: 'templates', label: 'Mail templates', legacy: '/mail-templates' },
    { path: 'analytics', label: 'Analytics', legacy: '/notification-analytics' },
    { path: 'bench', label: 'Bench', legacy: '/notification-bench' }
  ]
}

export const AUTOMATIONS_HUB: HubDef = {
  base: '/flows',
  title: 'Automations',
  hint: 'Flows and rules that act on records, their tests, and the runs that failed.',
  icon: SlidersHorizontal,
  tabs: [
    { path: '', label: 'Flows', legacy: '/flows' },
    { path: 'rules', label: 'Rules', legacy: '/rules' },
    { path: 'tests', label: 'Tests', legacy: '/automation-tests' },
    { path: 'dead-letters', label: 'Dead letters', legacy: '/dead-letters' }
  ]
}

export const DEADLINES_HUB: HubDef = {
  base: '/deadlines',
  title: 'Deadlines & risk',
  hint: 'When work is due, what is slipping, and the days that do not count.',
  icon: Clock,
  tabs: [
    { path: '', label: 'SLA rules', legacy: '/sla-rules' },
    { path: 'at-risk', label: 'At-risk rules', legacy: '/at-risk' },
    { path: 'scheduled', label: 'Scheduled changes', legacy: '/scheduled-changes' },
    { path: 'blackout', label: 'Blackout dates', legacy: '/blackout-dates' }
  ]
}

export const COVERAGE_HUB: HubDef = {
  base: '/coverage',
  title: 'Coverage',
  hint: 'Who covers for whom, and work nobody can act on.',
  icon: Users,
  tabs: [
    { path: '', label: 'Delegation', legacy: '/delegation' },
    { path: 'gaps', label: 'Coverage gaps', legacy: '/coverage-gaps' },
    { path: 'no-owner', label: 'No owner' }
  ]
}

export const SECURITY_HUB: HubDef = {
  base: '/security-center',
  title: 'Security & privacy',
  hint: 'Sessions and sign-ins, who is online, and how long data is kept.',
  icon: ShieldAlert,
  tabs: [
    { path: '', label: 'Security', legacy: '/security-center' },
    { path: 'presence', label: 'Presence', legacy: '/presence' },
    { path: 'retention', label: 'Retention', legacy: '/privacy-retention' },
    { path: 'logs', label: 'Log retention' },
    { path: 'holds', label: 'Legal holds', legacy: '/legal-holds' }
  ]
}

export const ACCESS_HUB: HubDef = {
  base: '/access',
  title: 'Access reviews',
  hint: 'Requests for record access, and audits of who can reach what.',
  icon: ShieldCheck,
  tabs: [
    { path: '', label: 'Requests', legacy: '/access-requests' },
    { path: 'audits', label: 'Audits', legacy: '/access-audit' }
  ]
}

export const MCP_HUB: HubDef = {
  base: '/mcp',
  title: 'MCP',
  hint: 'AI assistants connected to this instance, the tools they get, the record events that wake them, and a console to try them.',
  icon: Plug,
  tabs: [
    { path: '', label: 'Connections', legacy: '/mcp-connections' },
    { path: 'tools', label: 'Assistant tools', legacy: '/mcp-tools' },
    { path: 'triggers', label: 'Agent triggers', legacy: '/agent-triggers' },
    { path: 'console', label: 'Console', legacy: '/mcp-console' }
  ]
}

export const QUERIES_HUB: HubDef = {
  base: '/custom-queries',
  title: 'Queries',
  hint: 'Saved SQL, a runner for it, and a read-only scratchpad.',
  icon: Code2,
  tabs: [
    { path: '', label: 'Saved queries', legacy: '/custom-queries' },
    { path: 'catalog', label: 'Catalog', legacy: '/query-catalog' },
    { path: 'scratchpad', label: 'Scratchpad', legacy: '/sql-scratchpad' }
  ]
}

export const GRAPHQL_HUB: HubDef = {
  base: '/graphql',
  title: 'GraphQL',
  hint: 'Query the GraphQL API, and register queries by hash.',
  icon: Braces,
  tabs: [
    { path: '', label: 'Explorer', legacy: '/graphql' },
    { path: 'persisted', label: 'Persisted queries', legacy: '/persisted-queries' }
  ]
}

export const DOCS_HUB: HubDef = {
  base: '/docs',
  title: 'Docs',
  hint: 'How Nivaro works, the API’s types and changelogs, and what changed in each release.',
  icon: BookOpen,
  tabs: [
    { path: '', label: 'Guides', legacy: '/docs' },
    { path: 'api', label: 'API downloads', legacy: '/api-docs' },
    { path: 'releases', label: 'Release notes', legacy: '/changelog' }
  ]
}

export const DEV_TOOLS_HUB: HubDef = {
  base: '/dev-tools',
  title: 'Dev tools',
  hint: 'Tools for testing the admin itself.',
  icon: Wrench,
  tabs: [
    { path: '', label: 'E2E recorder', legacy: '/e2e-recorder' },
    { path: 'contrast', label: 'Contrast audit', legacy: '/contrast-audit' }
  ]
}

export const CONFIG_HUB: HubDef = {
  base: '/config',
  title: 'Config hygiene',
  hint: 'Unused, broken or contradicting configuration, and where anything is used.',
  icon: ClipboardCheck,
  tabs: [
    { path: '', label: 'Health', legacy: '/config-health' },
    { path: 'review', label: 'Review', legacy: '/config-review' },
    { path: 'search', label: 'Search', legacy: '/config-search' }
  ]
}

export const DATA_INTEGRITY_HUB: HubDef = {
  base: '/data-integrity',
  title: 'Data Integrity',
  hint: 'Rows that are wrong: records that fail their own form, quality rules, people who can no longer act, and links to records that are gone.',
  icon: ScanSearch,
  tabs: [
    { path: '', label: 'Form conformance' },
    // No `legacy`: every tab keeps the old page's permission key (/data-integrity…);
    // App.tsx redirects /data-quality here.
    { path: 'quality', label: 'Quality rules' },
    { path: 'people', label: 'Inactive people' },
    { path: 'orphans', label: 'Orphans' }
  ]
}

export const HUBS: HubDef[] = [
  JOBS_HUB,
  DATABASE_HUB,
  HEALTH_HUB,
  ENVIRONMENTS_HUB,
  PROMOTION_HUB,
  CONNECTIONS_HUB,
  REPORTS_HUB,
  ACTIVITY_HUB,
  AI_HUB,
  USAGE_HUB,
  ALERTS_HUB,
  DELIVERY_HUB,
  AUTOMATIONS_HUB,
  DEADLINES_HUB,
  COVERAGE_HUB,
  SECURITY_HUB,
  ACCESS_HUB,
  MCP_HUB,
  QUERIES_HUB,
  GRAPHQL_HUB,
  DOCS_HUB,
  DEV_TOOLS_HUB,
  CONFIG_HUB,
  DATA_INTEGRITY_HUB,
  APPS_HUB
]

export const hubTabPath = (hub: HubDef, tab: HubTabDef) =>
  tab.path ? `${hub.base}/${tab.path}` : hub.base

/** The group a tab path is in (hubs with `groups` only), else null. */
export const hubTabGroup = (hub: HubDef, path: string): HubTabGroup | null =>
  hub.groups?.find((g) => g.tabs.includes(path)) ?? null

/**
 * A hub's pages as search entries: found by label, by their group's full name and by the words
 * people use for what the page holds (`keywords`), never only by the page's own name.
 */
export function hubSearchPages(
  hub: HubDef
): Array<{ label: string; path: string; keywords: string }> {
  return hub.tabs.map((t) => {
    const group = hubTabGroup(hub, t.path)
    const home = group ? (group.title ?? group.label) : hub.title
    return {
      label: home === t.label ? t.label : `${t.label} · ${home}`,
      path: hubTabPath(hub, t),
      keywords: [t.keywords, t.hint].filter(Boolean).join(' ')
    }
  })
}

/** The hub and tab a pathname shows, or null when it is not a hub tab. */
export function hubForPath(pathname: string): { hub: HubDef; tab: HubTabDef } | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
  for (const hub of HUBS) {
    if (path !== hub.base && !path.startsWith(`${hub.base}/`)) continue
    const tab = hub.tabs.find((t) => hubTabPath(hub, t) === path)
    if (tab) return { hub, tab }
  }
  return null
}

/** Every path a hub answers on (bases and tab paths). */
export const HUB_PATHS = new Set(HUBS.flatMap((hub) => hub.tabs.map((t) => hubTabPath(hub, t))))

/** Old standalone paths App.tsx redirects onto their tab. */
export const HUB_REDIRECTS = HUBS.flatMap((hub) =>
  hub.tabs.flatMap((tab) => [
    ...(tab.legacy && !HUB_PATHS.has(tab.legacy)
      ? [{ from: tab.legacy, to: hubTabPath(hub, tab) }]
      : []),
    ...(tab.aliases ?? [])
      .map((a) => `${hub.base}/${a}`)
      .filter((from) => !HUB_PATHS.has(from))
      .map((from) => ({ from, to: hubTabPath(hub, tab) }))
  ])
)

/** The key ui_permissions use for a tab: its old path, or its own path. */
export const tabPermissionKey = (hub: HubDef, tab: HubTabDef) => tab.legacy ?? hubTabPath(hub, tab)

const isDisabled = (key: string, disabled: Set<string>) => {
  for (const p of disabled) if (key.startsWith(p)) return true
  return false
}

/**
 * Whether a role's disabled paths hide this pathname. A hub tab is judged by
 * its permission key (so hiding /rules hides /flows/rules, and hiding /flows
 * no longer hides the other Automations tabs); any other path by prefix, as
 * before.
 */
export function isPathDisabled(pathname: string, disabled: Set<string>): boolean {
  if (disabled.size === 0) return false
  const match = hubForPath(pathname)
  if (match) return isDisabled(tabPermissionKey(match.hub, match.tab), disabled)
  return isDisabled(pathname, disabled)
}

/** The tabs of a hub a role may open. */
export const allowedHubTabs = (hub: HubDef, disabled: Set<string>) =>
  hub.tabs.filter((t) => !isDisabled(tabPermissionKey(hub, t), disabled))

/** The hub whose BASE is this path (a nav entry), or null. */
export const hubAtBase = (path: string) => HUBS.find((h) => h.base === path) ?? null
