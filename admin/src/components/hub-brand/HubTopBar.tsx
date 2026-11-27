import { UserAvatar } from '@nivaro/shared'
import {
  ChevronDown,
  LayoutGrid,
  LogOut,
  Menu,
  ScrollText,
  Search,
  UserRound,
  X
} from 'lucide-react'
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { Link, useLocation } from 'react-router'
import { NotificationBell } from '@/components/notification-bell'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { hubSystemPageForEveryone, type NavItem } from '@/layouts/nav-config'
import { logout, useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { HubGlyph, HubWordmark } from './HubMark'
import { activeSection, type HubSection, visibleSections } from './hub-sections'

const NARROW = '(max-width: 639px)'

/** Open the command palette (components/command-palette.tsx listens). */
const openFind = () => window.dispatchEvent(new CustomEvent('nivaro:focus-search'))

function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(NARROW)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => window.matchMedia(NARROW).matches,
    () => false
  )
}

type TopBarItem = NavItem & { key?: string }

/**
 * The standalone Hub's chrome: a top bar with the Hub sections in place of Nivaro's icon rail and
 * panel (rendered by AppLayout only in Hub mode). The sections are the Apps hub's groups
 * (hub-sections.ts), so the bar, the strip under it and Find all show one map. "All pages" opens
 * that whole map at once; Find (also Ctrl/Cmd+K) searches it by meaning ("dns", "postgres"). Keeps everything the rail carried: team chat,
 * the notification bell, refresh, watch list, instance switch, theme, the account menu (with
 * do-not-disturb and browser chaos), and every other page the Hub keeps (under "System").
 * Sections and System follow the person's role exactly as the sidebar did. Below lg the sections
 * fold into a menu that lists every page under its section; on a phone the smaller tools move
 * into that menu too.
 */
