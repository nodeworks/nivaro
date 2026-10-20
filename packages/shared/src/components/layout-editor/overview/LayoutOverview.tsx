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
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  AlertTriangle,
  Check,
  FileStack,
  GripVertical,
  MoreHorizontal,
  Plus,
  X
} from 'lucide-react'
import {
  type CSSProperties,
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { del, patch, post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Skeleton } from '../../ui/skeleton'
import {
  type ChoiceLabels,
  choiceLabelsFrom,
  type DescribeField,
  describeReason,
  type Segment
} from './describe-conditions'
import {
  btnOutline,
  btnPrimary,
  createLayout,
  type ExplainResult,
  NewFormButton,
  TestRecordButton
} from './OverviewActions'
import {
  apiFailure,
  useInvalidateLayouts,
  useLayoutOverview,
  useOverviewFields
} from './overview-api'
import type {
  LayoutType,
  OverviewReason,
  OverviewReference,
  OverviewRow,
  OverviewSection
} from './types'

/**
 * "Which form does each record get?" — the page the Layouts tab opens on (spec §7.1).
 * One row per layout, in the order the server checks them, with the rules as
 * sentences. Forms rows are never draggable: their order is computed (more rules
 * first, then role preference, then the default). Only "Other views" reorder,
 * and only among layouts of one kind, where `sort` picks the fallback.
 */

export interface LayoutOverviewProps {
  collection: string
  onOpen: (layoutId: number) => void
  /** After New form / Create first form; defaults to opening the new layout. */
  onCreate?: (type: LayoutType, layoutId: number) => void
}

const SECTIONS: Array<{ id: OverviewSection; title: string; hint?: string }> = [
  { id: 'forms', title: 'Forms people fill in — checked in this order' },
  { id: 'link_only', title: 'Opened by a link or button only' },
  {
    id: 'other_views',
    title: 'Other views of the same record',
    hint: 'Drag to change which one is used first'
  },
  { id: 'unused', title: 'Unused' }
]

const TYPE_USE: Record<string, string> = {
  summary: 'Read mode',
  detail: 'Drill-down panel',
  file: 'PDF',
  addendum: 'Addendum form',
  table: 'Grid columns'
}

const DEFAULTABLE = new Set(['grouped', 'summary', 'detail'])

function shapeLine(row: OverviewRow): string {
  const { steps_or_tabs, groups, fields } = row.shape
  if (!fields && !groups) return 'empty'
  const parts: string[] = []
  if (steps_or_tabs > 0) {
    const unit = row.shape.container_mode === 'tabs' ? 'tab' : 'step'
    parts.push(`${steps_or_tabs} ${unit}${steps_or_tabs === 1 ? '' : 's'}`)
  } else if (groups > 0) parts.push(`${groups} ${groups === 1 ? 'section' : 'sections'}`)
  parts.push(`${fields} ${fields === 1 ? 'field' : 'fields'}`)
  return parts.join(' · ')
}

function Sentence({ segs, muted }: { segs: Segment[]; muted?: boolean }) {
  if (!segs.length) return <span className='text-slate-400 dark:text-muted-foreground'>—</span>
  return (
    <span className={muted ? 'text-slate-500 dark:text-muted-foreground' : undefined}>
      {segs.map((s, i) =>
        s.strong ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <b key={i} className='font-semibold text-slate-900 dark:text-foreground'>
            {s.text}
          </b>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
          <Fragment key={i}>{s.text}</Fragment>
        )
      )}
    </span>
  )
}

function Pill({
  tone,
  children
}: {
  tone: 'default' | 'rule' | 'link' | 'role'
  children: ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full px-2 py-px text-[11px] font-semibold',
        tone === 'default' && 'bg-nvr-cyan/15 text-[#0089ad] dark:text-nvr-cyan',
        tone === 'rule' &&
          'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300',
        tone === 'role' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
        tone === 'link' && 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
      )}
    >
      {children}
    </span>
  )
}

