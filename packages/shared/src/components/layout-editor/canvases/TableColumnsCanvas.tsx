import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react'
import {
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { DesignNode } from '../DesignNode'
import { useLayoutDesign } from '../design-context'

// A table layout drawn the way InlineTableField shows it: one header cell per
// column at its width, in order. Apply Values and Create with Defaults are the
// two extra forms of that table, shown as strips under it. Drag reorders (the
// same field targets the form canvas uses, zone = group_key); the arrow and
// width buttons are the keyboard route to the same ops.

export const APPLY_ZONE = '__apply_values__'
export const DEFAULTS_ZONE = '__create_with_defaults__'
const MIN_SPAN = 1
const MAX_SPAN = 12

type Apply = (ops: LayoutOp[], opts?: { label: string }) => void

export interface TableColumnsCanvasProps {
  bundle: LayoutBundle
  apply: Apply
  collection: string
}

const labelOf = (p: PlacementRow) => p.label_override ?? titleCase(p.field)

function zoneRows(bundle: LayoutBundle, zone: string | null): PlacementRow[] {
  return bundle.placements
    .filter((p) => p.group_key === zone && !isCanvasSlot(p) && !p.field.startsWith('__'))
    .sort((a, b) => a.sort - b.sort)
}

function Cell({
  row,
  index,
  count,
  apply,
  wide
}: {
  row: PlacementRow
  index: number
  count: number
  apply: Apply
  wide: boolean
}) {
  const label = labelOf(row)
  const span = row.col_span ?? MAX_SPAN
  const at = { field: row.field, group_key: row.group_key }
  const move = (to: number) =>
    apply([{ op: 'move', from: at, to_group_key: row.group_key, index: to }], {
      label: `Move ${label}`
    })
  const resize = (next: number) =>
    apply([{ op: 'update_placement', at, patch: { col_span: next } }], {
      label: `Resize ${label}`
    })
  const btn =
    'rounded p-0.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-700 dark:hover:text-slate-200'
  return (
    <DesignNode asChild target={{ kind: 'field', field: row.field, group_key: row.group_key }}>
      <div
        data-table-cell={row.field}
        style={wide ? { flex: `${span} 1 0`, minWidth: 0 } : undefined}
        className={`flex flex-col gap-1 whitespace-nowrap border-r border-slate-200 px-2.5 py-1.5 last:border-r-0 dark:border-border ${
          row.is_visible ? '' : 'opacity-50'
        }`}
      >
        <span className='truncate text-[11px] font-medium text-slate-500 dark:text-slate-400'>
          {label}
        </span>
        <span className='flex items-center gap-0.5' data-design-pass=''>
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
          {wide && (
            <>
              <button
                type='button'
                className={btn}
                aria-label={`Make ${label} narrower`}
                disabled={span <= MIN_SPAN}
                onClick={() => resize(span - 1)}
              >
                <Minus className='h-3 w-3' />
              </button>
              <span className='px-0.5 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'>
                {span}/12
              </span>
              <button
                type='button'
                className={btn}
                aria-label={`Make ${label} wider`}
                disabled={span >= MAX_SPAN}
                onClick={() => resize(span + 1)}
              >
                <Plus className='h-3 w-3' />
              </button>
            </>
          )}
        </span>
      </div>
    </DesignNode>
  )
}

function Zone({
  title,
  hint,
  rows,
  zone,
  apply,
  wide,
  showHidden
}: {
  title: string
  hint: string
  rows: PlacementRow[]
  zone: string | null
  apply: Apply
  wide: boolean
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
      {shown.length === 0 ? (
        <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-slate-400'>
          No fields yet. Add fields from the Add panel.
        </p>
      ) : (
        <div
          className={`flex ${wide ? 'bg-slate-50 dark:bg-slate-800/40' : 'flex-wrap gap-px'}`}
          data-table-header={wide ? '' : undefined}
        >
          {shown.map((r) => (
            <Cell
              key={r.field}
              row={r}
              index={rows.indexOf(r)}
              count={rows.length}
              apply={apply}
              wide={wide}
            />
          ))}
        </div>
      )}
    </section>
  )
}

export function TableColumnsCanvas({ bundle, apply, collection }: TableColumnsCanvasProps) {
  const showHidden = useLayoutDesign()?.showHidden ?? false
  return (
    <div className='flex flex-col gap-4 p-4' data-table-canvas={collection}>
      <Zone
        title='Columns'
        hint='The columns of the grid, left to right, at their width.'
        rows={zoneRows(bundle, null)}
        zone={null}
        apply={apply}
        wide
        showHidden={showHidden}
      />
      <Zone
        title='Apply values'
        hint='Fields in the "apply to all rows" form.'
        rows={zoneRows(bundle, APPLY_ZONE)}
        zone={APPLY_ZONE}
        apply={apply}
        wide={false}
        showHidden={showHidden}
      />
      <Zone
        title='Create with defaults'
        hint='Fields in the "with defaults" form when adding several rows.'
        rows={zoneRows(bundle, DEFAULTS_ZONE)}
        zone={DEFAULTS_ZONE}
        apply={apply}
        wide={false}
        showHidden={showHidden}
      />
    </div>
  )
}
