import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ChevronRight } from 'lucide-react'
import { type ReactNode, type Ref, useId, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { type CompareFieldMeta, compareValueText } from '../../lib/compare-value'
import { useRelativeText } from '../../lib/relative-ticker'
import { cn, formatDateTime } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { RelativeTime } from '../RelativeTime'
import { UserAvatar } from '../UserAvatar'
import { Skeleton } from '../ui/skeleton'

/**
 * The list behind the recap strip (2026-11-18, "it's hard to read" as a tooltip): what changed
 * since the person last viewed the record, field by field — the value before and after as the
 * form shows it, who and when, grouped by person and sitting. The server
 * (GET /record-views/:c/:id/changes) names only fields the viewer may read and labels links as
 * they may see them; bookkeeping fields (Date Updated…) fold into one muted line per group.
 */

export interface RecapChange {
  field: string
  has_before: boolean
  before: unknown
  after: unknown
  before_text?: string
  after_text?: string
}

export interface RecapGroup {
  user_id: string | null
  name: string
  first_at: string | null
  last_at: string | null
  saves: number
  changes: RecapChange[]
}

export interface RecapFieldMeta {
  label: string
  system: boolean
  type: string | null
  interface: string | null
  options: Record<string, unknown> | null
}

export interface RecapChanges {
  since: string
  groups: RecapGroup[]
  fields: Record<string, RecapFieldMeta>
  truncated: boolean
}

/** The value as words: the server's label when it named one, else as the form reads it. */
export function recapValueText(
  value: unknown,
  text: string | undefined,
  meta: RecapFieldMeta | undefined
): string | null {
  if (text !== undefined) return text
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value) && value.length === 0) return null
  const cmp: CompareFieldMeta | undefined = meta
    ? {
        type: meta.type,
        interface: meta.interface,
        options: meta.options,
        display_options: meta.options
      }
    : undefined
  const s = compareValueText(value, cmp)
  return s === '—' ? null : s
}

/** A group's changes split into what a person changed and the bookkeeping stamps. */
export function splitSystem(
  changes: RecapChange[],
  fields: Record<string, RecapFieldMeta>
): { main: RecapChange[]; system: RecapChange[] } {
  const main: RecapChange[] = []
  const system: RecapChange[] = []
  for (const c of changes) (fields[c.field]?.system ? system : main).push(c)
  return { main, system }
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '·'
  )
}

function ValueText({ text, strong }: { text: string | null; strong?: boolean }) {
  if (text == null) return <span className='italic text-slate-400 dark:text-slate-500'>Empty</span>
  return (
    <span
      className={cn(
        'break-words [overflow-wrap:anywhere]',
        strong
          ? 'font-medium text-slate-900 dark:text-slate-100'
          : 'text-slate-500 dark:text-slate-400'
      )}
    >
      {text}
    </span>
  )
}

function ChangeRow({
  change,
  meta,
  muted
}: {
  change: RecapChange
  meta: RecapFieldMeta | undefined
  muted?: boolean
}) {
  const label = meta?.label ?? change.field
  const before = recapValueText(change.before, change.before_text, meta)
  const after = recapValueText(change.after, change.after_text, meta)
  return (
    <li className={cn('relative py-1.5', muted && 'opacity-75')} data-recap-change={change.field}>
      <div className='text-[11.5px] font-medium text-slate-500 dark:text-slate-400'>{label}</div>
      <div className='mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] leading-snug'>
        {change.has_before ? (
          <>
            <ValueText text={before} />
            <ArrowRight
              aria-hidden
              className='h-3 w-3 shrink-0 self-center text-slate-400 dark:text-slate-500'
            />
            <span className='sr-only'>changed to</span>
          </>
        ) : (
          <span className='sr-only'>now</span>
        )}
        <ValueText text={after} strong={!muted} />
      </div>
    </li>
  )
}

