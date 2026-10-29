import { useQuery } from '@tanstack/react-query'
import { ChevronDown, HelpCircle } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type {
  NotificationDeliveryRecord,
  NotificationDetailRecord,
  NotificationWhy
} from '../../lib/notification-target'
import { cn } from '../../lib/utils'
import { describeDelivery } from './DeliveryChips'
import {
  type StoredWhyReason,
  WHY_KIND_LABELS,
  WHY_LAYER_LABELS,
  type WhyLayer,
  whyChangeLinks,
  whyLines
} from './why-lines'

/**
 * Two small expanders under a notification row, shared by the bell and the
 * center: "N changes" (#27 — every line a coalesced watch folded in, old →
 * new) and "Why?" (#77 / #3078 — the path that sent it and the rule that
 * picked each channel, as stored when the row was decided, with a link to
 * change it). Both render inline, never in a portal, so they work inside the
 * bell's scroll box and a grouped row.
 */

interface WhyAnswer {
  recorded: boolean
  reason: StoredWhyReason | null
  why: NotificationWhy | null
  delivery: NotificationDeliveryRecord | null
  category_label: string
}

function LayerTag({ layer, role }: { layer: WhyLayer; role?: string | null }) {
  return (
    <span
      data-why-layer={layer}
      className={cn(
        'ml-1 rounded px-1 text-[9.5px] font-medium',
        layer === 'person' && 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
        layer === 'role' &&
          'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
        layer === 'system' && 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
      )}
    >
      {WHY_LAYER_LABELS[layer]}
      {layer === 'role' && role ? ` · ${role}` : ''}
    </span>
  )
}

function WhyPanel({
  notificationId,
  why,
  delivery,
  subscriptionsPath,
  rulesPath,
  onNavigate
}: {
  notificationId?: number | null
  why?: NotificationWhy | null
  delivery?: NotificationDeliveryRecord | null
  subscriptionsPath?: string | null
  rulesPath?: string | null
  onNavigate?: (path: string) => void
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['notification-why', notificationId],
    enabled: notificationId != null,
    staleTime: 60_000,
    queryFn: () =>
      client
        .request<{ data: WhyAnswer }>(get(`/notifications/${notificationId}/why`))
        .then((r) => r.data)
  })
  const reason = data?.reason ?? null
  const path = reason?.path ?? data?.why ?? why ?? null
  const kind = path?.kind ?? 'rules'
  const roleName = reason?.role?.name ?? null
  return (
    <div
      className='mt-1 rounded-md border border-slate-100 bg-slate-50/70 px-2 py-1.5 text-[11px] leading-snug dark:border-border/60 dark:bg-muted/40'
      data-notification-why-panel
      data-why-recorded={data ? String(data.recorded) : undefined}
    >
      {path && (
        <p className='text-slate-700 dark:text-slate-200'>
          <span className='mr-1 rounded bg-slate-200/70 px-1 text-[9.5px] font-semibold uppercase tracking-wide text-slate-600 dark:bg-slate-700 dark:text-slate-300'>
            {WHY_KIND_LABELS[kind] ?? kind}
          </span>
          {path.text}
          {path.label && kind !== 'watch' && kind !== 'role_default' && (
            <span className='text-slate-500 dark:text-slate-400'> · {path.label}</span>
          )}
        </p>
      )}
      {isLoading && notificationId != null && (
        <p className='mt-1 text-[10.5px] text-slate-400'>Looking up why…</p>
      )}
      {data && !data.recorded && (
        <p className='mt-1 text-[10.5px] italic text-slate-500 dark:text-slate-400' data-why-legacy>
          Sent before reasons were recorded.
        </p>
      )}
      {reason ? (
        <ul
          className='mt-1 space-y-px text-[10.5px] text-slate-500 dark:text-slate-400'
          data-why-rules
        >
          {reason.critical && (
            <li>
              <span className='font-medium text-slate-600 dark:text-slate-300'>Critical:</span>{' '}
              mutes, quiet hours and your rules are bypassed.
            </li>
          )}
          {whyLines(reason).map((l) => (
            <li key={l.key} data-why-channel={l.key}>
              <span className='font-medium text-slate-600 dark:text-slate-300'>{l.label}:</span>{' '}
              {l.outcome}
              {l.rule ? ` — ${l.rule}` : ''}
              {l.layer && <LayerTag layer={l.layer} role={roleName} />}
            </li>
          ))}
        </ul>
      ) : (
        <ul className='mt-1 space-y-px text-[10.5px] text-slate-500 dark:text-slate-400'>
          {describeDelivery(data?.delivery ?? delivery).map((d) => (
            <li key={d.key}>
              <span className='font-medium text-slate-600 dark:text-slate-300'>{d.label}:</span>{' '}
              {d.tip}
            </li>
          ))}
        </ul>
      )}
      <div className='mt-1 flex flex-wrap gap-x-3'>
        {onNavigate &&
          whyChangeLinks(kind, { subscriptionsPath, rulesPath }).map((l) => (
            <button
              key={l.to}
              type='button'
              data-why-change={l.to}
              onClick={(e) => {
                e.stopPropagation()
                onNavigate(l.to)
              }}
              className='text-[10.5px] font-medium text-nvr-navy underline decoration-dotted underline-offset-2 dark:text-nvr-cyan'
            >
              {l.label}
            </button>
          ))}
      </div>
    </div>
  )
}

export function NotificationDetailBits({
  detail,
  why,
  delivery,
  notificationId,
  subscriptionsPath,
  rulesPath,
  onNavigate,
  className
}: {
  detail?: NotificationDetailRecord | null
  why?: NotificationWhy | null
  delivery?: NotificationDeliveryRecord | null
  /** The row's id — "Why?" reads the stored reason for it (#3078). */
  notificationId?: number | null
  /** Host route of the subscriptions page — a watch/subscription "why"
   *  offers a Manage link there. */
  subscriptionsPath?: string | null
  /** Host route of Profile → Notification rules — "Why?" offers a change link there. */
  rulesPath?: string | null
  onNavigate?: (path: string) => void
  className?: string
}) {
  const [open, setOpen] = useState<null | 'changes' | 'why'>(null)
  const changes = detail?.changes ?? []
  const toggle = (k: 'changes' | 'why') => setOpen((o) => (o === k ? null : k))
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
        {(why || notificationId != null) && (
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
            Why?
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
      {open === 'why' && (
        <WhyPanel
          notificationId={notificationId}
          why={why}
          delivery={delivery}
          subscriptionsPath={subscriptionsPath}
          rulesPath={rulesPath}
          onNavigate={onNavigate}
        />
      )}
    </div>
  )
}
