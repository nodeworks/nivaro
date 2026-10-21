import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import {
  Chip,
  DockerNotConfigured,
  HOSTS_STACK,
  HostBlock,
  LoadError,
  TabSkeleton,
  type Tone,
  useInfraStatus
} from './ui'

export {
  Chip,
  EmptyNote,
  META_CELL,
  META_GRID,
  PANEL,
  StatStrip,
  TABLE,
  TD,
  TH,
  type Tone
} from './ui'

/**
 * Shared pieces of the Stacks / Updates / Health / Swarm / Secrets tabs (#2826–#2828, #2838,
 * #2839): the per-host fetch, the host section, the counts strip, chips and time formatting.
 */

export interface PerHost<T> {
  host: string
  data: T | null
  error: string | null
}

/** GET /api/infrastructure/<path> → `{ hosts: PerHost<T>[] }` plus any extra top-level keys. */
export function useInfraHosts<T, X extends object = object>(
  path: string,
  opts: {
    refetchInterval?:
      | number
      | false
      | ((data: (X & { hosts: PerHost<T>[] }) | undefined) => number | false)
  } = {}
) {
  return useQuery({
    queryKey: ['infrastructure', path],
    queryFn: async () =>
      (await api.get(`/infrastructure/${path}`)).data.data as X & { hosts: PerHost<T>[] },
    staleTime: 5_000,
    refetchInterval:
      typeof opts.refetchInterval === 'function'
        ? (q) => (opts.refetchInterval as (d: unknown) => number | false)(q.state.data)
        : opts.refetchInterval
  })
}

/**
 * The shell every Docker-backed tab shares: not-configured, loading and request-error states, then
 * one section per host — a failing host shows its error and the others still render.
 */
export function InfraHostsView<T>({
  query,
  toolbar,
  aside,
  children
}: {
  query: {
    data?: { hosts: PerHost<T>[] }
    isLoading: boolean
    error: unknown
    refetch?: () => unknown
  }
  toolbar?: ReactNode
  /** Status chips beside each host's name (counts, verdicts). */
  aside?: (data: T | null, host: string) => ReactNode
  children: (data: T, host: string) => ReactNode
}) {
  const status = useInfraStatus()
  if (status.data && !status.data.docker.configured) return <DockerNotConfigured />
  if (query.isLoading || status.isLoading) return <TabSkeleton />
  if (query.error || !query.data)
    return <LoadError what='the Docker hosts' onRetry={query.refetch} />
  return (
    <div className='space-y-5'>
      {toolbar}
      <div className={HOSTS_STACK}>
        {query.data.hosts.map((h) => (
          <HostBlock key={h.host} host={h.host} error={h.error} aside={aside?.(h.data, h.host)}>
            {h.data ? children(h.data, h.host) : null}
          </HostBlock>
        ))}
      </div>
    </div>
  )
}

export function SearchBox({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
}) {
  return (
    <div className='relative w-full max-w-xs'>
      <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className='h-8 pl-8 text-[12px]'
      />
    </div>
  )
}

/** A toggle chip for a filter ("Failing only"). */
export function FilterChip({
  on,
  onToggle,
  children
}: {
  on: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onToggle}
      className={cn(
        'h-8 rounded-md border px-2.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
        on
          ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-slate-900 dark:text-foreground'
          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:bg-muted'
      )}
    >
      {children}
    </button>
  )
}

/** Tone for a task / container / node state word. */
export function stateTone(state: string | null | undefined): Tone {
  switch (state) {
    case 'running':
    case 'ready':
    case 'healthy':
    case 'completed':
    case 'complete':
    case 'active':
    case 'reachable':
      return 'ok'
    case 'failed':
    case 'rejected':
    case 'orphaned':
    case 'dead':
    case 'down':
    case 'unhealthy':
    case 'unreachable':
    case 'rollback_started':
    case 'rollback_paused':
    case 'paused':
      return 'bad'
    case 'pending':
    case 'starting':
    case 'preparing':
    case 'assigned':
    case 'accepted':
    case 'restarting':
    case 'updating':
    case 'drain':
    case 'rollback_completed':
      return 'warn'
    default:
      return 'muted'
  }
}

export const stateLabel = (s: string | null | undefined): string =>
  s ? s.replace(/_/g, ' ') : 'unknown'

export function StateChip({ state, tip }: { state: string | null | undefined; tip?: string }) {
  return (
    <Chip tone={stateTone(state)} tip={tip}>
      {stateLabel(state)}
    </Chip>
  )
}

/** 1.2 s, 45 s, 3 min 10 s, 2 h 5 min, 3 d 4 h. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)} s`
  if (s < 60) return `${Math.round(s)} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min${s % 60 >= 1 ? ` ${Math.floor(s % 60)} s` : ''}`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`
  const d = Math.floor(h / 24)
  return `${d} d${h % 24 ? ` ${h % 24} h` : ''}`
}

/** Relative age with the exact time as an instant tooltip. */
export function Ago({ at }: { at: string | null | undefined }) {
  if (!at) return <span className='text-slate-400'>—</span>
  return (
    <span data-tip={new Date(at).toLocaleString()} className='whitespace-nowrap tabular-nums'>
      {formatRelative(at)}
    </span>
  )
}

/** Image name (mono) with its short digest as a tooltip. */
export function ImageRef({ image, digest }: { image: string | null; digest?: string | null }) {
  if (!image) return <span className='text-slate-400'>—</span>
  return (
    <span className='flex min-w-0 max-w-full items-baseline gap-1.5'>
      <span className='truncate font-mono text-[12px]' data-tip={image}>
        {image}
      </span>
      {digest && (
        <span className='shrink-0 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          @{digest.slice(0, 7)}
        </span>
      )}
    </span>
  )
}

export const matches = (q: string, ...values: Array<string | null | undefined>): boolean => {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  return values.some((v) => v?.toLowerCase().includes(needle))
}
