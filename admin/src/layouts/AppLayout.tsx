import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
  Check,
  CheckSquare,
  Clapperboard,
  Clock,
  Code2,
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
  LayoutGrid,
  Link2,
  ListFilter,
  ListOrdered,
  LogOut,
  Mail,
  MailCheck,
  Megaphone,
  MessagesSquare,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  PuzzleIcon,
  Radar,
  Radio,
  RefreshCw,
  Replace,
  Rocket,
  RotateCcw,
  RotateCw,
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
  Star,
  Terminal,
  TerminalSquare,
  ThumbsUp,
  Trash2,
  TrendingUp,
  Upload,
  UserRound,
  UserX,
  Users,
  Webhook,
  Wifi,
  Workflow,
  X as XIcon
} from 'lucide-react'
import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Link, Navigate, Outlet, useLocation } from 'react-router'
import { rumRouteChange, setDisplayTimezone, startRum } from '@nivaro/shared'
import { adminRealtime } from '@/lib/socket'

/** '/collections/workflows/312100' → '/collections/:c/:id' — RUM aggregates
 *  per page, not per record. */
function rumPattern(path: string): string {
  return path
    .split('/')
    .map((seg, i) => {
      if (i <= 1) return seg
      if (/^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg)) return ':id'
      return seg
    })
    .join('/')
    .replace(/^\/collections\/[^/]+/, (m) => (m.split('/').length > 2 ? '/collections/:c' : m))
}
import { BugReporter } from '@/components/bug-reporter'
import { CommandPalette } from '@/components/command-palette'
import { NotificationBell } from '@/components/notification-bell'
import { KeyboardShortcuts } from '@/components/shortcuts-overlay'
import { TeamChatDock } from '@/components/team-chat'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useCloudPlugins, useExtensionPlugins } from '@/extensions/store'
import type { NavSidebarSlot } from '@/extensions/types'
import { api, WORKSPACE_KEY, type Workspace } from '@/lib/api'
import { logout, useAuth } from '@/lib/auth'
import { useT } from '@/lib/i18n'
import { usePagePresence } from '@/lib/use-page-presence'
import { captureErrorClip, useSessionRecorder } from '@/lib/use-session-recorder'
import { useSettings } from '@/lib/useSettings'
import { useUiPermissions } from '@/lib/useUiPermissions'
import { cn } from '@/lib/utils'
import { AnnouncementBanner, ApiUpdateBanner, NivaroProvider, RealtimeContext } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'

const announcementsClient = createNivaro(window.location.origin)

const SIDEBAR_KEY = 'nivaro-sidebar-collapsed'
const CATEGORY_KEY = 'nivaro-nav-category'

export type NavItem = { icon: React.ElementType; label: string; to: string }
export type NavCategory = { id: string; icon: React.ElementType; label: string; items: NavItem[] }

