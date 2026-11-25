import { useOverflowTip } from '@nivaro/shared'
import { type ComponentType, type ReactNode, Suspense, useCallback, useEffect } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ScrollTabStrip } from '@/components/tab-strip'
import { Skeleton } from '@/components/ui/skeleton'
import { useHubProductFlag } from '@/lib/hub-product'
import {
  type HubDef,
  type HubTabDef,
  type HubTabGroup,
  hubForPath,
  hubTabGroup,
  hubTabPath
} from '@/lib/hubs'
import { cn } from '@/lib/utils'

/**
 * A hub page (lib/hubs.ts): the hub's header and tab strip, then the active
 * tab's screen. The layout keys the page on the hub, not the pathname, so
 * switching tabs swaps only the body — the header and strip stay mounted and
 * keyboard focus stays on the strip.
 */
export function HubPage({
  hub,
  components
}: {
  hub: HubDef
  /** Screen per tab path ('' for the first tab). */
  components: Record<string, ComponentType>
}) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const hubLook = useHubProductFlag()
  const match = hubForPath(pathname)
  const tabDomId = useCallback(
    (path: string) => `hub-tab${hub.base.replace(/\//g, '-')}-${path || 'index'}`,
    [hub.base]
  )
  const tabLabel = match?.hub === hub ? match.tab.label : null

  // Name the tab in the browser tab and history ("Tuning · Database — <app>").
  useEffect(() => {
    if (!tabLabel) return
    const app = document.title.split(' — ').pop() ?? document.title
    document.title = `${tabLabel} · ${hub.title} — ${app}`
    return () => {
      document.title = app
    }
  }, [tabLabel, hub.title])

  if (!match || match.hub !== hub) return <Navigate to={hub.base} replace />

  const active = match.tab
  // The standalone Hub look names the tab (its top bar already names the hub); a tab without
  // its own hint, and every regular install, keeps the hub's title and hint.
  const tabHeader = hubLook && !!active.hint
  const title = tabHeader ? active.label : hub.title
  const hint = tabHeader ? active.hint : hub.hint
  const panelId = `hub-panel${hub.base.replace(/\//g, '-')}`
  // With groups the open tab is named by the second strip, or by its group when that strip does
  // not show it (a group of one, or a tab the Hub look leaves to its top bar).
  const group = hub.groups ? hubTabGroup(hub, active.path) : null
  const labelledBy =
    group && !groupStripTabs(hub, group, hubLook).includes(active)
      ? groupDomId(hub, group.key)
      : tabDomId(active.path)
  const Body = components[active.path]
  const Icon = hub.icon

  return (
    // data-hub-base: the standalone Hub look (hub-brand.css) styles its own hub by it; inert otherwise.
    <div className='flex flex-1 min-h-0 flex-col' data-hub-base={hub.base}>
      <header className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3 px-4 pt-3 sm:px-6 sm:pt-4'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
            <Icon className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' aria-hidden />
          </div>
          <div className='min-w-0'>
            <h1 className='m-0 truncate text-base font-semibold text-slate-900 dark:text-foreground'>
              {title}
            </h1>
            <p
              className={cn(
                'm-0 truncate text-[12px] text-slate-500 dark:text-muted-foreground',
                tabHeader && 'max-sm:hidden'
              )}
            >
              {hint}
            </p>
          </div>
        </div>
        {hub.groups ? (
          <GroupedTabStrips hub={hub} active={active} hubLook={hubLook} panelId={panelId} />
        ) : (
          <ScrollTabStrip
            className='mt-1.5'
            tabs={hub.tabs.map((t) => ({ id: t.path, label: t.label }))}
            active={active.path}
            onSelect={(path) => {
              const tab = hub.tabs.find((t) => t.path === path)
              if (tab) navigate(hubTabPath(hub, tab))
            }}
            ariaLabel={`${hub.title} views`}
            tabDomId={tabDomId}
            panelId={panelId}
          />
        )}
      </header>
      <div
        id={panelId}
        role='tabpanel'
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern; the panel is a tab stop so keyboard users reach a body that opens with text
        tabIndex={0}
        aria-labelledby={labelledBy}
        className='flex flex-1 min-h-0 flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
      >
        <Suspense fallback={<HubTabFallback />}>{Body && <Body key={active.path} />}</Suspense>
      </div>
    </div>
  )
}

