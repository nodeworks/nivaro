import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useEffect } from 'react'
import { useNivaroClient } from '../context'
import { get } from '../lib/commands'
import { useLiveRecord } from '../lib/live'
import { formatRelative } from '../lib/utils'
import { useHoverIntent } from './collections-directory/CollectionHoverCard'
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover'
import { Skeleton } from './ui/skeleton'

/**
 * Hover cards on record links (rt3 #16): relation chips, link fields, record mentions and list
 * cells show the linked record's CURRENT state — its step, owners and key amounts — after a
 * short hover pause. The card is read AS THE VIEWER (`GET /records/:c/:id/card`, 404 for a
 * record they cannot read: no card at all), kept briefly (15 s), and stays live while open:
 * a write to that record re-reads it quietly in place.
 *
 * Mouse only — a touch or pen press never opens it (the link's own tap stays a tap).
 */

export interface RecordCardData {
  collection: string
  collection_label: string
  id: string
  title: string
  state: { key: string; label: string; color: string | null } | null
  sla: 'ok' | 'warning' | 'breached' | null
  owners: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  amounts: Array<{ field: string; label: string; value: number; money: boolean }>
  updated_at: string | null
}

export const RECORD_CARD_STALE_MS = 15_000
const SYSTEM = /^(nivaro_|directus_)/i

export const recordCardKey = (collection: string, id: string) => ['record-card', collection, id]

/** Whether a link to this record may carry a card at all (system rows never do). */
export function hoverCardEligible(collection: string | null | undefined, id: unknown): boolean {
  return (
    !!collection && !SYSTEM.test(collection) && id != null && id !== '' && typeof id !== 'object'
  )
}

/** An owner as the header Owners tile names them ("Kim Lee (suspended)", "Former user"). */
export function ownerText(o: { name: string; inactive?: 'suspended' | 'former' }): string {
  return o.inactive === 'suspended' ? `${o.name} (suspended)` : o.name
}

export function cardAmountText(a: { value: number; money: boolean }): string {
  return a.money
    ? a.value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    : a.value.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const SLA_TEXT: Record<string, { text: string; cls: string }> = {
  warning: {
    text: 'Due soon',
    cls: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
  },
  breached: {
    text: 'Overdue',
    cls: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  }
}

function CardBody({
  collection,
  id,
  onGone
}: {
  collection: string
  id: string
  /** No card to show (the viewer cannot read the record): close the popover. */
  onGone: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data, isPending, isError } = useQuery<RecordCardData>({
    queryKey: recordCardKey(collection, id),
    queryFn: () =>
      client
        .request<{ data: RecordCardData }>(
          get(`/records/${collection}/${encodeURIComponent(id)}/card`)
        )
        .then((r) => r.data),
    staleTime: RECORD_CARD_STALE_MS,
    gcTime: 60_000,
    retry: false
  })
  // Live while open: a write to the record re-reads the card in place.
  useLiveRecord(collection, id, () => {
    void qc.invalidateQueries({ queryKey: recordCardKey(collection, id) })
  })
  // 404 (not theirs to read) or a failed read: no card at all — never an empty box.
  useEffect(() => {
    if (isError) onGone()
  }, [isError, onGone])
  if (isPending)
    return (
      // In dark the popover and the skeleton token are the same grey: lift the bars a step.
      <div className='space-y-2 dark:[&>div]:bg-white/[0.09]' aria-busy>
        <Skeleton className='h-4 w-40' />
        <Skeleton className='h-3 w-24' />
        <Skeleton className='h-3 w-32' />
      </div>
    )
  if (isError || !data) return null
  const sla = data.sla ? SLA_TEXT[data.sla] : null
  return (
    <div className='min-w-0' data-record-card>
      <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500'>
        {data.collection_label}
      </p>
      <p className='mt-0.5 line-clamp-2 text-[13px] font-semibold leading-snug text-slate-800 dark:text-slate-100'>
        {data.title}
      </p>
      {(data.state || sla) && (
        <div className='mt-2 flex flex-wrap items-center gap-1.5'>
          {data.state && (
            <span className='inline-flex max-w-full items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:bg-white/10 dark:text-slate-200'>
              <span
                aria-hidden
                className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400'
                style={data.state.color ? { backgroundColor: data.state.color } : undefined}
              />
              <span className='truncate'>{data.state.label}</span>
            </span>
          )}
          {sla && (
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${sla.cls}`}>
              {sla.text}
            </span>
          )}
        </div>
      )}
      {data.owners.length > 0 && (
        <p className='mt-2 truncate text-[11.5px] text-slate-600 dark:text-slate-300'>
          <span className='text-slate-400 dark:text-slate-500'>With </span>
          {data.owners.length <= 2
            ? data.owners.map(ownerText).join(' and ')
            : `${ownerText(data.owners[0])} and ${data.owners.length - 1} others`}
        </p>
      )}
      {data.amounts.length > 0 && (
        <dl className='mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px]'>
          {data.amounts.map((a) => (
            <div key={a.field} className='contents'>
              <dt className='truncate text-slate-500 dark:text-slate-400'>{a.label}</dt>
              <dd className='text-right font-medium tabular-nums text-slate-800 dark:text-slate-100'>
                {cardAmountText(a)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {data.updated_at && (
        <p className='mt-2 text-[10.5px] text-slate-400 dark:text-slate-500'>
          Updated {formatRelative(data.updated_at)}
        </p>
      )}
    </div>
  )
}

/**
 * Wrap a record link. Children render exactly as before; the card opens on a mouse hover pause
 * (or keyboard focus) and closes when the pointer leaves both the link and the card.
 */
export function RecordHoverCard({
  collection,
  id,
  children,
  disabled,
  side = 'bottom',
  block = false,
  delayMs = 500
}: {
  collection: string | null | undefined
  id: unknown
  children: ReactNode
  disabled?: boolean
  /** Where the card opens (a list docked at the right edge opens it to the left). */
  side?: 'bottom' | 'left' | 'right' | 'top'
  /** Wrap a block (a whole row) rather than an inline link. */
  block?: boolean
  /** How long the pointer rests before the card opens. */
  delayMs?: number
}) {
  const eligible = !disabled && hoverCardEligible(collection, id)
  const card = useHoverIntent(eligible, delayMs)
  const qc = useQueryClient()
  // A record already answered 404 for this viewer: no card, not even a skeleton.
  const show = () => {
    if (qc.getQueryState(recordCardKey(String(collection), String(id)))?.status === 'error') return
    card.show()
  }
  if (!eligible) return <>{children}</>
  const rid = String(id)
  return (
    <Popover open={card.open} onOpenChange={(v) => !v && card.close()}>
      <PopoverAnchor asChild>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a hover/focus wrapper; the link inside is the control */}
        <span
          className={block ? 'block' : 'inline'}
          data-record-card-anchor
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') show()
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') card.hide()
          }}
          onPointerDown={card.close}
          onFocus={show}
          onBlur={card.hide}
        >
          {children}
        </span>
      </PopoverAnchor>
      {card.open && (
        <PopoverContent
          side={side}
          align='start'
          sideOffset={6}
          collisionPadding={12}
          avoidCollisions
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={card.cancel}
          onPointerLeave={card.hide}
          onClick={(e) => e.stopPropagation()}
          className='w-[280px] max-w-[calc(100vw-24px)] p-3 motion-reduce:animate-none'
        >
          <CardBody collection={collection as string} id={rid} onGone={card.close} />
        </PopoverContent>
      )}
    </Popover>
  )
}
