import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useState } from 'react'
import {
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { DesignDropBody, DesignNode } from '../DesignNode'
import { targetKey, useLayoutDesign } from '../design-context'
import { TABLE_FORM_ZONES } from '../dnd/collision'

// A table layout drawn the way InlineTableField shows it: a table-fixed header
// with one equal-width cell per column, in order. The grid reads no per-column
// width from a layout (its columns are equal), so there is none to edit here.
// Apply Values and Create with Defaults are the two extra forms of that table,
// shown as strips under it. Drag reorders (the same field targets the form
// canvas uses, zone = group_key); the arrow buttons are the keyboard route.

export const [APPLY_ZONE, DEFAULTS_ZONE] = TABLE_FORM_ZONES as [string, string]

type Apply = (ops: LayoutOp[], opts?: { label: string }) => void

export interface TableFieldChoice {
  field: string
  label?: string | null
}

export interface TableColumnsCanvasProps {
  bundle: LayoutBundle
  apply: Apply
  collection: string
  /** The collection's fields, for each zone's "Add field" control. */
  fields?: TableFieldChoice[]
}

const labelOf = (p: PlacementRow) => p.label_override ?? titleCase(p.field)

function zoneRows(bundle: LayoutBundle, zone: string | null): PlacementRow[] {
  return bundle.placements
    .filter((p) => p.group_key === zone && !isCanvasSlot(p) && !p.field.startsWith('__'))
    .sort((a, b) => a.sort - b.sort)
}

function useCellActions(row: PlacementRow, index: number, count: number, apply: Apply) {
  const label = labelOf(row)
  const at = { field: row.field, group_key: row.group_key }
  const move = (to: number) =>
    apply([{ op: 'move', from: at, to_group_key: row.group_key, index: to }], {
      label: `Move ${label}`
    })
  const btn =
    'rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-700 dark:hover:text-slate-200'
  const arrows = (
    <>
      <button
        type='button'
        className={btn}
        aria-label={`Move ${label} left`}
        disabled={index === 0}
        onClick={() => move(index - 1)}
      >
        <ChevronLeft className='h-3 w-3' />
      </button>
      <button
        type='button'
        className={btn}
        aria-label={`Move ${label} right`}
        disabled={index === count - 1}
        onClick={() => move(index + 1)}
      >
        <ChevronRight className='h-3 w-3' />
      </button>
    </>
  )
  return { label, arrows }
}

function useIsSelected(row: PlacementRow) {
  const sel = useLayoutDesign()?.selected
  return (
    !!sel &&
    targetKey(sel) === targetKey({ kind: 'field', field: row.field, group_key: row.group_key })
  )
}

// Reorder controls float over the cell's right edge only while it is hovered,
// focused or selected: the header stays one row, like the real grid.
const REVEAL = 'hidden group-hover:flex group-focus-within:flex'

function HeaderCell({
  row,
  index,
  count,
  apply
}: {
  row: PlacementRow
  index: number
  count: number
  apply: Apply
}) {
  const { label, arrows } = useCellActions(row, index, count, apply)
  const selected = useIsSelected(row)
  return (
    <DesignNode asChild target={{ kind: 'field', field: row.field, group_key: row.group_key }}>
      <th
        data-table-cell={row.field}
        className={cn(
          'group px-3 py-2 text-left font-medium text-slate-500 text-[11px] dark:text-slate-400',
          !row.is_visible && 'opacity-50'
        )}
      >
        <span className='block truncate'>{label}</span>
        <span
          data-design-pass=''
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 items-center gap-0.5 rounded bg-slate-50 dark:bg-slate-800',
            selected ? 'flex' : REVEAL
          )}
        >
          {arrows}
        </span>
      </th>
    </DesignNode>
  )
}

function Chip({
  row,
  index,
  count,
  apply
}: {
  row: PlacementRow
  index: number
  count: number
  apply: Apply
}) {
  const { label, arrows } = useCellActions(row, index, count, apply)
  const selected = useIsSelected(row)
  return (
    <DesignNode asChild target={{ kind: 'field', field: row.field, group_key: row.group_key }}>
      <div
        data-table-cell={row.field}
        className={cn(
          'group flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-500 dark:border-border dark:bg-card dark:text-slate-400',
          !row.is_visible && 'opacity-50'
        )}
      >
        <span className='truncate'>{label}</span>
        <span
          data-design-pass=''
          className={cn('items-center gap-0.5', selected ? 'flex' : REVEAL)}
        >
          {arrows}
        </span>
      </div>
    </DesignNode>
  )
}

