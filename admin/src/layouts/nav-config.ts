import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowRightLeft,
  BarChart2,
  BarChart3,
  Bell,
  BellDot,
  BookOpen,
  Braces,
  Building2,
  CalendarClock,
  CalendarOff,
  CalendarRange,
  CheckSquare,
  Clapperboard,
  ClipboardList,
  Clock,
  Code2,
  Contrast,
  Database,
  DatabaseZap,
  Eye,
  FileBarChart,
  FileImage,
  FileSearch,
  FileText,
  FlaskConical,
  GitBranch,
  GitCompare,
  Globe,
  Grid3x3,
  HeartPulse,
  House,
  Inbox,
  KeyRound,
  KeySquare,
  Layers,
  LayoutGrid,
  LifeBuoy,
  Link2,
  ListFilter,
  ListOrdered,
  Mail,
  MailCheck,
  Megaphone,
  MessagesSquare,
  Network,
  Package,
  Plug,
  PuzzleIcon,
  Radar,
  Radio,
  RefreshCw,
  Replace,
  Rocket,
  RotateCcw,
  Scale,
  ScanSearch,
  ScrollText,
  SearchCode,
  ServerCog,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Siren,
  SlidersHorizontal,
  Sparkles,
  SquareFunction,
  Terminal,
  TerminalSquare,
  ThumbsUp,
  Timer,
  ToggleLeft,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  Users2,
  UserX,
  Video,
  Waypoints,
  Webhook,
  Wifi,
  Wrench
} from 'lucide-react'

/**
 * The admin's navigation map.
 *
 * Organised by the job an operator came to do, not by when a screen was built:
 * each rail category answers one question ("what is in my data?", "who can do
 * what?", "is the platform healthy?") and splits into small named sections so
 * no panel is a wall of links. The first six categories are the day-to-day
 * work; the last four (`zone: 'platform'`) are for the people who run the
 * instance itself, and the rail draws a rule between the two.
 *
 * Roles' ui_permissions store PATHS, so moving a page between categories or
 * renaming its label never changes who may open it. Category ids are kept
 * where the meaning survived (home, content, people, automation, system) so a
 * remembered panel choice in localStorage still lands somewhere sensible.
 */

export type NavItem = {
  icon: React.ElementType
  label: string
  to: string
  section?: string
  /** Extra words the panel's Find box matches on (never shown). */
  keywords?: string
}

export type NavCategory = {
  id: string
  icon: React.ElementType
  label: string
  /** One sentence shown under the panel title, so the category explains itself. */
  hint?: string
  zone?: 'work' | 'platform'
  items: NavItem[]
}

