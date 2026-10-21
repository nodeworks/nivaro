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
  BarChart3,
  Check,
  FileStack,
  GripVertical,
  MoreHorizontal,
  Plus,
  X
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { del, patch, post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Skeleton } from '../../ui/skeleton'
import { BulkChangesButton } from '../bulk/BulkChangesButton'
import { OwnerLine } from '../collab/OwnerLine'
import { useCollectionBody } from '../collection-meta'
import {
  CompareForms,
  defaultComparePair,
  FindFieldButton,
  LayoutThumb,
  type LayoutThumbData,
  useCrossform
} from '../crossform'
import { MergeFormsButton } from '../crossform/MergeForms'
import { overviewLoops } from '../explain/overview-loops'
import type { RuleFieldRow } from '../explain/rule-graph'
import { useFieldRuleRows } from '../explain/use-explain'
import { type ScheduleRow, useLayoutSchedules } from '../history-api'
import { DependencyDiagram } from '../ops/DependencyDiagram'
import { downloadLayout, requestsByLayout, useChangeRequests } from '../ops/ops-api'
import { PromotePanel } from '../ops/PromotePanel'
import { amberStrip } from '../panel-style'
import { FormFromRecordButton } from '../reuse/FormFromRecordButton'
import { BarMenu } from '../toolbar-kit'
import {
  AnalysisButtons,
  AnalysisProvider,
  CoverageNote,
  HealthChip,
  sortWorstFirst,
  useOverviewAnalysis
} from './analysis'
import { ChangeLogButton } from './ChangeLogButton'
import {
  type ChoiceLabels,
  type DescribeField,
  describeReason,
  type Segment
} from './describe-conditions'
import { FindingsStrip } from './FindingsStrip'
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
  useOverviewFields,
  useRuleChoiceLabels
} from './overview-api'
import { Pill, Sentence, shapeLine, TYPE_USE } from './purpose'
import { ScheduledChanges } from './ScheduledChanges'
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
  { id: 'link_only', title: 'Opened by a link, a button or the New menu' },
  {
    id: 'other_views',
    title: 'Other views of the same record',
    hint: 'Drag to change which one is used first'
  },
  { id: 'unused', title: 'Unused' }
]

const DEFAULTABLE = new Set(['grouped', 'summary', 'detail'])

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

const ONLY_LAYOUT_REASON = 'The only form for this collection can’t be deleted'

// ─── Row menu ────────────────────────────────────────────────────────────────

