import * as PopoverPrimitive from '@radix-ui/react-popover'
import { ArrowLeft, ArrowRight, LayoutTemplate, Workflow } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatRelative, titleCase } from '@/lib/utils'
import { useCollectionSummary } from './overview-data'

const OPEN_DELAY_MS = 400
const CLOSE_DELAY_MS = 150
const MAX_CHIPS = 6

/**
 * Hover intent for the row's name: opens after a pause, closes shortly after
 * the pointer leaves (so it can travel into the card). `enabled` false = never opens.
 */
export function useHoverIntent(enabled: boolean, openDelay = OPEN_DELAY_MS) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const show = useCallback(() => {
    if (!enabled) return
    cancel()
    timer.current = setTimeout(() => setOpen(true), openDelay)
  }, [enabled, cancel, openDelay])
  const hide = useCallback(() => {
    cancel()
    timer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }, [cancel])
  const close = useCallback(() => {
    cancel()
    setOpen(false)
  }, [cancel])

  useEffect(() => cancel, [cancel])
  useEffect(() => {
    if (!enabled) close()
  }, [enabled, close])

  return { open, show, hide, cancel, close }
}

function Chips({ items }: { items: Array<{ key: string; label: string; tip: string }> }) {
  if (items.length === 0)
    return <p className='text-[11px] text-slate-400 dark:text-slate-500'>None</p>
  const shown = items.slice(0, MAX_CHIPS)
  const rest = items.slice(MAX_CHIPS)
  return (
    <div className='flex flex-wrap gap-1'>
      {shown.map((c) => (
        <span
          key={c.key}
          data-tip={c.tip}
          className='inline-flex max-w-[140px] items-center truncate rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:bg-white/10 dark:text-slate-300'
        >
          <span className='truncate'>{c.label}</span>
        </span>
      ))}
      {rest.length > 0 && (
        <span
          data-tip={rest.map((c) => c.label).join(', ')}
          className='inline-flex items-center rounded px-1 py-px text-[10px] font-medium text-slate-500 dark:text-slate-400'
        >
          +{rest.length}
        </span>
      )}
    </div>
  )
}

function SectionLabel({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <p className='mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
      {icon}
      {children}
    </p>
  )
}

function SummaryBody({ collection }: { collection: string }) {
  const { data, isLoading, isError } = useCollectionSummary(collection, true)

  if (isLoading)
    return (
      <div className='space-y-2' role='status' aria-busy='true' aria-label='Loading summary'>
        <Skeleton className='h-3 w-24' />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className='flex justify-between gap-4'>
            <Skeleton className='h-3 w-32' />
            <Skeleton className='h-3 w-12' />
          </div>
        ))}
        <Skeleton className='h-3 w-20' />
        <Skeleton className='h-4 w-full' />
      </div>
    )

  if (isError || !data)
    return (
      <p className='text-[12px] text-slate-500 dark:text-slate-400'>
        Couldn't load this collection's summary.
      </p>
    )

  const hiddenFields = Math.max(0, data.field_count - data.fields.length)

  return (
    <div className='space-y-3'>
      <div>
        <SectionLabel>
          {data.field_count} field{data.field_count === 1 ? '' : 's'}
        </SectionLabel>
        {data.fields.length === 0 ? (
          <p className='text-[11px] text-slate-400 dark:text-slate-500'>No fields yet</p>
        ) : (
          <ul className='space-y-0.5'>
            {data.fields.slice(0, 8).map((f) => (
              <li key={f.field} className='flex items-baseline justify-between gap-3 text-[12px]'>
                <span
                  className='truncate text-slate-700 dark:text-slate-200'
                  data-tip={f.label !== f.field ? f.field : undefined}
                >
                  {f.label || f.field}
                </span>
                <span className='shrink-0 font-mono text-[10px] text-slate-400 dark:text-slate-500'>
                  {f.type}
                </span>
              </li>
            ))}
          </ul>
        )}
        {hiddenFields > 0 && (
          <p className='mt-0.5 text-[11px] text-slate-400 dark:text-slate-500'>
            and {hiddenFields} more
          </p>
        )}
      </div>

      <div>
        <SectionLabel icon={<ArrowRight className='h-2.5 w-2.5' />}>Points to</SectionLabel>
        <Chips
          items={data.relations_out.map((r) => ({
            key: `${r.field}:${r.collection}`,
            label: titleCase(r.collection),
            tip: `${r.field} → ${r.collection}`
          }))}
        />
      </div>

      <div>
        <SectionLabel icon={<ArrowLeft className='h-2.5 w-2.5' />}>Used by</SectionLabel>
        <Chips
          items={data.relations_in.map((r) => ({
            key: `${r.collection}:${r.field}`,
            label: titleCase(r.collection),
            tip: `${r.collection}.${r.field}`
          }))}
        />
      </div>

      {(data.pipeline || data.forms > 0) && (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-300'>
          {data.pipeline && (
            <span className='inline-flex min-w-0 items-center gap-1'>
              <Workflow className='h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500' />
              <span className='truncate'>{data.pipeline}</span>
            </span>
          )}
          {data.forms > 0 && (
            <span className='inline-flex items-center gap-1'>
              <LayoutTemplate className='h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500' />
              {data.forms} form{data.forms === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      <p className='border-t border-slate-100 pt-2 text-[11px] text-slate-500 dark:border-white/[0.06] dark:text-slate-400'>
        {data.last_edit ? (
          <span data-tip={formatDateTime(data.last_edit.at)}>
            Edited {formatRelative(data.last_edit.at)}
            {data.last_edit.user ? ` by ${data.last_edit.user}` : ''}
          </span>
        ) : (
          'No edits in the last 90 days'
        )}
      </p>
    </div>
  )
}

/**
 * Admin-only summary card anchored on a row's name. Controlled by the row
 * (see useHoverIntent); the request runs only while the card is open. The
 * card is non-modal and never takes focus, so row clicks keep working.
 */
export function CollectionHoverCard({
  collection,
  title,
  open,
  onClose,
  onCardEnter,
  onCardLeave,
  children
}: {
  collection: string
  title: string
  open: boolean
  onClose: () => void
  onCardEnter: () => void
  onCardLeave: () => void
  /** The anchor (the row's name). */
  children: ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={(v) => !v && onClose()}>
      <PopoverPrimitive.Anchor asChild>{children}</PopoverPrimitive.Anchor>
      {open && (
        <PopoverContent
          side='right'
          align='start'
          sideOffset={12}
          collisionPadding={12}
          avoidCollisions
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onPointerEnter={onCardEnter}
          onPointerLeave={onCardLeave}
          // The card is a React child of the row's Link: without this a click in
          // it would bubble (through the portal) to the Link and navigate.
          onClick={(e) => e.stopPropagation()}
          aria-label={`${title} summary`}
          className='w-[320px] p-3 motion-reduce:animate-none'
        >
          <p className='mb-2 truncate text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
            {title}
          </p>
          <SummaryBody collection={collection} />
        </PopoverContent>
      )}
    </Popover>
  )
}
