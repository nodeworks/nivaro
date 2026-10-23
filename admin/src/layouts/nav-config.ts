import {
  Activity,
  AlertOctagon,
  ArrowRightLeft,
  BarChart2,
  BarChart3,
  Bell,
  BellDot,
  BookOpen,
  Braces,
  Building2,
  CheckSquare,
  ClipboardCheck,
  Clock,
  Code2,
  Container,
  Database,
  DatabaseZap,
  FileBarChart,
  FileImage,
  FileText,
  GitBranch,
  Globe,
  Grid3x3,
  HeartPulse,
  House,
  Inbox,
  KeyRound,
  Layers,
  LayoutGrid,
  LifeBuoy,
  Lightbulb,
  Link2,
  ListChecks,
  ListOrdered,
  MailCheck,
  Megaphone,
  MessagesSquare,
  MonitorPlay,
  Network,
  Plug,
  PuzzleIcon,
  Radar,
  Radio,
  Replace,
  Rocket,
  ScanSearch,
  ServerCog,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  Sparkles,
  SquareFunction,
  Terminal,
  TerminalSquare,
  ThumbsUp,
  ToggleLeft,
  Trash2,
  Upload,
  Users,
  Users2,
  UserX,
  Video,
  Waypoints,
  Webhook
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
      {
        icon: ListChecks,
        label: 'AI Plans',
        to: '/ai-plans',
        keywords: 'ask ai plan history undo templates scheduled'
      },
      { icon: MessagesSquare, label: 'Chat', to: '/chat', keywords: 'messages dm channels' },
      { icon: LifeBuoy, label: 'Support', to: '/support', keywords: 'help tickets request' },
      {
        icon: MonitorPlay,
        label: 'Videos',
        to: '/help-videos',
        keywords: 'help tutorial training how to demo'
      },
      {
        icon: Lightbulb,
        label: 'Ideas',
        to: '/ideas',
        keywords: 'feature requests suggest a feature feedback vote roadmap'
      }
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
        keywords: 'workflow states owners matrix'
      },
      { icon: ThumbsUp, label: 'Approvals', to: '/approvals' },
      { icon: Inbox, label: 'Queues', to: '/queues', keywords: 'worklist' },
      {
        icon: SlidersHorizontal,
        label: 'Automations',
        to: '/flows',
        keywords: 'flows rules conditions triggers automation tests dead letters failed retry'
      },
      {
        icon: Clock,
        label: 'Deadlines & risk',
        to: '/deadlines',
        keywords: 'sla rules at-risk scheduled changes blackout dates holidays'
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
      {
        icon: ShieldCheck,
        label: 'Access reviews',
        to: '/access',
        section: 'Access',
        keywords: 'access requests access audit'
      },
      {
        icon: UserX,
        label: 'Coverage',
        to: '/coverage',
        section: 'Oversight',
        keywords: 'delegation out of office ooo cover coverage gaps unowned'
      },
      {
        icon: ShieldAlert,
        label: 'Security & privacy',
        to: '/security-center',
        section: 'Oversight',
        keywords:
          'security center sessions logins presence online retention redaction gdpr legal holds'
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
      {
        icon: BellDot,
        label: 'Alerts',
        to: '/alerts',
        keywords:
          'alert manager metric anomaly widget alerts field watches notification subscriptions'
      },
      {
        icon: Megaphone,
        label: 'Broadcasts',
        to: '/announcements',
        keywords: 'announcement banner bulk message'
      },
      {
        icon: MailCheck,
        label: 'Delivery',
        to: '/delivery',
        keywords:
          'mail log email sent bounce mail templates notification analytics notification bench test simulate'
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
      {
        icon: FileBarChart,
        label: 'Reports',
        to: '/reports',
        keywords: 'report studio scheduled reports team throughput'
      },
      {
        icon: Activity,
        label: 'Activity',
        to: '/activity',
        keywords: 'audit log audit report pulse live history search revisions value provenance'
      },
      {
        icon: BarChart2,
        label: 'Usage',
        to: '/analytics',
        keywords:
          'analytics page views api analytics search analytics session replays recording rrweb chat analytics'
      },
      {
        icon: Sparkles,
        label: 'AI',
        to: '/ai',
        keywords: 'ai analytics ai quality ai knowledge glossary data guide spend models'
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
        keywords: 'firefight partners obligations events console erp submissions push fusion mdsi'
      },
      {
        icon: Webhook,
        label: 'Connections',
        to: '/connections',
        keywords: 'external apis webhooks sync jobs inbound mappings payload'
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
      {
        icon: HeartPulse,
        label: 'Health',
        to: '/health',
        section: 'Health',
        keywords:
          'slo status preflight monitors probes ssl freshness uptime telemetry grafana traces logs metrics alerts backups monitoring'
      },
      { icon: AlertOctagon, label: 'Issues', to: '/issues', section: 'Health', keywords: 'errors' },
      {
        icon: Database,
        label: 'Database',
        to: '/database',
        section: 'Health',
        keywords:
          'db runtime pool indexes deadlocks tuning proposals procedure rewrite cache rollup sql checks merge null lint sqlfluff findings redis keys'
      },
      { icon: Waypoints, label: 'Traffic Map', to: '/traffic-map', section: 'Health' },
      {
        icon: Container,
        label: 'Infrastructure',
        to: '/infrastructure',
        section: 'Health',
        keywords: 'docker swarm stacks containers services volumes images traefik hosts reboot'
      },
      { icon: Radio, label: 'Realtime', to: '/realtime', section: 'Health', keywords: 'sockets' },
      {
        icon: Siren,
        label: 'Chaos',
        to: '/chaos',
        section: 'Health',
        keywords: 'chaos drill fault injection resilience game day stop all'
      },
      {
        icon: Activity,
        label: 'Jobs',
        to: '/jobs',
        section: 'Jobs',
        keywords:
          'background cron runs schedules timeline calendar ops repair tasks backfill remediation'
      },
      {
        icon: TerminalSquare,
        label: 'Ops Console',
        to: '/ops-console',
        section: 'Jobs',
        keywords: 'logs maintenance restart'
      },
      {
        icon: ServerCog,
        label: 'Environments',
        to: '/environments',
        section: 'Release',
        keywords:
          'deploy pipelines release environment config diff drift go-live readiness quality checks'
      },
      {
        icon: ArrowRightLeft,
        label: 'Promotion',
        to: '/promotion',
        section: 'Release',
        keywords:
          'content promotion blueprints change sets schema snapshot starter kits collection presets'
      }
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
      {
        icon: Plug,
        label: 'MCP',
        to: '/mcp',
        section: 'APIs',
        keywords:
          'mcp connections assistant tools mcp console ai agent claude chatgpt codex oauth connected apps'
      },
      {
        icon: Braces,
        label: 'GraphQL',
        to: '/graphql',
        section: 'APIs',
        keywords: 'explorer persisted queries'
      },
      {
        icon: Terminal,
        label: 'Playground',
        to: '/playground',
        section: 'APIs',
        keywords: 'sdk repl'
      },
      {
        icon: Code2,
        label: 'Queries',
        to: '/custom-queries',
        section: 'Queries',
        keywords: 'custom queries query catalog sql scratchpad'
      },
      {
        icon: SquareFunction,
        label: 'Procedures',
        to: '/procedures',
        section: 'Queries',
        keywords: 'stored procedure sql'
      },
      { icon: PuzzleIcon, label: 'Extensions', to: '/extensions', section: 'Extend & test' },
      {
        icon: LayoutGrid,
        label: 'Widgets',
        to: '/widgets',
        section: 'Extend & test',
        keywords: 'embed feeds'
      },
      {
        icon: Video,
        label: 'Dev tools',
        to: '/dev-tools',
        section: 'Extend & test',
        keywords: 'e2e recorder contrast audit playwright'
      },
      {
        icon: BookOpen,
        label: 'Docs',
        to: '/docs',
        section: 'Reference',
        keywords: 'api docs openapi changelog release notes'
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
        icon: ClipboardCheck,
        label: 'Config hygiene',
        to: '/config',
        keywords:
          'config health config review config search lint hygiene monthly cleanup duplicate unused where is this used'
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