function whenCell(row: OverviewRow, fields: DescribeField[], choices: ChoiceLabels): ReactNode {
  if (row.section === 'unused') return <Sentence segs={[]} />
  if (row.section === 'link_only' || row.reason.kind === 'slug') {
    if (row.references.length) {
      return (
        <span className='text-slate-600 dark:text-muted-foreground'>
          {row.references.map((r) => r.label).join(' · ')}
        </span>
      )
    }
    return (
      <span className='text-slate-500 dark:text-muted-foreground'>
        Has a link name; may be used by URLs or code
      </span>
    )
  }
  if (row.section === 'other_views') {
    const use = row.reason.type_use || TYPE_USE[row.layout_type] || row.layout_type
    return <span className='text-slate-600 dark:text-muted-foreground'>{use}</span>
  }
  const segs = describeReason(row.reason, fields, choices)
  return (
    <>
      <Sentence segs={segs} />
      {row.reason.kind === 'fallback' && (
        <span className='mt-0.5 block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          No form is marked default, so the first in order is used
        </span>
      )}
    </>
  )
}

function alsoCell(row: OverviewRow): ReactNode {
  if (!row.new_menu) return null
  if (row.new_menu.hidden) return 'hidden from New menu'
  return `“${row.new_menu.label}” on New menu`
}

// ─── Row menu ────────────────────────────────────────────────────────────────

