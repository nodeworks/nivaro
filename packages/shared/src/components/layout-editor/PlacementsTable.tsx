import type { MouseEvent } from 'react'
import { useMemo } from 'react'
import {
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../lib/layout-ops'
import { cn } from '../../lib/utils'
import { Checkbox } from '../ui/checkbox'
import { SimpleSelect } from '../ui/SimpleSelect'
import { type DesignTarget, type SelectOptions, targetKey } from './design-context'
import {
  type FlagKey,
  fieldZones,
  flagOn,
  flagOps,
  GRID_WIDTHS,
  isFieldRow,
  keyOf,
  moveToZoneOps,
  targetOfKey,
  WIDTH_LABELS,
  widthOf,
  widthOps,
  zoneItems
} from './field-zones'
import { useFocusBuffer } from './focus-buffer'
import { useCollectionMeta } from './inspector/field-context'
import { describeField, readOverrides, withOverride } from './inspector/model'
import { slotName } from './slot-names'
import type { ApplyOptions } from './useLayoutDraft'

// The placements table (#2602): every field on the form as a row — label,
// section, width, required, read-only, hidden — edited in place, each change
// one op through the draft. Rows select like the canvas (Shift / ⌘-click for
// several) so the inspector's bulk panel edits many at once.

export interface PlacementsTableProps {
  bundle: LayoutBundle
  collection: string
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  flush: () => void
  selection: DesignTarget[]
  onSelect: (t: DesignTarget, opts?: SelectOptions) => void
  onSelection: (next: DesignTarget[]) => void
}

const cellInput =
  'h-7 w-full min-w-[120px] rounded-md border border-transparent bg-transparent px-2 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 hover:border-slate-200 focus:border-nvr-cyan focus:bg-white dark:text-foreground dark:placeholder:text-muted-foreground dark:hover:border-border dark:focus:bg-background'
const cellSelect =
  'h-7 w-full gap-1 rounded-md border-transparent bg-transparent px-2 text-[12.5px] shadow-none hover:border-slate-200 focus:ring-0 focus:ring-offset-0 dark:hover:border-border'
const check =
  'h-4 w-4 rounded border-slate-300 data-[state=checked]:border-nvr-cyan data-[state=checked]:bg-nvr-cyan data-[state=checked]:text-white dark:border-slate-600 [&_svg]:h-3 [&_svg]:w-3'
const th =
  'sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-2 py-2 text-left text-[11.5px] font-semibold text-slate-600 dark:border-border dark:bg-card dark:text-muted-foreground'

const zoneOption = (key: string | null) => key ?? UNGROUPED_KEY

const FLAG_COLS: Array<{ k: FlagKey; label: string; on: string; off: string }> = [
  { k: 'required', label: 'Required', on: 'Make {n} required', off: 'Make {n} optional' },
  { k: 'readonly', label: 'Read-only', on: 'Make {n} read-only', off: 'Make {n} editable' },
  { k: 'hidden', label: 'Hidden', on: 'Hide {n}', off: 'Show {n}' }
]

function LabelCell({
  row,
  placeholder,
  name,
  apply,
  flush
}: {
  row: PlacementRow
  placeholder: string
  name: string
  apply: PlacementsTableProps['apply']
  flush: () => void
}) {
  const ov = readOverrides(row)
  const stored = typeof ov.label === 'string' ? ov.label : ''
  const buf = useFocusBuffer(stored, flush)
  return (
    <input
      aria-label={`Label of ${name}`}
      value={buf.value}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value
        buf.set(v)
        apply(
          [
            {
              op: 'update_placement',
              at: keyOf(row),
              patch: { overrides: withOverride(row, 'label', v === '' ? undefined : v) }
            }
          ],
          { label: `Rename ${name}`, text: true }
        )
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') flush()
      }}
      {...buf.props}
      className={cellInput}
    />
  )
}

