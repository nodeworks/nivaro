import { useQuery } from '@tanstack/react-query'
import { Check, CopyPlus, LayoutPanelTop, ListPlus, Plus, Search, Sigma, Undo2 } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import {
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type LayoutOp,
  type PlacementPatch,
  type PlacementRow
} from '../../lib/layout-ops'
import { listLayoutSlots } from '../../lib/layout-slots'
import { nextDisplayFormulaField } from '../../lib/placement-behaviour'
import { cn, titleCase } from '../../lib/utils'
import { fieldSpot, placeOp, sectionOp, slotSpot } from './add-target'
import { MeaningSuggestions } from './ai-forms/MeaningSuggestions'
import type { DesignTarget } from './design-context'
import type { AddSource } from './dnd/collision'
import { useAddDragSource } from './dnd/node'
import { parseFieldList, placeListPlan } from './field-list'
import { useFormFields } from './inspect/inspect-api'
import { textMatcher } from './nav/find'
import { useOverviewFields } from './overview/overview-api'
import { putBackPlan, type RemovedEntry } from './removed-log'
import { LibraryRows } from './reuse/LibraryRows'
import { slotName } from './slot-names'
import { fillText, useFieldFillRates } from './usage/usage-api'
import type { ApplyOptions } from './useLayoutDraft'

// "+ Add": everything that can go on the form — the collection's fields by
// label, a new section, panels (slot cards) and widgets. A click adds right
// after the selection (one op) and selects what it added; something already
// on the form is selected instead of added twice. Rows not on the form also
// drag onto the canvas (inside the editor's LayoutDndProvider): the drop is
// one `place` op where the line shows.

export interface AddFieldRow {
  field: string
  label?: string | null
  type?: string | null
  interface?: string | null
}

interface WidgetRow {
  id: number
  name: string
  widget_type: string
}

// The six slot cards (CANVAS_SLOT_KEYS), then owners, PDF and subtitle —
// everything the classic editor could add.
export const BUILT_IN_SLOTS = [
  '__pipeline__',
  '__comments__',
  '__tasks__',
  '__addendums__',
  '__referenced_by__',
  '__related_records__',
  '__owners__',
  '__pdf__',
  '__subtitle__'
] as const

export const SLOT_HINTS: Record<string, string> = {
  __pipeline__: 'State track and actions',
  __comments__: 'Notes and replies',
  __tasks__: 'To-dos on this record',
  __addendums__: 'Changes made to the saved record',
  __referenced_by__: 'Records that point at this one',
  __related_records__: 'Records linked to this one',
  __owners__: 'Who owns it at each step',
  __pdf__: 'Generate and download a PDF',
  __subtitle__: 'A line of values under the title'
}

// Widgets that list rows for this record need its id bound to work at all.
const RECORD_BOUND_WIDGETS = ['review_list', 'rollup']

function widgetPatch(w: WidgetRow): PlacementPatch {
  return {
    widget_id: w.id,
    input_bindings: RECORD_BOUND_WIDGETS.includes(w.widget_type)
      ? [{ key: 'record_id', binding_type: 'item_field', binding_value: 'id' }]
      : []
  }
}

export function typeWord(f: AddFieldRow): string {
  const ifc = f.interface ?? ''
  if (ifc.includes('o2m') || ifc === 'list-o2m' || ifc === 'inline-grid') return 'Grid'
  if (ifc.includes('m2m') || ifc.includes('m2a')) return 'Several records'
  if (ifc.includes('m2o')) return 'Record'
  switch (f.type) {
    case 'string':
    case 'uuid':
      return 'Text'
    case 'text':
      return 'Long text'
    case 'integer':
    case 'bigInteger':
    case 'decimal':
    case 'float':
      return 'Number'
    case 'boolean':
      return 'Yes / no'
    case 'date':
      return 'Date'
    case 'dateTime':
    case 'timestamp':
      return 'Date and time'
    case 'json':
      return 'Data'
    case 'alias':
      return 'Group'
    default:
      return f.type ? titleCase(f.type) : ''
  }
}

const searchCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white pl-7 pr-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const head = 'px-2 pb-1 pt-3 text-[11.5px] font-semibold text-slate-500 dark:text-muted-foreground'