function GroupBlock({ group, fields }: { group: RecapGroup; fields: RecapChanges['fields'] }) {
  const [showSystem, setShowSystem] = useState(false)
  const systemId = useId()
  const { main, system } = splitSystem(group.changes, fields)
  const at = group.last_at
  return (
    <section className='py-2.5 first:pt-1' aria-label={`Changed by ${group.name}`}>
      <header className='flex items-center gap-2'>
        <UserAvatar
          userId={group.user_id}
          className='h-5 w-5 rounded-full'
          fallback={
            <span className='flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/10 text-[9px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
              {initials(group.name)}
            </span>
          }
        />
        <span className='min-w-0 truncate text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          {group.name}
        </span>
        {at && (
          <span className='ml-auto shrink-0 text-[11.5px] text-slate-400 dark:text-slate-500'>
            <RelativeTime value={at} title={formatDateTime(at)} />
          </span>
        )}
      </header>
      {main.length > 0 && (
        <ul className='mt-1 divide-y divide-slate-100 pl-7 dark:divide-border/60'>
          {main.map((c) => (
            <ChangeRow key={c.field} change={c} meta={fields[c.field]} />
          ))}
        </ul>
      )}
      {system.length > 0 && (
        <div className='pl-7'>
          <button
            type='button'
            aria-expanded={showSystem}
            aria-controls={systemId}
            onClick={() => setShowSystem((v) => !v)}
            className='mt-1 inline-flex items-center gap-1 rounded text-[11.5px] text-slate-400 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-500 dark:hover:text-slate-300'
            data-recap-system-toggle
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'h-3 w-3 transition-transform duration-150 motion-reduce:transition-none',
                showSystem && 'rotate-90'
              )}
            />
            {main.length > 0 ? 'and ' : ''}
            {system.length} system field{system.length === 1 ? '' : 's'}
          </button>
          <ul
            id={systemId}
            hidden={!showSystem}
            className='divide-y divide-slate-100 dark:divide-border/60'
          >
            {system.map((c) => (
              <ChangeRow key={c.field} change={c} meta={fields[c.field]} muted />
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/** The popover's body: loads on mount (the popover mounts it when it opens). */
export function RecordRecapChangesList({
  collection,
  itemId,
  since,
  everyone,
  emptyText
}: {
  collection: string
  itemId: string
  since: string
  /** Every save, the viewer's own included ("since this email"). */
  everyone?: boolean
  /** What an empty list says (a move or a comment changes no field). */
  emptyText?: string
}) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['record-recap-changes', collection, itemId, since, !!everyone],
    queryFn: () =>
      client
        .request<{ data: RecapChanges }>(
          get(`/record-views/${collection}/${encodeURIComponent(itemId)}/changes`, {
            since,
            ...(everyone ? { everyone: '1' } : {})
          })
        )
        .then((r) => r.data),
    staleTime: 30_000,
    retry: false
  })
  if (q.isLoading)
    return (
      <div className='space-y-3 py-2' aria-busy='true'>
        {[0, 1, 2].map((i) => (
          <div key={i} className='space-y-1.5'>
            <Skeleton className='h-3 w-24' />
            <Skeleton className='h-4 w-56 max-w-full' />
          </div>
        ))}
      </div>
    )
  if (q.isError)
    return (
      <div className='py-2'>
        <ErrorNotice error={q.error} what='the changes' onRetry={() => void q.refetch()} />
      </div>
    )
  const data = q.data
  if (!data || data.groups.length === 0)
    return (
      <p className='py-3 text-[12.5px] text-slate-500 dark:text-slate-400'>
        {emptyText ?? 'No field changes to show — the values are back to what you last saw.'}
      </p>
    )
  return (
    <div data-recap-changes>
      <div className='divide-y divide-slate-200/70 dark:divide-border'>
        {data.groups.map((g) => (
          <GroupBlock
            key={`${g.user_id ?? 'system'}|${g.first_at}`}
            group={g}
            fields={data.fields}
          />
        ))}
      </div>
      {data.truncated && (
        <p className='pt-2 text-[11.5px] text-slate-400 dark:text-slate-500'>
          Showing the first 300 saves — the full history has the rest.
        </p>
      )}
    </div>
  )
}

/**
 * The body every "changed since you last looked" popover shares (record recap strip, list and
 * queue unseen dots): title and when it starts, the field-by-field list, the extras line, and the
 * host's footer actions. Hosts own the Popover and its trigger.
 */
export function RecapChangesPanel({
  collection,
  itemId,
  since,
  everyone,
  title,
  extras,
  emptyText,
  footer,
  bodyRef,
  sinceLabel
}: {
  collection: string
  itemId: string
  since: string
  everyone?: boolean
  title: string
  /** "1 new comment · 1 workflow transition": what the field list does not cover. */
  extras: string | null
  emptyText?: string
  footer?: ReactNode
  bodyRef?: Ref<HTMLDivElement>
  /** Words before the start time ("You last opened it"). */
  sinceLabel?: string
}) {
  const relative = useRelativeText(since)
  return (
    <div ref={bodyRef} tabIndex={-1} className='outline-none'>
      <div className='border-b border-slate-200/80 px-4 pb-2 pt-3 dark:border-border'>
        <p className='text-[13px] font-semibold text-slate-900 dark:text-slate-100'>{title}</p>
        <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
          {sinceLabel ? `${sinceLabel} ` : ''}
          <time dateTime={since}>{formatDateTime(since)}</time>
          {/* With exact timestamps on (or past a week) the relative form is the same stamp. */}
          {relative && relative !== formatDateTime(since) ? ` · ${relative}` : null}
        </p>
      </div>
      <div className='max-h-[min(60vh,420px)] overflow-y-auto overscroll-contain px-4 py-1'>
        <RecordRecapChangesList
          collection={collection}
          itemId={itemId}
          since={since}
          everyone={everyone}
          emptyText={emptyText}
        />
      </div>
      {extras && (
        <p className='border-t border-slate-200/80 px-4 py-2 text-[11.5px] text-slate-500 dark:border-border dark:text-slate-400'>
          Also {extras}
        </p>
      )}
      {footer && (
        <div className='flex items-center justify-between gap-2 border-t border-slate-200/80 px-4 py-2 dark:border-border'>
          {footer}
        </div>
      )}
    </div>
  )
}
