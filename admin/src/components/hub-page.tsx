import { useOverflowTip } from '@nivaro/shared'
import { type ComponentType, type ReactNode, Suspense, useCallback, useEffect } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { ScrollTabStrip } from '@/components/tab-strip'
import { Skeleton } from '@/components/ui/skeleton'
import { type HubDef, hubForPath, hubTabPath } from '@/lib/hubs'
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
  const panelId = `hub-panel${hub.base.replace(/\//g, '-')}`
  const Body = components[active.path]
  const Icon = hub.icon

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3 px-4 pt-3 sm:px-6 sm:pt-4'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
            <Icon className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' aria-hidden />
          </div>
          <div className='min-w-0'>
            <h1 className='m-0 text-base font-semibold text-slate-900 dark:text-foreground'>
              {hub.title}
            </h1>
            <p className='m-0 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
              {hub.hint}
            </p>
          </div>
        </div>
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
      </header>
      <div
        id={panelId}
        role='tabpanel'
        // biome-ignore lint/a11y/noNoninteractiveTabindex: WAI-ARIA tabs pattern; the panel is a tab stop so keyboard users reach a body that opens with text
        tabIndex={0}
        aria-labelledby={tabDomId(active.path)}
        className='flex flex-1 min-h-0 flex-col focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
      >
        <Suspense fallback={<HubTabFallback />}>{Body && <Body key={active.path} />}</Suspense>
      </div>
    </div>
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
