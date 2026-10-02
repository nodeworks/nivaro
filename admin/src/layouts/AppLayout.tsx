import {
  AutofillRunsChip,
  ForceReloadBanner,
  parseThemeAccents,
  registerViewAsOpener,
  resolveAccentColor,
  rumRouteChange,
  setDisplayTimezone,
  setNumberFormat,
  setTimeDisplay,
  startRum,
  UserAvatar
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Star,
  UserRound
} from 'lucide-react'
import {
  Component,
  Fragment,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { DevStaleBanner } from '@/components/dev-stale-banner'
import { InstanceSwitcher } from '@/components/InstanceSwitcher'
import { getRecorderState, subscribeRecorder } from '@/lib/e2e-recorder'
import { adminRealtime } from '@/lib/socket'
import { applyThemeSettings } from '@/lib/theme-settings'

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

import { createNivaro } from '@nivaro/sdk'
import {
  AnnouncementBanner,
  ApiUpdateBanner,
  ErrorSurface,
  NivaroProvider,
  OfflineBanner,
  RealtimeContext
} from '@nivaro/shared'
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
import { openViewAsTab, readMasquerade, stopMasquerade } from '@/lib/masquerade'
import { usePagePresence } from '@/lib/use-page-presence'
import { captureErrorClip, useSessionRecorder } from '@/lib/use-session-recorder'
import { useSettings } from '@/lib/useSettings'
import { useUiPermissions } from '@/lib/useUiPermissions'
import { cn } from '@/lib/utils'
import { FavoritePinButton, FavoritesPanel, PanelLink, useNavFavorites } from './FavoritesNav'
import { NavFind } from './NavFind'
import {
  findCategoryForPath,
  iconForPath,
  isActiveRoute,
  type NavCategory,
  type NavItem,
  navCategories
} from './nav-config'

const announcementsClient = createNivaro(window.location.origin)

const SIDEBAR_KEY = 'nivaro-sidebar-collapsed'
const CATEGORY_KEY = 'nivaro-nav-category'

export type { NavCategory, NavItem } from './nav-config'
export { navCategories }

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
        <ErrorSurface
          variant='500'
          detail={this.state.error.message}
          action={
            <button
              type='button'
              onClick={() => this.setState({ error: null })}
              className='rounded-md bg-nvr-cyan px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110'
            >
              Try again
            </button>
          }
        />
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
  useSessionKeepalive()
  const t = useT()
  usePagePresence()
  useSessionRecorder()
  const { user } = useAuth()
  // "View as" on a person's page (#640) opens a new tab as them.
  useEffect(() => registerViewAsOpener(openViewAsTab), [])
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
    const prefs = (authUser?.preferences ?? {}) as {
      timezone?: string
      time_display?: string
      number_format?: { locale?: string; compact?: boolean }
      font_size?: string
    }
    // Instance default timezone (#178): users without a pref get the
    // instance-configured default rather than the browser zone.
    if (typeof prefs.timezone === 'string') setDisplayTimezone(prefs.timezone)
    else {
      void api
        .get<{ data: { default_timezone?: string | null } }>('/settings')
        .then((r) => setDisplayTimezone(r.data.data.default_timezone ?? null))
        .catch(() => setDisplayTimezone(null))
    }
    // Display prefs (#229/#230/#411): shared formatters honor them.
    setTimeDisplay(prefs.time_display ?? null)
    setNumberFormat(prefs.number_format ?? null)
    // Font size (#232): root scaling — everything in rem follows.
    const size = prefs.font_size === 'small' ? '15px' : prefs.font_size === 'large' ? '17.5px' : ''
    document.documentElement.style.fontSize = size
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

  // Workspace theming (#463): the ACTIVE workspace's color (a column that
  // existed unused) wins over the instance project_color, so switching
  // workspaces re-accents the whole admin. Falls through when unset.
  const { data: themeWorkspaces = [] } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ data: Workspace[] }>('/workspaces').then((r) => r.data.data),
    staleTime: 5 * 60_000
  })
  const { user: authUserForTheme } = useAuth()
  const workspaceColor = (() => {
    const ws = themeWorkspaces.find((w) => w.id === user?.current_workspace)
    const c = (ws as { color?: string | null } | undefined)?.color
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : null
  })()

  // Per-user accent (#83): an explicit pick from the instance's approved
  // palette beats the workspace colour and the project colour — the person
  // chose it. Unset/'brand' falls through to the instance chain.
  const accentPick = resolveAccentColor(
    (authUserForTheme?.preferences as { theme_accent?: unknown } | undefined)?.theme_accent,
    parseThemeAccents((settings as { theme_accents?: unknown } | undefined)?.theme_accents)
  )
  useEffect(() => {
    const color = accentPick ?? workspaceColor ?? settings?.project_color ?? '#00ceff'
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
    // Theme studio (#662): radius + font follow the same settings effect.
    applyThemeSettings(settings as Record<string, unknown> | undefined)
  }, [settings?.project_color, workspaceColor, settings, accentPick])

  useEffect(() => {
    // Following a favorite keeps you in Favorites. The panel otherwise jumps
    // to whichever category owns the destination, which throws away the list
    // the reader was working from — they chose the shortcut list, so leave
    // them in it until they pick a category themselves.
    setActiveCategory((current) => {
      if (current === 'favorites') return current
      return findCategoryForPath(location.pathname) ?? current
    })
    setFindQuery('')
  }, [location.pathname])

  function handleCategoryClick(catId: string) {
    if (catId !== 'favorites') setOrganizing(false)
    setFindQuery('')
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
  // living inside one of them was always the wrong shape. One instance for the
  // star and the panel, so an optimistic reorder never snaps back.
  const favoritesApi = useNavFavorites()
  const [organizing, setOrganizing] = useState(false)
  const [findQuery, setFindQuery] = useState('')

  const favoritesCategory: NavCategory = {
    id: 'favorites',
    icon: Star,
    label: 'Favorites',
    hint: 'Your pinned pages, in your order',
    items: favoritesApi.favorites.items.map((f) => ({
      icon: iconForPath(f.path) ?? Star,
      label: f.label,
      to: f.path,
      section: f.group ?? undefined
    }))
  }

  const openOrganize = () => {
    setActiveCategory('favorites')
    localStorage.setItem(CATEGORY_KEY, 'favorites')
    setCollapsed(false)
    localStorage.setItem(SIDEBAR_KEY, 'false')
    setFindQuery('')
    setOrganizing(true)
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
            ...extensionNavItems.map((e) => ({
              icon: e.icon,
              label: e.label,
              to: e.href,
              section: 'Extensions'
            })),
            ...cloudNavItems.map((e) => ({
              icon: e.icon,
              label: e.label,
              to: e.href,
              section: 'Account'
            }))
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
          <ApiUpdateBanner
            appName='Nivaro'
            releaseNotesUrl={(u) =>
              `/changelog?since=${encodeURIComponent(u.from ?? '')}&to=${encodeURIComponent(u.version)}`
            }
          />
          <ViewAsBar />
          <DevStaleBanner />
          <RecorderBadge />
          <SessionExpiryWatcher />
          <OfflineBanner />
          <DbOutageBanner />
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
                  {railCategories.map((cat, ci) => {
                    // A rule between the day-to-day categories and the ones
                    // for running the instance itself.
                    const startsPlatform =
                      cat.zone === 'platform' && railCategories[ci - 1]?.zone !== 'platform'
                    const hasActive = cat.items.some((item) =>
                      isActiveRoute(item.to, location.pathname)
                    )
                    const isSelected = activeCategory === cat.id
                    const panelOpen = isSelected && !collapsed
                    return (
                      <Fragment key={cat.id}>
                        {startsPlatform && (
                          <div
                            className='mx-auto my-1.5 h-px w-6 shrink-0 bg-white/[0.12]'
                            aria-hidden
                          />
                        )}
                        <Tooltip>
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
                          <TooltipContent side='right' sideOffset={8} className='max-w-[220px]'>
                            <span className='font-semibold'>
                              {t(`nav.${cat.label}`, cat.label)}
                            </span>
                            {cat.hint && (
                              <span className='mt-0.5 block text-[11px] font-normal opacity-75'>
                                {cat.hint}
                              </span>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </Fragment>
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
                  <InstanceSwitcher collapsed />
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
                      <span className='inline-flex cursor-pointer'>
                        <UserAvatar
                          userId={user?.id}
                          alt={displayName}
                          className='h-7 w-7'
                          fallback={
                            <Avatar className='h-7 w-7'>
                              <AvatarFallback className='bg-white/[0.15] text-[10px] font-bold text-white'>
                                {initials}
                              </AvatarFallback>
                            </Avatar>
                          }
                        />
                      </span>
                    </PopoverTrigger>
                    <PopoverContent side='right' sideOffset={12} className='w-52 p-3'>
                      <div className='flex items-center gap-2.5'>
                        <UserAvatar
                          userId={user?.id}
                          alt={displayName}
                          className='h-8 w-8'
                          fallback={
                            <Avatar className='h-8 w-8 shrink-0'>
                              <AvatarFallback className='bg-nvr-cyan/[0.15] text-[11px] font-bold text-nvr-navy'>
                                {initials}
                              </AvatarFallback>
                            </Avatar>
                          }
                        />
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
                  'overflow-hidden border-r border-white/[0.07] transition-[width] duration-200 ease-out motion-reduce:transition-none',
                  collapsed ? 'w-0' : 'w-[192px]'
                )}
              >
                <div className='flex h-full w-[192px] flex-col'>
                  {/* Panel header */}
                  <div className='flex h-14 shrink-0 items-center justify-between gap-1.5 border-b border-white/[0.07] pl-4 pr-2.5'>
                    <div className='min-w-0'>
                      <p className='truncate text-[11px] font-medium leading-tight text-slate-400'>
                        {projectName}
                      </p>
                      <p className='truncate text-[13.5px] font-semibold leading-tight tracking-[-0.01em] text-white'>
                        {t(`nav.${activeCat.label}`, activeCat.label)}
                      </p>
                    </div>
                    <div className='flex shrink-0 items-center gap-0.5'>
                      {activeCategory === 'favorites' &&
                        (favoritesApi.favorites.items.length > 0 ||
                          favoritesApi.favorites.groups.length > 0) &&
                        !organizing && (
                          <button
                            type='button'
                            onClick={() => setOrganizing(true)}
                            className='rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition-colors hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60'
                          >
                            Organize
                          </button>
                        )}
                      <FavoritePinButton {...favoritesApi} onOrganize={openOrganize} />
                    </div>
                  </div>

                  {!organizing && (
                    <NavFind
                      query={findQuery}
                      onQuery={setFindQuery}
                      categories={railCategories.map((c) =>
                        c.id === activeCat.id ? { ...c, items: panelItems } : c
                      )}
                    />
                  )}

                  {/* Nav items — no horizontal padding so active rows span full width */}
                  {!findQuery.trim() && (
                    <nav
                      className='min-h-0 flex-1 overflow-y-auto pb-4 pt-1'
                      aria-label={`${activeCat.label} navigation`}
                    >
                      {activeCategory === 'favorites' ? (
                        <FavoritesPanel
                          {...favoritesApi}
                          organizing={organizing}
                          setOrganizing={setOrganizing}
                        />
                      ) : (
                        <div className='space-y-0.5'>
                          {panelItems.map((item, idx) => (
                            <div key={item.to}>
                              {item.section && item.section !== panelItems[idx - 1]?.section && (
                                <p
                                  className={cn(
                                    'px-4 pb-1 text-[11px] font-semibold text-slate-400',
                                    idx > 0 ? 'mt-3.5' : 'mt-0.5'
                                  )}
                                >
                                  {item.section}
                                </p>
                              )}
                              <PanelLink icon={item.icon} label={item.label} to={item.to} />
                            </div>
                          ))}
                        </div>
                      )}
                    </nav>
                  )}
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
                    </div>
                  )}
                </Suspense>
              </PageErrorBoundary>
            </main>
          </div>
        </div>
        {/* Outside the animated page wrapper on purpose — see bug-reporter.tsx. */}
        <BugReporter />
        <CommandPalette />
        <KeyboardShortcuts />
        <ForceRefreshBanner />
        <AutofillChips />
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
/**
 * Session auto-extend (#386): the session cookie is `rolling`, so ANY request
 * refreshes it — this quietly guarantees one request per 10 minutes of real
 * user activity, so someone reading a long record never gets logged out
 * mid-thought. /api/version is the cheapest same-origin endpoint (no DB).
 */
function useSessionKeepalive() {
  useEffect(() => {
    let last = 0
    const onActivity = () => {
      const now = Date.now()
      if (now - last < 10 * 60_000) return
      last = now
      void fetch('/api/version', { credentials: 'include', cache: 'no-store' }).catch(() => {})
    }
    window.addEventListener('pointerdown', onActivity, { passive: true })
    window.addEventListener('keydown', onActivity, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onActivity)
      window.removeEventListener('keydown', onActivity)
    }
  }, [])
}

/**
 * DB outage banner (#329): shown when any API call returns the fast
 * DB_UNAVAILABLE 503; clears itself by probing /api/health until the
 * database answers again.
 */
function DbOutageBanner() {
  const [down, setDown] = useState(false)
  useEffect(() => {
    const onDown = () => setDown(true)
    window.addEventListener('nvr:db-down', onDown)
    return () => window.removeEventListener('nvr:db-down', onDown)
  }, [])
  useEffect(() => {
    if (!down) return
    const t = setInterval(() => {
      void fetch('/api/health', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
          if (d?.db?.status === 'connected') setDown(false)
        })
        .catch(() => {})
    }, 5000)
    return () => clearInterval(t)
  }, [down])
  if (!down) return null
  return (
    <div className='flex items-center justify-center gap-2 border-b border-red-300 bg-red-50 px-4 py-1.5 text-[12px] text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300'>
      <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-red-500' />
      The database is unreachable — changes can't be saved right now. This clears automatically when
      it recovers.
    </div>
  )
}

function ForceRefreshBanner() {
  const qc = useQueryClient()
  useEffect(() => {
    const onCatchupFull = () => void qc.invalidateQueries()
    window.addEventListener('nvr:catchup-full', onCatchupFull)
    return () => window.removeEventListener('nvr:catchup-full', onCatchupFull)
  }, [qc])
  return <ForceReloadBanner />
}

// ─── Session-expiry warning (#199) ───────────────────────────────────────────
// Sessions are ROLLING, so any request refreshes them — including a TTL poll,
// which would keep an idle tab alive forever. Instead: read the TTL ONCE at
// mount (that single refresh is fine), then count down locally from the last
// real user interaction; a toast at <5 min offers Extend (one fetch resets
// the server clock, and we restart the local one).
function SessionExpiryWatcher() {
  const warnedRef = useRef(false)
  useEffect(() => {
    let ttlSeconds: number | null = null
    let lastActivity = Date.now()
    const onActivity = () => {
      lastActivity = Date.now()
      warnedRef.current = false
    }
    for (const ev of ['pointerdown', 'keydown'])
      window.addEventListener(ev, onActivity, { passive: true })
    void api
      .get<{ data: { ttl_seconds: number | null } }>('/security/my/session-ttl')
      .then((r) => {
        ttlSeconds = r.data.data.ttl_seconds
      })
      .catch(() => {})
    const timer = setInterval(() => {
      if (!ttlSeconds || warnedRef.current) return
      const remaining = ttlSeconds * 1000 - (Date.now() - lastActivity)
      if (remaining > 0 && remaining < 5 * 60_000) {
        warnedRef.current = true
        toast.warning('Your session expires in about 5 minutes.', {
          duration: 30_000,
          action: {
            label: 'Extend',
            onClick: () => {
              void api.get('/auth/me').then(() => {
                lastActivity = Date.now()
                warnedRef.current = false
                toast.success('Session extended')
              })
            }
          }
        })
      }
    }, 30_000)
    return () => {
      clearInterval(timer)
      for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, onActivity)
    }
  }, [])
  return null
}

/**
 * Golden-path recorder badge (#73): while a recording is on, a fixed pill
 * says so on every route and links back to the recorder — the recorder lives
 * in a module-level singleton, so leaving its page does not stop it.
 */
function RecorderBadge() {
  const rec = useSyncExternalStore(subscribeRecorder, getRecorderState, getRecorderState)
  if (!rec.recording) return null
  return (
    <Link
      to='/e2e-recorder'
      data-nvr-dock-aware
      className='fixed bottom-4 right-4 z-[120] inline-flex items-center gap-2 rounded-full border border-red-200 bg-white px-3 py-1.5 text-[11.5px] font-medium text-red-600 shadow-lg hover:bg-red-50 dark:border-red-500/30 dark:bg-card dark:text-red-300'
      data-e2e-recorder
      data-e2e-badge={rec.steps.length}
    >
      <span className='h-2 w-2 animate-pulse rounded-full bg-red-500' />
      Recording · {rec.steps.length} step{rec.steps.length === 1 ? '' : 's'}
    </Link>
  )
}

/** Document-autofill runs follow the person across pages; a click opens the
 *  new-record form on the run (the form takes the dialog from there). */
function AutofillChips() {
  const navigate = useNavigate()
  return (
    <AutofillRunsChip
      onOpen={(run) => navigate(`/collections/${run.collection}/new?autofill=${run.id}`)}
    />
  )
}

/** The amber bar of a "View as" tab (#640): who this tab is, and the way out. */
function ViewAsBar() {
  const m = readMasquerade()
  const [leaving, setLeaving] = useState(false)
  if (!m) return null
  return (
    <div
      data-view-as-bar
      role='status'
      className='flex shrink-0 items-center gap-3 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-[12.5px] text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100'
    >
      <span>
        Viewing as <b>{m.name || 'another person'}</b> in this tab. Everything here is what they see
        and can do; your other tabs are still you.
      </span>
      <button
        type='button'
        data-view-as-stop
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          void stopMasquerade()
        }}
        className='ml-auto h-7 rounded-md border border-amber-400 px-2.5 text-[12px] font-semibold hover:bg-amber-200 disabled:opacity-60 dark:border-amber-500/50 dark:hover:bg-amber-500/25'
      >
        {leaving ? 'Leaving…' : 'Stop viewing as'}
      </button>
    </div>
  )
}
