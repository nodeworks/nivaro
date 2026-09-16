import { ChevronDown, HelpCircle } from 'lucide-react'
import { useState } from 'react'
import type {
  NotificationDeliveryRecord,
  NotificationDetailRecord,
  NotificationWhy
} from '../../lib/notification-target'
import { cn } from '../../lib/utils'
import { describeDelivery } from './DeliveryChips'

/**
 * Two small expanders under a notification row, shared by the bell and the
 * center: "N changes" (#27 — every line a coalesced watch folded in, old →
 * new) and "Why me?" (#77 — which watch / subscription / sender produced the
 * row, plus what each channel did with it). Both render inline, never in a
 * portal, so they work inside the bell's scroll box and a grouped row.
 */
export function NotificationDetailBits({
  detail,
  why,
  delivery,
  subscriptionsPath,
  onNavigate,
  className
}: {
  detail?: NotificationDetailRecord | null
  why?: NotificationWhy | null
  delivery?: NotificationDeliveryRecord | null
  /** Host route of the subscriptions page — a watch/subscription "why"
   *  offers a Manage link there. */
  subscriptionsPath?: string | null
  onNavigate?: (path: string) => void
  className?: string
}) {
  const [open, setOpen] = useState<null | 'changes' | 'why'>(null)
  const changes = detail?.changes ?? []
  const toggle = (k: 'changes' | 'why') => setOpen((o) => (o === k ? null : k))
  const WHY_KIND_LABELS: Record<string, string> = {
    watch: 'Record watch',
    subscription: 'Subscription',
    rules: 'Notification rules',
    message: 'Direct message',
    mention: 'Mention',
    task: 'Task',
    approval: 'Approval',
    sla: 'SLA',
    flow: 'Flow',
    broadcast: 'Broadcast',
    alert: 'Alert'
  }
  return (
    <div className={cn('text-[10.5px]', className)} data-notification-bits>
      <div className='flex flex-wrap items-center gap-2'>
        {changes.length > 0 && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              toggle('changes')
            }}
            aria-expanded={open === 'changes'}
            data-notification-changes
            className='inline-flex items-center gap-0.5 rounded px-1 py-px font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-muted dark:hover:text-slate-100'
          >
            {changes.length} change{changes.length === 1 ? '' : 's'}
            <ChevronDown
              className={cn('h-3 w-3 transition-transform', open === 'changes' && 'rotate-180')}
            />
          </button>
        )}
        {why && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              toggle('why')
            }}
            aria-expanded={open === 'why'}
            data-notification-why
            className='inline-flex items-center gap-0.5 rounded px-1 py-px font-medium text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted dark:hover:text-slate-200'
          >
            <HelpCircle className='h-3 w-3' />
            Why me?
          </button>
        )}
      </div>
      {open === 'changes' && (
        <ul
          className='mt-1 space-y-0.5 rounded-md border border-slate-100 bg-slate-50/70 px-2 py-1.5 dark:border-border/60 dark:bg-muted/40'
          data-notification-changes-list
        >
          {changes.slice(0, 20).map((c, i) => (
            <li
              key={`${c.field}-${i}`}
              className='flex flex-wrap items-baseline gap-x-1.5 text-[11px] leading-snug'
            >
              <span className='font-medium text-slate-700 dark:text-slate-200'>{c.label}</span>
              {c.old !== '' && (
                <>
                  <span className='text-slate-400 line-through decoration-slate-300'>{c.old}</span>
                  <span className='text-slate-300'>→</span>
                </>
              )}
              <span className='text-slate-800 dark:text-slate-100'>{c.new || '—'}</span>
            </li>
          ))}
          {changes.length > 20 && (
            <li className='text-[10.5px] text-slate-400'>+{changes.length - 20} more</li>
          )}
        </ul>
      )}
      {open === 'why' && why && (
        <div
          className='mt-1 rounded-md border border-slate-100 bg-slate-50/70 px-2 py-1.5 text-[11px] leading-snug dark:border-border/60 dark:bg-muted/40'
          data-notification-why-panel
        >
          <p className='text-slate-700 dark:text-slate-200'>
            <span className='mr-1 rounded bg-slate-200/70 px-1 text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300'>
              {WHY_KIND_LABELS[why.kind] ?? why.kind}
            </span>
            {why.text}
            {why.label && why.kind !== 'watch' && (
              <span className='text-slate-500 dark:text-slate-400'> · {why.label}</span>
            )}
          </p>
          {(why.kind === 'watch' || why.kind === 'subscription') &&
            subscriptionsPath &&
            onNavigate && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation()
                  onNavigate(subscriptionsPath)
                }}
                className='mt-0.5 text-[10.5px] font-medium text-nvr-navy underline decoration-dotted underline-offset-2 dark:text-nvr-cyan'
              >
                Manage your subscriptions
              </button>
            )}
          <ul className='mt-1 space-y-px text-[10.5px] text-slate-500 dark:text-slate-400'>
            {describeDelivery(delivery).map((d) => (
              <li key={d.key}>
                <span className='font-medium text-slate-600 dark:text-slate-300'>{d.label}:</span>{' '}
                {d.tip}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