export const navCategories: NavCategory[] = [
  {
    id: 'home',
    icon: House,
    label: 'Home',
    items: [
      { icon: House, label: 'Overview', to: '/' },
      { icon: Inbox, label: 'My Work', to: '/my-work' },
      { icon: LayoutGrid, label: 'Dashboards', to: '/dashboards' },
      { icon: Sparkles, label: 'Ask AI', to: '/ask' },
      { icon: MessagesSquare, label: 'Chat', to: '/chat' }
    ]
  },
  {
    id: 'content',
    icon: Database,
    label: 'Content',
    items: [
      { icon: Database, label: 'Collections', to: '/collections' },
      { icon: DatabaseZap, label: 'Data Model', to: '/data-model' },
      { icon: CheckSquare, label: 'Tasks', to: '/tasks' },
      { icon: FileImage, label: 'Files', to: '/files' },
      { icon: Network, label: 'Hierarchies', to: '/hierarchies' },
      { icon: FileText, label: 'Record Templates', to: '/record-templates' },
      { icon: Package, label: 'Collection Presets', to: '/collection-presets' },
      { icon: LayoutGrid, label: 'Pages', to: '/pages-admin' },
      { icon: FileText, label: 'PDF Templates', to: '/pdf-templates' }
    ]
  },
  {
    id: 'people',
    icon: Users,
    label: 'People',
    items: [
      { icon: Users, label: 'Users', to: '/users' },
      { icon: Shield, label: 'Roles', to: '/roles' },
      { icon: Building2, label: 'Workspaces', to: '/workspaces' },
      { icon: SlidersHorizontal, label: 'User Scopes', to: '/scope-dimensions' }
    ]
  },
  {
    id: 'automation',
    icon: GitBranch,
    label: 'Automation',
    items: [
      { icon: GitBranch, label: 'Pipelines', to: '/pipelines' },
      { icon: SlidersHorizontal, label: 'Flows', to: '/flows' },
      { icon: ThumbsUp, label: 'Approvals', to: '/approvals' },
      { icon: Inbox, label: 'Queues', to: '/queues' },
      { icon: Webhook, label: 'Webhooks', to: '/webhooks' },
      { icon: ListFilter, label: 'Rules', to: '/rules' },
      { icon: CalendarOff, label: 'Blackout Dates', to: '/blackout-dates' },
      { icon: CalendarClock, label: 'Scheduled Changes', to: '/scheduled-changes' },
      { icon: RefreshCw, label: 'Sync Jobs', to: '/sync-jobs' },
      { icon: Upload, label: 'ERP Submissions', to: '/erp-submissions' }
    ]
  },
  {
    id: 'monitoring',
    icon: Activity,
    label: 'Monitoring',
    items: [
      { icon: Activity, label: 'Activity', to: '/activity' },
      { icon: Radio, label: 'Pulse', to: '/pulse' },
      { icon: FileBarChart, label: 'Reports', to: '/reports' },
      { icon: FileBarChart, label: 'Scheduled Reports', to: '/scheduled-reports' },
      { icon: TrendingUp, label: 'Team Throughput', to: '/team-throughput' },
      { icon: BellDot, label: 'Alerts', to: '/alerts' },
      { icon: Siren, label: 'Alert Manager', to: '/alert-manager' },
      { icon: AlertTriangle, label: 'At-Risk Rules', to: '/at-risk' },
      { icon: Clock, label: 'SLA Rules', to: '/sla-rules' },
      { icon: ShieldCheck, label: 'Access Audit', to: '/access-audit' },
      { icon: UserX, label: 'Coverage Gaps', to: '/coverage-gaps' },
      { icon: Link2, label: 'Integrations', to: '/integration-health' },
      { icon: Activity, label: 'Background Jobs', to: '/background-jobs' },
      { icon: Radio, label: 'Realtime', to: '/realtime' },
      { icon: Radar, label: 'Monitors', to: '/monitors' },
      { icon: CalendarClock, label: 'Ops Calendar', to: '/ops-calendar' },
      { icon: Sparkles, label: 'Config Health', to: '/config-health' },
      { icon: FlaskConical, label: 'Automation Tests', to: '/automation-tests' },
      { icon: ShieldAlert, label: 'Security Center', to: '/security-center' },
      { icon: Scale, label: 'Legal Holds', to: '/legal-holds' },
      { icon: Replace, label: 'Find & Replace', to: '/find-replace' },
      { icon: Grid3x3, label: 'M2M Matrix', to: '/m2m-matrix' },
      { icon: Mail, label: 'Mail Templates', to: '/mail-templates' },
      { icon: SearchCode, label: 'Config Search', to: '/config-search' },
      { icon: ListOrdered, label: 'ID Sequences', to: '/sequences' },
      { icon: TerminalSquare, label: 'SQL Scratchpad', to: '/sql-scratchpad' },
      { icon: FileSearch, label: 'History Search', to: '/revision-search' },
      { icon: KeyRound, label: 'Access Requests', to: '/access-requests' },
      { icon: MailCheck, label: 'Mail Log', to: '/mail-log' },
      { icon: Rocket, label: 'Setup Checklist', to: '/setup-checklist' },
      { icon: Eye, label: 'Field Watches', to: '/field-watches' },
      { icon: Bell, label: 'Subscriptions', to: '/notification-subscriptions' },
      { icon: Upload, label: 'Imports', to: '/imports' },
      { icon: Globe, label: 'Submission Forms', to: '/submission-forms' },
      { icon: BarChart2, label: 'API Analytics', to: '/api-analytics' },
      { icon: HeartPulse, label: 'Health', to: '/health' },
      { icon: ScanSearch, label: 'Data Integrity', to: '/data-integrity' },
      { icon: ShieldOff, label: 'Privacy & Retention', to: '/privacy-retention' },
      { icon: AlertOctagon, label: 'Issues', to: '/issues' },
      { icon: RotateCcw, label: 'Dead Letters', to: '/dead-letters' }
    ]
  },
  {
    id: 'system',
    icon: Settings,
    label: 'System',
    items: [
      { icon: Database, label: 'Virtual Collections', to: '/virtual-collections' },
      { icon: ArrowRightLeft, label: 'Content Promotion', to: '/content-promotion' },
      { icon: GitCompare, label: 'Environment Config', to: '/config-diff' },
      { icon: ServerCog, label: 'Environments', to: '/environments' },
      { icon: Rocket, label: 'Go-Live Readiness', to: '/readiness' },
      { icon: Megaphone, label: 'Broadcasts', to: '/announcements' },
      { icon: Package, label: 'Blueprints', to: '/blueprints' },
      { icon: Trash2, label: 'Trash', to: '/trash' },
      { icon: Link2, label: 'External APIs', to: '/external-apis' },
      { icon: Braces, label: 'GraphQL', to: '/graphql' },
      { icon: Code2, label: 'Custom Queries', to: '/custom-queries' },
      { icon: PuzzleIcon, label: 'Extensions', to: '/extensions' },
      { icon: BarChart2, label: 'Analytics', to: '/analytics' },
      { icon: BarChart3, label: 'Report Studio', to: '/report-studio' },
      { icon: Wifi, label: 'Presence', to: '/presence' },
      { icon: Clapperboard, label: 'Session Replays', to: '/session-replays' },
      { icon: KeyRound, label: 'API Keys', to: '/api-keys' },
      { icon: Terminal, label: 'Playground', to: '/playground' },
      { icon: Braces, label: 'Persisted Queries', to: '/persisted-queries' },
      { icon: LayoutGrid, label: 'Widgets', to: '/widgets' },
      { icon: BookOpen, label: 'Docs', to: '/docs' },
      { icon: ScrollText, label: 'API Docs', to: '/api-docs' },
      { icon: Settings, label: 'Settings', to: '/settings' }
    ]
  }
]

