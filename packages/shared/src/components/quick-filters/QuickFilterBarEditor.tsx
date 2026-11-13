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
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  GripVertical,
  Loader2,
  Plus,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import { forwardRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { describeError } from '../../lib/error-message'
import { cn, titleCase } from '../../lib/utils'
import { ErrorDetails } from '../ErrorNotice'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { quickFilterProblems, slugKey, uniqueKey } from './config'
import { pathLabel } from './facets'
import { QuickFilterFieldPicker, usedPathLabels } from './QuickFilterFieldPicker'
import { facetDefaults, QuickFilterForm } from './QuickFilterForm'
import type { DraftFilter, QuickFilterEditing } from './useQuickFilterEditing'

const popCls =
  'w-[min(22rem,calc(100vw-2rem))] rounded-lg border-slate-200 bg-white p-0 shadow-[0_10px_30px_-8px_rgba(15,23,42,0.25),0_2px_6px_rgba(15,23,42,0.08)] dark:border-slate-700 dark:bg-slate-900'
const footBtn =
  'inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'

/**
 * Idle-bar entry for administrators: opens the bar's edit mode, and says how
 * the last save went ("Saving…" / "Saved").
 */
export const QuickFilterEditButton = forwardRef<
  HTMLButtonElement,
  { ctl: QuickFilterEditing; label?: string; className?: string }
>(function QuickFilterEditButton({ ctl, label = 'Edit filters', className }, ref) {
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {ctl.status === 'saving' && (
        <span
          role='status'
          className='inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'
        >
          <Loader2 aria-hidden className='h-3 w-3 animate-spin' />
          Saving…
        </span>
      )}
      {ctl.status === 'saved' && (
        <span
          role='status'
          className='nvr-fade-in inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400'
        >
          <Check aria-hidden className='h-3 w-3' strokeWidth={3} />
          Saved
        </span>
      )}
      <button
        ref={ref}
        type='button'
        onClick={() => ctl.start()}
        data-tip='Choose the filters everyone sees above this list. Only administrators can change them.'
        data-qf-edit=''
        className='inline-flex h-6 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100'
      >
        <SlidersHorizontal aria-hidden className='h-3 w-3' />
        {label}
      </button>
    </span>
  )
})