const groupDomId = (hub: HubDef, key: string) => `hub-group${hub.base.replace(/\//g, '-')}-${key}`

/** A group's tabs as its strip shows them: one tab alone shows no strip (empty list). */
function groupStripTabs(hub: HubDef, group: HubTabGroup, hubLook: boolean): HubTabDef[] {
  const tabs = group.tabs
    .map((p) => hub.tabs.find((t) => t.path === p))
    .filter((t): t is HubTabDef => !!t && !(hubLook && t.topBar))
  return tabs.length > 1 ? tabs : []
}

/**
 * A hub with groups (only the Apps hub): the groups in one strip, the open group's tabs in a
 * quieter strip under it. Choosing a group opens its first tab. A group of one tab shows no
 * second strip. In the standalone Hub look a tab its top bar also links (`topBar`) is left out.
 */
function GroupedTabStrips({
  hub,
  active,
  hubLook,
  panelId
}: {
  hub: HubDef
  active: HubTabDef
  hubLook: boolean
  panelId: string
}) {
  const navigate = useNavigate()
  const groups = hub.groups ?? []
  const open = hubTabGroup(hub, active.path) ?? groups[0]
  const openTabs = groupStripTabs(hub, open, hubLook)
  const groupId = useCallback((key: string) => groupDomId(hub, key), [hub])
  const tabDomId = useCallback(
    (path: string) => `hub-tab${hub.base.replace(/\//g, '-')}-${path || 'index'}`,
    [hub.base]
  )
  /** The tab a group opens on: its first one this look shows. */
  const landing = (g: HubTabGroup) =>
    g.tabs.map((p) => hub.tabs.find((t) => t.path === p)).find((t) => t && !(hubLook && t.topBar))
  return (
    <>
      <ScrollTabStrip
        className='mt-1.5'
        tabs={groups.map((g) => ({ id: g.key, label: g.label }))}
        active={open.key}
        onSelect={(key) => {
          const g = groups.find((x) => x.key === key)
          const first = g && landing(g)
          if (first) navigate(hubTabPath(hub, first))
        }}
        ariaLabel={`${hub.title} sections`}
        tabDomId={groupId}
        panelId={panelId}
      />
      {openTabs.length > 0 && (
        <div className='border-t border-slate-200 bg-slate-50 dark:border-border dark:bg-background'>
          <ScrollTabStrip
            variant='sub'
            tabs={openTabs.map((t) => ({ id: t.path, label: t.label }))}
            active={active.path}
            onSelect={(path) => {
              const tab = hub.tabs.find((t) => t.path === path)
              if (tab) navigate(hubTabPath(hub, tab))
            }}
            ariaLabel={`${open.label} views`}
            tabDomId={tabDomId}
            panelId={panelId}
          />
        </div>
      )}
    </>
  )
}

function HubTabFallback() {
  return (
    <div className='flex-1 space-y-3 bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      <Skeleton className='h-10 w-full max-w-[640px]' />
      <Skeleton className='h-[220px] w-full' />
    </div>
  )
}

/**
 * The strip under a hub's tabs: what this tab is for (left), its actions
 * (right), and anything that belongs with them (filters, a summary line) below.
 * The hub header already carries the title, so a tab never repeats it. On a
 * screen narrower than md the description stops at two lines (the full text is its tip),
 * so the tab's own content stays above the fold.
 */
export function HubToolbar({
  description,
  actions,
  children,
  className
}: {
  description?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const tipRef = useOverflowTip<HTMLParagraphElement>(
    typeof description === 'string' ? description : null
  )
  return (
    <div
      className={cn(
        'flex min-h-16 shrink-0 flex-col justify-center border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-border dark:bg-card',
        className
      )}
    >
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        {description && (
          <p
            ref={tipRef}
            className='m-0 line-clamp-2 min-w-0 max-w-[72ch] flex-1 basis-[320px] text-[12px] leading-relaxed text-slate-600 md:line-clamp-none dark:text-muted-foreground'
          >
            {description}
          </p>
        )}
        {actions && <div className='ml-auto flex flex-wrap items-center gap-2'>{actions}</div>}
      </div>
      {children}
    </div>
  )
}

/** Old standalone path → its hub tab, keeping the query string and hash. */
export function HubRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={{ pathname: to, search, hash }} replace />
}
