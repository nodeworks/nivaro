import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { DockerNotConfigured, HostError } from './ui'

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
  intro
}: {
  area: string
  intro?: ReactNode
  children: (data: T, host: string) => ReactNode
}) {
  const { data, isLoading, error } = useInventory<T>(area)
  if (isLoading)
    return (
      <div className='space-y-3'>
        <Skeleton className='h-6 w-48' />
        <Skeleton className='h-40' />
      </div>
    )
  if (error || !data)
    return (
      <p className='text-[13px] text-red-600 dark:text-red-400'>
        Could not read the Docker inventory.
      </p>
    )
  if (!data.configured) return <DockerNotConfigured />
  return (
    <div className='space-y-6'>
      {intro && (
        <p className='max-w-prose text-[12px] text-slate-600 dark:text-muted-foreground'>{intro}</p>
      )}
      {data.hosts.map((h) => (
        <section key={h.host} className='space-y-2'>
          <h2 className='text-[13px] font-semibold'>{h.host}</h2>
          {h.error || !h.data ? (
            <HostError host={h.host} error={h.error ?? 'No data'} />
          ) : (
            children(h.data, h.host)
          )}
        </section>
      ))}
    </div>
  )
}

export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th
    className={cn(
      'px-3 py-1.5 text-left font-medium text-slate-500 dark:text-muted-foreground',
      className
    )}
  >
    {children}
  </th>
)

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cn('px-3 py-1.5 align-top', className)}>{children}</td>
)

export function DataTable({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full min-w-[720px] text-[12px]'>
        <thead className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'>
          <tr>{head}</tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border'>{children}</tbody>
      </table>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className='rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-[12px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
      {children}
    </p>
  )
}

/** A flag explained in a sentence; the text is the finding, not a code. */
export function Flags({ flags }: { flags: Array<{ code: string; text: string }> }) {
  if (flags.length === 0) return null
  return (
    <ul className='mt-1 space-y-1'>
      {flags.map((f) => (
        <li key={f.code} className='flex items-start gap-1.5 text-amber-800 dark:text-amber-300'>
          <AlertTriangle className='mt-0.5 h-3 w-3 shrink-0' />
          <span className='break-words'>{f.text}</span>
        </li>
      ))}
    </ul>
  )
}

export function Pill({
  tone = 'slate',
  children
}: {
  tone?: 'slate' | 'green' | 'amber' | 'red'
  children: ReactNode
}) {
  const t = {
    slate: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-muted-foreground',
    green: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-300',
    red: 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300'
  }[tone]
  return <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-medium', t)}>{children}</span>
}

export function duration(s: number | null | undefined): string {
  if (s == null) return '—'
  const d = Math.floor(s / 86400)
  if (d >= 1) return `${d}d`
  const h = Math.floor(s / 3600)
  if (h >= 1) return `${h}h`
  return `${Math.max(1, Math.floor(s / 60))}m`
}

export const Stat = ({ label, value }: { label: string; value: ReactNode }) => (
  <div className='bg-white px-3 py-2 dark:bg-card'>
    <div className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</div>
    <div className='text-[13px] font-semibold tabular-nums'>{value}</div>
  </div>
)

export const StatStrip = ({ children }: { children: ReactNode }) => (
  <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
    {children}
  </div>
)
