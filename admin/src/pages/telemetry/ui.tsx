import { AlertTriangle, type Telescope } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Status tones, the dot, the card and the inline error line shared by the Telemetry page and its panels. */
export type Tone = 'ok' | 'warn' | 'bad' | 'off'

export const TONE: Record<Tone, { dot: string; text: string; ring: string }> = {
  ok: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-700 dark:text-emerald-400',
    ring: 'border-slate-200 dark:border-border'
  },
  warn: {
    dot: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
    ring: 'border-amber-300 dark:border-amber-500/40'
  },
  bad: {
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    ring: 'border-red-300 dark:border-red-500/40'
  },
  off: {
    dot: 'bg-slate-300 dark:bg-slate-600',
    text: 'text-muted-foreground',
    ring: 'border-slate-200 dark:border-border'
  }
}

export function PartError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p className='m-0 flex items-start gap-1.5 text-[12px] text-amber-700 dark:text-amber-400'>
      <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden='true' />
      {error}
    </p>
  )
}

export function Dot({ tone }: { tone: Tone }) {
  return (
    <span
      aria-hidden='true'
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', TONE[tone].dot)}
    />
  )
}

export function Card({
  title,
  icon: Icon,
  aside,
  asideTone = 'off',
  children
}: {
  title: string
  icon: typeof Telescope
  aside?: ReactNode
  asideTone?: Tone
  children: ReactNode
}) {
  return (
    <section className='min-w-0 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <Icon className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden='true' />
        <h2 className='m-0 text-[13px] font-semibold'>{title}</h2>
        {aside && (
          <div
            className={cn(
              'ml-auto min-w-0 truncate text-[11.5px]',
              asideTone === 'off' ? 'text-muted-foreground' : TONE[asideTone].text
            )}
          >
            {aside}
          </div>
        )}
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}