function OnForm({ children }: { children: ReactNode }) {
  return (
    <span className='inline-flex shrink-0 items-center gap-0.5 text-[11px] font-medium text-[#0089ad] dark:text-nvr-cyan'>
      <Check className='h-3 w-3' />
      {children}
    </span>
  )
}

function Row({
  title,
  sub,
  aside,
  onClick,
  attrs,
  extra,
  drag: source = null
}: {
  title: string
  sub?: string | null
  aside?: ReactNode
  onClick: () => void
  attrs?: Record<string, string | undefined>
  /** A second action beside the row (buttons cannot nest). */
  extra?: ReactNode
  /** Drag this row onto the canvas to add it there; null: click only. */
  drag?: (AddSource & { to: 'form' | 'header' }) | null
}) {
  const drag = useAddDragSource(source)
  const main = (
    <button
      type='button'
      {...drag.props}
      onClick={() => {
        if (!drag.clickBlocked()) onClick()
      }}
      {...attrs}
      className={cn(
        'group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted',
        drag.dragging && 'opacity-40'
      )}
    >
      <span className='flex min-w-0 flex-1 flex-col'>
        <span className='truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
          {title}
        </span>
        {sub && (
          <span className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {sub}
          </span>
        )}
      </span>
      {aside}
    </button>
  )
  if (!extra) return main
  return (
    <div className='flex items-center gap-0.5'>
      {main}
      {extra}
    </div>
  )
}

