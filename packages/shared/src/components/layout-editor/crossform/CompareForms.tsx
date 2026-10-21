import { ArrowLeft, ArrowLeftRight, ChevronDown, ChevronRight } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Skeleton } from '../../ui/skeleton'
import { bundleToActiveLayout } from '../bundle-to-active'
import { type DesignTarget, type LayoutDesign, targetKey } from '../design-context'
import { NO_DND } from '../dnd/node'
import { EditorCanvas } from '../EditorCanvas'
import { btnOutline } from '../overview/OverviewActions'
import { useOverviewFields } from '../overview/overview-api'
import type { OverviewRow } from '../overview/types'
import { useLayoutBundle } from '../useLayoutDraft'
import {
  type CompareEntry,
  type CompareSide,
  compareCounts,
  compareLayouts,
  compareMarksFor,
  effectivePlacements
} from './crossform-model'

// Two different forms side by side (#2659), read-only: each drawn by the
// renderer its type uses, with "Only here" on what the other form lacks and
// "Differs" on fields set up differently. Clicking a field selects it on both.

const noop = () => {}

function useSide(id: number | null): { side: CompareSide | null; loading: boolean } {
  const { data: bundle, isLoading } = useLayoutBundle(id)
  const parentId =
    bundle?.layout.parent_layout_id != null ? Number(bundle.layout.parent_layout_id) : null
  const { data: parent = null, isLoading: parentLoading } = useLayoutBundle(parentId)
  return {
    side: bundle && (parentId == null || parent) ? { bundle, parent } : null,
    loading: isLoading || (parentId != null && parentLoading)
  }
}

function targetFor(side: CompareSide, field: string | null): DesignTarget | null {
  if (!field) return null
  const p = effectivePlacements(side).get(field)?.p
  if (!p) return null
  return { kind: field.startsWith('__') ? 'slot' : 'field', field, group_key: p.group_key }
}

function ComparePane({
  collection,
  side,
  other,
  which,
  entries,
  selectedField,
  onSelectField
}: {
  collection: string
  side: CompareSide
  other: CompareSide
  which: 'a' | 'b'
  entries: CompareEntry[]
  selectedField: string | null
  onSelectField: (field: string | null) => void
}) {
  const canvas = useMemo(() => bundleToActiveLayout(side.bundle, side.parent), [side])
  const marks = useMemo(
    () => compareMarksFor(which, entries, side, other),
    [which, entries, side, other]
  )
  const selected = useMemo(() => targetFor(side, selectedField), [side, selectedField])
  const onSelect = useCallback(
    (t: DesignTarget) => {
      if (t.kind === 'group') return onSelectField(null)
      onSelectField(t.field === selectedField ? null : t.field)
    },
    [onSelectField, selectedField]
  )
  const design = useMemo<LayoutDesign>(
    () => ({
      selected,
      selection: selected ? [selected] : [],
      onSelect,
      showHidden: true,
      inheritedFrom: (t) => canvas.inherited.get(targetKey(t)) ?? null,
      dnd: NO_DND,
      marks
    }),
    [selected, onSelect, canvas.inherited, marks]
  )
  return (
    <EditorCanvas
      collection={collection}
      bundle={side.bundle}
      layout={canvas.active}
      record={null}
      design={design}
      apply={noop}
    />
  )
}