function RowMenu({
  row,
  only,
  onOpen,
  onRename,
  onDelete,
  onDone,
  onPanel
}: {
  row: OverviewRow
  only: boolean
  onOpen: () => void
  onRename: () => void
  onDelete: () => void
  onDone: () => void
  /** #2613 / #2593 — open an inline panel under the row. */
  onPanel: (panel: 'deps' | 'compare') => void
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
            className={item}
            data-row-action='deps'
            onClick={() => {
              setOpen(false)
              onPanel('deps')
            }}
          >
            What relies on this…
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            data-row-action='compare'
            onClick={() => {
              setOpen(false)
              onPanel('compare')
            }}
          >
            Compare with another environment…
          </button>
          <button
            type='button'
            role='menuitem'
            className={item}
            data-row-action='download'
            onClick={() => {
              setOpen(false)
              void downloadLayout(client, row.layout_id, row.name).catch((err) =>
                toast.error(apiFailure(err, 'Could not download').message)
              )
            }}
          >
            Download this form
          </button>
          <div className='my-1 h-px bg-slate-100 dark:bg-border' />
          <button
            type='button'
            role='menuitem'
            disabled={only}
            data-tip={only ? ONLY_LAYOUT_REASON : undefined}
            className={cn(
              item,
              'text-red-600 dark:text-red-400',
              only && 'cursor-not-allowed opacity-50'
            )}
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
      const f = apiFailure(err, 'Could not delete the form')
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
            {!blocked && (
              <DependencyDiagram layoutId={row.layout_id} change='delete' className='mt-2' />
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
                Nothing uses this form. Its sections, placements and history go with it.
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
  /** The collection's only layout: it is the fallback for every record. */
  only: boolean
  /** Open form change suggestions naming this layout (#2609). */
  requests?: number
  /** Sketch of the form (#2664); none for grid-column layouts. */
  thumb?: LayoutThumbData
  onOpen: (id: number) => void
  onChanged: () => void
  /** This form's scheduled layout changes (#2590). */
  scheduled?: ScheduleRow[]
  collection?: string
  drag?: {
    setNodeRef: (el: HTMLElement | null) => void
    style: CSSProperties
    handle: ReactNode
    dragging: boolean
  }
}

function RowView({
  row,
  fields,
  choices,
  tested,
  only,
  requests,
  thumb,
  onOpen,
  onChanged,
  scheduled,
  collection,
  drag
}: RowProps) {
  const client = useNivaroClient()
  const [renaming, setRenaming] = useState(false)
  const [panel, setPanel] = useState<'deps' | 'compare' | null>(null)
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
          {thumb && <LayoutThumb thumb={thumb} name={row.name} className='float-right ml-3' />}
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
            <HealthChip layoutId={row.layout_id} />
            {row.section === 'forms' && row.is_default && <Pill tone='default'>default</Pill>}
            {row.section === 'forms' && row.reason.kind === 'record_rule' && (
              <Pill tone='rule'>rule</Pill>
            )}
            {row.section === 'forms' && row.reason.kind === 'role' && <Pill tone='role'>role</Pill>}
            {row.section === 'link_only' && (
              <Pill tone='link'>
                {row.new_menu && !row.new_menu.hidden ? 'link or New menu' : 'link only'}
              </Pill>
            )}
            {requests ? (
              <button
                type='button'
                data-row-requests={requests}
                data-tip='Open the form to read them (Form settings → Tools)'
                onClick={() => onOpen(row.layout_id)}
                className='rounded-full bg-nvr-cyan/10 px-2 py-px text-[11px] font-semibold text-nvr-navy hover:bg-nvr-cyan/15 dark:text-nvr-cyan'
              >
                {requests} {requests === 1 ? 'suggestion' : 'suggestions'}
              </button>
            ) : null}
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
          <OwnerLine layoutId={row.layout_id} />
          {row.warnings.map((w) => (
            <div
              key={w}
              className='mt-1 flex items-start gap-1 text-[11.5px] text-amber-700 dark:text-amber-300'
            >
              <AlertTriangle className='mt-[2px] h-3 w-3 shrink-0' />
              {w}
            </div>
          ))}
          <CoverageNote row={row} />
          {scheduled && collection && <ScheduledChanges rows={scheduled} collection={collection} />}
        </td>
        <td className={cn(cell, 'w-[22%] text-[12.5px] text-slate-500 dark:text-muted-foreground')}>
          {row.section === 'unused' ? (
            <button
              type='button'
              className={btnOutline}
              disabled={only}
              data-tip={only ? ONLY_LAYOUT_REASON : undefined}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </button>
          ) : (
            also
          )}
        </td>
        <td className={cn(cell, 'w-[44px] px-1.5 text-right')}>
          <RowMenu
            row={row}
            only={only}
            onOpen={() => onOpen(row.layout_id)}
            onRename={() => {
              renameSettled.current = false
              setDraftName(row.name)
              setRenaming(true)
            }}
            onDelete={() => setConfirmDelete(true)}
            onDone={onChanged}
            onPanel={(p) => setPanel((cur) => (cur === p ? null : p))}
          />
        </td>
      </tr>
      {(panel || (renaming && row.references.length > 0)) && (
        <tr data-row-panel={renaming ? 'rename' : panel}>
          <td
            colSpan={4}
            className='border-b border-slate-100 bg-slate-50 px-3.5 py-3 dark:border-border/60 dark:bg-background'
          >
            <div className='flex items-start gap-3'>
              <div className='min-w-0 flex-1'>
                {renaming || panel === 'deps' ? (
                  <DependencyDiagram layoutId={row.layout_id} change={renaming ? 'rename' : null} />
                ) : (
                  <PromotePanel
                    layoutId={row.layout_id}
                    layoutName={row.name}
                    onApplied={onChanged}
                  />
                )}
              </div>
              {!renaming && (
                <button
                  type='button'
                  aria-label='Close'
                  onClick={() => setPanel(null)}
                  className='rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
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
    case 'ab':
      return [{ text: 'this person is in the half of the role trying a new version (A/B test)' }]
    default:
      return reason.type_use ? [{ text: reason.type_use }] : []
  }
}

function ExplainStrip({
  collection,
  result,
  rows,
  fields,
  choices,
  onClear,
  onMade
}: {
  collection: string
  result: ExplainResult
  rows: OverviewRow[]
  fields: DescribeField[]
  choices: ChoiceLabels
  onClear: () => void
  /** A form was made from the tested record (#2585). */
  onMade: (layoutId: number) => void
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
        <FormFromRecordButton
          collection={collection}
          recordId={result.recordId}
          recordLabel={result.recordLabel}
          onMade={onMade}
        />
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

/**
 * "3 suggested changes" in the overview's subtitle (#2609): a link that
 * lists the forms people suggested changes for; opening one shows them under
 * Form settings → Tools.
 */
function SuggestedChangesLink({
  total,
  counts,
  rows,
  onOpen
}: {
  total: number
  counts: Map<number, number>
  rows: OverviewRow[]
  onOpen: (id: number) => void
}) {
  const [open, setOpen] = useState(false)
  const forms = rows.filter((r) => (counts.get(r.layout_id) ?? 0) > 0)
  const loose = counts.get(0) ?? 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-overview-requests={total}
          className='font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
        >
          {total} suggested {total === 1 ? 'change' : 'changes'}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[300px] p-1.5'>
        <p className='px-2 pb-1 pt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          Suggested changes · from people, on record pages. Open a form to read its own.
        </p>
        {forms.map((r) => (
          <button
            key={r.layout_id}
            type='button'
            data-requests-form={r.layout_id}
            onClick={() => {
              setOpen(false)
              onOpen(r.layout_id)
            }}
            className='flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
          >
            <span className='min-w-0 flex-1 truncate'>{r.name}</span>
            <span className='shrink-0 tabular-nums text-slate-500 dark:text-muted-foreground'>
              {counts.get(r.layout_id)}
            </span>
          </button>
        ))}
        {loose > 0 && (
          <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {loose} {loose === 1 ? 'suggestion names' : 'suggestions name'} no form: read them in
            any form’s Form settings → Tools.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function LayoutOverview({ collection, onOpen, onCreate }: LayoutOverviewProps) {
  const client = useNivaroClient()
  const { data, isLoading, isError, refetch } = useLayoutOverview(collection)
  const { data: fields = [] } = useOverviewFields(collection)
  const invalidate = useInvalidateLayouts(collection)
  const [explain, setExplain] = useState<ExplainResult | null>(null)
  const [creatingFirst, setCreatingFirst] = useState(false)
  // Optimistic order for Other views while the sort PATCHes land.
  const [otherOrder, setOtherOrder] = useState<number[] | null>(null)
  const rows = useMemo(() => data?.rows ?? [], [data])
  // #2609 — open form change suggestions, per layout (0 = they name no form).
  const { data: requestList } = useChangeRequests(collection)
  const requestCounts = useMemo(() => requestsByLayout(requestList), [requestList])
  const requestTotal = requestList?.length ?? 0
  const choices = useRuleChoiceLabels(collection, fields, rows)
  const analysis = useOverviewAnalysis(collection, rows.length > 0)
  // Rule loops (#2642): on the form whose sections loop, or once for the collection.
  const { data: fieldRows = [] } = useCollectionBody(collection, {
    select: (b) => (Array.isArray(b?.fields) ? (b.fields as RuleFieldRow[]) : [])
  })
  const { data: fieldRules = [] } = useFieldRuleRows(collection)
  const loops = useMemo(
    () => overviewLoops(rows, fieldRows, fieldRules, fields),
    [rows, fieldRows, fieldRules, fields]
  )
  // biome-ignore lint/correctness/useExhaustiveDependencies: a fresh server read resets the local order
  useEffect(() => setOtherOrder(null), [data])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a test result belongs to one collection
  useEffect(() => setExplain(null), [collection])
  // Two forms side by side (#2659), in place of the list.
  const [compare, setCompare] = useState<[number, number] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a comparison belongs to one collection
  useEffect(() => setCompare(null), [collection])
  const crossform = useCrossform(collection, rows.length > 0)

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
      // The first form is the default, so the overview never says none is marked.
      // The form exists either way: say so if it could not be made the default.
      await client
        .request(post(`/collection-layouts/${id}/activate`))
        .catch((err) =>
          toast.error(
            `Main form was created but not made the default: ${apiFailure(err, 'the server refused').message}`
          )
        )
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
    if (analysis.worstFirst)
      for (const [k, list] of m) m.set(k, sortWorstFirst(list, analysis.value.health))
    return m
  }, [rows, otherOrder, analysis.worstFirst, analysis.value.health])

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
      // The refetch may return the same data (structural sharing keeps the
      // reference), so the reset effect would not run: drop the order here.
      setOtherOrder(null)
    } finally {
      invalidate()
    }
  }

  const { data: schedules } = useLayoutSchedules(collection)
  const schedulesByLayout = useMemo(() => {
    const m = new Map<number, ScheduleRow[]>()
    for (const s of schedules ?? []) m.set(s.layout_id, [...(m.get(s.layout_id) ?? []), s])
    return m
  }, [schedules])

  if (compare)
    return (
      <CompareForms
        collection={collection}
        rows={rows}
        aId={compare[0]}
        bId={compare[1]}
        onChange={(a, b) => setCompare([a, b])}
        onOpen={onOpen}
        onClose={() => setCompare(null)}
      />
    )

  const renderRow = (stored: OverviewRow, draggable?: boolean) => {
    const own = loops.byLayout.get(stored.layout_id)
    const row = own
      ? { ...stored, warnings: [...stored.warnings, ...own.map((t) => `Rule loop: ${t}`)] }
      : stored
    const common = {
      row,
      fields,
      choices,
      tested: explain?.layout_id === row.layout_id,
      only: rows.length === 1,
      requests: requestCounts.get(row.layout_id) ?? 0,
      thumb: crossform.data?.thumbs[String(row.layout_id)],
      onOpen,
      onChanged: invalidate,
      scheduled: schedulesByLayout.get(row.layout_id),
      collection
    }
    return draggable === undefined ? (
      <RowView key={row.layout_id} {...common} />
    ) : (
      <SortableRow key={row.layout_id} {...common} draggable={draggable} />
    )
  }

  const comparePair = defaultComparePair(rows)
  const header = (
    <header className='flex shrink-0 flex-nowrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='min-w-0 flex-1'>
        <h2 className='truncate text-[14px] font-semibold text-slate-900 dark:text-foreground'>
          Which form does each record get?
        </h2>
        <p className='truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
          {analysis.worstFirst
            ? 'Sorted by health, worst first. Turn it off to see the order records are matched in.'
            : 'Read top to bottom: records are matched the same way.'}
          {requestTotal > 0 && (
            <>
              {' · '}
              <SuggestedChangesLink
                total={requestTotal}
                counts={requestCounts}
                rows={rows}
                onOpen={onOpen}
              />
            </>
          )}
        </p>
      </div>
      <div className='flex shrink-0 items-center gap-1.5'>
        {rows.length > 0 && <TestRecordButton collection={collection} onResult={setExplain} />}
        {rows.length > 0 && <FindFieldButton collection={collection} onOpen={onOpen} />}
        {rows.length > 0 && (
          <BarMenu
            label='Analyze'
            icon={<BarChart3 className='h-3.5 w-3.5' />}
            align='end'
            tip='Coverage, health order and comparing forms'
          >
            <AnalysisButtons
              hasCoverage={!!analysis.value.coverage}
              checking={analysis.checking}
              onCheck={() => void analysis.check(!!analysis.value.coverage)}
              worstFirst={analysis.worstFirst}
              onWorstFirst={analysis.setWorstFirst}
              onCompare={comparePair ? () => setCompare(comparePair) : undefined}
            />
          </BarMenu>
        )}
        {rows.length > 0 && (
          <BarMenu
            label='More'
            icon={<MoreHorizontal className='h-4 w-4' />}
            iconOnly
            align='end'
            tip='Changes to every form, merging forms, the change log'
            data={{ 'data-overview-more': '' }}
          >
            <BulkChangesButton collection={collection} />
            <MergeFormsButton collection={collection} />
            <ChangeLogButton collection={collection} />
          </BarMenu>
        )}
        <NewFormButton collection={collection} onCreated={created} />
      </div>
    </header>
  )

  const banner = data?.warning ? (
    <div
      role='status'
      className={cn(
        'flex items-start gap-2 border-b px-4 py-2 text-[12.5px] font-medium',
        amberStrip
      )}
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
    <AnalysisProvider value={analysis.value}>
      <div className='flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-background'>
        {header}
        {banner}
        {explain && (
          <ExplainStrip
            collection={collection}
            result={explain}
            rows={rows}
            fields={fields}
            choices={choices}
            onClear={() => setExplain(null)}
            onMade={(id) => created('grouped', id)}
          />
        )}
        {rows.length > 0 && (
          <FindingsStrip
            collection={collection}
            rows={rows}
            loops={loops}
            checking={analysis.checking}
            onRecheck={() => void analysis.check(true)}
            onOpen={onOpen}
            onCompare={(a, b) => setCompare([a, b])}
            onChanged={invalidate}
          />
        )}
        <div className='min-h-0 flex-1 overflow-y-auto'>{body}</div>
      </div>
    </AnalysisProvider>
  )
}