export function AddPanel({
  bundle,
  collection,
  selected,
  apply,
  onSelect,
  removed = []
}: {
  bundle: LayoutBundle
  collection: string
  selected: DesignTarget | null
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  /** Select something on the canvas (what was just added, or what is already there). */
  onSelect(t: DesignTarget): void
  /** #3191: what this session took off the form and is still off it, newest first. */
  removed?: RemovedEntry[]
}) {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const [to, setTo] = useState<'form' | 'header'>('form')
  const { data: fields = [] } = useOverviewFields(collection)
  const { data: fill } = useFieldFillRates(collection)
  const { data: widgets = [], error: widgetsError } = useQuery<WidgetRow[]>({
    queryKey: ['layout-editor', 'widgets'],
    queryFn: () =>
      client.request<{ data: WidgetRow[] }>(get('/widgets-internal')).then((r) => r.data ?? []),
    staleTime: 60_000,
    retry: false
  })
  // "Add another copy" refused: which field, and why.
  const [notice, setNotice] = useState<{ field: string; text: string } | null>(null)
  // #3201: a pasted (or typed) list of field names, placed in order; null = closed.
  const [list, setList] = useState<string | null>(null)
  const [backNotice, setBackNotice] = useState<{ id: string; text: string } | null>(null)

  const matches = textMatcher(q)

  // Where each field / slot already sits (twins: body first, header last).
  const placed = useMemo(() => {
    const m = new Map<string, PlacementRow[]>()
    for (const p of bundle.placements) m.set(p.field, [...(m.get(p.field) ?? []), p])
    return m
  }, [bundle.placements])
  const inBody = (f: string) => (placed.get(f) ?? []).find((p) => p.group_key !== HEADER_GROUP_KEY)
  const inHeader = (f: string) =>
    (placed.get(f) ?? []).find((p) => p.group_key === HEADER_GROUP_KEY)

  const targetOf = (p: PlacementRow): DesignTarget =>
    p.group_key === HEADER_GROUP_KEY
      ? { kind: 'header', field: p.field }
      : {
          kind: p.field.startsWith('__') ? 'slot' : 'field',
          field: p.field,
          group_key: p.group_key
        }

  const place = (field: string, label: string, patch?: PlacementPatch) => {
    const spot =
      to === 'header'
        ? fieldSpot(bundle, selected, 'header')
        : isCanvasSlot({ field, group_key: null })
          ? slotSpot(bundle, selected)
          : field === '__subtitle__'
            ? { group_key: null, index: 0 }
            : fieldSpot(bundle, selected)
    apply([placeOp(field, spot, patch)], { label: `Add ${label}` })
    onSelect(targetOf({ field, group_key: spot.group_key } as PlacementRow))
  }

  // Dragged in from a row: select what landed, as a click does.
  const dragOf = (field: string, label: string, on: unknown, patch?: PlacementPatch) =>
    on
      ? null
      : {
          field,
          label,
          patch,
          to,
          onAdded: (ops: LayoutOp[]) => {
            const op = ops[0]
            if (op?.op === 'place')
              onSelect(targetOf({ field, group_key: op.group_key } as PlacementRow))
          }
        }

  const pick = (field: string, label: string, patch?: PlacementPatch) => {
    setNotice(null)
    const existing = to === 'header' ? inHeader(field) : inBody(field)
    if (existing) onSelect(targetOf(existing))
    else place(field, label, patch)
  }

  // A field may sit in more than one group: a second copy goes where a new
  // field would (after the selection), never twice in the same group.
  const addCopy = (field: string, label: string) => {
    const spot = fieldSpot(bundle, selected)
    if ((placed.get(field) ?? []).some((p) => p.group_key === spot.group_key)) {
      const where =
        spot.group_key === null
          ? 'Ungrouped'
          : (bundle.groups.find((g) => g.key === spot.group_key)?.label ?? spot.group_key)
      setNotice({
        field,
        text: `${label} is already in ${where}. Select another section first.`
      })
      return
    }
    setNotice(null)
    apply([placeOp(field, spot)], { label: `Add another ${label}` })
    onSelect(targetOf({ field, group_key: spot.group_key } as PlacementRow))
  }

  // #2638: fields this collection's other forms (of the same kind) place but
  // this one does not, by how many of them carry each.
  const { data: forms = [] } = useFormFields(collection)
  const suggested = useMemo(
    () => otherFormSuggestions(bundle, forms, fields as AddFieldRow[]),
    [bundle, forms, fields]
  )
  const suggestionRows = suggested.filter((f) => matches(f.title, f.field)).slice(0, 8)

  const fieldRows = (fields as AddFieldRow[])
    .filter((f) => f.field && !f.field.startsWith('__'))
    .map((f) => ({ ...f, title: f.label || titleCase(f.field) }))
    .filter((f) => matches(f.title, f.field))
    .sort((a, b) => a.title.localeCompare(b.title))

  const slots = [...BUILT_IN_SLOTS, ...listLayoutSlots().map((k) => `__ext_${k}__`)].filter((s) =>
    to === 'header' ? s === '__owners__' : true
  )
  const slotRows = slots.filter((s) => matches(slotName(s), SLOT_HINTS[s]))
  const widgetRows = widgets.filter((w) => matches(w.name, w.widget_type))
  const section = sectionOp(bundle, selected)
  const sectionLabel = section.op === 'group_create' ? section.label.replace(/^New /, '') : ''

  return (
    <div data-editor-add='' className='flex flex-col px-2 pb-4'>
      <div className='sticky top-0 z-10 flex flex-col gap-2 bg-white px-1 pb-1 pt-2 dark:bg-card'>
        <div className='relative'>
          <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPaste={(e) => {
              // A pasted list of names (lines or commas) opens the list placer instead.
              const text = e.clipboardData.getData('text/plain')
              if (/[\n\r,;\t]/.test(text) && parseFieldList(text).length > 1) {
                e.preventDefault()
                setList(text)
              }
            }}
            placeholder='Find a field, panel or widget'
            aria-label='Find something to add'
            className={searchCls}
          />
        </div>
        <div className='flex items-center gap-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
          <span className='mr-1'>Add to</span>
          {(['form', 'header'] as const).map((v) => (
            <button
              key={v}
              type='button'
              aria-pressed={to === v}
              onClick={() => setTo(v)}
              className={cn(
                'rounded-md px-2 py-0.5 font-medium transition-colors',
                to === v
                  ? 'bg-accent text-slate-900 dark:text-foreground'
                  : 'hover:bg-muted hover:text-slate-800 dark:hover:text-foreground'
              )}
            >
              {v === 'form' ? 'Form' : 'Header strip'}
            </button>
          ))}
        </div>
      </div>

      {removed.length > 0 && !q.trim() && (
        <>
          <p className={head}>Recently removed</p>
          {removed.slice(0, 8).map((e) => (
            <div key={e.id}>
              <Row
                title={
                  e.piece.kind === 'field'
                    ? ((fields as AddFieldRow[]).find(
                        (f) => e.piece.kind === 'field' && f.field === e.piece.field
                      )?.label ?? e.label)
                    : e.label
                }
                sub={`${e.where} · ${e.how}`}
                attrs={{ 'data-removed-entry': e.id }}
                aside={
                  <span className='inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-slate-500 group-hover:text-slate-800 dark:text-muted-foreground dark:group-hover:text-foreground'>
                    <Undo2 className='h-3.5 w-3.5' />
                    Put back
                  </span>
                }
                onClick={() => {
                  const plan = putBackPlan(bundle, e, selected)
                  if (!plan.ok) {
                    setBackNotice({ id: e.id, text: plan.reason })
                    return
                  }
                  setBackNotice(null)
                  apply(plan.ops, { label: plan.label })
                  if (plan.select) onSelect(plan.select)
                  if (plan.notes.length)
                    toast.success(plan.label, { description: plan.notes.join('. ') })
                }}
              />
              {backNotice?.id === e.id && (
                <p
                  role='status'
                  className='px-2 pb-1 text-[11.5px] text-amber-700 dark:text-amber-300'
                >
                  {backNotice.text}
                </p>
              )}
            </div>
          ))}
        </>
      )}

      {list !== null && (
        <ListPlacer
          bundle={bundle}
          text={list}
          onText={setList}
          fields={fields as AddFieldRow[]}
          selected={selected}
          to={to}
          onPlace={(ops, label, select) => {
            apply(ops, { label })
            if (select) onSelect(select)
            setList(null)
          }}
          onClose={() => setList(null)}
        />
      )}

      {to === 'form' && matches(sectionLabel, 'section', 'tab', 'step') && (
        <>
          <p className={head}>Layout</p>
          <Row
            title={sectionLabel.charAt(0).toUpperCase() + sectionLabel.slice(1)}
            sub={`A new ${sectionLabel.toLowerCase()} after the selection`}
            attrs={{ 'data-add-section': '' }}
            aside={<LayoutPanelTop className='h-3.5 w-3.5 text-slate-400' />}
            onClick={() => {
              apply([section], { label: `Add ${sectionLabel.toLowerCase()}` })
              if (section.op === 'group_create') onSelect({ kind: 'group', key: section.key })
            }}
          />
        </>
      )}
      {list === null && matches('Place a list of fields', 'paste names list several') && (
        <Row
          title='Place a list of fields'
          sub='Paste names or keys, one per line or with commas'
          attrs={{ 'data-add-list-open': '' }}
          aside={<ListPlus className='h-3.5 w-3.5 text-slate-400' />}
          onClick={() => setList('')}
        />
      )}
      {/* #2712: a read-only figure from the form's fields, worked out on the page. */}
      {to === 'form' &&
        !['table', 'file'].includes(String(bundle.layout.layout_type ?? 'grouped')) &&
        matches('Display formula', 'formula calculation remaining total') && (
          <Row
            title='Display formula'
            sub='A read-only figure worked out from fields on the form, never saved'
            attrs={{ 'data-add-formula': '' }}
            aside={<Sigma className='h-3.5 w-3.5 text-slate-400' />}
            onClick={() =>
              place(
                nextDisplayFormulaField(bundle.placements.map((p) => p.field)),
                'a display formula',
                {
                  overrides: { label: 'Formula', display_formula: { expr: '', format: '' } }
                }
              )
            }
          />
        )}

      {to === 'form' && !q.trim() && (
        <MeaningSuggestions bundle={bundle} collection={collection} apply={apply} />
      )}
      {to === 'form' && suggestionRows.length > 0 && (
        <>
          <p className={head}>On other forms</p>
          {suggestionRows.map((f) => (
            <Row
              key={f.field}
              title={f.title}
              sub={`On ${f.count} of ${f.of} other forms · ${f.names.join(', ')}`}
              attrs={{ 'data-add-suggested': f.field }}
              aside={
                <Plus className='h-3.5 w-3.5 shrink-0 text-slate-400 opacity-0 group-hover:opacity-100' />
              }
              onClick={() => pick(f.field, f.title)}
              drag={dragOf(f.field, f.title, null)}
            />
          ))}
        </>
      )}
      {to === 'form' && (
        <LibraryRows
          bundle={bundle}
          collection={collection}
          selected={selected}
          apply={apply}
          onSelect={onSelect}
          matches={matches}
        />
      )}

      <p className={head}>Fields</p>
      {fieldRows.map((f) => {
        const on = to === 'header' ? inHeader(f.field) : inBody(f.field)
        return (
          <div key={f.field}>
            <Row
              title={f.title}
              sub={[f.field, typeWord(f), fill ? fillText(fill.pct.get(f.field), fill.total) : null]
                .filter(Boolean)
                .join(' · ')}
              attrs={{ 'data-add-field': f.field, 'data-on-form': on ? 'true' : undefined }}
              aside={
                on ? (
                  <OnForm>{to === 'header' ? 'in header' : 'on this form'}</OnForm>
                ) : (
                  <Plus className='h-3.5 w-3.5 shrink-0 text-slate-400 opacity-0 group-hover:opacity-100' />
                )
              }
              onClick={() => pick(f.field, f.title)}
              drag={dragOf(f.field, f.title, on)}
              extra={
                on && to === 'form' ? (
                  <button
                    type='button'
                    aria-label={`Add another copy of ${f.title}`}
                    data-add-copy={f.field}
                    data-tip='Add another copy after the selection'
                    onClick={() => addCopy(f.field, f.title)}
                    className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'
                  >
                    <CopyPlus className='h-3.5 w-3.5' />
                  </button>
                ) : null
              }
            />
            {notice?.field === f.field && (
              <p
                role='status'
                data-add-notice=''
                className='px-2 pb-1 text-[11.5px] text-amber-700 dark:text-amber-300'
              >
                {notice.text}
              </p>
            )}
          </div>
        )
      })}
      {!fieldRows.length && (
        <p className='px-2 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No fields match.
        </p>
      )}

      {slotRows.length > 0 && <p className={head}>Panels</p>}
      {slotRows.map((s) => {
        const on = to === 'header' ? inHeader(s) : inBody(s)
        const patch: PlacementPatch | undefined =
          s === '__subtitle__'
            ? {
                input_bindings: [
                  {
                    key: '__subtitle_config__',
                    binding_type: 'static',
                    binding_value: JSON.stringify({ fields: [], separator: ' · ' })
                  }
                ]
              }
            : undefined
        return (
          <Row
            key={s}
            title={slotName(s)}
            sub={SLOT_HINTS[s] ?? 'Extension panel'}
            attrs={{ 'data-add-slot': s, 'data-on-form': on ? 'true' : undefined }}
            aside={on ? <OnForm>on this form</OnForm> : null}
            onClick={() => pick(s, slotName(s), patch)}
            drag={s === '__subtitle__' ? null : dragOf(s, slotName(s), on)}
          />
        )
      })}

      {to === 'form' && (widgetRows.length > 0 || widgetsError) && <p className={head}>Widgets</p>}
      {to === 'form' && widgetsError && (
        <p role='alert' className='px-2 py-1.5 text-[12px] text-red-700 dark:text-red-300'>
          Widgets could not be loaded: {(widgetsError as Error).message}
        </p>
      )}
      {to === 'form' &&
        widgetRows.map((w) => {
          const key = `__widget_${w.id}__`
          const on = inBody(key)
          return (
            <Row
              key={w.id}
              title={w.name}
              sub={titleCase(w.widget_type)}
              attrs={{ 'data-add-widget': String(w.id), 'data-on-form': on ? 'true' : undefined }}
              aside={on ? <OnForm>on this form</OnForm> : null}
              onClick={() => pick(key, w.name, widgetPatch(w))}
              drag={dragOf(key, w.name, on, widgetPatch(w))}
            />
          )
        })}
    </div>
  )
}

