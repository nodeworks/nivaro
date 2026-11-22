import { useQuery } from '@tanstack/react-query'
import { LayoutGrid } from 'lucide-react'
import { useApiFetchConfig } from '../../context'
import { cn } from '../../lib/utils'
import { useOverflowTip } from '../TipLayer'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/** The app's name, cut to one line; the whole name shows on hover only when it is cut. */
function AppName({ name, className }: { name: string; className?: string }) {
  const ref = useOverflowTip<HTMLSpanElement>(name)
  return (
    <span ref={ref} className={cn('truncate', className)}>
      {name}
    </span>
  )
}

export interface HubSwitcherApp {
  app_key: string
  app_name: string
  environment_key: string
  url: string
  signin_url: string
  current: boolean
}

export interface HubSwitcherData {
  apps: HubSwitcherApp[]
  unavailable: boolean
}

/** A link is followed only when it is https, or http on a loopback host (local development). */
export function isSafeSwitcherLink(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:') return true
    return (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
    )
  } catch {
    return false
  }
}

const NOTHING: HubSwitcherData = { apps: [], unavailable: false }

export function HubSwitcherView({
  apps,
  unavailable,
  variant = 'header',
  defaultOpen,
  className
}: HubSwitcherData & {
  variant?: 'rail' | 'header'
  defaultOpen?: boolean
  /** Appended to the trigger button's classes (a host matching its own icon buttons). */
  className?: string
}) {
  // Only worth a button when it can take the person somewhere: at least one other app with a
  // safe link (a list holding only "You are here" hides it; ruling P7-18).
  const elsewhere = apps.some((a) => !a.current && isSafeSwitcherLink(a.signin_url))
  if (!elsewhere && !unavailable) return null
  return (
    <Popover defaultOpen={defaultOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Your apps'
          data-tip='Your apps'
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
            variant === 'rail'
              ? 'h-8 w-8 text-slate-400 hover:bg-white/[0.05] hover:text-white'
              : 'h-9 w-9 border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50 hover:text-slate-800 dark:border-border dark:bg-card dark:text-slate-300 dark:hover:bg-muted dark:hover:text-foreground',
            className
          )}
        >
          <LayoutGrid className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={variant === 'rail' ? 'right' : 'bottom'}
        align='end'
        className='w-[min(18rem,calc(100vw-2rem))] p-1.5'
      >
        <div className='px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          Your apps
        </div>
        {unavailable && (
          <p className='px-2 py-2 text-[13px] text-slate-600 dark:text-slate-300'>
            The app list is not available right now. Try again in a few minutes.
          </p>
        )}
        <ul className='m-0 list-none p-0'>
          {apps.map((a) => {
            const chip =
              a.environment_key && a.environment_key !== 'production' ? (
                <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-white/[0.08] dark:text-slate-300'>
                  {a.environment_key}
                </span>
              ) : null
            const row =
              'flex items-center justify-between gap-2 rounded-md px-2 py-2 text-[13px] text-slate-800 dark:text-slate-100'
            if (a.current)
              return (
                <li key={`${a.app_key}:${a.environment_key}`}>
                  <div className={cn(row, 'bg-slate-50 dark:bg-white/[0.06]')} aria-current='true'>
                    <AppName name={a.app_name} className='font-medium' />
                    <span className='flex shrink-0 items-center gap-2'>
                      <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                        You are here
                      </span>
                      {chip}
                    </span>
                  </div>
                </li>
              )
            if (!isSafeSwitcherLink(a.signin_url)) return null
            return (
              <li key={`${a.app_key}:${a.environment_key}`}>
                <a
                  href={a.signin_url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className={cn(row, 'hover:bg-slate-100 dark:hover:bg-white/[0.06]')}
                >
                  <AppName name={a.app_name} />
                  {chip}
                </a>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/** App switcher: the other apps this person uses through the Hub. Mount only when the server
 * lists the `hub_switcher` feature (GET /api/hub-switcher answers 404 otherwise). */
export function HubSwitcher({
  variant = 'header',
  className
}: {
  variant?: 'rail' | 'header'
  className?: string
}) {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const { data } = useQuery({
    queryKey: ['hub-switcher'],
    staleTime: 5 * 60_000,
    retry: false,
    queryFn: async (): Promise<HubSwitcherData> => {
      const res = await fetch(`${apiBase}/hub-switcher`, { credentials, headers: authHeaders })
      if (!res.ok) return NOTHING
      const body = (await res.json().catch(() => null)) as {
        data?: Partial<HubSwitcherData>
      } | null
      const apps = Array.isArray(body?.data?.apps) ? (body?.data?.apps as HubSwitcherApp[]) : []
      return { apps, unavailable: body?.data?.unavailable === true }
    }
  })
  return <HubSwitcherView {...(data ?? NOTHING)} variant={variant} className={className} />
}