function isActiveRoute(itemTo: string, pathname: string): boolean {
  return itemTo === '/' ? pathname === '/' : pathname.startsWith(itemTo)
}

function findCategoryForPath(pathname: string): string | null {
  for (const cat of navCategories) {
    for (const item of cat.items) {
      if (isActiveRoute(item.to, pathname)) return cat.id
    }
  }
  return null
}

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Report to the issue log (deduped server-side); never block rendering.
    // captureErrorClip resolves the replay link (live recording offset, or an
    // uploaded last-minute clip in buffer mode) — null when neither mode is
    // on, and it self-times-out so the report never waits long for it.
    void captureErrorClip().then((replay) => {
      api
        .post('/issues/client', {
          message: error.message,
          stack: [error.stack, info.componentStack].filter(Boolean).join('\n---\n').slice(0, 6000),
          url: window.location.pathname,
          ...(replay
            ? { recording_id: replay.recording_id, recording_offset_ms: replay.offset_ms }
            : {})
        })
        .catch(() => {})
    })
  }
  render() {
    if (this.state.error) {
      return (
        <div className='flex flex-1 min-h-0 flex-col items-center justify-center gap-3 p-8 text-center'>
          <p className='text-sm font-medium text-slate-900 dark:text-foreground'>
            Something went wrong loading this page.
          </p>
          <p className='max-w-sm text-xs text-muted-foreground'>{this.state.error.message}</p>
          <button
            type='button'
            onClick={() => this.setState({ error: null })}
            className='rounded-md bg-nvr-cyan px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110'
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function NivaroMark({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true'>
      <rect x='2' y='2' width='6' height='20' fill={color} />
      <rect x='16' y='2' width='6' height='20' fill={color} />
      <polygon points='8,2 12.5,2 16,22 11.5,22' fill={color} />
    </svg>
  )
}

function WorkspaceSwitcher() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)

  const { data: workspaces = [] } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ data: Workspace[] }>('/workspaces').then((r) => r.data.data)
  })

  const switchMut = useMutation({
    mutationFn: (id: string) => api.post(`/workspaces/${id}/switch`),
    onSuccess: (_, id) => {
      localStorage.setItem(WORKSPACE_KEY, id)
      window.location.reload()
    }
  })

  const current = workspaces.find((w) => w.id === user?.current_workspace) ?? workspaces[0]
  const dotColor = current?.color ?? '#00ceff'

  return (
    <Tooltip>
      <Popover open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-white/[0.05]'
              aria-label={`Workspace: ${current?.name ?? 'Select workspace'}`}
            >
              <div className='h-3 w-3 rounded-full' style={{ backgroundColor: dotColor }} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side='right' sideOffset={8}>
          {current?.name ?? 'Workspace'}
        </TooltipContent>
        <PopoverContent side='right' sideOffset={8} className='w-52 !p-3'>
          <p className='px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground'>
            Workspaces
          </p>
          {workspaces.map((ws) => {
            const isCurrent = ws.id === user?.current_workspace
            return (
              <button
                key={ws.id}
                type='button'
                onClick={() => {
                  if (!isCurrent) switchMut.mutate(ws.id)
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent'
              >
                <div
                  className='h-2.5 w-2.5 shrink-0 rounded-full'
                  style={{ backgroundColor: ws.color ?? '#00ceff' }}
                />
                <span className='flex-1 min-w-0 truncate'>{ws.name}</span>
                {isCurrent && <Check className='h-3.5 w-3.5 text-nvr-cyan shrink-0' />}
              </button>
            )
          })}
        </PopoverContent>
      </Popover>
    </Tooltip>
  )
}


/**
 * Per-user shortcuts to anywhere in the app. The nav is organised by what
 * things ARE (collections, monitoring, system), which is the right default and
 * the wrong shape for someone who lives in three specific screens all day —
 * this gives them those three, one click away, without reorganising navigation
 * for everyone else.
 *
 * Stored on the user's own preferences, so it follows them between machines.
 */
/**
 * Pin control for the current page. The favourites themselves live in their own
 * rail category — they cut across categories, so listing them inside one was
 * always the wrong shape — and this is just the way to add and remove the page
 * you are looking at.
 */
function FavoritePinButton() {
  const { user, refetch } = useAuth()
  const location = useLocation()
  const [saving, setSaving] = useState(false)
  const favorites = useMemo<Array<{ label: string; path: string }>>(() => {
    const prefs = (user as { preferences?: { nav_favorites?: unknown } } | null)?.preferences
    const list = prefs?.nav_favorites
    return Array.isArray(list)
      ? (list as Array<{ label?: unknown; path?: unknown }>)
          .filter(
            (f: { label?: unknown; path?: unknown }) =>
              f && typeof f.path === 'string' && typeof f.label === 'string'
          )
          .map((f: { label?: unknown; path?: unknown }) => ({
            label: String(f.label),
            path: String(f.path)
          }))
      : []
  }, [user])

  const here = location.pathname + location.search
  const pinned = favorites.some((f) => f.path === here)

  const save = async (next: Array<{ label: string; path: string }>) => {
    setSaving(true)
    try {
      await api.patch('/users/me/preferences', { nav_favorites: next })
      await refetch()
      toast.success(pinned ? 'Removed from favourites' : 'Added to favourites')
    } catch {
      toast.error('Could not save favourites')
    } finally {
      setSaving(false)
    }
  }

  const toggle = () => {
    if (pinned) return void save(favorites.filter((f) => f.path !== here))
    // Name it what the page calls itself; a route is a poor label and there is
    // nowhere here to rename it afterwards.
    const heading = document.querySelector('h1')?.textContent?.trim()
    const label = (heading || document.title.split('|')[0].trim() || here).slice(0, 60)
    void save([...favorites, { label, path: here }])
  }

  if (here === '/') return null

  return (
    <button
      type='button'
      disabled={saving}
      onClick={toggle}
      title={pinned ? 'Remove this page from favourites' : 'Add this page to favourites'}
      className='rounded p-1 text-slate-400 transition-colors hover:bg-white/5 hover:text-nvr-cyan disabled:opacity-50'
    >
      <Star className={cn('h-3.5 w-3.5', pinned && 'fill-nvr-cyan text-nvr-cyan')} strokeWidth={2} />
    </button>
  )
}

function PanelNavItem({ icon: Icon, label, to }: NavItem) {
  const { pathname } = useLocation()
  const active = isActiveRoute(to, pathname)
  const t = useT()

  return (
    <Link
      to={to}
      className={cn(
        // Full-bleed rows — the active background spans the entire panel width
        'flex items-center gap-2.5 px-4 py-[7px] text-[13px] font-medium transition-colors duration-100',
        active
          ? 'bg-nvr-cyan/[0.12] text-nvr-cyan'
          : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
      )}
    >
      <Icon className={cn('h-[15px] w-[15px] shrink-0', active ? 'text-nvr-cyan' : '')} />
      {t(`nav.${label}`, label)}
    </Link>
  )
}

/** `#00ceff` / `#0cf` → `"0 206 255"`. Returns null for anything else, so a
 *  non-hex setting leaves the default channels in place rather than breaking
 *  every tinted surface. */
function hexToRgbChannels(hex: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const h =
    m[1].length === 3
      ? m[1]
          .split('')
          .map((c) => c + c)
          .join('')
      : m[1]
  const n = Number.parseInt(h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

export function AppLayout() {
  const t = useT()
  usePagePresence()
  useSessionRecorder()
  const { user, refetch: refetchAuth } = useAuth()
  const { data: settings } = useSettings()
  useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ cloud?: boolean }>('/health').then((r) => r.data),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })

  const projectName = settings?.project_name ?? 'Nivaro'

  // Timezone preference (#31): the shared formatters render in the user's
  // chosen zone once set; browser default otherwise.
  const { user: authUser } = useAuth()
  useEffect(() => {
    const tz = (authUser?.preferences as { timezone?: string } | null | undefined)?.timezone
    setDisplayTimezone(typeof tz === 'string' ? tz : null)
  }, [authUser])

  const location = useLocation()
  // Real-user monitoring: one 'load' event per page load, one 'route' event
  // per SPA navigation, aggregated per ROUTE PATTERN so ids don't explode
  // the cardinality. Fire-and-forget — never affects the page it measures.
  useEffect(() => {
    startRum({ app: 'admin', routePattern: rumPattern })
  }, [])
  const firstRouteRef = useRef(true)
  useEffect(() => {
    // The initial render is the 'load' event's job, not a route change.
    if (firstRouteRef.current) {
      firstRouteRef.current = false
      return
    }
    rumRouteChange(location.pathname)
  }, [location.pathname])
  const extensionPlugins = useExtensionPlugins()
  const cloudPlugins = useCloudPlugins()
  const extensionNavItems = extensionPlugins.flatMap((p) =>
    p.slots?.['nav-sidebar'] ? [p.slots['nav-sidebar'] as NavSidebarSlot] : []
  )
  const cloudNavItems = cloudPlugins.flatMap((p) =>
    p.slots?.['nav-sidebar'] ? [p.slots['nav-sidebar'] as NavSidebarSlot] : []
  )

  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'true')
  const [activeCategory, setActiveCategory] = useState<string>(() => {
    const saved = localStorage.getItem(CATEGORY_KEY)
    if (saved && navCategories.some((c) => c.id === saved)) return saved
    return findCategoryForPath(location.pathname) ?? 'home'
  })

  useEffect(() => {
    if (settings?.project_name) {
      document.title = `${settings.project_name} | Nivaro`
    }
  }, [settings?.project_name])

  useEffect(() => {
    const color = settings?.project_color ?? '#00ceff'
    const el = document.documentElement
    el.style.setProperty('--nvr-cyan', color)
    el.style.setProperty('--nvr-cyan-dark', color)
    // The Tailwind token reads the CHANNEL form so `/N` opacity modifiers work,
    // so a white-label colour has to land there too — otherwise solid fills
    // rebrand and every tint stays default cyan.
    const rgb = hexToRgbChannels(color)
    if (rgb) {
      el.style.setProperty('--nvr-cyan-rgb', rgb)
      el.style.setProperty('--nvr-cyan-dark-rgb', rgb)
    }
  }, [settings?.project_color])

  useEffect(() => {
    // Following a favourite keeps you in Favourites. The panel otherwise jumps
    // to whichever category owns the destination, which throws away the list
    // the reader was working from — they chose the shortcut list, so leave
    // them in it until they pick a category themselves.
    setActiveCategory((current) => {
      if (current === 'favorites') return current
      return findCategoryForPath(location.pathname) ?? current
    })
  }, [location.pathname])

  function handleCategoryClick(catId: string) {
    if (catId === activeCategory && !collapsed) {
      // clicking active category while panel is open → collapse
      setCollapsed(true)
      localStorage.setItem(SIDEBAR_KEY, 'true')
    } else if (collapsed) {
      // panel is hidden → expand and switch
      setActiveCategory(catId)
      localStorage.setItem(CATEGORY_KEY, catId)
      setCollapsed(false)
      localStorage.setItem(SIDEBAR_KEY, 'false')
    } else {
      setActiveCategory(catId)
      localStorage.setItem(CATEGORY_KEY, catId)
    }
  }

  function togglePanel() {
    setCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(SIDEBAR_KEY, String(next))
      return next
    })
  }

  const disabledPaths = useUiPermissions()

  // The reader's own shortcuts get their own place in the rail rather than
  // sitting on top of one category's nav — they cut across categories, so
  // living inside one of them was always the wrong shape.
  const navFavorites = useMemo<Array<{ label: string; path: string }>>(() => {
    const prefs = (user as { preferences?: { nav_favorites?: unknown } } | null)?.preferences
    const list = prefs?.nav_favorites
    return Array.isArray(list)
      ? (list as Array<{ label?: unknown; path?: unknown }>)
          .filter(
            (f: { label?: unknown; path?: unknown }) =>
              f && typeof f.path === 'string' && typeof f.label === 'string'
          )
          .map((f: { label?: unknown; path?: unknown }) => ({
            label: String(f.label),
            path: String(f.path)
          }))
      : []
  }, [user])

  // Wear the icon of the page you point at: a column of identical stars tells
  // the reader nothing, and these are the same destinations they already know
  // from the nav. Longest-prefix match so a record page inherits its list's
  // icon; the star is only for somewhere the nav has no entry for.
  const iconForPath = (path: string): React.ElementType => {
    let best: { len: number; icon: React.ElementType } | null = null
    for (const cat of navCategories) {
      for (const item of cat.items) {
        if (path === item.to || (item.to !== '/' && path.startsWith(`${item.to}/`))) {
          if (!best || item.to.length > best.len) best = { len: item.to.length, icon: item.icon }
        }
      }
    }
    return best?.icon ?? Star
  }

  const removeFavorite = async (path: string) => {
    await api.patch('/users/me/preferences', {
      nav_favorites: navFavorites.filter((f) => f.path !== path)
    })
    await refetchAuth()
  }

  const favoritesCategory: NavCategory = {
    id: 'favorites',
    icon: Star,
    label: 'Favourites',
    items: navFavorites.map((f) => ({ icon: iconForPath(f.path), label: f.label, to: f.path }))
  }

  const visibleCategories = navCategories
    .map((cat) => ({
      ...cat,
      items: cat.items.filter((item) => !disabledPaths.has(item.to))
    }))
    .filter((cat) => cat.items.length > 0)

  const railCategories = [favoritesCategory, ...visibleCategories]
  const activeCat =
    railCategories.find((c) => c.id === activeCategory) ?? visibleCategories[0] ?? favoritesCategory

  const panelItems: NavItem[] =
    activeCategory === 'favorites'
      ? favoritesCategory.items
      : activeCategory === 'system'
      ? [
          ...(activeCat?.items ?? []),
          ...extensionNavItems.map((e) => ({ icon: e.icon, label: e.label, to: e.href })),
          ...cloudNavItems.map((e) => ({ icon: e.icon, label: e.label, to: e.href }))
        ]
      : activeCat.items

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.email || '?'
  const initials =
    [user?.first_name?.[0], user?.last_name?.[0]].filter(Boolean).join('').toUpperCase() ||
    user?.email?.[0]?.toUpperCase() ||
    '?'

  return (
    <RealtimeContext.Provider value={adminRealtime}>
    <TooltipProvider delayDuration={150}>
      {/* User extension app-components */}
      {extensionPlugins
        .flatMap((p) => (p.slots?.['app-component'] ? [p.slots['app-component'].component] : []))
        .map((Comp, i) => (
          <Comp key={`ext-${i}`} />
        ))}
      {/* Cloud extension app-components — rendered separately, always present */}
      {cloudPlugins
        .flatMap((p) => (p.slots?.['app-component'] ? [p.slots['app-component'].component] : []))
        .map((Comp, i) => (
          <Comp key={`cloud-${i}`} />
        ))}
      <div className='flex h-screen flex-col overflow-hidden bg-secondary'>
        {/* API redeploy notice — clears itself once this tab reloads onto the
            new build (see the shared api-version watcher). */}
        <ApiUpdateBanner appName='Nivaro' />
        <NivaroProvider client={announcementsClient}>
          <AnnouncementBanner />
        </NivaroProvider>
        <div className='flex min-h-0 flex-1 overflow-hidden'>
        <a
          href='#main-content'
          className='sr-only focus:not-sr-only focus:absolute focus:z-50 focus:top-2 focus:left-2 focus:rounded focus:bg-nvr-cyan focus:px-3 focus:py-1.5 focus:text-xs focus:font-semibold focus:text-white'
        >
          Skip to main content
        </a>

        {/* ─── Sidebar ──────────────────────────────────────────────── */}
        <aside className='flex h-screen shrink-0 overflow-hidden bg-nvr-navy dark:bg-[#090c10]'>
          {/* Icon rail — always 52px */}
          <div className='flex w-[52px] shrink-0 flex-col items-center border-r border-white/[0.07]'>
            {/* Logo mark */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className='flex h-14 w-full shrink-0 cursor-default items-center justify-center border-b border-white/[0.07]'>
                  {settings?.brand_logo ? (
                    <img
                      src={`/api/files/${settings.brand_logo}`}
                      alt={projectName}
                      className='max-h-8 max-w-[40px] object-contain'
                    />
                  ) : (
                    <div className='flex h-7 w-7 items-center justify-center rounded-md bg-nvr-cyan'>
                      <NivaroMark size={16} color='#172940' />
                    </div>
                  )}
                </div>
              </TooltipTrigger>
              <TooltipContent side='right' sideOffset={8}>
                {projectName}
              </TooltipContent>
            </Tooltip>

            {/* Workspace dot */}
            <div className='flex w-full shrink-0 justify-center border-b border-white/[0.07] px-1.5 py-2 h-12'>
              <WorkspaceSwitcher />
            </div>

            {/* Category buttons */}
            <nav
              className='flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto pb-3'
              aria-label='Navigation categories'
            >
              {railCategories.map((cat) => {
                const hasActive = cat.items.some((item) =>
                  isActiveRoute(item.to, location.pathname)
                )
                const isSelected = activeCategory === cat.id
                const panelOpen = isSelected && !collapsed
                return (
                  <Tooltip key={cat.id}>
                    <TooltipTrigger asChild>
                      <button
                        type='button'
                        onClick={() => handleCategoryClick(cat.id)}
                        aria-pressed={panelOpen}
                        aria-label={cat.label}
                        className={cn(
                          // Full-bleed rows — active background spans the entire rail width
                          'relative flex h-9 w-full items-center justify-center transition-colors duration-100',
                          panelOpen
                            ? 'bg-nvr-cyan/[0.15] text-nvr-cyan'
                            : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200'
                        )}
                      >
                        <cat.icon className='h-[15px] w-[15px]' />
                        {hasActive && !panelOpen && (
                          <span className='absolute bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-nvr-cyan/70' />
                        )}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side='right' sideOffset={8}>
                      {t(`nav.${cat.label}`, cat.label)}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </nav>

            {/* Footer utilities */}
            <div className='flex shrink-0 flex-col items-center gap-0.5 border-t border-white/[0.07] px-1.5 py-2'>
              <TeamChatDock />
              <NotificationBell collapsed compact />
              {/* Beside chat and the bell rather than buried in System: "what
                  changed" is something people reach for from anywhere, not a
                  configuration screen they navigate to. */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to='/changelog'
                    aria-label='Changelog'
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-white/[0.05] hover:text-white',
                      location.pathname === '/changelog'
                        ? 'bg-white/[0.08] text-white'
                        : 'text-slate-400'
                    )}
                  >
                    <ScrollText className='h-[15px] w-[15px]' />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side='right'>Changelog</TooltipContent>
              </Tooltip>
              <ThemeSwitcher collapsed />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type='button'
                    onClick={togglePanel}
                    aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    className='flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white'
                  >
                    {collapsed ? (
                      <PanelLeftOpen className='h-[15px] w-[15px]' />
                    ) : (
                      <PanelLeftClose className='h-[15px] w-[15px]' />
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side='right' sideOffset={8}>
                  {collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                </TooltipContent>
              </Tooltip>
            </div>

            {/* User avatar */}
            <div className='flex w-full shrink-0 justify-center border-t border-white/[0.07] px-1.5 py-2.5'>
              <Popover>
                <PopoverTrigger asChild>
                  <Avatar className='h-7 w-7 cursor-pointer'>
                    <AvatarFallback className='bg-white/[0.15] text-[10px] font-bold text-white'>
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                </PopoverTrigger>
                <PopoverContent side='right' sideOffset={12} className='w-52 p-3'>
                  <div className='flex items-center gap-2.5'>
                    <Avatar className='h-8 w-8 shrink-0'>
                      <AvatarFallback className='bg-nvr-cyan/[0.15] text-[11px] font-bold text-nvr-navy'>
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className='min-w-0'>
                      <p className='truncate text-[13px] font-medium text-slate-900'>
                        {displayName}
                      </p>
                      <p className='truncate text-[11px] text-slate-500'>{user?.email}</p>
                    </div>
                  </div>
                  <div className='my-2.5 border-t border-slate-100' />
                  <Link
                    to='/profile'
                    className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900'
                  >
                    <UserRound className='h-3.5 w-3.5' />
                    My Profile
                  </Link>
                  <button
                    type='button'
                    onClick={logout}
                    className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900'
                  >
                    <LogOut className='h-3.5 w-3.5' />
                    Sign out
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Category panel — slides in/out */}
          <div
            className={cn(
              'overflow-hidden border-r border-white/[0.07] transition-[width] duration-200 ease-in-out',
              collapsed ? 'w-0' : 'w-[168px]'
            )}
          >
            <div className='flex h-full w-[168px] flex-col'>
              {/* Panel header */}
              <div className='flex h-14 shrink-0 items-center justify-between gap-2 border-b border-white/[0.07] px-4'>
                <div className='min-w-0'>
                  <p className='truncate text-[11px] font-medium leading-tight text-slate-500'>
                    {projectName}
                  </p>
                  <p className='truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em] text-white'>
                    {t(`nav.${activeCat.label}`, activeCat.label)}
                  </p>
                </div>
                <FavoritePinButton />
              </div>

              {/* Nav items — no horizontal padding so active rows span full width */}
              <nav
                className='min-h-0 flex-1 overflow-y-auto py-3'
                aria-label={`${activeCat.label} navigation`}
              >
                {activeCategory === 'favorites' && panelItems.length === 0 && (
                  <p className='px-4 py-2 text-[11px] leading-snug text-slate-400'>
                    Star a page with the ☆ beside its category name to keep it here.
                  </p>
                )}
                <div className='space-y-0.5'>
                  {panelItems.map((item) =>
                    activeCategory === 'favorites' ? (
                      // Favourites are removable HERE — the star toggle lives on
                      // the page itself, which may no longer exist (a deleted
                      // page-builder page left an unremovable favourite).
                      <div key={item.to} className='group/fav relative'>
                        <PanelNavItem {...item} />
                        <button
                          type='button'
                          aria-label={`Remove ${item.label} from favourites`}
                          title='Remove from favourites'
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            void removeFavorite(item.to)
                          }}
                          className='absolute right-1.5 top-1/2 hidden h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-red-500 group-hover/fav:flex dark:hover:bg-muted'
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <PanelNavItem key={item.to} {...item} />
                    )
                  )}
                </div>
              </nav>
            </div>
          </div>
        </aside>

        {/* ─── Main area ───────────────────────────────────────────── */}
        <main id='main-content' className='flex flex-1 flex-col overflow-hidden bg-secondary'>
          <PageErrorBoundary key={location.pathname}>
            <Suspense fallback={null}>
              {disabledPaths.size > 0 &&
              [...disabledPaths].some((p) => location.pathname.startsWith(p)) ? (
                <Navigate to='/' replace />
              ) : (
                <div
                  key={location.pathname}
                  className='animate-page-enter flex-1 min-h-0 overflow-auto flex flex-col'
                >
                  <Outlet />
                  <BugReporter />
                </div>
              )}
            </Suspense>
          </PageErrorBoundary>
        </main>
        </div>
      </div>
      <CommandPalette />
      <KeyboardShortcuts />
      <ForceRefreshBanner />
    </TooltipProvider>
    </RealtimeContext.Provider>
  )
}

/**
 * Remote client refresh (#285): an admin fired POST /realtime/force-refresh —
 * every connected client shows a countdown, then reloads. The listener side
 * lives in lib/socket.ts (window event), so this renders for followers too.
 * Also handles catchup:full (#266): the event journal couldn't cover a
 * reconnect gap, so every cached query refetches.
 */
function ForceRefreshBanner() {
  const qc = useQueryClient()
  const [refresh, setRefresh] = useState<{ seconds: number; message: string } | null>(null)
  const [remaining, setRemaining] = useState(0)
  useEffect(() => {
    const onForce = (e: Event) => {
      const d = (e as CustomEvent).detail as { seconds?: number; message?: string }
      const seconds = Math.max(5, Number(d?.seconds) || 30)
      setRefresh({ seconds, message: String(d?.message ?? '') })
      setRemaining(seconds)
    }
    const onCatchupFull = () => void qc.invalidateQueries()
    window.addEventListener('nvr:force-refresh', onForce)
    window.addEventListener('nvr:catchup-full', onCatchupFull)
    return () => {
      window.removeEventListener('nvr:force-refresh', onForce)
      window.removeEventListener('nvr:catchup-full', onCatchupFull)
    }
  }, [qc])
  useEffect(() => {
    if (!refresh) return
    const t = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.location.reload()
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(t)
  }, [refresh])
  if (!refresh) return null
  return (
    <div className='fixed inset-x-0 top-0 z-[150] flex items-center justify-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-[13px] text-amber-900 dark:border-amber-500/40 dark:bg-[#3a2e10] dark:text-amber-200'>
      <RotateCw className='h-4 w-4 animate-spin' />
      <span>
        <span className='font-semibold'>This page will reload in {remaining}s</span>
        {refresh.message ? ` — ${refresh.message}` : ' — an administrator pushed an update.'}
      </span>
      <button
        type='button'
        onClick={() => window.location.reload()}
        className='rounded-md border border-amber-400 bg-white px-2.5 py-1 text-[12px] font-medium text-amber-800 hover:bg-amber-100 dark:bg-transparent dark:text-amber-200'
      >
        Reload now
      </button>
    </div>
  )
}
