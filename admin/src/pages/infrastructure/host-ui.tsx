import { AlertOctagon, AlertTriangle, CheckCircle2, CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Bits shared by the Hosts, Reboot and Logs tabs (#2829 #2831 #2836 #2837). */

export type Tone = 'ok' | 'warning' | 'critical' | 'unknown'

const TONE: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300',
  warning: 'bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
  critical: 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300',
  unknown: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
}

const ICON: Record<Tone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warning: AlertTriangle,
  critical: AlertOctagon,
  unknown: CircleHelp
}

export function ToneChip({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = ICON[tone]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium',
        TONE[tone]
      )}
    >
      <Icon className='h-3 w-3' aria-hidden />
      {children}
    </span>
  )
}

/** A tinted one-line statement (the verdict of a section), with an icon. */
export function ToneBanner({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = ICON[tone]
  return (
    <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-[13px]', TONE[tone])}>
      <Icon className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <div className='min-w-0'>{children}</div>
    </div>
  )
}

/** One host's block on a tab: name, a status on the right, then the body. */
export function HostSection({
  host,
  aside,
  children
}: {
  host: string
  aside?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      aria-label={host}
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <header className='flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-2.5 dark:border-border'>
        <h2 className='font-mono text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {host}
        </h2>
        <div className='ml-auto flex flex-wrap items-center gap-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {aside}
        </div>
      </header>
      <div className='space-y-3 p-4'>{children}</div>
    </section>
  )
}

/** Key/value cells with 1px dividers (the meta grid pattern). */
export function MetaGrid({
  items
}: {
  items: Array<{ label: string; value: ReactNode; tone?: Tone; mono?: boolean }>
}) {
  return (
    <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-3 xl:grid-cols-6 dark:border-border dark:bg-border'>
      {items.map((it) => (
        <div key={it.label} className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
          <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{it.label}</dt>
          <dd
            data-tip={typeof it.value === 'string' && it.value.length > 14 ? it.value : undefined}
            className={cn(
              'mt-0.5 truncate text-[13px] text-slate-900 dark:text-foreground',
              it.mono && 'font-mono text-[12px]',
              it.tone === 'warning' && 'text-amber-700 dark:text-amber-300',
              it.tone === 'critical' && 'text-red-700 dark:text-red-400'
            )}
          >
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** What a tab shows while it loads: one block per host. */
export function HostSkeletons() {
  return (
    <div className='space-y-4' aria-busy='true'>
      <Skeleton className='h-40' />
      <Skeleton className='h-40' />
    </div>
  )
}

export function TabError({ what }: { what: string }) {
  return (
    <p className='text-[13px] text-red-600 dark:text-red-400'>
      Could not read {what}. Try again in a moment.
    </p>
  )
}

/** Host facts are missing for this host (the collector is not installed or not shipping). */
export function FactsNotCollected({ compact, title }: { compact?: boolean; title?: string }) {
  if (compact)
    return (
      <span className='text-slate-500 dark:text-muted-foreground'>Host facts not collected</span>
    )
  return (
    <div className='rounded-md border border-dashed border-slate-300 px-3 py-2.5 text-[12px] text-slate-600 dark:border-border dark:text-muted-foreground'>
      <p className='font-medium text-slate-800 dark:text-foreground'>
        {title ?? 'Host facts are not collected on this host'}
      </p>
      <p className='mt-0.5 max-w-prose'>
        Install{' '}
        <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-muted'>
          deploy/host-facts/nivaro-host-facts.sh
        </code>{' '}
        on the host with its systemd timer (or run it as a container — no sudo needed), set{' '}
        <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] dark:bg-muted'>
          NIVARO_HOST_NAME
        </code>{' '}
        to this host's name, and point node_exporter's textfile collector at its folder. The README
        beside the script has the steps.
      </p>
    </div>
  )
}

export function StoreNotConfigured() {
  return (
    <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
      Host facts and growth figures need the telemetry store (TELEMETRY_STORE_URL is not set).
    </p>
  )
}

/** "3 days", "5 hours", "12 minutes" — for ages and durations. */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'}`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}