/** Fields placed on the collection's other layouts of this layout's kind but
 *  not on this one, most-carried first (ties by label). */
export function otherFormSuggestions(
  bundle: LayoutBundle,
  forms: Array<{ layout_id: number; name: string; layout_type: string; fields: string[] }>,
  fields: AddFieldRow[]
): Array<{ field: string; title: string; count: number; of: number; names: string[] }> {
  const type = String(bundle.layout.layout_type || 'grouped')
  const others = forms.filter(
    (f) => Number(f.layout_id) !== Number(bundle.layout.id) && f.layout_type === type
  )
  if (!others.length) return []
  const here = new Set(
    bundle.placements.filter((p) => p.group_key !== HEADER_GROUP_KEY).map((p) => p.field)
  )
  const known = new Map(fields.map((f) => [f.field, f]))
  const by = new Map<string, string[]>()
  for (const form of others)
    for (const field of form.fields)
      if (!here.has(field) && known.has(field)) by.set(field, [...(by.get(field) ?? []), form.name])
  return [...by.entries()]
    .map(([field, names]) => ({
      field,
      title: known.get(field)?.label || titleCase(field),
      count: names.length,
      of: others.length,
      names: names.slice(0, 3).concat(names.length > 3 ? [`${names.length - 3} more`] : [])
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
}

/** #3201: names pasted or typed, matched to fields, placed after the selection in order. */
function ListPlacer({
  bundle,
  text,
  onText,
  fields,
  selected,
  to,
  onPlace,
  onClose
}: {
  bundle: LayoutBundle
  text: string
  onText(t: string): void
  fields: AddFieldRow[]
  selected: DesignTarget | null
  to: 'form' | 'header'
  onPlace(ops: LayoutOp[], label: string, select?: DesignTarget): void
  onClose(): void
}) {
  const plan = useMemo(
    () => placeListPlan(bundle, text, fields, selected, to),
    [bundle, text, fields, selected, to]
  )
  const names = parseFieldList(text).length
  return (
    <div
      data-add-list=''
      className='mx-1 mt-2 rounded-lg border border-slate-200 bg-slate-50/60 p-2 dark:border-border dark:bg-muted/30'
    >
      <label className='block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'>
        Field names, keys or labels
        <textarea
          // biome-ignore lint/a11y/noAutofocus: opened on purpose to paste into
          autoFocus
          value={text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              onClose()
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && plan.ok) {
              e.preventDefault()
              onPlace(plan.ops, plan.label, plan.select)
            }
          }}
          rows={4}
          placeholder={'PO number\nVendor\nstatus, due_date'}
          className='mt-1 block w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1.5 font-normal text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
        />
      </label>
      {names > 0 && (
        <div role='status' className='mt-1.5 space-y-0.5 text-[11.5px] leading-snug'>
          <p className='m-0 text-slate-600 dark:text-muted-foreground'>
            {plan.placed.length} of {names} will be placed
            {plan.ok ? ` · ${plan.label.replace(/^Place \d+ fields? /, '')}` : ''}
          </p>
          {plan.unmatched.length > 0 && (
            <p className='m-0 text-amber-700 dark:text-amber-300' data-add-list-unmatched=''>
              No field matches: {plan.unmatched.join(', ')}
            </p>
          )}
          {plan.already.length > 0 && (
            <p className='m-0 text-slate-500 dark:text-muted-foreground'>
              Already there: {plan.already.join(', ')}
            </p>
          )}
          {!plan.ok && plan.placed.length === 0 && plan.unmatched.length === 0 && (
            <p className='m-0 text-slate-500 dark:text-muted-foreground'>{plan.reason}</p>
          )}
        </div>
      )}
      <div className='mt-2 flex items-center justify-end gap-1.5'>
        <button
          type='button'
          onClick={onClose}
          className='inline-flex h-7 items-center rounded-md px-2.5 text-[12px] font-medium text-slate-600 hover:bg-muted dark:text-muted-foreground dark:hover:text-foreground'
        >
          Cancel
        </button>
        <button
          type='button'
          data-add-list-place=''
          disabled={!plan.ok}
          onClick={() => plan.ok && onPlace(plan.ops, plan.label, plan.select)}
          className='inline-flex h-7 items-center rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40'
        >
          {plan.ok ? `Place ${plan.placed.length}` : 'Place'}
        </button>
      </div>
    </div>
  )
}