function Token({
  item,
  index,
  count,
  ctl,
  collection,
  onMoved
}: {
  item: DraftFilter
  index: number
  count: number
  ctl: QuickFilterEditing
  collection: string
  onMoved: (label: string, to: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id
  })
  const [picking, setPicking] = useState(false)
  const label = item.def.label?.trim() || 'Untitled filter'
  const issues = quickFilterProblems(item.def, ctl.defs)
  const open = ctl.openId === item.id
  const move = (by: number) => {
    const to = index + by
    if (to < 0 || to >= count) return
    ctl.move(item.id, by)
    onMoved(label, to + 1)
  }
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-qf-token={item.def.key || item.id}
      className={cn(
        'inline-flex h-6 max-w-[15rem] items-center rounded border bg-white text-[11.5px] shadow-[0_1px_1px_rgba(15,23,42,0.04)] dark:bg-slate-900',
        issues.length > 0
          ? 'border-amber-400 dark:border-amber-500/70'
          : open
            ? 'border-nvr-cyan/70 ring-2 ring-nvr-cyan/20'
            : 'border-slate-300 dark:border-slate-600',
        isDragging && 'z-10 opacity-80 shadow-lg'
      )}
    >
      <button
        type='button'
        {...attributes}
        {...listeners}
        aria-label={`Drag ${label} to reorder`}
        className='flex h-full w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-l text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 active:cursor-grabbing dark:text-slate-500 dark:hover:text-slate-200'
      >
        <GripVertical className='h-3 w-3' />
      </button>
      <Popover open={open} onOpenChange={(o) => ctl.setOpenId(o ? item.id : null)}>
        <PopoverTrigger asChild>
          <button
            type='button'
            onKeyDown={(e) => {
              if (!e.altKey) return
              if (e.key === 'ArrowLeft') {
                e.preventDefault()
                move(-1)
              } else if (e.key === 'ArrowRight') {
                e.preventDefault()
                move(1)
              }
            }}
            aria-label={`${label}: settings${issues.length ? ` (${issues[0]})` : ''}. Alt+Left or Alt+Right moves it.`}
            className='flex h-full min-w-0 items-center gap-1.5 px-1 text-slate-800 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:text-slate-100 dark:hover:text-white'
          >
            <span className={cn('truncate', !item.def.label?.trim() && 'italic text-slate-500')}>
              {label}
            </span>
            {issues.length > 0 && (
              <span aria-hidden className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500' />
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          sideOffset={6}
          collisionPadding={16}
          className={popCls}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            // Just added: the name is what to change first.
            if (item.isNew)
              (e.currentTarget as HTMLElement | null)
                ?.querySelector<HTMLInputElement>('[data-qf-name]')
                ?.select()
          }}
        >
          {!picking && (
            <div className='flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800'>
              <p className='min-w-0 truncate text-[12.5px] font-semibold text-slate-900 dark:text-slate-50'>
                {label}
              </p>
              <button
                type='button'
                onClick={() => ctl.setOpenId(null)}
                aria-label='Close'
                className='flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          )}
          <QuickFilterForm
            collection={collection}
            value={item.def}
            all={ctl.defs}
            isNew={item.isNew}
            onChange={(partial) => ctl.update(item.id, partial)}
            onPickingChange={setPicking}
            className='max-h-[min(30rem,65vh)] overflow-y-auto px-3 py-3'
          />
          {!picking && (
            <div className='flex items-center gap-1 border-t border-slate-100 px-2 py-1.5 dark:border-slate-800'>
              <button
                type='button'
                disabled={index === 0}
                onClick={() => move(-1)}
                className={footBtn}
              >
                <ArrowLeft aria-hidden className='h-3.5 w-3.5' />
                Move left
              </button>
              <button
                type='button'
                disabled={index === count - 1}
                onClick={() => move(1)}
                className={footBtn}
              >
                Move right
                <ArrowRight aria-hidden className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => ctl.remove(item.id)}
                className='ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
              >
                <Trash2 aria-hidden className='h-3.5 w-3.5' />
                Remove
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>
      <button
        type='button'
        onClick={() => ctl.remove(item.id)}
        aria-label={`Remove ${label}`}
        className='flex h-full w-5 shrink-0 items-center justify-center rounded-r text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/60 dark:hover:bg-red-500/10 dark:hover:text-red-400'
      >
        <X className='h-3 w-3' />
      </button>
    </div>
  )
}

/**
 * The quick-filter bar in edit mode (administrators): the bar's own filters as
 * tokens — drag or Alt+arrow to reorder, click to rename or change, ✕ to
 * remove, + to add — then Save for everyone or Cancel. Same height and type
 * size as the bar people use, so editing reads as the same bar.
 */
export function QuickFilterBarEditor({
  ctl,
  collection
}: {
  ctl: QuickFilterEditing
  collection: string
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const [announce, setAnnounce] = useState('')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) ctl.reorder(String(e.active.id), String(e.over.id))
  }
  const count = ctl.draft.length
  const failed = ctl.status === 'error' && ctl.error != null
  const canSave = (ctl.dirty || failed) && ctl.problemCount === 0
  const firstProblem = ctl.draft.find((d) => quickFilterProblems(d.def, ctl.defs).length > 0)
  const err = failed ? describeError(ctl.error, 'The quick filters were not saved') : null

  return (
    <div
      data-qf-editor=''
      className='relative flex shrink-0 flex-wrap items-center gap-1.5 border-b border-nvr-cyan/25 bg-[#f4fbfd] px-4 py-1.5 dark:border-nvr-cyan/20 dark:bg-[#0f1d26]'
    >
      <span className='sr-only' aria-live='polite'>
        {announce}
      </span>
      <span className='mr-0.5 text-[11px] font-semibold text-slate-700 dark:text-slate-200'>
        Quick filters
      </span>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ctl.draft.map((d) => d.id)} strategy={rectSortingStrategy}>
          {ctl.draft.map((item, i) => (
            <Token
              key={item.id}
              item={item}
              index={i}
              count={count}
              ctl={ctl}
              collection={collection}
              onMoved={(label, to) => setAnnounce(`${label} moved to position ${to} of ${count}`)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <Popover open={ctl.adding} onOpenChange={ctl.setAdding}>
        <PopoverTrigger asChild>
          <button
            type='button'
            data-qf-add=''
            className='inline-flex h-6 items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 text-[11.5px] font-medium text-slate-600 hover:border-nvr-cyan/70 hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 data-[state=open]:border-nvr-cyan/70 data-[state=open]:bg-white dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white dark:data-[state=open]:bg-slate-900'
          >
            <Plus aria-hidden className='h-3 w-3' />
            Add quick filter
          </button>
        </PopoverTrigger>
        <PopoverContent
          align='start'
          sideOffset={6}
          collisionPadding={16}
          className={popCls}
          // The new filter's own settings open next; focus going back to this
          // button would close them again.
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <QuickFilterFieldPicker
            rootCollection={collection}
            used={usedPathLabels(ctl.defs)}
            onPick={(p) => {
              void facetDefaults(qc, client, p).then((src) => {
                const base = slugKey(p.path[p.path.length - 1] ?? '')
                ctl.add({
                  key: uniqueKey(base, ctl.defs),
                  label: titleCase(p.path[p.path.length - 1] ?? ''),
                  path: p.path,
                  ...src
                })
                setAnnounce(`Added ${pathLabel(p.path)}`)
              })
            }}
          />
        </PopoverContent>
      </Popover>
      {count === 0 && !ctl.adding && (
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          No quick filters yet.
        </span>
      )}
      {err && (
        <span
          role='alert'
          className='order-last flex min-w-0 basis-full items-center gap-1.5 text-[11.5px] text-red-700 sm:order-none sm:ml-auto sm:basis-auto dark:text-red-300'
        >
          <AlertTriangle aria-hidden className='h-3.5 w-3.5 shrink-0' />
          <span className='min-w-0 sm:truncate' data-tip={err.hint}>
            {err.title}
          </span>
          <ErrorDetails description={err} action='Save quick filters' className='shrink-0' />
        </span>
      )}
      <div className='ml-auto flex min-w-0 items-center gap-1.5'>
        {err ? null : firstProblem ? (
          <button
            type='button'
            onClick={() => ctl.setOpenId(firstProblem.id)}
            className='rounded text-[11.5px] font-medium text-amber-800 underline decoration-amber-400 underline-offset-2 hover:text-amber-950 dark:text-amber-300 dark:hover:text-amber-200'
          >
            {ctl.problemCount === 1 ? '1 filter needs' : `${ctl.problemCount} filters need`}{' '}
            finishing
          </button>
        ) : (
          <span className='hidden text-[11.5px] text-slate-500 lg:inline dark:text-slate-400'>
            Saved for everyone who opens this list
          </span>
        )}
        <button
          type='button'
          onClick={ctl.cancel}
          className='h-6 rounded px-2 text-[11.5px] font-medium text-slate-600 hover:bg-white hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-slate-300 dark:hover:bg-slate-900 dark:hover:text-white'
        >
          Cancel
        </button>
        <button
          type='button'
          disabled={!canSave}
          onClick={() => void ctl.save()}
          data-qf-save=''
          className='h-6 whitespace-nowrap rounded bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 focus-visible:ring-offset-1 hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-45'
        >
          {failed ? 'Try again' : 'Save'}
        </button>
      </div>
    </div>
  )
}