function Summary({
  entries,
  nameA,
  nameB
}: {
  entries: CompareEntry[]
  nameA: string
  nameB: string
}) {
  const [open, setOpen] = useState(false)
  const c = compareCounts(entries)
  const changed = entries.filter((e) => e.status !== 'same')
  const chip = (n: number, text: string, cls: string) =>
    n > 0 && (
      <span
        className={cn('inline-flex h-6 items-center rounded px-2 text-[12px] font-medium', cls)}
      >
        {n} {text}
      </span>
    )
  return (
    <div className='shrink-0 border-b border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-1.5 px-4 py-2'>
        {chip(
          c.same,
          'the same',
          'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground'
        )}
        {chip(
          c.differs,
          'set up differently',
          'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200'
        )}
        {chip(
          c.only_a,
          `only on ${nameA}`,
          'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200'
        )}
        {chip(
          c.only_b,
          `only on ${nameB}`,
          'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200'
        )}
        {changed.length === 0 && (
          <span className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            The two forms place the same fields the same way.
          </span>
        )}
        {changed.length > 0 && (
          <button
            type='button'
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className='ml-auto inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-slate-600 hover:bg-muted dark:text-muted-foreground'
          >
            {open ? (
              <ChevronDown className='h-3.5 w-3.5' />
            ) : (
              <ChevronRight className='h-3.5 w-3.5' />
            )}
            {open ? 'Hide the list' : 'List the differences'}
          </button>
        )}
      </div>
      {open && (
        <div className='max-h-[240px] overflow-y-auto border-t border-slate-100 dark:border-border/60'>
          <table className='w-full border-collapse text-[12.5px]'>
            <thead>
              <tr className='text-left text-[12px] text-slate-500 dark:text-muted-foreground'>
                <th className='px-4 py-1.5 font-medium'>Field</th>
                <th className='px-4 py-1.5 font-medium'>
                  {nameA} → {nameB}
                </th>
              </tr>
            </thead>
            <tbody>
              {changed.map((e) => (
                <tr
                  key={e.field}
                  data-compare-row={e.status}
                  className='border-t border-slate-100 dark:border-border/60'
                >
                  <td className='px-4 py-1.5 align-top'>
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {e.label}
                    </span>{' '}
                    <span className='font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      {e.field}
                    </span>
                  </td>
                  <td className='px-4 py-1.5 text-slate-600 dark:text-muted-foreground'>
                    {e.status === 'only_a'
                      ? `Only on ${nameA}`
                      : e.status === 'only_b'
                        ? `Only on ${nameB}`
                        : e.diffs.join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export function CompareForms({
  collection,
  rows,
  aId,
  bId,
  onChange,
  onOpen,
  onClose
}: {
  collection: string
  /** The overview's rows: the forms either side can switch to. */
  rows: OverviewRow[]
  aId: number
  bId: number
  onChange: (a: number, b: number) => void
  onOpen: (id: number) => void
  onClose: () => void
}) {
  const a = useSide(aId)
  const b = useSide(bId)
  const { data: fields = [] } = useOverviewFields(collection)
  const fieldLabels = useMemo(
    () => new Map(fields.filter((f) => f.label).map((f) => [f.field, String(f.label)])),
    [fields]
  )
  const entries = useMemo(
    () => (a.side && b.side ? compareLayouts(a.side, b.side, fieldLabels) : []),
    [a.side, b.side, fieldLabels]
  )
  const [selectedField, setSelectedField] = useState<string | null>(null)
  const options = rows
    .filter((r) => r.layout_type !== 'table')
    .map((r) => ({ value: String(r.layout_id), label: r.name }))
  const nameOf = (id: number, bundle: LayoutBundle | undefined) =>
    rows.find((r) => r.layout_id === id)?.name ?? String(bundle?.layout.name ?? `Layout ${id}`)
  const nameA = nameOf(aId, a.side?.bundle)
  const nameB = nameOf(bId, b.side?.bundle)

  const pane = (which: 'a' | 'b') => {
    const mine = which === 'a' ? a : b
    const theirs = which === 'a' ? b : a
    const id = which === 'a' ? aId : bId
    return (
      <section
        data-compare-pane={which}
        className='flex min-h-0 min-w-0 flex-1 flex-col border-slate-200 first:border-r dark:border-border'
      >
        <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'>
          <SimpleSelect
            value={String(id)}
            onChange={(v) => (which === 'a' ? onChange(Number(v), bId) : onChange(aId, Number(v)))}
            ariaLabel={which === 'a' ? 'Left form' : 'Right form'}
            className='h-8 min-w-0 max-w-[280px] text-[12.5px] font-semibold'
            options={options}
          />
          <button type='button' className={cn(btnOutline, 'ml-auto')} onClick={() => onOpen(id)}>
            Open
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto bg-slate-50 p-3 dark:bg-background'>
          {mine.side && theirs.side ? (
            <ComparePane
              collection={collection}
              side={mine.side}
              other={theirs.side}
              which={which}
              entries={entries}
              selectedField={selectedField}
              onSelectField={setSelectedField}
            />
          ) : mine.loading || theirs.loading ? (
            <div className='space-y-2'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-16 w-full' />
              ))}
            </div>
          ) : (
            <p className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>
              This layout could not be read.
            </p>
          )}
        </div>
      </section>
    )
  }

  return (
    <div
      data-compare-forms=''
      className='flex min-h-0 flex-1 flex-col bg-slate-50 dark:bg-background'
    >
      <header className='flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <button
          type='button'
          aria-label='Back to all forms'
          data-tip='Back to all forms'
          onClick={onClose}
          className='inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
        >
          <ArrowLeft className='h-4 w-4' />
        </button>
        <div className='min-w-0 flex-1'>
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            Compare forms
          </h2>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Read only. Click a field to find it on both forms.
          </p>
        </div>
        <button
          type='button'
          className={btnOutline}
          onClick={() => onChange(bId, aId)}
          data-tip='Swap left and right'
        >
          <ArrowLeftRight className='h-3.5 w-3.5' />
          Swap
        </button>
      </header>
      {a.side && b.side && <Summary entries={entries} nameA={nameA} nameB={nameB} />}
      <div className='flex min-h-0 flex-1'>
        {pane('a')}
        {pane('b')}
      </div>
    </div>
  )
}

/** The pair Compare forms opens on: the first two forms people fill in, else the first two layouts. */
export function defaultComparePair(rows: OverviewRow[]): [number, number] | null {
  const forms = rows.filter((r) => r.layout_type === 'grouped')
  const pool = forms.length >= 2 ? forms : rows.filter((r) => r.layout_type !== 'table')
  return pool.length >= 2 ? [pool[0].layout_id, pool[1].layout_id] : null
}