export function PlacementsTable({
  bundle,
  collection,
  apply,
  flush,
  selection,
  onSelect,
  onSelection
}: PlacementsTableProps) {
  const { data: meta } = useCollectionMeta(collection)
  const zones = useMemo(() => fieldZones(bundle), [bundle])
  const selected = useMemo(() => new Set(selection.map(targetKey)), [selection])
  const info = (row: PlacementRow) =>
    describeField(row.field, meta?.fields ?? [], meta?.relations ?? [], null)
  const zoneOptions = zones.map((z) => ({ value: zoneOption(z.key), label: z.label }))
  const widthOptions = GRID_WIDTHS.map((w) => ({ value: String(w), label: WIDTH_LABELS[w] }))
  const total = zones.reduce((n, z) => n + zoneItems(bundle, z.key).length, 0)

  const rowClick = (e: MouseEvent, t: DesignTarget) => {
    // Clicks on the cell controls edit; anywhere else on the row selects.
    if ((e.target as Element).closest('input, button, [role="combobox"], [role="checkbox"]')) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) onSelect(t, { additive: true })
    else onSelect(t)
  }

  return (
    <div data-placements-table='' className='flex min-h-full flex-col p-4'>
      <p className='mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
        {total} {total === 1 ? 'item' : 'items'} on this form. Shift- or ⌘-click rows to select
        several; the panel on the right changes them together.
        {bundle.layout.parent_layout_id != null &&
          ' Fields that come from the parent form are not listed.'}
      </p>
      <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <table className='w-full border-collapse text-[12.5px]'>
          <thead>
            <tr>
              <th className={cn(th, 'w-8')}>
                <span className='sr-only'>Selected</span>
              </th>
              <th className={th}>Field</th>
              <th className={th}>Label on this form</th>
              <th className={th}>Section</th>
              <th className={cn(th, 'w-[92px]')}>Width</th>
              {FLAG_COLS.map((c) => (
                <th key={c.k} className={cn(th, 'w-[76px] text-center')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {zones.map((z) => {
            const items = zoneItems(bundle, z.key)
            if (items.length === 0) return null
            return (
              <tbody key={zoneOption(z.key)} data-table-zone={zoneOption(z.key)}>
                <tr>
                  <td
                    colSpan={5 + FLAG_COLS.length}
                    className='border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-[12px] font-semibold text-slate-700 dark:border-border/60 dark:bg-muted/40 dark:text-foreground'
                  >
                    {z.label}
                    <span className='ml-1.5 font-normal text-slate-400 dark:text-muted-foreground'>
                      {items.length}
                    </span>
                  </td>
                </tr>
                {items.map((row) => {
                  const t = targetOfKey(keyOf(row))
                  const on = selected.has(targetKey(t))
                  const fi = info(row)
                  const field = isFieldRow(row)
                  const name = field
                    ? describeField(row.field, meta?.fields ?? [], meta?.relations ?? [], row).label
                    : (row.label_override ?? slotName(row.field))
                  return (
                    <tr
                      key={targetKey(t)}
                      data-table-row={targetKey(t)}
                      aria-selected={on}
                      onClick={(e) => rowClick(e, t)}
                      className={cn(
                        'cursor-pointer border-b border-slate-100 last:border-0 dark:border-border/60',
                        on ? 'bg-accent' : 'hover:bg-muted'
                      )}
                    >
                      <td className='px-2 py-1'>
                        <Checkbox
                          checked={on}
                          aria-label={`Select ${name}`}
                          onCheckedChange={() => onSelect(t, { additive: true })}
                          className={check}
                        />
                      </td>
                      <td className='max-w-[220px] px-2 py-1'>
                        <span className='block truncate font-medium text-slate-800 dark:text-foreground'>
                          {name}
                        </span>
                        <span className='block truncate font-mono text-[11px] text-slate-400 dark:text-muted-foreground'>
                          {row.field}
                        </span>
                      </td>
                      <td className='px-1 py-1'>
                        {field ? (
                          <LabelCell
                            row={row}
                            name={name}
                            placeholder={fi.label}
                            apply={apply}
                            flush={flush}
                          />
                        ) : (
                          <span className='px-2 text-slate-400'>—</span>
                        )}
                      </td>
                      <td className='min-w-[150px] px-1 py-1'>
                        <SimpleSelect
                          ariaLabel={`Section of ${name}`}
                          value={zoneOption(row.group_key)}
                          options={zoneOptions}
                          className={cellSelect}
                          onChange={(v) => {
                            const to = v === UNGROUPED_KEY ? null : v
                            const plan = moveToZoneOps(bundle, [row], to)
                            if (!plan.ops.length) return
                            apply(plan.ops, {
                              label: `Move ${name} to ${zones.find((x) => x.key === to)?.label}`
                            })
                            if (on)
                              onSelection(
                                selection.map((s) =>
                                  targetKey(s) === targetKey(t) ? targetOfKey(plan.moved[0]) : s
                                )
                              )
                          }}
                        />
                      </td>
                      <td className='px-1 py-1'>
                        <SimpleSelect
                          ariaLabel={`Width of ${name}`}
                          value={String(widthOf(row))}
                          options={widthOptions}
                          className={cellSelect}
                          onChange={(v) =>
                            apply(widthOps([row], Number(v)), {
                              label: `Set the width of ${name} to ${WIDTH_LABELS[Number(v)]}`
                            })
                          }
                        />
                      </td>
                      {FLAG_COLS.map((c) => (
                        <td key={c.k} className='px-2 py-1 text-center'>
                          {field || c.k === 'hidden' ? (
                            <Checkbox
                              checked={flagOn(row, c.k)}
                              aria-label={`${c.label}: ${name}`}
                              onCheckedChange={(v) =>
                                apply(flagOps([row], c.k, v === true), {
                                  label: (v === true ? c.on : c.off).replace('{n}', name)
                                })
                              }
                              className={check}
                            />
                          ) : (
                            <span className='text-slate-400'>—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            )
          })}
        </table>
      </div>
    </div>
  )
}
