import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CircleCheck, GripVertical, X } from 'lucide-react'
import type { CSSProperties, MouseEvent, ReactNode } from 'react'
import { dueInText, liveDeadlineStatus, useDeadlineNow } from '../../lib/deadline-ticker'
import { type PeekTarget, usePeekOrOpen } from '../../lib/record-peek'
import { serverNow } from '../../lib/server-clock'
import { spanText, type WatchRowData } from '../../lib/watch-list'
import { cardAmountText, ownerText, RecordHoverCard } from '../RecordHoverCard'
import { UserAvatar } from '../UserAvatar'

/** "2 m", "3 h", "4 d", then the date — the change line's "when". */
export function agoText(iso: string | null | undefined, now: number = serverNow()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} m`
  if (s < 86_400) return `${Math.floor(s / 3600)} h`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

export function StepChip({ state }: { state: { label: string; color: string | null } | null }) {
  if (!state) return null
  return (
    <span className='inline-flex min-w-0 max-w-[140px] items-center gap-1.5 rounded-full bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-700 dark:bg-white/[0.07] dark:text-slate-200'>
      <span
        aria-hidden
        className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400'
        style={state.color ? { backgroundColor: state.color } : undefined}
      />
      <span className='truncate'>{state.label}</span>
    </span>
  )
}

export function OwnerStack({
  owners,
  max = 2
}: {
  owners: Array<{ id: string; name: string; inactive?: 'suspended' | 'former' }>
  max?: number
}) {
  if (owners.length === 0) return null
  const shown = owners.slice(0, max)
  const extra = owners.length - shown.length
  const names = owners.map(ownerText).join(', ')
  return (
    // No tooltip: the row's hover card names the owners (one overlay at a time).
    <span className='flex shrink-0 items-center pl-1'>
      <span className='sr-only'>With {names}</span>
      {shown.map((o, i) => (
        <span
          key={o.id}
          aria-hidden
          className={`relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-slate-200 text-[8.5px] font-semibold text-slate-600 ring-2 ring-card dark:bg-slate-700 dark:text-slate-200 ${
            i > 0 ? '-ml-1' : ''
          } ${o.inactive ? 'opacity-50 grayscale' : ''}`}
          style={{ zIndex: shown.length - i }}
        >
          <UserAvatar
            userId={o.id}
            fallback={initials(o.name)}
            className='h-full w-full rounded-full object-cover'
            alt=''
          />
        </span>
      ))}
      {extra > 0 && (
        <span
          aria-hidden
          className='relative -ml-1 inline-flex h-[18px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-slate-100 px-1 text-[9px] font-semibold tabular-nums text-slate-600 ring-2 ring-card dark:bg-slate-800 dark:text-slate-300'
        >
          +{extra}
        </span>
      )}
    </span>
  )
}

/**
 * Time in the step against the usual stay, as words that carry the numbers: "20 d / 17 m" —
 * amber once it has been there longer than usual. (No bar: a bar pinned at full for every late
 * record said nothing.) The whole sentence is read out; no tooltip, so it never stacks on the
 * row's hover card.
 */
function StepTimeline({
  timing,
  stepLabel
}: {
  timing: NonNullable<WatchRowData['timing']>
  stepLabel: string | null
}) {
  const over = timing.ratio != null && timing.ratio > 1
  const words = `${spanText(timing.in_step_s)} in ${stepLabel ?? 'this step'}${
    timing.usual_s ? `, usually ${spanText(timing.usual_s)}` : ''
  }`
  return (
    <span className='flex min-w-0 shrink-0 items-baseline' data-step-timeline>
      <span className='sr-only'>{words}</span>
      <span
        aria-hidden
        className={`text-[10.5px] font-medium tabular-nums ${
          over ? 'text-amber-700 dark:text-amber-300' : 'text-slate-600 dark:text-slate-300'
        }`}
      >
        {spanText(timing.in_step_s)}
      </span>
      {timing.usual_s != null && (
        <span
          aria-hidden
          className='whitespace-pre text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400'
        >
          {' / usually '}
          {spanText(timing.usual_s)}
        </span>
      )}
    </span>
  )
}

/** The record is done: it says so (green check), then leaves the list on its own. */
export function CompletedChip({ at }: { at: string }) {
  return (
    <span
      className='inline-flex min-w-0 items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
      data-watch-completed
    >
      <CircleCheck aria-hidden className='h-3 w-3 shrink-0' />
      Completed
      <span className='font-normal text-emerald-700/80 dark:text-emerald-300/70'>
        · {agoText(at)}
      </span>
    </span>
  )
}

function Countdown({ sla }: { sla: NonNullable<WatchRowData['sla']> }) {
  const now = useDeadlineNow(!!sla.due_at)
  const text = dueInText(sla, now)
  if (!text) return null
  const status = liveDeadlineStatus(sla, now)
  return (
    <span
      className={`shrink-0 text-[10.5px] font-medium tabular-nums ${
        status === 'breached'
          ? 'text-red-600 dark:text-red-400'
          : status === 'warning'
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-slate-500 dark:text-slate-400'
      }`}
      data-deadline={status ?? undefined}
    >
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  )
}

function RowShell({
  sortable,
  id,
  children
}: {
  sortable: boolean
  id: string
  children: (
    handle: ReactNode,
    style: CSSProperties,
    ref: (el: HTMLElement | null) => void
  ) => ReactNode
}) {
  const s = useSortable({ id, disabled: !sortable })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(s.transform),
    transition: s.transition,
    zIndex: s.isDragging ? 2 : undefined,
    position: 'relative'
  }
  const handle = sortable ? (
    <button
      type='button'
      aria-label='Move'
      {...s.attributes}
      {...s.listeners}
      onClick={(e) => e.stopPropagation()}
      className='absolute left-0 top-1/2 flex h-7 w-3.5 -translate-y-1/2 cursor-grab items-center justify-center text-slate-300 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 active:cursor-grabbing dark:text-slate-600'
    >
      <GripVertical className='h-3 w-3' />
    </button>
  ) : null
  return <>{children(handle, style, s.setNodeRef)}</>
}

export function WatchRow({
  row,
  list,
  sortable,
  onUnpin,
  onSeen,
  rowActions,
  unpinLabel = 'Unpin',
  canRemove = true
}: {
  row: WatchRowData
  list: PeekTarget[]
  sortable: boolean
  onUnpin: (row: WatchRowData) => void
  onSeen: (key: string) => void
  /** Extra buttons beside the unpin cross (the alert bell). */
  rowActions?: (row: WatchRowData) => ReactNode
  /** What the cross says: "Unpin", "Remove from this list". */
  unpinLabel?: string
  /** False = read-only (a shared list whose maker is gone): no cross. */
  canRemove?: boolean
}) {
  const open = usePeekOrOpen()
  useDeadlineNow(true) // the "2 m" on the change line moves with the page clock
  const changed = !!row.change?.changed

  if (!row.available)
    return (
      <RowShell sortable={sortable} id={row.key}>
        {(handle, style, ref) => (
          <li
            ref={ref}
            style={style}
            className='group/row flex items-center gap-2 py-2.5 pl-4 pr-2'
            data-watch-row='unavailable'
          >
            {handle}
            <div className='min-w-0 flex-1'>
              {/* What it was, as the person pinned it: the kind of record and its number. */}
              <p className='truncate text-[12.5px] font-medium text-slate-600 dark:text-slate-300'>
                {row.collection_label} {row.id}
              </p>
              <p className='text-[11px] text-slate-500 dark:text-slate-400'>
                No longer available to you
              </p>
            </div>
            <button
              type='button'
              onClick={() => onUnpin(row)}
              className='shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:border-white/[0.12] dark:text-slate-200 dark:hover:bg-white/[0.05]'
            >
              Remove
            </button>
          </li>
        )}
      </RowShell>
    )

  const title = row.title ?? row.collection_label
  const figure = row.figures[0]
  const go = (e: MouseEvent) => {
    onSeen(row.key)
    open({ collection: row.collection, itemId: row.id, title }, e, { list })
  }
  const change = row.change
  const changeWords = change
    ? [change.text, change.by && !change.by.self ? change.by.name : change.by ? 'You' : '']
        .filter(Boolean)
        .join(' · ')
    : null
  return (
    <RowShell sortable={sortable} id={row.key}>
      {(handle, style, ref) => (
        <li
          ref={ref}
          style={style}
          data-watch-row={changed ? 'changed' : 'quiet'}
          className={`group/row relative transition-colors duration-700 motion-reduce:transition-none ${
            changed
              ? 'bg-sky-50 dark:bg-nvr-cyan/[0.07]'
              : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'
          }`}
        >
          {handle}
          <RecordHoverCard
            collection={row.collection}
            id={row.id}
            side='bottom'
            block
            delayMs={800}
          >
            {/* biome-ignore lint/a11y/useSemanticElements: the row holds its own buttons */}
            <div
              role='button'
              tabIndex={0}
              aria-label={`${title}${changed ? ', changed' : ''}`}
              onClick={go}
              onAuxClick={go}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSeen(row.key)
                  open({ collection: row.collection, itemId: row.id, title }, null, { list })
                }
              }}
              className={`block cursor-pointer py-2.5 pl-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 ${
                rowActions ? 'pr-14' : 'pr-8'
              }`}
            >
              <div className='flex items-baseline gap-2'>
                <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                  {title}
                </span>
                {figure && (
                  <span className='shrink-0 text-[12px] font-medium tabular-nums text-slate-700 dark:text-slate-200'>
                    {cardAmountText(figure)}
                  </span>
                )}
              </div>
              <div className='mt-1 flex min-w-0 items-center gap-2'>
                {row.completed_at ? (
                  <CompletedChip at={row.completed_at} />
                ) : (
                  <>
                    <StepChip state={row.state} />
                    {row.timing && (
                      <StepTimeline timing={row.timing} stepLabel={row.state?.label ?? null} />
                    )}
                  </>
                )}
                <span className='flex-1' />
                {!row.completed_at && <OwnerStack owners={row.owners} />}
              </div>
              {(changeWords || row.sla?.due_at) && (
                <div className='mt-1 flex min-w-0 items-center gap-2'>
                  {changeWords ? (
                    <span
                      className={`flex min-w-0 flex-1 items-center gap-1.5 text-[11px] ${
                        changed
                          ? 'text-slate-700 dark:text-slate-200'
                          : 'text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {changed && (
                        <span
                          aria-hidden
                          className='h-1.5 w-1.5 shrink-0 rounded-full bg-nvr-cyan'
                        />
                      )}
                      <span className='flex min-w-0'>
                        <span className='truncate'>{changeWords}</span>
                        <span className='shrink-0 whitespace-pre tabular-nums text-slate-500 dark:text-slate-400'>
                          {' · '}
                          {agoText(change?.at)}
                        </span>
                      </span>
                    </span>
                  ) : (
                    <span className='flex-1' />
                  )}
                  {row.sla?.due_at && !row.completed_at && <Countdown sla={row.sla} />}
                </div>
              )}
            </div>
          </RecordHoverCard>
          <div className='absolute right-1.5 top-2 flex items-center gap-0.5'>
            {rowActions?.(row)}
            {canRemove && (
              <button
                type='button'
                aria-label={`${unpinLabel}: ${title}`}
                data-tip={unpinLabel}
                onClick={(e) => {
                  e.stopPropagation()
                  onUnpin(row)
                }}
                className='invisible flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-slate-200/70 hover:text-slate-700 focus-visible:visible group-hover/row:visible dark:text-slate-500 dark:hover:bg-white/[0.08] dark:hover:text-slate-200'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            )}
          </div>
        </li>
      )}
    </RowShell>
  )
}

