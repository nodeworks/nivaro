import { ChevronRight, CornerDownRight, RotateCw } from 'lucide-react'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'

/**
 * Resend trail on the mail log (migration 534): an original that was resent
 * carries a chip coloured by how its newest resend went; a resend row says
 * which original it replays; the detail panel lists every resend.
 */

export interface ResendSummary {
  count: number
  last_status: string
  last_at: string
  last_by: string | null
  last_by_name: string | null
}

export interface ResendEntry {
  id: number
  status: string
  error: string | null
  created_at: string
  resent_by: string | null
  resent_by_name: string | null
}

const OUTCOME: Record<string, { label: string; cls: string }> = {
  sent: {
    label: 'Sent',
    cls: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
  },
  failed: {
    label: 'Failed',
    cls: 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-400'
  },
  dropped: {
    label: 'Dropped',
    cls: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-400'
  },
  deferred: {
    label: 'Deferred',
    cls: 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-400'
  }
}

export function outcomeOf(status: string) {
  return (
    OUTCOME[status] ?? {
      label: status,
      cls: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
    }
  )
}

/** "Resent ×2 · Sent" beside an original's status. */
export function ResendChip({ summary, className }: { summary: ResendSummary; className?: string }) {
  const o = outcomeOf(summary.last_status)
  const times = summary.count === 1 ? 'once' : `${summary.count} times`
  const who = summary.last_by_name ? ` by ${summary.last_by_name}` : ''
  return (
    <span
      data-mail-resend-chip={summary.last_status}
      data-tip={`Resent ${times} · last ${formatDateTime(summary.last_at)}${who} · ${o.label.toLowerCase()}`}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10.5px] font-semibold',
        o.cls,
        className
      )}
    >
      <RotateCw className='h-2.5 w-2.5' aria-hidden />
      Resent{summary.count > 1 ? ` ×${summary.count}` : ''} · {o.label}
    </span>
  )
}

/** "Resend of #12" on a resend row — opens the original. */
export function ResendOfLink({ of, onOpen }: { of: number; onOpen: (id: number) => void }) {
  return (
    <button
      type='button'
      data-mail-resend-of={of}
      onClick={(e) => {
        e.stopPropagation()
        onOpen(of)
      }}
      data-tip='Open the original send'
      className='inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded text-[11px] font-medium text-slate-500 hover:text-nvr-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:text-nvr-cyan'
    >
      <CornerDownRight className='h-3 w-3' aria-hidden />
      Resend of #{of}
    </button>
  )
}

/**
 * A stored mail-log error, said for a person. The raw relay text stays under
 * "Details for support".
 */
export function mailErrorTitle(status: string, error: string | null): string | null {
  const raw = (error ?? '').trim()
  if (status === 'sent') return null
  if (/^skipped:/i.test(raw)) return `Left out — ${raw.replace(/^skipped:\s*/i, '')}`
  if (/^suppressed:/i.test(raw)) return 'Not sent — the address bounced before and is suppressed'
  if (/^caught in /i.test(raw)) return 'Caught by test mode — it went to the catch inbox'
  if (status === 'dropped') return 'Not sent — test mode held it back'
  if (status === 'deferred') return 'Folded into the daily summary'
  if (status === 'failed') return 'The mail server refused it'
  return null
}

function RawDetails({ text }: { text: string }) {
  return (
    <details className='group mt-1 text-[11px]'>
      <summary className='inline-flex cursor-pointer list-none items-center gap-1 rounded text-slate-500 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-muted-foreground dark:hover:text-foreground [&::-webkit-details-marker]:hidden'>
        <ChevronRight className='h-3 w-3 transition-transform group-open:rotate-90' aria-hidden />
        Details for support
      </summary>
      <p className='mt-1 select-all break-words rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 font-mono text-[10.5px] text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
        {text}
      </p>
    </details>
  )
}

/** The detail panel's list of an original's resends, newest first. */
export function ResendList({
  resends,
  onOpen
}: {
  resends: ResendEntry[]
  onOpen: (id: number) => void
}) {
  if (resends.length === 0) return null
  return (
    <section
      data-mail-resends
      className='shrink-0 border-t border-slate-200 bg-white px-5 py-3 dark:border-border dark:bg-card'
    >
      <h3 className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        Resends <span className='font-normal text-slate-400'>· {resends.length}</span>
      </h3>
      <ul className='mt-2 max-h-[184px] space-y-1.5 overflow-y-auto pr-1'>
        {resends.map((r) => {
          const o = outcomeOf(r.status)
          const title = mailErrorTitle(r.status, r.error)
          return (
            <li key={r.id} data-mail-resend={r.id} className='text-[12px]'>
              <div className='flex items-center gap-2'>
                <span
                  className={cn(
                    'shrink-0 rounded-full border px-1.5 py-px text-[10.5px] font-semibold',
                    o.cls
                  )}
                >
                  {o.label}
                </span>
                <span
                  className='truncate text-slate-600 dark:text-muted-foreground'
                  data-tip={formatDateTime(r.created_at)}
                >
                  {formatRelative(r.created_at)}
                  {r.resent_by_name ? ` · ${r.resent_by_name}` : ''}
                </span>
                <button
                  type='button'
                  onClick={() => onOpen(r.id)}
                  className='ml-auto shrink-0 rounded text-[11px] font-medium text-slate-400 tabular-nums hover:text-nvr-navy hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:hover:text-nvr-cyan'
                >
                  #{r.id}
                </button>
              </div>
              {title && (
                <p className='mt-0.5 pl-0.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                  {title}
                </p>
              )}
              {r.error && <RawDetails text={r.error} />}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
