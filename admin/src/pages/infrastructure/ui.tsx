import { useQuery } from '@tanstack/react-query'
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleHelp, Server } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The Infrastructure page's one design kit: host sections, tables, counts strips, chips, empty /
 * error / loading states. Every tab builds from these so the 16 tabs read as one product; the
 * older per-area helper files (swarm-ui, inventory-ui, host-ui, edge-ui) re-export or wrap them.
 */

/** GET /api/infrastructure/status — shared by every tab (one cached read). */
export interface InfraStatus {
  cloud: boolean
  docker: {
    configured: boolean
    hosts: Array<{
      host: string
      error: string | null
      data: {
        engine: string | null
        api: string | null
        hostname: string | null
        os: string | null
        kernel: string | null
        cpus: number | null
        memory_bytes: number | null
        swarm: string | null
        manager: boolean
      } | null
    }>
  }
  metrics_store: boolean
}

export function useInfraStatus() {
  return useQuery({
    queryKey: ['infrastructure', 'status'],
    queryFn: async () => (await api.get('/infrastructure/status')).data.data as InfraStatus,
    staleTime: 15_000
  })
}

// ── Tones ────────────────────────────────────────────────────────────────────

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const TONES: Record<Tone, string> = {
  ok: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
  warn: 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200',
  bad: 'bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-300',
  info: 'bg-nvr-cyan/10 text-slate-800 dark:bg-nvr-cyan/15 dark:text-nvr-cyan',
  muted: 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
}

/** Text colour for a figure that carries a tone (counts strip values, table cells). */
export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-300',
  warn: 'text-amber-700 dark:text-amber-300',
  bad: 'text-red-600 dark:text-red-400',
  info: 'text-slate-900 dark:text-nvr-cyan',
  muted: 'text-slate-500 dark:text-muted-foreground'
}

const TONE_ICON: Partial<Record<Tone, typeof CheckCircle2>> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  bad: AlertOctagon,
  muted: CircleHelp
}

/** Status chip: tone carries meaning together with the words, never colour alone. */
export function Chip({
  tone,
  children,
  tip,
  icon
}: {
  tone: Tone
  children: ReactNode
  tip?: string
  /** Lead with the tone's icon (verdict chips in section headers). */
  icon?: boolean
}) {
  const Icon = icon ? TONE_ICON[tone] : undefined
  return (
    <span
      data-tip={tip}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium leading-4',
        TONES[tone]
      )}
    >
      {Icon && <Icon className='h-3 w-3' aria-hidden />}
      {children}
    </span>
  )
}

/** A tinted one-line statement (the verdict of a section), with an icon. */
export function Banner({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = TONE_ICON[tone] ?? CircleHelp
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md px-3 py-2 text-[12px] leading-5',
        TONES[tone],
        tone === 'warn' && 'border border-amber-200 dark:border-amber-500/30',
        tone === 'bad' && 'border border-red-200 dark:border-red-500/30'
      )}
    >
      <Icon className='mt-[3px] h-3.5 w-3.5 shrink-0' aria-hidden />
      <div className='min-w-0 break-words'>{children}</div>
    </div>
  )
}

// ── Host sections ────────────────────────────────────────────────────────────

/**
 * One host's block on a tab: a heading row (server icon, host name, status chips on the right)
 * and the body below it on the page background — no card around it, so the tables and strips
 * inside are the only panels. A host that failed shows its error in place of the body.
 */
export function HostBlock({
  host,
  aside,
  error,
  children
}: {
  host: string
  aside?: ReactNode
  error?: string | null
  children?: ReactNode
}) {
  return (
    <section aria-label={`Host ${host}`} className='space-y-3'>
      <header className='flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-slate-200 pb-2 dark:border-border'>
        <h2 className='flex min-w-0 items-center gap-2 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          <Server className='h-3.5 w-3.5 shrink-0 text-slate-400' aria-hidden />
          <span className='truncate font-mono'>{host}</span>
        </h2>
        {(aside || error) && (
          <div className='ml-auto flex flex-wrap items-center justify-end gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {error ? (
              <Chip tone='bad' icon>
                Not answering
              </Chip>
            ) : (
              aside
            )}
          </div>
        )}
      </header>
      {error ? <HostError host={host} error={error} /> : children}
    </section>
  )
}

/** Vertical rhythm between host sections. */
export const HOSTS_STACK = 'space-y-8'

/** One host's read failed; the rest of the tab still renders. */
export function HostError({ host, error }: { host: string; error: string }) {
  return (
    <Banner tone='warn'>
      <span className='font-medium'>Could not read {host}.</span>{' '}
      <span className='break-words'>{error}</span>
    </Banner>
  )
}

// ── Empty / not-connected / error / loading ─────────────────────────────────

/** A source this tab reads is not connected: what it needs, in a sentence or two. */
export function NotConnected({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='rounded-lg border border-slate-200 bg-white p-5 text-[13px] dark:border-border dark:bg-card'>
      <p className='font-medium text-slate-900 dark:text-foreground'>{title}</p>
      <div className='mt-1 max-w-prose text-[12px] leading-5 text-slate-600 dark:text-muted-foreground'>
        {children}
      </div>
    </div>
  )
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className='rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-800 dark:bg-muted dark:text-foreground'>
      {children}
    </code>
  )
}