export function WatchRowList({
  rows,
  sortable,
  onReorder,
  onUnpin,
  onSeen,
  rowActions,
  unpinLabel,
  canRemove,
  label = 'Watched records'
}: {
  rows: WatchRowData[]
  sortable: boolean
  onReorder: (keys: string[]) => void
  onUnpin: (row: WatchRowData) => void
  onSeen: (key: string) => void
  rowActions?: (row: WatchRowData) => ReactNode
  unpinLabel?: string
  canRemove?: boolean
  label?: string
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const list: PeekTarget[] = rows
    .filter((r) => r.available)
    .map((r) => ({ collection: r.collection, itemId: r.id, title: r.title }))
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const keys = rows.map((r) => r.key)
    const from = keys.indexOf(String(e.active.id))
    const to = keys.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    const next = [...keys]
    next.splice(to, 0, next.splice(from, 1)[0])
    onReorder(next)
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
        <ul className='divide-y divide-slate-100 dark:divide-white/[0.05]' aria-label={label}>
          {rows.map((r) => (
            <WatchRow
              key={r.key}
              row={r}
              list={list}
              sortable={sortable}
              onUnpin={onUnpin}
              onSeen={onSeen}
              rowActions={rowActions}
              unpinLabel={unpinLabel}
              canRemove={canRemove}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}