export const navCategories: NavCategory[] = [
  {
    id: 'home',
    icon: House,
    label: 'Home',
    hint: 'Your work and where to start',
    zone: 'work',
    items: [
      { icon: House, label: 'Overview', to: '/', keywords: 'home start' },
      { icon: Inbox, label: 'My Work', to: '/my-work', keywords: 'inbox assigned owned' },
      { icon: CheckSquare, label: 'Tasks', to: '/tasks', keywords: 'todo assignments' },
      { icon: LayoutGrid, label: 'Dashboards', to: '/dashboards', keywords: 'kpi widgets' },
      { icon: Radar, label: 'Command Center', to: '/command', keywords: 'map live' },
      { icon: Sparkles, label: 'Ask AI', to: '/ask', keywords: 'chat question assistant' },
      { icon: MessagesSquare, label: 'Chat', to: '/chat', keywords: 'messages dm channels' },
      { icon: LifeBuoy, label: 'Support', to: '/support', keywords: 'help tickets request' }
    ]
  },
  {
    id: 'content',
    icon: Database,
    label: 'Data',
    hint: 'Records, their shape, and bulk changes',
    zone: 'work',
    items: [
      { icon: Database, label: 'Collections', to: '/collections', section: 'Records' },
      { icon: FileImage, label: 'Files', to: '/files', section: 'Records', keywords: 'uploads' },
      {
        icon: Trash2,
        label: 'Trash',
        to: '/trash',
        section: 'Records',
        keywords: 'deleted restore'
      },
      {
        icon: DatabaseZap,
        label: 'Data Model',
        to: '/data-model',
        section: 'Structure',
        keywords: 'schema fields tables layouts'
      },
      { icon: Network, label: 'Hierarchies', to: '/hierarchies', section: 'Structure' },
      {
        icon: Layers,
        label: 'Virtual Collections',
        to: '/virtual-collections',
        section: 'Structure',
        keywords: 'sql view'
      },
      {
        icon: ListOrdered,
        label: 'ID Sequences',
        to: '/sequences',
        section: 'Structure',
        keywords: 'auto id numbering'
      },
      {
        icon: FileText,
        label: 'Record Templates',
        to: '/record-templates',
        section: 'Templates & forms'
      },
      {
        icon: Package,
        label: 'Collection Presets',
        to: '/collection-presets',
        section: 'Templates & forms'
      },
      {
        icon: Globe,
        label: 'Submission Forms',
        to: '/submission-forms',
        section: 'Templates & forms',
        keywords: 'public form'
      },
      {
        icon: LayoutGrid,
        label: 'Pages',
        to: '/pages-admin',
        section: 'Templates & forms',
        keywords: 'page builder'
      },
      {
        icon: FileText,
        label: 'PDF Templates',
        to: '/pdf-templates',
        section: 'Templates & forms'
      },
      {
        icon: Upload,
        label: 'Imports',
        to: '/imports',
        section: 'Bulk changes',
        keywords: 'csv staged upload'
      },
      { icon: Replace, label: 'Find & Replace', to: '/find-replace', section: 'Bulk changes' },
      {
        icon: Grid3x3,
        label: 'M2M Matrix',
        to: '/m2m-matrix',
        section: 'Bulk changes',
        keywords: 'many to many links'
      },
      {
        icon: ScanSearch,
        label: 'Data Integrity',
        to: '/data-integrity',
        section: 'Bulk changes',
        keywords: 'quality conformance inactive people'
      }
    ]
  },
  {
    id: 'automation',
    icon: GitBranch,
    label: 'Workflow',
    hint: 'How records move, and the rules around them',
    zone: 'work',
    items: [
      {
        icon: GitBranch,
        label: 'Pipelines',
        to: '/pipelines',
        section: 'Processes',
        keywords: 'workflow states owners matrix'
      },
      { icon: ThumbsUp, label: 'Approvals', to: '/approvals', section: 'Processes' },
      {
        icon: Inbox,
        label: 'Queues',
        to: '/queues',
        section: 'Processes',
        keywords: 'worklist'
      },
      { icon: SlidersHorizontal, label: 'Flows', to: '/flows', section: 'Automations' },
      {
        icon: ListFilter,
        label: 'Rules',
        to: '/rules',
        section: 'Automations',
        keywords: 'conditions triggers'
      },
      {
        icon: FlaskConical,
        label: 'Automation Tests',
        to: '/automation-tests',
        section: 'Automations'
      },
      { icon: Clock, label: 'SLA Rules', to: '/sla-rules', section: 'Deadlines & risk' },
      { icon: AlertTriangle, label: 'At-Risk Rules', to: '/at-risk', section: 'Deadlines & risk' },
      {
        icon: CalendarClock,
        label: 'Scheduled Changes',
        to: '/scheduled-changes',
        section: 'Deadlines & risk'
      },
      {
        icon: CalendarOff,
        label: 'Blackout Dates',
        to: '/blackout-dates',
        section: 'Deadlines & risk',
        keywords: 'holidays'
      }
    ]
  },
  {
    id: 'people',
    icon: Users,
    label: 'People',
    hint: 'Who is here and what they may do',
    zone: 'work',
    items: [
      { icon: Users, label: 'Users', to: '/users', section: 'Directory', keywords: 'accounts' },
      { icon: Users2, label: 'Teams', to: '/user-groups', section: 'Directory' },
      { icon: Building2, label: 'Workspaces', to: '/workspaces', section: 'Directory' },
      {
        icon: Shield,
        label: 'Roles',
        to: '/roles',
        section: 'Access',
        keywords: 'permissions policies rbac'
      },
      { icon: SlidersHorizontal, label: 'User Scopes', to: '/scope-dimensions', section: 'Access' },
      { icon: KeyRound, label: 'Access Requests', to: '/access-requests', section: 'Access' },
      { icon: ShieldCheck, label: 'Access Audit', to: '/access-audit', section: 'Access' },
      {
        icon: Users,
        label: 'Delegation',
        to: '/delegation',
        section: 'Availability',
        keywords: 'out of office ooo cover'
      },
      {
        icon: UserX,
        label: 'Coverage Gaps',
        to: '/coverage-gaps',
        section: 'Availability',
        keywords: 'unowned'
      },
      {
        icon: Wifi,
        label: 'Presence',
        to: '/presence',
        section: 'Availability',
        keywords: 'online'
      },
      {
        icon: ShieldAlert,
        label: 'Security Center',
        to: '/security-center',
        section: 'Security & privacy',
        keywords: 'sessions logins'
      },
      { icon: Scale, label: 'Legal Holds', to: '/legal-holds', section: 'Security & privacy' },
      {
        icon: ShieldOff,
        label: 'Privacy & Retention',
        to: '/privacy-retention',
        section: 'Security & privacy',
        keywords: 'redaction gdpr'
      }
    ]
  },
  {
    id: 'notify',
    icon: Bell,
    label: 'Notifications',
    hint: 'Alerts, messages, and how they are delivered',
    zone: 'work',
    items: [
      { icon: BellDot, label: 'Alerts', to: '/alerts', section: 'Alerts & watching' },
      {
        icon: Siren,
        label: 'Alert Manager',
        to: '/alert-manager',
        section: 'Alerts & watching',
        keywords: 'metric anomaly'
      },
      { icon: Eye, label: 'Field Watches', to: '/field-watches', section: 'Alerts & watching' },
      {
        icon: Bell,
        label: 'Subscriptions',
        to: '/notification-subscriptions',
        section: 'Alerts & watching'
      },
      {
        icon: Megaphone,
        label: 'Broadcasts',
        to: '/announcements',
        section: 'Messages',
        keywords: 'announcement banner bulk message'
      },
      {
        icon: Mail,
        label: 'Mail Templates',
        to: '/mail-templates',
        section: 'Messages',
        keywords: 'email'
      },
      {
        icon: MailCheck,
        label: 'Mail Log',
        to: '/mail-log',
        section: 'Delivery',
        keywords: 'email sent bounce'
      },
      {
        icon: BarChart3,
        label: 'Notification Analytics',
        to: '/notification-analytics',
        section: 'Delivery'
      },
      {
        icon: FlaskConical,
        label: 'Notification Bench',
        to: '/notification-bench',
        section: 'Delivery',
        keywords: 'test simulate'
      }
    ]
  },
  {
    id: 'insights',
    icon: BarChart3,
    label: 'Insights',
    hint: 'Reports, usage, and the history of every change',
    zone: 'work',
    items: [
      { icon: FileBarChart, label: 'Reports', to: '/reports', section: 'Reports' },
      { icon: BarChart3, label: 'Report Studio', to: '/report-studio', section: 'Reports' },
      {
        icon: FileBarChart,
        label: 'Scheduled Reports',
        to: '/scheduled-reports',
        section: 'Reports'
      },
      { icon: TrendingUp, label: 'Team Throughput', to: '/team-throughput', section: 'Reports' },
      {
        icon: BarChart2,
        label: 'Analytics',
        to: '/analytics',
        section: 'Usage',
        keywords: 'page views'
      },
      { icon: BarChart2, label: 'API Analytics', to: '/api-analytics', section: 'Usage' },
      { icon: Sparkles, label: 'AI Analytics', to: '/ai-analytics', section: 'Usage' },
      { icon: MessagesSquare, label: 'Chat Analytics', to: '/chat-analytics', section: 'Usage' },
      {
        icon: Clapperboard,
        label: 'Session Replays',
        to: '/session-replays',
        section: 'Usage',
        keywords: 'recording rrweb'
      },
      { icon: Activity, label: 'Activity', to: '/activity', section: 'History', keywords: 'audit' },
      { icon: Radio, label: 'Pulse', to: '/pulse', section: 'History' },
      {
        icon: FileSearch,
        label: 'History Search',
        to: '/revision-search',
        section: 'History',
        keywords: 'revisions'
      },
      {
        icon: GitBranch,
        label: 'Value Provenance',
        to: '/provenance',
        section: 'History',
        keywords: 'where did this value come from'
      }
    ]
  },
  {
    id: 'integrations',
    icon: Plug,
    label: 'Integrations',
    hint: 'Partner systems, in and out',
    zone: 'platform',
    items: [
      {
        icon: Link2,
        label: 'Integration Health',
        to: '/integration-health',
        section: 'Health',
        keywords: 'firefight partners obligations events console'
      },
      {
        icon: Upload,
        label: 'ERP Submissions',
        to: '/erp-submissions',
        section: 'Health',
        keywords: 'push fusion mdsi'
      },
      {
        icon: RotateCcw,
        label: 'Dead Letters',
        to: '/dead-letters',
        section: 'Health',
        keywords: 'failed retry'
      },
      { icon: Link2, label: 'External APIs', to: '/external-apis', section: 'Connections' },
      { icon: Webhook, label: 'Webhooks', to: '/webhooks', section: 'Connections' },
      { icon: RefreshCw, label: 'Sync Jobs', to: '/sync-jobs', section: 'Connections' },
      {
        icon: Inbox,
        label: 'Inbound Mappings',
        to: '/inbound-mappings',
        section: 'Connections',
        keywords: 'inbound payload'
      }
    ]
  },
  {
    id: 'operations',
    icon: HeartPulse,
    label: 'Operations',
    hint: 'Keep the instance healthy and ship changes safely',
    zone: 'platform',
    items: [
      { icon: HeartPulse, label: 'Health', to: '/health', section: 'Health', keywords: 'slo' },
      { icon: AlertOctagon, label: 'Issues', to: '/issues', section: 'Health', keywords: 'errors' },
      { icon: Radar, label: 'Monitors', to: '/monitors', section: 'Health' },
      {
        icon: Database,
        label: 'DB & Runtime',
        to: '/db-health',
        section: 'Health',
        keywords: 'database pool indexes deadlocks'
      },
      { icon: Waypoints, label: 'Traffic Map', to: '/traffic-map', section: 'Health' },
      { icon: Radio, label: 'Realtime', to: '/realtime', section: 'Health', keywords: 'sockets' },
      {
        icon: Activity,
        label: 'Background Jobs',
        to: '/background-jobs',
        section: 'Jobs',
        keywords: 'cron'
      },
      { icon: Timer, label: 'Cron Timeline', to: '/cron-timeline', section: 'Jobs' },
      { icon: CalendarRange, label: 'Ops Calendar', to: '/ops-calendar', section: 'Jobs' },
      { icon: Wrench, label: 'Ops Tasks', to: '/ops-tasks', section: 'Jobs', keywords: 'repairs' },
      {
        icon: TerminalSquare,
        label: 'Ops Console',
        to: '/ops-console',
        section: 'Jobs',
        keywords: 'logs maintenance restart'
      },
      { icon: KeySquare, label: 'Redis Keys', to: '/ops-redis', section: 'Jobs' },
      {
        icon: ServerCog,
        label: 'Environments',
        to: '/environments',
        section: 'Release',
        keywords: 'deploy pipelines release'
      },
      {
        icon: GitCompare,
        label: 'Environment Config',
        to: '/config-diff',
        section: 'Release',
        keywords: 'diff drift'
      },
      { icon: Rocket, label: 'Go-Live Readiness', to: '/readiness', section: 'Release' },
      {
        icon: ArrowRightLeft,
        label: 'Content Promotion',
        to: '/content-promotion',
        section: 'Release'
      },
      { icon: Package, label: 'Blueprints', to: '/blueprints', section: 'Release' },
      { icon: ClipboardList, label: 'Change Sets', to: '/change-sets', section: 'Release' }
    ]
  },
  {
    id: 'developer',
    icon: Code2,
    label: 'Developer',
    hint: 'APIs, queries, and extending the platform',
    zone: 'platform',
    items: [
      { icon: KeyRound, label: 'API Keys', to: '/api-keys', section: 'APIs', keywords: 'token' },
      { icon: Braces, label: 'GraphQL', to: '/graphql', section: 'APIs', keywords: 'explorer' },
      { icon: Braces, label: 'Persisted Queries', to: '/persisted-queries', section: 'APIs' },
      {
        icon: Terminal,
        label: 'Playground',
        to: '/playground',
        section: 'APIs',
        keywords: 'sdk repl'
      },
      { icon: Code2, label: 'Custom Queries', to: '/custom-queries', section: 'Queries' },
      { icon: BookOpen, label: 'Query Catalog', to: '/query-catalog', section: 'Queries' },
      {
        icon: SquareFunction,
        label: 'Procedures',
        to: '/procedures',
        section: 'Queries',
        keywords: 'stored procedure sql'
      },
      { icon: TerminalSquare, label: 'SQL Scratchpad', to: '/sql-scratchpad', section: 'Queries' },
      { icon: PuzzleIcon, label: 'Extensions', to: '/extensions', section: 'Extend & test' },
      {
        icon: LayoutGrid,
        label: 'Widgets',
        to: '/widgets',
        section: 'Extend & test',
        keywords: 'embed feeds'
      },
      { icon: Video, label: 'E2E Recorder', to: '/e2e-recorder', section: 'Extend & test' },
      {
        icon: Contrast,
        label: 'Contrast Audit',
        to: '/contrast-audit',
        section: 'Extend & test'
      },
      { icon: BookOpen, label: 'Docs', to: '/docs', section: 'Reference' },
      {
        icon: ScrollText,
        label: 'API Docs',
        to: '/api-docs',
        section: 'Reference',
        keywords: 'openapi'
      }
    ]
  },
  {
    id: 'system',
    icon: Settings,
    label: 'System',
    hint: 'Instance-wide settings',
    zone: 'platform',
    items: [
      { icon: Settings, label: 'Settings', to: '/settings', keywords: 'smtp sms ai sign-in' },
      { icon: ToggleLeft, label: 'Feature Flags', to: '/feature-flags' },
      {
        icon: Sparkles,
        label: 'Config Health',
        to: '/config-health',
        keywords: 'lint hygiene'
      },
      {
        icon: SearchCode,
        label: 'Config Search',
        to: '/config-search',
        keywords: 'where is this used'
      },
      { icon: Rocket, label: 'Setup Checklist', to: '/setup-checklist', keywords: 'onboarding' }
    ]
  }
]

export function isActiveRoute(itemTo: string, pathname: string): boolean {
  return itemTo === '/' ? pathname === '/' : pathname.startsWith(itemTo)
}

/** The category owning the most specific nav entry for this path. */
export function findCategoryForPath(pathname: string): string | null {
  let best: { len: number; id: string } | null = null
  for (const cat of navCategories) {
    for (const item of cat.items) {
      if (isActiveRoute(item.to, pathname) && (!best || item.to.length > best.len)) {
        best = { len: item.to.length, id: cat.id }
      }
    }
  }
  return best?.id ?? null
}

/** The icon of the most specific nav entry a path sits under (Star-less fallback is the caller's). */
export function iconForPath(path: string): React.ElementType | null {
  let best: { len: number; icon: React.ElementType } | null = null
  for (const cat of navCategories) {
    for (const item of cat.items) {
      if (path === item.to || (item.to !== '/' && path.startsWith(`${item.to}/`))) {
        if (!best || item.to.length > best.len) best = { len: item.to.length, icon: item.icon }
      }
    }
  }
  return best?.icon ?? null
}
