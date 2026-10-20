import { useQuery } from '@tanstack/react-query'
import { Check, CopyPlus, LayoutPanelTop, Plus, Search } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
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
import { cn, titleCase } from '../../lib/utils'
import { fieldSpot, placeOp, sectionOp, slotSpot } from './add-target'
import type { DesignTarget } from './design-context'
import { slotName } from './inspector-slot'
import { useOverviewFields } from './overview/overview-api'
import type { ApplyOptions } from './useLayoutDraft'

// "+ Add": everything that can go on the form — the collection's fields by
// label, a new section, panels (slot cards) and widgets. A click adds right
// after the selection (one op) and selects what it added; something already
// on the form is selected instead of added twice.

interface FieldRow {
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
const BUILT_IN_SLOTS = [
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

const SLOT_HINTS: Record<string, string> = {
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

function typeWord(f: FieldRow): string {
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
  extra
}: {
  title: string
  sub?: string | null
  aside?: ReactNode
  onClick: () => void
  attrs?: Record<string, string | undefined>
  /** A second action beside the row (buttons cannot nest). */
  extra?: ReactNode
}) {
  const main = (
    <button
      type='button'
      onClick={onClick}
      {...attrs}
      className='group flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted'
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
  onSelect
}: {
  bundle: LayoutBundle
  collection: string
  selected: DesignTarget | null
  apply(ops: LayoutOp[], opts?: ApplyOptions): void
  /** Select something on the canvas (what was just added, or what is already there). */
  onSelect(t: DesignTarget): void
}) {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const [to, setTo] = useState<'form' | 'header'>('form')
  const { data: fields = [] } = useOverviewFields(collection)
  const { data: widgets = [], error: widgetsError } = useQuery<WidgetRow[]>({
    queryKey: ['layout-editor', 'widgets'],
    queryFn: () =>
      client.request<{ data: WidgetRow[] }>(get('/widgets-internal')).then((r) => r.data ?? []),
    staleTime: 60_000,
    retry: false
  })
  // "Add another copy" refused: which field, and why.
  const [notice, setNotice] = useState<{ field: string; text: string } | null>(null)

  const needle = q.trim().toLowerCase()
  const matches = (...texts: Array<string | null | undefined>) =>
    !needle || texts.some((t) => t?.toLowerCase().includes(needle))

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

  const fieldRows = (fields as FieldRow[])
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

      {to === 'form' && matches(sectionLabel, 'section', 'tab', 'step') && (
        <>
          <p className={head}>Layout</p>
          <Row
            title={sectionLabel}
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

      <p className={head}>Fields</p>
      {fieldRows.map((f) => {
        const on = to === 'header' ? inHeader(f.field) : inBody(f.field)
        return (
          <div key={f.field}>
            <Row
              title={f.title}
              sub={[f.field, typeWord(f)].filter(Boolean).join(' · ')}
              attrs={{ 'data-add-field': f.field, 'data-on-form': on ? 'true' : undefined }}
              aside={
                on ? (
                  <OnForm>{to === 'header' ? 'in header' : 'on this form'}</OnForm>
                ) : (
                  <Plus className='h-3.5 w-3.5 shrink-0 text-slate-400 opacity-0 group-hover:opacity-100' />
                )
              }
              onClick={() => pick(f.field, f.title)}
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
              onClick={() =>
                pick(key, w.name, {
                  widget_id: w.id,
                  input_bindings: RECORD_BOUND_WIDGETS.includes(w.widget_type)
                    ? [{ key: 'record_id', binding_type: 'item_field', binding_value: 'id' }]
                    : []
                })
              }
            />
          )
        })}
    </div>
  )
}