export function HubTopBar({
  items,
  disabled,
  user,
  logoUrl,
  chat,
  tools,
  accountExtras
}: {
  /** The pages this person may open (AppLayout's permitted nav, already Hub-trimmed). */
  items: TopBarItem[]
  /** Their role's ui_permissions (useUiPermissions). */
  disabled: ReadonlySet<string>
  user: { id?: string | null; name: string; email?: string | null; initials: string }
  /** An operator's own logo (Settings → Project) replaces the mark. */
  logoUrl?: string | null
  /** Always in the bar (team chat). */
  chat?: ReactNode
  /** In the bar from sm up, in the menu on a phone (refresh, watch list, instance switch). */
  tools?: ReactNode
  /** Rows at the top of the account menu (do-not-disturb, browser chaos). */
  accountExtras?: ReactNode
}) {
  const { pathname } = useLocation()
  const narrow = useNarrow()
  const permitted = useMemo(() => new Set(items.map((i) => i.key ?? i.to)), [items])
  // Signed in and not an administrator = an app owner: admin-only pages are not offered.
  const { user: me } = useAuth()
  const admin = me ? !!(me as { is_admin?: boolean }).is_admin : undefined
  const sections = useMemo(
    () => visibleSections({ permitted, disabled, admin }),
    [permitted, disabled, admin]
  )
  const current = activeSection(sections, pathname)
  const system = useMemo(() => systemItems(items, { admin }), [items, admin])
  const [menuOpen, setMenuOpen] = useState(false)
  const navRef = useRef<HTMLDivElement>(null)

  // A navigation closes the phone menu.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setMenuOpen(false), [pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  // Left / Right move between the section links (Tab still walks them in order).
  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const links = [...(navRef.current?.querySelectorAll<HTMLElement>('[data-hub-section]') ?? [])]
    const i = links.indexOf(document.activeElement as HTMLElement)
    if (i < 0) return
    e.preventDefault()
    links[(i + (e.key === 'ArrowRight' ? 1 : links.length - 1)) % links.length]?.focus()
  }

  const systemActive = system.some((s) => itemActive(s.to, pathname))

  return (
    <header
      data-hub-topbar=''
      className='relative z-30 shrink-0 border-b border-[var(--hub-chrome-line)] bg-[var(--hub-chrome)] text-[var(--hub-chrome-text)]'
    >
      <div className='flex h-12 items-center gap-2 px-3 sm:px-4'>
        <button
          type='button'
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls='hub-topbar-menu'
          className='-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-[var(--hub-chrome-text)] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan lg:hidden'
        >
          {menuOpen ? <X className='h-5 w-5' /> : <Menu className='h-5 w-5' />}
        </button>
        <Link
          to={sections[0]?.to ?? '/'}
          data-hub-home=''
          className='mr-2 flex shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          aria-label='Nivaro Hub'
        >
          <HubWordmark onDark size='sm' logoUrl={logoUrl} />
        </Link>

        <nav
          aria-label='Hub sections'
          className='hidden h-full min-w-0 flex-1 lg:flex'
          ref={navRef}
          onKeyDown={onNavKey}
        >
          <ul className='m-0 flex h-full min-w-0 list-none items-stretch gap-0.5 overflow-x-auto p-0 [scrollbar-width:none]'>
            {sections.length > 1 && (
              <li className='flex'>
                <AllPagesMenu sections={sections} system={system} pathname={pathname} />
              </li>
            )}
            {sections.map((s) => (
              <li key={s.key} className='flex'>
                <SectionLink section={s} active={current?.key === s.key} />
              </li>
            ))}
            {system.length > 0 && (
              <li className='flex'>
                <SystemMenu items={system} active={systemActive} pathname={pathname} />
              </li>
            )}
          </ul>
        </nav>
        <div className='flex-1 lg:hidden' />

        <div className='flex shrink-0 items-center gap-0.5'>
          <button
            type='button'
            onClick={openFind}
            data-tip='Find a page, an app or a setting (Ctrl/Cmd+K)'
            aria-label='Find'
            className='flex h-8 items-center gap-1.5 rounded-md px-2 text-[12px] text-[var(--hub-chrome-text)] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          >
            <Search className='h-4 w-4' aria-hidden />
            <span className='hidden xl:inline'>Find</span>
          </button>
          {chat}
          {!narrow && tools}
          <NotificationBell collapsed compact placement='below' />
          {!narrow && <ThemeSwitcher collapsed />}
          <AccountMenu user={user} extras={accountExtras} />
        </div>
      </div>

      {menuOpen && (
        <div
          id='hub-topbar-menu'
          className='absolute inset-x-0 top-full max-h-[calc(100dvh-3rem)] overflow-y-auto border-b border-[var(--hub-chrome-line)] bg-[var(--hub-chrome)] px-2 pb-3 pt-1 shadow-[0_12px_24px_-12px_rgb(0_0_0/0.5)] lg:hidden'
        >
          {narrow && (
            <div className='mb-1 flex items-center gap-0.5 border-b border-[var(--hub-chrome-line)] px-1 pb-2'>
              {tools}
              <ThemeSwitcher collapsed />
            </div>
          )}
          <nav aria-label='Hub sections'>
            {sections.map((s) => (
              <section key={s.key} aria-label={s.title}>
                <p className='mb-1 mt-3 px-3 text-[11px] font-medium text-[var(--hub-chrome-muted)]'>
                  {s.title}
                </p>
                <ul className='m-0 list-none p-0'>
                  {s.pages.map((pg) => (
                    <li key={pg.to}>
                      <MenuLink to={pg.to} label={pg.label} active={pathname === pg.to} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {system.length > 0 && (
              <>
                <p className='mb-1 mt-3 px-3 text-[11px] font-medium text-[var(--hub-chrome-muted)]'>
                  System
                </p>
                <ul className='m-0 list-none p-0'>
                  {system.map((it) => (
                    <li key={it.to}>
                      <MenuLink
                        to={it.to}
                        label={it.label}
                        icon={it.icon}
                        active={itemActive(it.to, pathname)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  )
}

/**
 * Pages the Hub keeps that are not Hub pages (Users, Roles, Settings…), each once, in nav order.
 * `admin: false` = signed in and not an administrator (an app owner): the pages only an
 * administrator can use are left out, so System offers an owner only what they can use. With
 * nothing left the bar shows no System menu at all.
 */
export function systemItems(items: NavItem[], opts: { admin?: boolean } = {}): NavItem[] {
  const seen = new Set<string>()
  const out: NavItem[] = []
  for (const it of items) {
    if (seen.has(it.to) || it.to === '/hub' || it.to.startsWith('/hub/')) continue
    if (opts.admin === false && !hubSystemPageForEveryone(it.to)) continue
    seen.add(it.to)
    out.push(it)
  }
  return out
}

function itemActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/'
  return pathname === to || pathname.startsWith(`${to}/`)
}

const tabClass = (active: boolean) =>
  cn(
    'relative flex items-center whitespace-nowrap px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
    active
      ? 'text-white after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:rounded-full after:bg-[var(--hub-op-on-chrome,var(--nvr-cyan))]'
      : 'text-[var(--hub-chrome-text)] hover:text-white'
  )

function SectionLink({ section, active }: { section: HubSection; active: boolean }) {
  return (
    <Link
      to={section.to}
      data-hub-section=''
      data-tip={section.title === section.label ? undefined : section.title}
      aria-current={active ? 'true' : undefined}
      className={tabClass(active)}
    >
      {section.label}
    </Link>
  )
}

/**
 * The whole Hub on one sheet: every section with its pages, then System. For the first weeks,
 * when nobody knows yet which section a page lives in.
 */
function AllPagesMenu({
  sections,
  system,
  pathname
}: {
  sections: HubSection[]
  system: NavItem[]
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setOpen(false), [pathname])
  const link = (to: string, label: string) => {
    const on = pathname === to
    return (
      <Link
        to={to}
        aria-current={on ? 'page' : undefined}
        className={cn(
          'block rounded-md px-2 py-1 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          on ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted'
        )}
      >
        {label}
      </Link>
    )
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-hub-section=''
          aria-label='All pages'
          data-tip='All pages'
          className={cn(tabClass(false), 'px-2')}
        >
          <LayoutGrid className='h-4 w-4' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        sideOffset={6}
        className='max-h-[calc(100dvh-5rem)] w-[min(960px,calc(100vw-2rem))] overflow-y-auto p-4'
      >
        <nav
          aria-label='All Hub pages'
          className='grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-4 gap-y-5'
        >
          {sections.map((s) => (
            <section key={s.key} aria-label={s.title}>
              <h3 className='m-0 mb-1 px-2 text-[12px] font-semibold text-foreground'>{s.title}</h3>
              <ul className='m-0 list-none p-0'>
                {s.pages.map((pg) => (
                  <li key={pg.to}>{link(pg.to, pg.label)}</li>
                ))}
              </ul>
            </section>
          ))}
          {system.length > 0 && (
            <section aria-label='System'>
              <h3 className='m-0 mb-1 px-2 text-[12px] font-semibold text-foreground'>System</h3>
              <ul className='m-0 list-none p-0'>
                {system.map((it) => (
                  <li key={it.to}>{link(it.to, it.label)}</li>
                ))}
              </ul>
            </section>
          )}
        </nav>
      </PopoverContent>
    </Popover>
  )
}

function SystemMenu({
  items,
  active,
  pathname
}: {
  items: NavItem[]
  active: boolean
  pathname: string
}) {
  const [open, setOpen] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger
  useEffect(() => setOpen(false), [pathname])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' data-hub-section='' className={cn(tabClass(active), 'gap-1')}>
          System
          <ChevronDown className='h-3.5 w-3.5 opacity-70' aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' sideOffset={6} className='w-60 p-1.5'>
        <ul className='m-0 list-none p-0'>
          {items.map((it) => {
            const Icon = it.icon
            const on = itemActive(it.to, pathname)
            return (
              <li key={it.to}>
                <Link
                  to={it.to}
                  aria-current={on ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'bg-accent font-medium text-accent-foreground' : 'hover:bg-muted'
                  )}
                >
                  {Icon && <Icon className='h-3.5 w-3.5 shrink-0 opacity-70' aria-hidden />}
                  {it.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function MenuLink({
  to,
  label,
  icon: Icon,
  active
}: {
  to: string
  label: string
  icon?: NavItem['icon']
  active: boolean
}) {
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-10 items-center gap-2.5 rounded-md px-3 text-[14px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        active
          ? 'bg-white/[0.08] font-medium text-white shadow-[inset_2px_0_0_var(--hub-op-on-chrome,var(--nvr-cyan))]'
          : 'text-[var(--hub-chrome-text)] hover:bg-white/[0.05] hover:text-white'
      )}
    >
      {Icon && <Icon className='h-4 w-4 shrink-0 opacity-70' aria-hidden />}
      {label}
    </Link>
  )
}

function AccountMenu({
  user,
  extras
}: {
  user: { id?: string | null; name: string; email?: string | null; initials: string }
  extras?: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`Account menu: ${user.name}`}
          className='ml-0.5 inline-flex rounded-full p-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <UserAvatar
            userId={user.id ?? undefined}
            alt={user.name}
            className='h-7 w-7'
            fallback={
              <Avatar className='h-7 w-7'>
                <AvatarFallback className='bg-white/[0.15] text-[10px] font-bold text-white'>
                  {user.initials}
                </AvatarFallback>
              </Avatar>
            }
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={8} className='w-60 p-3'>
        <p className='m-0 truncate text-[13px] font-medium'>{user.name}</p>
        {user.email && (
          <p className='m-0 truncate text-[11px] text-muted-foreground'>{user.email}</p>
        )}
        <div className='my-2.5 border-t' />
        {extras}
        <Link
          to='/docs/releases'
          className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <ScrollText className='h-3.5 w-3.5' aria-hidden />
          Changelog
        </Link>
        <Link
          to='/profile'
          className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <UserRound className='h-3.5 w-3.5' aria-hidden />
          My Profile
        </Link>
        <button
          type='button'
          onClick={logout}
          className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <LogOut className='h-3.5 w-3.5' aria-hidden />
          Sign out
        </button>
        <div className='mt-2.5 flex items-center gap-2 border-t pt-2.5 text-[11px] text-muted-foreground'>
          <HubGlyph size={16} />
          <span>Nivaro Hub</span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
