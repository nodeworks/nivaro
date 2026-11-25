import { UserAvatar } from '@nivaro/shared'
import { ChevronDown, LogOut, Menu, ScrollText, UserRound, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { NotificationBell } from '@/components/notification-bell'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { NavItem } from '@/layouts/nav-config'
import { logout } from '@/lib/auth'
import { cn } from '@/lib/utils'
import { HubGlyph, HubWordmark } from './HubMark'
import { type HubSection, sectionActive, visibleSections } from './hub-sections'

/**
 * The standalone Hub's chrome: a top bar with the Hub sections in place of Nivaro's icon rail and
 * panel (rendered by AppLayout only in Hub mode). Keeps what the rail carried: the notification
 * bell, the theme switch, the account menu, and every other page the Hub keeps (under "System").
 * Below md the sections fold into a menu.
 */
export function HubTopBar({
  items,
  user,
  logoUrl
}: {
  /** The pages this person may open (AppLayout's permitted nav, already Hub-trimmed). */
  items: NavItem[]
  user: { id?: string | null; name: string; email?: string | null; initials: string }
  /** An operator's own logo (Settings → Project) replaces the mark. */
  logoUrl?: string | null
}) {
  const { pathname } = useLocation()
  const sections = visibleSections()
  const system = useMemo(() => systemItems(items, sections), [items, sections])
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
          className='-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-[var(--hub-chrome-text)] hover:bg-white/[0.06] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan md:hidden'
        >
          {menuOpen ? <X className='h-5 w-5' /> : <Menu className='h-5 w-5' />}
        </button>
        <Link
          to='/hub'
          className='mr-2 flex shrink-0 items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
          aria-label='Nivaro Hub — Apps'
        >
          <HubWordmark onDark size='sm' logoUrl={logoUrl} />
        </Link>

        <nav
          aria-label='Hub sections'
          className='hidden h-full min-w-0 flex-1 md:flex'
          ref={navRef}
          onKeyDown={onNavKey}
        >
          <ul className='m-0 flex h-full min-w-0 list-none items-stretch gap-0.5 overflow-x-auto p-0 [scrollbar-width:none]'>
            {sections.map((s) => (
              <li key={s.to} className='flex'>
                <SectionLink section={s} active={sectionActive(s, pathname)} />
              </li>
            ))}
            {system.length > 0 && (
              <li className='flex'>
                <SystemMenu items={system} active={systemActive} pathname={pathname} />
              </li>
            )}
          </ul>
        </nav>
        <div className='flex-1 md:hidden' />

        <div className='flex shrink-0 items-center gap-0.5'>
          <NotificationBell collapsed compact />
          <ThemeSwitcher collapsed />
          <AccountMenu user={user} />
        </div>
      </div>

      {menuOpen && (
        <div
          id='hub-topbar-menu'
          className='absolute inset-x-0 top-full max-h-[calc(100dvh-3rem)] overflow-y-auto border-b border-[var(--hub-chrome-line)] bg-[var(--hub-chrome)] px-2 pb-3 pt-1 shadow-[0_12px_24px_-12px_rgb(0_0_0/0.5)] md:hidden'
        >
          <nav aria-label='Hub sections'>
            <ul className='m-0 list-none p-0'>
              {sections.map((s) => (
                <li key={s.to}>
                  <MenuLink to={s.to} label={s.label} active={sectionActive(s, pathname)} />
                </li>
              ))}
            </ul>
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

/** Pages the Hub keeps that are not a section of their own, each once, in nav order. */
export function systemItems(items: NavItem[], sections: HubSection[]): NavItem[] {
  const taken = new Set(sections.map((s) => s.to))
  const seen = new Set<string>()
  const out: NavItem[] = []
  for (const it of items) {
    if (taken.has(it.to) || seen.has(it.to) || it.to.startsWith('/hub')) continue
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
      ? 'text-white after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:rounded-full after:bg-nvr-cyan'
      : 'text-[var(--hub-chrome-text)] hover:text-white'
  )

function SectionLink({ section, active }: { section: HubSection; active: boolean }) {
  return (
    <Link
      to={section.to}
      data-hub-section=''
      aria-current={active ? 'page' : undefined}
      className={tabClass(active)}
    >
      {section.label}
    </Link>
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
          ? 'bg-white/[0.08] font-medium text-white shadow-[inset_2px_0_0_var(--nvr-cyan)]'
          : 'text-[var(--hub-chrome-text)] hover:bg-white/[0.05] hover:text-white'
      )}
    >
      {Icon && <Icon className='h-4 w-4 shrink-0 opacity-70' aria-hidden />}
      {label}
    </Link>
  )
}

function AccountMenu({
  user
}: {
  user: { id?: string | null; name: string; email?: string | null; initials: string }
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
      <PopoverContent align='end' sideOffset={8} className='w-56 p-3'>
        <p className='m-0 truncate text-[13px] font-medium'>{user.name}</p>
        {user.email && (
          <p className='m-0 truncate text-[11px] text-muted-foreground'>{user.email}</p>
        )}
        <div className='my-2.5 border-t' />
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
