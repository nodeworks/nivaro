import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'Something went wrong'

export const cardCls =
  'rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
export const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
export const thCls =
  'px-3 py-2 text-left text-[12px] font-medium text-slate-500 dark:text-muted-foreground'
export const tdCls = 'px-3 py-2 align-top'

export const money = (n: number | null | undefined) =>
  n == null
    ? '—'
    : n.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2,
        maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? 4 : 2
      })

export const whole = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString())

export const monthLabel = (m: string) =>
  new Date(`${m}-01T12:00:00Z`).toLocaleString(undefined, { month: 'long', year: 'numeric' })

export function Change({ pct }: { pct: number | null }) {
  if (pct == null) return <span className='text-slate-400'>—</span>
  return (
    <span
      className={cn(
        'tabular-nums',
        pct > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
      )}
    >
      {pct > 0 ? '+' : ''}
      {pct}%
    </span>
  )
}

/** The 1px-divider stat strip (the meta grid pattern). */
export function Stats({
  items
}: {
  items: Array<{ label: string; value: string; hint?: string }>
}) {
  return (
    <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border md:grid-cols-4'>
      {items.map((s) => (
        <div key={s.label} className='bg-white px-4 py-3 dark:bg-card'>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{s.label}</p>
          <p className='text-lg font-semibold tabular-nums'>{s.value}</p>
          {s.hint && (
            <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>{s.hint}</p>
          )}
        </div>
      ))}
    </div>
  )
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className='space-y-2'>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className='h-8 w-full' />
      ))}
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn(cardCls, 'text-[12px] text-slate-500 dark:text-muted-foreground')}>
      {children}
    </div>
  )
}

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-[12px] text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300'>
      {errMsg(error)}
    </div>
  )
}

export function DaysSelect({
  value,
  onChange,
  options = [7, 14, 30]
}: {
  value: number
  onChange: (n: number) => void
  options?: number[]
}) {
  return (
    <SimpleSelect
      ariaLabel='Period'
      className='h-8 w-36 text-[12px]'
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
      options={options.map((d) => ({ value: String(d), label: `Last ${d} days` }))}
    />
  )
}

export function Chip({
  tone,
  children
}: {
  tone: 'neutral' | 'good' | 'warn' | 'bad'
  children: React.ReactNode
}) {
  const t = {
    neutral: 'bg-slate-100 text-slate-700 dark:bg-muted dark:text-muted-foreground',
    good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
    warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
    bad: 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'
  }[tone]
  return <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[12px]', t)}>{children}</span>
}
