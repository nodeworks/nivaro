import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  BarChart2,
  Bell,
  BookOpen,
  Braces,
  Building2,
  CalendarClock,
  CalendarOff,
  Check,
  CheckSquare,
  Clock,
  Code2,
  Database,
  DatabaseZap,
  Eye,
  FileBarChart,
  FileImage,
  FileText,
  GitBranch,
  Globe,
  HeartPulse,
  House,
  KeyRound,
  LayoutGrid,
  Link2,
  ListFilter,
  LogOut,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  PuzzleIcon,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Settings,
  Shield,
  ShieldOff,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  ThumbsUp,
  Upload,
  UserRound,
  Users,
  Webhook,
  Wifi,
  Workflow
} from 'lucide-react'
import { Suspense, useEffect, useState } from 'react'
import { Link, Navigate, Outlet, useLocation } from 'react-router'
import { CommandPalette } from '@/components/command-palette'
import { NotificationBell } from '@/components/notification-bell'
import { KeyboardShortcuts } from '@/components/shortcuts-overlay'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useExtensionPlugins, useCloudPlugins } from '@/extensions/store'
import type { NavSidebarSlot } from '@/extensions/types'
import { api, WORKSPACE_KEY, type Workspace } from "@/lib/api"
import { logout, useAuth } from '@/lib/auth'
import { useSettings } from '@/lib/useSettings'
import { useUiPermissions } from '@/lib/useUiPermissions'
import { cn } from '@/lib/utils'

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
      { icon: LayoutGrid, label: 'Dashboards', to: '/dashboards' }
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
      { icon: Building2, label: 'Workspaces', to: '/workspaces' }
    ]
  },
  {
    id: 'automation',
    icon: GitBranch,
    label: 'Automation',
    items: [
      { icon: GitBranch, label: 'Pipelines', to: '/pipelines' },
      { icon: Workflow, label: 'Workflows', to: '/workflows' },
      { icon: SlidersHorizontal, label: 'Flows', to: '/flows' },
      { icon: ThumbsUp, label: 'Approvals', to: '/approvals' },
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
      { icon: FileBarChart, label: 'Reports', to: '/reports' },
      { icon: Bell, label: 'Alerts', to: '/alerts' },
      { icon: AlertTriangle, label: 'At-Risk Rules', to: '/at-risk' },
      { icon: Clock, label: 'SLA Rules', to: '/sla-rules' },
      { icon: Eye, label: 'Field Watches', to: '/field-watches' },
      { icon: Bell, label: 'Subscriptions', to: '/notification-subscriptions' },
      { icon: Upload, label: 'Imports', to: '/imports' },
      { icon: Globe, label: 'Submission Forms', to: '/submission-forms' },
      { icon: BarChart2, label: 'API Analytics', to: '/api-analytics' },
      { icon: HeartPulse, label: 'Health', to: '/health' },
      { icon: ShieldCheck, label: 'Data Quality', to: '/data-quality' },
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
      { icon: Link2, label: 'External APIs', to: '/external-apis' },
      { icon: Braces, label: 'GraphQL', to: '/graphql' },
      { icon: Code2, label: 'Custom Queries', to: '/custom-queries' },
      { icon: PuzzleIcon, label: 'Extensions', to: '/extensions' },
      { icon: BarChart2, label: 'Analytics', to: '/analytics' },
      { icon: Wifi, label: 'Presence', to: '/presence' },
      { icon: KeyRound, label: 'API Keys', to: '/api-keys' },
      { icon: Terminal, label: 'SDK Playground', to: '/sdk-playground' },
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

function PanelNavItem({ icon: Icon, label, to }: NavItem) {
  const { pathname } = useLocation()
  const active = isActiveRoute(to, pathname)

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
      {label}
    </Link>
  )
}

export function AppLayout() {
  const { user } = useAuth()
  const { data: settings } = useSettings()
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => api.get<{ cloud?: boolean }>('/health').then(r => r.data),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false
  })

