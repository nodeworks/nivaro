import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Chip,
  DockerNotConfigured,
  EmptyNote,
  HOSTS_STACK,
  HostBlock,
  Intro,
  LoadError,
  META_CELL,
  META_GRID,
  PANEL,
  TABLE,
  TabSkeleton,
  TD,
  TH
} from './ui'

export interface HostResult<T> {
  host: string
  data: T | null
  error: string | null
}

export interface InventoryResponse<T> {
  configured: boolean
  hosts: HostResult<T>[]
  version?: string
}

export function useInventory<T>(area: string) {
  return useQuery({
    queryKey: ['infrastructure', 'inventory', area],
    queryFn: async () =>
      (await api.get(`/infrastructure/inventory/${area}`)).data.data as InventoryResponse<T>,
    staleTime: 30_000
  })
}

/** Loading / not-configured / per-host error wrapper shared by the inventory tabs. */
export function InventoryTab<T>({
  area,
  children,
  intro,
  toolbar,
  aside
}: {
  area: string
  intro?: ReactNode
  toolbar?: ReactNode
  /** Status chips beside each host's name. */
  aside?: (data: T, host: string) => ReactNode
  children: (data: T, host: string) => ReactNode
}) {
  const { data, isLoading, error, refetch } = useInventory<T>(area)
  if (isLoading) return <TabSkeleton />
  if (error || !data) return <LoadError what='the Docker inventory' onRetry={refetch} />
  if (!data.configured) return <DockerNotConfigured />
  return (
    <div className='space-y-5'>
      {intro && <Intro>{intro}</Intro>}
      {toolbar}
      <div className={HOSTS_STACK}>
        {data.hosts.map((h) => (
          <HostBlock
            key={h.host}
            host={h.host}
            error={h.error ?? (h.data ? null : 'The host sent no data.')}
            aside={h.data ? aside?.(h.data, h.host) : undefined}
          >
            {h.data != null && children(h.data, h.host)}
          </HostBlock>
        ))}
      </div>
    </div>
  )
}

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cn(TH, className)}>{children}</th>
)

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cn(TD, className)}>{children}</td>
)

export function DataTable({
  head,
  children,
  footer
}: {
  head: ReactNode
  children: ReactNode
  /** Under the rows, inside the panel ("Show all 224"). */
  footer?: ReactNode
}) {
  return (
    <div className={PANEL}>
      <table className={cn(TABLE, 'min-w-[720px]')}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {footer && (
        <div className='border-t border-slate-200 px-3 py-2 dark:border-border'>{footer}</div>
      )}
    </div>
  )
}

export const Empty = EmptyNote

/** A flag explained in a sentence; the text is the finding, not a code. */
export function Flags({ flags }: { flags: Array<{ code: string; text: string }> }) {
  if (flags.length === 0) return null
  return (
    <ul className='mt-1 space-y-1'>
      {flags.map((f) => (
        <li
          key={f.code}
          className='flex items-start gap-1.5 font-sans text-[12px] leading-snug text-amber-800 dark:text-amber-300'
        >
          <AlertTriangle className='mt-0.5 h-3 w-3 shrink-0' aria-hidden />
          <span className='break-words'>{f.text}</span>
        </li>
      ))}
    </ul>
  )
}

const PILL_TONE = { slate: 'muted', green: 'ok', amber: 'warn', red: 'bad' } as const

export function Pill({
  tone = 'slate',
  children
}: {
  tone?: 'slate' | 'green' | 'amber' | 'red'
  children: ReactNode
}) {
  return <Chip tone={PILL_TONE[tone]}>{children}</Chip>
}

export function duration(s: number | null | undefined): string {
  if (s == null) return '—'
  const d = Math.floor(s / 86400)
  if (d >= 1) return `${d}d`
  const h = Math.floor(s / 3600)
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.floor(s / 60))}m`
}

export const Stat = ({
  label,
  value,
  tone
}: {
  label: string
  value: ReactNode
  tone?: 'warn' | 'bad'
}) => (
  <div className={cn(META_CELL, 'min-w-0 px-3 py-2')}>
    <div className='truncate text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</div>
    <div
      className={cn(
        'mt-0.5 truncate text-[14px] font-semibold tabular-nums',
        tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : tone === 'warn'
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-slate-900 dark:text-foreground'
      )}
    >
      {value}
    </div>
  </div>
)

export const StatStrip = ({ children }: { children: ReactNode }) => (
  <div
    className={META_GRID}
    style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 50%), 1fr))' }}
  >
    {children}
  </div>
)