function RowMenu({
  row,
  onOpen,
  onRename,
  onDelete,
  onDone
}: {
  row: OverviewRow
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: string, fail: string) => {
    setOpen(false)
    try {
      await fn()
      toast.success(ok)
      onDone()
    } catch (err) {
      toast.error(apiFailure(err, fail).message)
    }
  }
  const item =
    'flex w-full items-center rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='Layout actions'
          data-tip='Actions'
          className='inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <MoreHorizontal className='h-4 w-4' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' side='bottom' className='w-[200px] p-1'>
        <div role='menu' aria-label={`${row.name} actions`}>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={() => {
              setOpen(false)
              onOpen()
            }}
          >
            Open
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={() => {
              setOpen(false)
              onRename()
            }}
          >
            Rename
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            onClick={() =>
              void run(
                () =>
                  client.request(
                    post(`/collection-layouts/${row.layout_id}/clone`, {
                      name: `${row.name} (copy)`
                    })
                  ),
                'Duplicated',
                'Could not duplicate'
              )
            }
          >
            Duplicate
          </button>
          {row.layout_type === 'grouped' && (
            <button
              type='button'
              role='menuitem'
              className={item}
              onClick={() =>
                void run(
                  () =>
                    client.request(
                      post(`/collection-layouts/${row.layout_id}/clone`, {
                        name: `${row.name} — Summary`,
                        layout_type: 'summary'
                      })
                    ),
                  'Summary created',
                  'Could not create the summary'
                )
              }
            >
              Duplicate as summary
            </button>
          )}
          {DEFAULTABLE.has(row.layout_type) && !row.is_default && (
            <button
              type='button'
              role='menuitem'
              className={item}
              onClick={() =>
                void run(
                  () => client.request(post(`/collection-layouts/${row.layout_id}/activate`)),
                  `${row.name} is now the default`,
                  'Could not make it the default'
                )
              }
            >
              Make default
            </button>
          )}
          <div className='my-1 h-px bg-slate-100 dark:bg-border' />
          <button
            type='button'
            role='menuitem'
            className={cn(item, 'text-red-600 dark:text-red-400')}
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
          >
            Delete…
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Delete confirm (inline, under the row) ─────────────────────────────────

function DeleteConfirm({
  row,
  onCancel,
  onDeleted
}: {
  row: OverviewRow
  onCancel: () => void
  onDeleted: () => void
}) {
  const client = useNivaroClient()
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState<{ message: string; refs: OverviewReference[] } | null>(
    null
  )
  const refs = blocked?.refs.length ? blocked.refs : row.references

  const confirm = async () => {
    setBusy(true)
    try {
      await client.request(del(`/collection-layouts/${row.layout_id}`))
      toast.success(`${row.name} deleted`)
      onDeleted()
    } catch (err) {
      const f = apiFailure(err, 'Could not delete the layout')
      if (f.status === 409) setBlocked({ message: f.message, refs: f.references })
      else toast.error(f.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <tr data-delete-confirm={row.layout_id}>
      <td
        colSpan={4}
        className='border-b border-red-100 bg-red-50 px-3.5 py-3 dark:border-red-500/20 dark:bg-[#2a1215]'
      >
        <div className='flex flex-wrap items-start gap-x-6 gap-y-2'>
          <div className='min-w-[240px] flex-1 text-[12.5px] text-slate-700 dark:text-foreground'>
            {blocked ? (
              <p className='font-semibold text-red-700 dark:text-red-300'>{blocked.message}</p>
            ) : (
              <p className='font-semibold'>Delete “{row.name}”?</p>
            )}
            {refs.length ? (
              <>
                <p className='mt-1 text-slate-600 dark:text-muted-foreground'>
                  {blocked ? 'Remove these uses first:' : 'Still used by:'}
                </p>
                <ul className='mt-1 list-disc space-y-0.5 pl-5'>
                  {refs.map((r) => (
                    <li key={`${r.kind}:${r.id}`}>{r.label}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className='mt-1 text-slate-600 dark:text-muted-foreground'>
                Nothing uses this layout. Its sections, placements and history go with it.
              </p>
            )}
          </div>
          <div className='flex shrink-0 gap-2'>
            <button type='button' className={btnOutline} onClick={onCancel}>
              Cancel
            </button>
            {!blocked && (
              <button
                type='button'
                disabled={busy}
                onClick={() => void confirm()}
                className='inline-flex h-8 items-center rounded-md bg-red-600 px-3 text-[12.5px] font-semibold text-white hover:bg-red-700 disabled:opacity-50'
              >
                {busy ? 'Deleting…' : 'Delete layout'}
              </button>
            )}
          </div>
        </div>
      </td>
    </tr>
  )
}

// ─── One row ────────────────────────────────────────────────────────────────

interface RowProps {
  row: OverviewRow
  fields: DescribeField[]
  choices: ChoiceLabels
  tested: boolean
  onOpen: (id: number) => void
  onChanged: () => void
  drag?: {
    setNodeRef: (el: HTMLElement | null) => void
    style: CSSProperties
    handle: ReactNode
    dragging: boolean
  }
}

function RowView({ row, fields, choices, tested, onOpen, onChanged, drag }: RowProps) {
  const client = useNivaroClient()
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(row.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Enter and Escape unmount the focused input, and the browser then fires blur
  // with the typed text still in the last render's closure: without this, Escape
  // saved the name it meant to drop and Enter saved twice. Reset per rename.
  const renameSettled = useRef(false)

  const cancelRename = () => {
    renameSettled.current = true
    setDraftName(row.name)
    setRenaming(false)
  }

  const commitRename = async () => {
    if (renameSettled.current) return
    renameSettled.current = true
    const next = draftName.trim()
    setRenaming(false)
    if (!next || next === row.name) return
    try {
      await client.request(patch(`/collection-layouts/${row.layout_id}`, { name: next }))
      onChanged()
    } catch (err) {
      setDraftName(row.name)
      toast.error(apiFailure(err, 'Could not rename the layout').message)
    }
  }

  const also = alsoCell(row)
  const cell = 'border-b border-slate-100 px-3.5 py-3 align-top dark:border-border/60'

  return (
    <>
      <tr
        ref={drag?.setNodeRef}
        style={drag?.style}
        data-layout-row={row.layout_id}
        data-tested={tested || undefined}
        className={cn(
          'bg-white text-[13px] dark:bg-card',
          tested && 'bg-[#e6f9ff] dark:bg-[#0c2a33]',
          drag?.dragging && 'relative z-10 shadow-lg'
        )}
      >
        <td className={cn(cell, 'w-[34%]')}>
          <div className='flex items-start gap-1.5'>
            {drag?.handle}
            <div className='min-w-0'>{whenCell(row, fields, choices)}</div>
          </div>
        </td>
        <td className={cell}>
          <div className='flex flex-wrap items-center gap-1.5'>
            {renaming ? (
              <input
                // biome-ignore lint/a11y/noAutofocus: inline rename starts typing at once
                autoFocus
                aria-label='Layout name'
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitRename()
                  if (e.key === 'Escape') cancelRename()
                }}
                className='h-7 w-[220px] rounded-md border border-nvr-cyan bg-white px-2 text-[13px] font-semibold outline-none dark:bg-background dark:text-foreground'
              />
            ) : (
              <button
                type='button'
                onClick={() => onOpen(row.layout_id)}
                className={cn(
                  'text-left font-semibold text-slate-900 hover:text-[#0089ad] hover:underline dark:text-foreground dark:hover:text-nvr-cyan',
                  row.section === 'unused' && 'text-slate-500 dark:text-muted-foreground'
                )}
              >
                {row.name}
              </button>
            )}
            {row.section === 'forms' && row.is_default && <Pill tone='default'>default</Pill>}
            {row.section === 'forms' && row.reason.kind === 'record_rule' && (
              <Pill tone='rule'>rule</Pill>
            )}
            {row.section === 'forms' && row.reason.kind === 'role' && <Pill tone='role'>role</Pill>}
            {row.section === 'link_only' && <Pill tone='link'>link only</Pill>}
            {tested && (
              <span className='inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#0089ad] dark:text-nvr-cyan'>
                <Check className='h-3 w-3' />
                this record
              </span>
            )}
          </div>
          <div className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {row.section === 'unused' ? `${shapeLine(row)}, used by nothing` : shapeLine(row)}
          </div>
          {row.warnings.map((w) => (
            <div
              key={w}
              className='mt-1 flex items-start gap-1 text-[11.5px] text-amber-700 dark:text-amber-300'
            >
              <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />
              {w}
            </div>
          ))}
        </td>
        <td className={cn(cell, 'w-[22%] text-[12.5px] text-slate-500 dark:text-muted-foreground')}>
          {row.section === 'unused' ? (
            <button type='button' className={btnOutline} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          ) : (
            also
          )}
        </td>
        <td className={cn(cell, 'w-[44px] px-1.5 text-right')}>
          <RowMenu
            row={row}
            onOpen={() => onOpen(row.layout_id)}
            onRename={() => {
              renameSettled.current = false
              setDraftName(row.name)
              setRenaming(true)
            }}
            onDelete={() => setConfirmDelete(true)}
            onDone={onChanged}
          />
        </td>
      </tr>
      {confirmDelete && (
        <DeleteConfirm
          row={row}
          onCancel={() => setConfirmDelete(false)}
          onDeleted={() => {
            setConfirmDelete(false)
            onChanged()
          }}
        />
      )}
    </>
  )
}

function SortableRow(props: Omit<RowProps, 'drag'> & { draggable: boolean }) {
  const { draggable, ...rest } = props
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.row.layout_id,
    disabled: !draggable
  })
  const handle = draggable ? (
    <button
      type='button'
      data-drag-handle=''
      aria-label={`Reorder ${props.row.name}`}
      data-tip='Drag to reorder'
      className='-ml-1 mt-px cursor-grab touch-none text-slate-400 hover:text-slate-700 active:cursor-grabbing dark:text-muted-foreground dark:hover:text-foreground'
      {...attributes}
      {...listeners}
    >
      <GripVertical className='h-4 w-4' />
    </button>
  ) : (
    <span className='-ml-1 w-4 shrink-0' />
  )
  return (
    <RowView
      {...rest}
      drag={{
        setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        handle,
        dragging: isDragging
      }}
    />
  )
}

// ─── Sections ───────────────────────────────────────────────────────────────

function SectionHead({ id, title, hint }: { id: OverviewSection; title: string; hint?: string }) {
  return (
    <div
      data-overview-section={id}
      className='flex items-baseline gap-3 border-y border-slate-200 bg-slate-50 px-3.5 py-2 text-[12px] font-semibold text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'
    >
      {title}
      {hint && (
        <span className='font-normal text-slate-500 dark:text-muted-foreground'>{hint}</span>
      )}
    </div>
  )
}

/** Drag wraps the whole table: dnd-kit's screen-reader text is a div, which a tbody cannot hold. */
function OtherViewsDnd({
  rows,
  onReorder,
  children
}: {
  rows: OverviewRow[]
  onReorder: (rows: OverviewRow[], moved: OverviewRow) => void
  children: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = rows.findIndex((r) => r.layout_id === e.active.id)
    const to = rows.findIndex((r) => r.layout_id === e.over?.id)
    if (from < 0 || to < 0) return
    if (rows[from].layout_type !== rows[to].layout_type) {
      toast.info('Order only matters among layouts of the same kind')
      return
    }
    onReorder(arrayMove(rows, from, to), rows[from])
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={rows.map((r) => r.layout_id)} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  )
}

/** Sort decides the fallback only among layouts of one kind, so only those drag. */
function sharesType(row: OverviewRow, rows: OverviewRow[]): boolean {
  return rows.filter((r) => r.layout_type === row.layout_type).length > 1
}

// ─── Explain strip ──────────────────────────────────────────────────────────

/** Why a tested record got its form, as the end of "IR 32833 opens Unit Order — …". */
function explainWords(
  reason: OverviewReason,
  fields: DescribeField[],
  choices: ChoiceLabels
): Segment[] {
  switch (reason.kind) {
    case 'record_rule':
      return [{ text: 'because it ' }, ...describeReason(reason, fields, choices)]
    case 'role':
      return [{ text: 'that form is ' }, ...describeReason(reason, fields, choices)]
    case 'default':
      return [{ text: 'no rule caught it, so it gets the ' }, { text: 'default', strong: true }]
    case 'fallback':
      return [{ text: 'no rule caught it and no form is default, so it gets the first in order' }]
    case 'slug':
      return [{ text: 'pinned by the form’s link name' }]
    default:
      return reason.type_use ? [{ text: reason.type_use }] : []
  }
}

function ExplainStrip({
  result,
  rows,
  fields,
  choices,
  onClear
}: {
  result: ExplainResult
  rows: OverviewRow[]
  fields: DescribeField[]
  choices: ChoiceLabels
  onClear: () => void
}) {
  const nameOf = (id: number | null) =>
    rows.find((r) => r.layout_id === id)?.name ?? (id == null ? 'no layout' : `layout ${id}`)
  const reason = result.reason ? explainWords(result.reason, fields, choices) : []
  return (
    <div className='border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='flex items-start gap-3'>
        <div className='min-w-0 flex-1 text-[13px] text-slate-700 dark:text-foreground'>
          <span className='font-semibold'>{result.recordLabel}</span>
          {result.roleName && (
            <span className='text-slate-500 dark:text-muted-foreground'> as {result.roleName}</span>
          )}{' '}
          opens{' '}
          <b className='font-semibold text-[#0089ad] dark:text-nvr-cyan'>
            {nameOf(result.layout_id)}
          </b>
          {reason.length > 0 && (
            <>
              {' — '}
              <Sentence segs={reason} />
            </>
          )}
        </div>
        <button
          type='button'
          aria-label='Clear test'
          data-tip='Clear'
          onClick={onClear}
          className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-muted dark:text-muted-foreground'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      {result.checked.length > 0 && (
        <ol className='mt-2 space-y-0.5 text-[12px]'>
          {result.checked.map((c) => (
            <li key={c.layout_id} className='flex items-start gap-1.5'>
              {c.matched ? (
                <Check className='mt-[2px] h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400' />
              ) : (
                <X className='mt-[2px] h-3 w-3 shrink-0 text-slate-400 dark:text-muted-foreground' />
              )}
              <span className='font-medium text-slate-700 dark:text-foreground'>
                {nameOf(c.layout_id)}
              </span>
              <span className='text-slate-500 dark:text-muted-foreground'>{c.why}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function LayoutOverview({ collection, onOpen, onCreate }: LayoutOverviewProps) {
  const client = useNivaroClient()
  const { data, isLoading, isError, refetch } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const choices = useMemo(() => choiceLabelsFrom(fields), [fields])
  const invalidate = useInvalidateLayouts(collection)
  const [explain, setExplain] = useState<ExplainResult | null>(null)
  const [creatingFirst, setCreatingFirst] = useState(false)
  // Optimistic order for Other views while the sort PATCHes land.
  const [otherOrder, setOtherOrder] = useState<number[] | null>(null)
  const rows = data?.rows ?? []
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh server read resets the local order
  useEffect(() => setOtherOrder(null), [data])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a test result belongs to one collection
  useEffect(() => setExplain(null), [collection])

  const created = (type: LayoutType, id: number) => {
    invalidate()
    if (onCreate) onCreate(type, id)
    else onOpen(id)
  }

  const createFirst = async () => {
    setCreatingFirst(true)
    try {
      const id = await createLayout(client, {
        collection,
        name: 'Main form',
        layout_type: 'grouped',
        seed_fields: true
      })
      if (id == null) throw new Error('No id came back')
      created('grouped', id)
    } catch (err) {
      toast.error(apiFailure(err, 'Could not create the form').message)
    } finally {
      setCreatingFirst(false)
    }
  }

  const bySection = useMemo(() => {
    const m = new Map<OverviewSection, OverviewRow[]>()
    for (const r of rows) m.set(r.section, [...(m.get(r.section) ?? []), r])
    const others = m.get('other_views')
    if (others && otherOrder) {
      const pos = new Map(otherOrder.map((id, i) => [id, i]))
      m.set(
        'other_views',
        [...others].sort((a, b) => (pos.get(a.layout_id) ?? 0) - (pos.get(b.layout_id) ?? 0))
      )
    }
    return m
  }, [rows, otherOrder])

  const reorder = async (next: OverviewRow[], moved: OverviewRow) => {
    setOtherOrder(next.map((r) => r.layout_id))
    const sameType = next.filter((r) => r.layout_type === moved.layout_type)
    try {
      await Promise.all(
        sameType.map((r, i) =>
          client.request(patch(`/collection-layouts/${r.layout_id}`, { sort: i + 1 }))
        )
      )
    } catch (err) {
      toast.error(apiFailure(err, 'Could not save the new order').message)
    } finally {
      invalidate()
    }
  }

  const renderRow = (row: OverviewRow, draggable?: boolean) => {
    const common = {
      row,
      fields,
      choices,
      tested: explain?.layout_id === row.layout_id,
      onOpen,
      onChanged: invalidate
    }
    return draggable === undefined ? (
      <RowView key={row.layout_id} {...common} />
    ) : (
      <SortableRow key={row.layout_id} {...common} draggable={draggable} />
    )
  }

  const header = (
    <header className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='min-w-0 flex-1'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Which form does each record get?
        </h2>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Read top to bottom: records are matched the same way.
        </p>
      </div>
      {rows.length > 0 && <TestRecordButton collection={collection} onResult={setExplain} />}
      <NewFormButton collection={collection} onCreated={created} />
    </header>
  )

  const banner = data?.warning ? (
    <div
      role='status'
      className='flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-[12.5px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-[#2b2111] dark:text-amber-200'
    >
      <AlertTriangle className='mt-[2px] h-3.5 w-3.5 shrink-0' />
      {data.warning}
    </div>
  ) : null

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className='space-y-2 p-4'>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className='h-12 w-full' />
        ))}
      </div>
    )
  } else if (isError) {
    body = (
      <div className='p-6 text-[13px] text-slate-600 dark:text-muted-foreground'>
        Could not load the layouts.{' '}
        <button
          type='button'
          className='font-semibold text-[#0089ad] hover:underline dark:text-nvr-cyan'
          onClick={() => void refetch()}
        >
          Try again
        </button>
      </div>
    )
  } else if (rows.length === 0) {
    body = (
      <div className='flex flex-col items-center justify-center gap-2 px-6 py-14 text-center'>
        <div className='flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-muted'>
          <FileStack className='h-5 w-5 text-slate-400 dark:text-muted-foreground' />
        </div>
        <p className='text-[13.5px] font-semibold text-slate-800 dark:text-foreground'>
          No forms yet
        </p>
        <p className='max-w-[460px] text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          A form layout decides which fields people see on a record, in which sections and steps,
          and in what order. Without one, records show every field in one list.
        </p>
        <button
          type='button'
          className={cn(btnPrimary, 'mt-2')}
          disabled={creatingFirst}
          onClick={() => void createFirst()}
        >
          <Plus className='h-3.5 w-3.5' />
          {creatingFirst ? 'Creating…' : 'Create first form'}
        </button>
      </div>
    )
  } else {
    body = (
      <div>
        {SECTIONS.map((s) => {
          const list = bySection.get(s.id) ?? []
          if (!list.length && s.id !== 'forms') return null
          const isOther = s.id === 'other_views'
          const draggableAny = isOther && list.some((r) => sharesType(r, list))
          const table = (
            <table className='w-full table-fixed border-collapse'>
              {s.id === 'forms' && (
                <thead>
                  <tr className='bg-white text-left text-[12px] font-semibold text-slate-500 dark:bg-card dark:text-muted-foreground'>
                    <th className='w-[34%] border-b border-slate-200 px-3.5 py-2 font-semibold dark:border-border'>
                      When the record…
                    </th>
                    <th className='border-b border-slate-200 px-3.5 py-2 font-semibold dark:border-border'>
                      Opens
                    </th>
                    <th className='w-[22%] border-b border-slate-200 px-3.5 py-2 font-semibold dark:border-border'>
                      Also
                    </th>
                    <th className='w-[44px] border-b border-slate-200 dark:border-border' />
                  </tr>
                </thead>
              )}
              <tbody>
                {list.map((r) => (isOther ? renderRow(r, sharesType(r, list)) : renderRow(r)))}
                {s.id === 'forms' && list.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className='bg-white px-3.5 py-3 text-[12.5px] text-slate-500 dark:bg-card dark:text-muted-foreground'
                    >
                      No form people fill in yet. Records show every field in one list.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )
          return (
            <section key={s.id}>
              <SectionHead id={s.id} title={s.title} hint={draggableAny ? s.hint : undefined} />
              {isOther ? (
                <OtherViewsDnd rows={list} onReorder={reorder}>
                  {table}
                </OtherViewsDnd>
              ) : (
                table
              )}
            </section>
          )
        })}
      </div>
    )
  }

  return (
    <div className='flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-background'>
      {header}
      {banner}
      {explain && (
        <ExplainStrip
          result={explain}
          rows={rows}
          fields={fields}
          choices={choices}
          onClear={() => setExplain(null)}
        />
      )}
      <div className='min-h-0 flex-1 overflow-y-auto'>{body}</div>
    </div>
  )
}