/** Shown by any Docker-backed tab when no Docker host is configured. */
export function DockerNotConfigured({ children }: { children?: ReactNode }) {
  return (
    <NotConnected title='No Docker host is connected'>
      Run a read-only Docker socket proxy (GET only) on an internal network and set{' '}
      <Code>DOCKER_HOSTS=name=http://proxy:2375</Code> on this instance. Nivaro never mounts the
      Docker socket itself.
      {children}
    </NotConnected>
  )
}

/** A plain-sentence empty state that says what would appear and why it doesn't. */
export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className='rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-[12px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
      {children}
    </p>
  )
}

/** The whole tab's read failed (as opposed to one host): say so and offer a retry. */
export function LoadError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div
      role='alert'
      className='flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
    >
      <AlertOctagon className='h-4 w-4 shrink-0' aria-hidden />
      <span className='min-w-0 flex-1'>Could not read {what}. Try again in a moment.</span>
      {onRetry && (
        <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** What a tab shows while it loads: a toolbar line, a counts strip and a table. */
export function TabSkeleton() {
  return (
    <div className='space-y-3' role='status' aria-busy='true' aria-label='Loading'>
      <Skeleton className='h-5 w-40' />
      <Skeleton className='h-14' />
      <Skeleton className='h-56' />
    </div>
  )
}

/** An intro line under the tab strip: what the tab shows and where its figures come from. */
export function Intro({ children }: { children: ReactNode }) {
  return (
    <p className='max-w-prose text-[12px] leading-5 text-slate-600 dark:text-muted-foreground'>
      {children}
    </p>
  )
}

/** A small footnote under a table. */
export function Note({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return (
    <p
      className={cn(
        'max-w-prose text-[12px] leading-5',
        tone ? TONE_TEXT[tone] : 'text-slate-500 dark:text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** Table chrome shared by every tab: header 11px muted, rows 12px with 1px dividers. */
export const PANEL =
  'overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
export const TABLE =
  'w-full border-collapse text-[12px] [&>tbody>tr:last-child>td]:border-b-0 [&>tbody>tr]:transition-colors [&>tbody>tr:hover]:bg-slate-50 dark:[&>tbody>tr:hover]:bg-muted/40'
export const TH =
  'whitespace-nowrap border-b border-slate-200 px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'
export const TD = 'border-b border-slate-100 px-3 py-2 align-top dark:border-border/60'
/** A table's group title row (stack name, section name) inside the panel, above the header. */
export const PANEL_TITLE =
  'flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-slate-200 px-3 py-2 dark:border-border'

/** A muted dash for an unknown value. */
export const Dash = () => <span className='text-slate-400 dark:text-muted-foreground'>—</span>

/**
 * Long lists: the first `cap` rows, then a button for the rest. Keeps a 200-container host from
 * turning a tab into a wall, while every row stays one click away.
 */
export function useShowMore<T>(rows: T[], cap: number) {
  const [all, setAll] = useState(false)
  const visible = all || rows.length <= cap ? rows : rows.slice(0, cap)
  const more =
    rows.length > cap ? (
      <button
        type='button'
        onClick={() => setAll((v) => !v)}
        className='rounded text-[12px] font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground'
      >
        {all ? `Show the first ${cap}` : `Show all ${rows.length}`}
      </button>
    ) : null
  return { visible, more, hidden: rows.length - visible.length }
}

// ── Counts strip ─────────────────────────────────────────────────────────────

/**
 * Meta grid with 1px dividers that also works when the last row is short: every cell draws its
 * right and bottom rule and the container clips the outer ones (no gap-px backdrop showing
 * through empty tracks).
 */
export const META_GRID =
  'grid overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
export const META_CELL = '-mb-px -mr-px border-b border-r border-slate-200 dark:border-border'

/** The counts strip: one row of figures with 1px dividers; wraps on narrow screens. */
export function StatStrip({
  items,
  min = 140
}: {
  items: Array<{ label: string; value: ReactNode; tone?: Tone; mono?: boolean; tip?: string }>
  /** Narrowest cell before the strip wraps. */
  min?: number
}) {
  return (
    <dl
      className={META_GRID}
      style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 50%), 1fr))` }}
    >
      {items.map((i) => (
        <div key={i.label} className={cn(META_CELL, 'min-w-0 px-3 py-2')}>
          <dt className='truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
            {i.label}
          </dt>
          <dd
            data-tip={i.tip}
            className={cn(
              'mt-0.5 truncate text-[14px] font-semibold tabular-nums',
              i.mono && 'font-mono text-[12px] font-medium',
              i.tone && i.tone !== 'muted'
                ? TONE_TEXT[i.tone]
                : 'text-slate-900 dark:text-foreground'
            )}
          >
            {i.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