// Add a field to this zone: the collection's fields not already in it.
function AddField({
  zone,
  title,
  taken,
  fields,
  apply,
  size
}: {
  zone: string | null
  title: string
  taken: Set<string>
  fields: TableFieldChoice[]
  apply: Apply
  size: number
}) {
  const [open, setOpen] = useState(false)
  const choices = fields
    .filter((f) => f.field && !f.field.startsWith('__') && !taken.has(f.field))
    .map((f) => ({ field: f.field, title: f.label || titleCase(f.field) }))
    .sort((a, b) => a.title.localeCompare(b.title))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`Add field to ${title}`}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 text-[12px] font-medium text-slate-500 hover:border-nvr-cyan hover:text-slate-800 dark:border-slate-600 dark:text-slate-400 dark:hover:text-slate-200'
        >
          <Plus className='h-3 w-3' />
          Add field
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-0'>
        <Command>
          <CommandInput placeholder='Find a field' />
          <CommandList>
            <CommandEmpty>No fields left to add.</CommandEmpty>
            {choices.map((c) => (
              <CommandItem
                key={c.field}
                value={`${c.title} ${c.field}`}
                onSelect={() => {
                  setOpen(false)
                  apply([{ op: 'place', field: c.field, group_key: zone, index: size }], {
                    label: `Add ${c.title}`
                  })
                }}
              >
                {c.title}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function Zone({
  title,
  hint,
  rows,
  zone,
  apply,
  columns,
  fields,
  showHidden
}: {
  title: string
  hint: string
  rows: PlacementRow[]
  zone: string | null
  apply: Apply
  columns: boolean
  fields: TableFieldChoice[]
  showHidden: boolean
}) {
  const shown = rows.filter((r) => r.is_visible || showHidden)
  return (
    <section
      data-table-zone={zone ?? 'columns'}
      className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
    >
      <div className='border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-slate-800/40'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>{title}</h3>
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>{hint}</p>
      </div>
      <div className='relative' data-table-body={zone ?? 'columns'}>
        {/* The zone body is one drop target: an empty zone takes a dragged field here. */}
        <DesignDropBody groupKey={zone ?? UNGROUPED_KEY} />
        {shown.length === 0 ? (
          <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-slate-400'>
            No fields yet. Add one below, or drag one here.
          </p>
        ) : columns ? (
          <table className='w-full table-fixed' data-table-header=''>
            <thead className='border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-slate-800/40'>
              <tr>
                {shown.map((r) => (
                  <HeaderCell
                    key={r.field}
                    row={r}
                    index={rows.indexOf(r)}
                    count={rows.length}
                    apply={apply}
                  />
                ))}
              </tr>
            </thead>
          </table>
        ) : (
          <div className='flex flex-wrap gap-1.5 p-2'>
            {shown.map((r) => (
              <Chip
                key={r.field}
                row={r}
                index={rows.indexOf(r)}
                count={rows.length}
                apply={apply}
              />
            ))}
          </div>
        )}
      </div>
      <div className='border-t border-slate-200 px-2 py-1.5 dark:border-border'>
        <AddField
          zone={zone}
          title={title}
          taken={new Set(rows.map((r) => r.field))}
          fields={fields}
          apply={apply}
          size={rows.length}
        />
      </div>
    </section>
  )
}

export function TableColumnsCanvas({
  bundle,
  apply,
  collection,
  fields = []
}: TableColumnsCanvasProps) {
  const showHidden = useLayoutDesign()?.showHidden ?? false
  return (
    <div className='flex flex-col gap-4 p-4' data-table-canvas={collection}>
      <Zone
        title='Columns'
        hint='The columns of the grid, left to right. The grid gives them equal width.'
        rows={zoneRows(bundle, null)}
        zone={null}
        apply={apply}
        columns
        fields={fields}
        showHidden={showHidden}
      />
      <Zone
        title='Apply values'
        hint='Fields in the "apply to all rows" form.'
        rows={zoneRows(bundle, APPLY_ZONE)}
        zone={APPLY_ZONE}
        apply={apply}
        columns={false}
        fields={fields}
        showHidden={showHidden}
      />
      <Zone
        title='Create with defaults'
        hint='Fields in the "with defaults" form when adding several rows.'
        rows={zoneRows(bundle, DEFAULTS_ZONE)}
        zone={DEFAULTS_ZONE}
        apply={apply}
        columns={false}
        fields={fields}
        showHidden={showHidden}
      />
    </div>
  )
}
