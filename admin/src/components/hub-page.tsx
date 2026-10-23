import { type ComponentType, type KeyboardEvent, type ReactNode, Suspense } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/**
 * Hub pages: several related screens behind one nav entry, one tab per screen.
 *
 * A tab is a PATH segment under the hub (`/database/tuning`), never a `?tab=`
 * param, so every tab keeps its own query string (`/database/sql-checks?tab=
 * findings&severity=critical`, `/database/tuning?proposal=12`) and the old
 * standalone paths redirect onto it with their query intact. The first tab
 * lives at the hub's own path.
 */
export type HubTab = {
  /** Path segment under the hub; '' for the first tab. */
  path: string
  label: string
  component: ComponentType
}

const tabDomId = (base: string, path: string) =>
  `hub-tab${base.replace(/\//g, '-')}-${path || 'index'}`

export function HubPage({
  icon: Icon,
  title,
  hint,
  base,
  tabs
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  hint: string
  /** The hub's own path, e.g. '/database'. */
  base: string
  tabs: HubTab[]
}) {
  const navigate = useNavigate()
  const segment = (useParams()['*'] ?? '').split('/')[0]
  const active = tabs.find((t) => t.path === segment)
  if (!active) return <Navigate to={base} replace />

  const go = (t: HubTab) => navigate(t.path ? `${base}/${t.path}` : base)
  const panelId = `hub-panel${base.replace(/\//g, '-')}`

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.indexOf(active)
    const next =
      e.key === 'ArrowRight'
        ? tabs[(i + 1) % tabs.length]
        : e.key === 'ArrowLeft'
          ? tabs[(i - 1 + tabs.length) % tabs.length]
          : e.key === 'Home'
            ? tabs[0]
            : e.key === 'End'
              ? tabs[tabs.length - 1]
              : null
    if (!next) return
    e.preventDefault()
    go(next)
    requestAnimationFrame(() => document.getElementById(tabDomId(base, next.path))?.focus())
  }

  const Body = active.component
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3 px-4 pt-3 sm:px-6 sm:pt-4'>
          <div className='flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-nvr-cyan/15'>
            <Icon className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
          </div>
          <div className='min-w-0'>
            <h1 className='m-0 text-base font-semibold text-slate-900 dark:text-foreground'>
              {title}
            </h1>
            <p className='m-0 truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
              {hint}
            </p>
          </div>
        </div>
        <div
          role='tablist'
          aria-label={`${title} views`}
          onKeyDown={onKeyDown}
          className='mt-1.5 flex items-stretch gap-0.5 overflow-x-auto px-2.5 [scrollbar-width:none] sm:px-4 [&::-webkit-scrollbar]:hidden'
        >
          {tabs.map((t) => {
            const on = t === active
            return (
              <button
                key={t.path}
                id={tabDomId(base, t.path)}
                type='button'
                role='tab'
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                onClick={() => !on && go(t)}
                className={cn(
                  'shrink-0 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan',
                  on
                    ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                    : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                )}
              >
                {t.label}
              </button>
            )
          })}
        </div>
      </header>
      <div
        id={panelId}
        role='tabpanel'
        aria-labelledby={tabDomId(base, active.path)}
        className='flex flex-1 min-h-0 flex-col'
      >
        <Suspense fallback={<HubTabFallback />}>
          <Body key={active.path} />
        </Suspense>
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
 * The hub header already carries the title, so a tab never repeats it.
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
  return (
    <div
      className={cn(
        'shrink-0 border-b border-slate-200 bg-white px-4 py-3 sm:px-6 dark:border-border dark:bg-card',
        className
      )}
    >
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
        {description && (
          <p className='m-0 min-w-0 max-w-[80ch] flex-1 basis-[320px] text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
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