const projectName = settings?.project_name ?? 'Nivaro'

  const location = useLocation()
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
    const cat = findCategoryForPath(location.pathname)
    if (cat) setActiveCategory(cat)
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

  const visibleCategories = navCategories.map((cat) => ({
    ...cat,
    items: cat.items.filter((item) => !disabledPaths.has(item.to))
  })).filter((cat) => cat.items.length > 0)

  const activeCat = visibleCategories.find((c) => c.id === activeCategory) ?? visibleCategories[0]

  const panelItems: NavItem[] =
    activeCategory === 'system'
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
    <TooltipProvider delayDuration={150}>
      {/* User extension app-components */}
      {extensionPlugins.flatMap(p =>
        p.slots?.['app-component'] ? [p.slots['app-component'].component] : []
      ).map((Comp, i) => <Comp key={`ext-${i}`} />)}
      {/* Cloud extension app-components — rendered separately, always present */}
      {cloudPlugins.flatMap(p =>
        p.slots?.['app-component'] ? [p.slots['app-component'].component] : []
      ).map((Comp, i) => <Comp key={`cloud-${i}`} />)}
      <div className='flex h-screen overflow-hidden bg-secondary'>
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
            {/* Workspace dot */}
            <div className='flex w-full shrink-0 justify-center border-b border-white/[0.07] px-1.5 py-2 h-12'>
              <WorkspaceSwitcher />
            </div>

            {/* Logo mark */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div className='flex h-14 w-full shrink-0 cursor-default items-center justify-center border-b border-white/[0.07]'>
                  <div className='flex h-7 w-7 items-center justify-center rounded-md bg-nvr-cyan'>
                    <NivaroMark size={16} color='#172940' />
                  </div>
                </div>
              </TooltipTrigger>
              <TooltipContent side='right' sideOffset={8}>
                {projectName}
              </TooltipContent>
            </Tooltip>

            {/* Category buttons */}
            <nav
              className='flex min-h-0 w-full flex-1 flex-col gap-0.5 overflow-y-auto pb-3'
              aria-label='Navigation categories'
            >
              {visibleCategories.map((cat) => {
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
                      {cat.label}
                    </TooltipContent>
                  </Tooltip>
                )
              })}
            </nav>

            {/* Footer utilities */}
            <div className='flex shrink-0 flex-col items-center gap-0.5 border-t border-white/[0.07] px-1.5 py-2'>
              <NotificationBell collapsed compact />
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
              <div className='flex h-12 shrink-0 flex-col justify-center border-b border-white/[0.07] px-4'>
                <p className='truncate text-[11px] font-medium leading-tight text-slate-500'>
                  {projectName}
                </p>
                <p className='truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em] text-white'>
                  {activeCat.label}
                </p>
              </div>

              {/* Nav items — no horizontal padding so active rows span full width */}
              <nav className='min-h-0 flex-1 overflow-y-auto py-3'>
                <div className='space-y-0.5'>
                  {panelItems.map((item) => (
                    <PanelNavItem key={item.to} {...item} />
                  ))}
                </div>
              </nav>
            </div>
          </div>
        </aside>

        {/* ─── Main area ───────────────────────────────────────────── */}
        <main id='main-content' className='flex flex-1 flex-col overflow-hidden bg-secondary'>
          <Suspense fallback={null}>
            {disabledPaths.size > 0 && [...disabledPaths].some((p) => location.pathname.startsWith(p)) ? (
              <Navigate to='/' replace />
            ) : (
              <div
                key={location.pathname}
                className='animate-page-enter flex-1 min-h-0 overflow-auto flex flex-col'
              >
                <Outlet />
              </div>
            )}
          </Suspense>
        </main>
      </div>
      <CommandPalette />
      <KeyboardShortcuts />
    </TooltipProvider>
  )
}
