import {
  Activity,
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
}

export type HubDef = {
  base: string
  title: string
  hint: string
  icon: LucideIcon
  tabs: HubTabDef[]
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
    { path: 'telemetry', label: 'Telemetry', legacy: '/telemetry' }
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
    { path: 'inbound', label: 'Inbound mappings', legacy: '/inbound-mappings' }
  ]
}

export const REPORTS_HUB: HubDef = {
  base: '/reports',
  title: 'Reports',
  hint: 'Reports built from widgets, the ones emailed on a schedule, and team throughput.',
  icon: FileBarChart,
  tabs: [
    { path: '', label: 'Report Studio', legacy: '/report-studio' },
    { path: 'scheduled', label: 'Scheduled', legacy: '/scheduled-reports' },
    { path: 'throughput', label: 'Team throughput', legacy: '/team-throughput' }
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
    { path: 'gaps', label: 'Coverage gaps', legacy: '/coverage-gaps' }
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
  CONFIG_HUB
]

export const hubTabPath = (hub: HubDef, tab: HubTabDef) =>
  tab.path ? `${hub.base}/${tab.path}` : hub.base

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
  hub.tabs.flatMap((tab) =>
    tab.legacy && !HUB_PATHS.has(tab.legacy) ? [{ from: tab.legacy, to: hubTabPath(hub, tab) }] : []
  )
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
