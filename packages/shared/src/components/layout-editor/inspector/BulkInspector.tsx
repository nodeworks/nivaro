import { X } from 'lucide-react'
import { useMemo } from 'react'
import { type LayoutBundle, type LayoutOp, UNGROUPED_KEY } from '../../../lib/layout-ops'
import { TipLayer } from '../../TipLayer'
import { ArrangeButton } from '../ArrangeButton'
import { type DesignTarget, targetKey } from '../design-context'
import {
  type FlagKey,
  fieldZones,
  flagOn,
  flagOps,
  GRID_WIDTHS,
  inPageOrder,
  isFieldRow,
  keyOf,
  moveToZoneOps,
  plural,
  selectedPlacements,
  targetOfKey,
  WIDTH_LABELS,
  widthOf,
  widthOps
} from '../field-zones'
import { PanelBody, PanelHeader } from '../panel-frame'
import { effectText } from '../panel-style'
import { slotName } from '../slot-names'
import type { ApplyOptions } from '../useLayoutDraft'
import { useCollectionMeta } from './field-context'
import { Choice, Segmented, Setting, Toggle } from './kit'
import { describeField } from './model'

// Several fields selected on the canvas (Shift / ⌘-click) or in the
// placements table (#2583): the settings they share, each change one apply
// — one undo step for all of them.

export interface BulkInspectorProps {
  bundle: LayoutBundle
  selection: DesignTarget[]
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  collection: string
  /** Replace the selection (after a move the fields have new keys; × takes one out). */
  onSelection: (next: DesignTarget[]) => void
}

const FLAGS: Array<{ k: FlagKey; label: string; on: string; off: string; effect: string }> = [
  {
    k: 'required',
    label: 'Required',
    on: 'Make {n} required',
    off: 'Make {n} optional',
    effect: 'The form will not save without a value.'
  },
  {
    k: 'readonly',
    label: 'Read-only',
    on: 'Make {n} read-only',
    off: 'Make {n} editable',
    effect: 'Shown but not editable on this form.'
  },
  {
    k: 'hidden',
    label: 'Hidden',
    on: 'Hide {n}',
    off: 'Show {n}',
    effect: 'Leaves them off this form; their values are kept.'
  }
]

export function BulkInspector({
  bundle,
  selection,
  apply,
  collection,
  onSelection
}: BulkInspectorProps) {
  const { data: meta } = useCollectionMeta(collection)
  const rows = useMemo(
    () => inPageOrder(bundle, selectedPlacements(bundle, selection)),
    [bundle, selection]
  )
  const zones = useMemo(() => fieldZones(bundle), [bundle])
  const nameOf = (field: string) =>
    field.startsWith('__')
      ? slotName(field)
      : describeField(
          field,
          meta?.fields ?? [],
          meta?.relations ?? [],
          rows.find((r) => r.field === field) ?? null
        ).label
  const fields = rows.filter(isFieldRow)
  const outside = selection.length - rows.length
  const count = plural(rows.length, 'item')
  const widths = new Set(rows.map(widthOf))
  const width = widths.size === 1 ? String([...widths][0]) : ''
  const zoneKeys = new Set(rows.map((r) => r.group_key))
  const zoneValue = zoneKeys.size === 1 ? zoneOption([...zoneKeys][0] ?? null) : ''

  const run = (ops: LayoutOp[], label: string) => {
    if (ops.length) apply(ops, { label })
  }

  return (
    <div
      data-inspector=''
      data-bulk-inspector=''
      className='flex h-full min-h-0 min-w-0 flex-col text-[12px]'
    >
      <TipLayer />
      <PanelHeader
        eyebrow='Several selected'
        title={`${count} selected`}
        sub='Shift- or ⌘-click to add or take out'
      />
      <PanelBody>
        <ul className='flex flex-wrap gap-1.5' aria-label='Selected'>
          {rows.map((r) => (
            <li
              key={`${r.field}:${r.group_key ?? ''}`}
              className='inline-flex max-w-full items-center gap-1 rounded-full bg-nvr-cyan/10 py-0.5 pl-2.5 pr-1 text-[12px] font-medium text-slate-800 dark:text-foreground'
            >
              <span className='truncate'>{nameOf(r.field)}</span>
              <button
                type='button'
                aria-label={`Take ${nameOf(r.field)} out of the selection`}
                onClick={() => {
                  const k = targetKey(targetOfKey(keyOf(r)))
                  onSelection(selection.filter((t) => targetKey(t) !== k))
                }}
                className='inline-flex h-4 w-4 items-center justify-center rounded-full text-slate-500 hover:bg-nvr-cyan/20 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
              >
                <X className='h-3 w-3' />
              </button>
            </li>
          ))}
        </ul>
        <ArrangeButton targets={selection} />
        {outside > 0 && (
          <p className={effectText}>
            {plural(outside, 'item')} from the parent form {outside === 1 ? 'is' : 'are'} left out:
            override {outside === 1 ? 'it' : 'them'} on this form first.
          </p>
        )}

        {rows.length > 0 && (
          <>
            <Setting k='bulk.col_span' label='Width' effect='Share of the row each one takes.'>
              <Segmented
                value={width}
                options={GRID_WIDTHS.map((w) => ({ value: String(w), label: WIDTH_LABELS[w] }))}
                onChange={(v) =>
                  run(
                    widthOps(rows, Number(v)),
                    `Set the width of ${count} to ${WIDTH_LABELS[Number(v)]}`
                  )
                }
              />
            </Setting>
            {FLAGS.map((f) => {
              const subject = f.k === 'hidden' ? rows : fields
              if (subject.length === 0) return null
              const on = subject.filter((r) => flagOn(r, f.k)).length
              const n = plural(subject.length, f.k === 'hidden' ? 'item' : 'field')
              return (
                <Toggle
                  key={f.k}
                  k={`bulk.${f.k}`}
                  label={f.label}
                  effect={
                    on > 0 && on < subject.length
                      ? `${on} of ${subject.length} now. ${f.effect}`
                      : f.effect
                  }
                  checked={on === subject.length}
                  onChange={(v) =>
                    run(flagOps(subject, f.k, v), (v ? f.on : f.off).replace('{n}', n))
                  }
                />
              )
            })}
            <Setting
              k='bulk.move'
              label='Section'
              effect='Moves them to the end of that section, in the order they are on the form.'
            >
              <Choice
                ariaLabel='Move to section'
                value={zoneValue}
                options={[
                  ...(zoneValue ? [] : [{ value: '', label: 'Several sections' }]),
                  ...zones.map((z) => ({ value: zoneOption(z.key), label: z.label }))
                ]}
                onChange={(v) => {
                  if (!v) return
                  const to = v === UNGROUPED_OPTION ? null : v
                  const zone = zones.find((z) => z.key === to)
                  const plan = moveToZoneOps(bundle, rows, to)
                  if (!plan.ops.length) return
                  apply(plan.ops, { label: `Move ${count} to ${zone?.label ?? 'another section'}` })
                  onSelection(plan.moved.map(targetOfKey))
                }}
              />
            </Setting>
          </>
        )}
        <button
          type='button'
          onClick={() => onSelection([])}
          className='text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
        >
          Clear the selection
        </button>
      </PanelBody>
    </div>
  )
}

// SimpleSelect keeps '' for "nothing chosen": the Ungrouped zone needs its own value.
const UNGROUPED_OPTION = UNGROUPED_KEY
const zoneOption = (key: string | null) => key ?? UNGROUPED_OPTION
