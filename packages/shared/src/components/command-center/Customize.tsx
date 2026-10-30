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
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, GripVertical, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet'
import { Switch } from '../ui/switch'
import { DEFAULT_PREFS, useCcRoleDefaults, useSaveCcPrefs, useSaveRoleDefault } from './board-prefs'
import { KioskLinks } from './KioskLinks'
import {
  effectiveLayout,
  layoutToSave,
  movePanel,
  movePanelTo,
  type ResolvedPanel,
  resolvePanels,
  setPanelVisible
} from './layout'
import { CC_PANELS } from './panels/registry'
import { useCc } from './state'
import { BUTTON, ccVars, FAINT, FOCUS, MUTED } from './theme'
import type { CcLayout, CcSavedView } from './types'

/**
 * Customise (CC-24): one side sheet — panels (drag, or the up/down buttons, and a switch each),
 * saved views (region + map + filters under a name), appearance (follow the app or always dark,
 * TV cycle speed) and, for administrators, role starting layouts and wallboard links. Every
 * change saves as it is made.
 */

const SECTION = 'space-y-2 border-t border-[var(--cc-border)] pt-4 first:border-t-0 first:pt-0'
const H3 = 'text-[13px] font-semibold text-[var(--cc-strong)]'
const INPUT =
  'h-8 w-full rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2.5 text-[12.5px] text-[var(--cc-text)] placeholder:text-[var(--cc-faint)]'

export function usePanelsFor(isAdmin: boolean) {
  return useMemo(() => CC_PANELS.filter((p) => !p.adminOnly || isAdmin), [isAdmin])
}

function SortableRow({
  panel,
  index,
  count,
  onMove,
  onVisible
}: {
  panel: ResolvedPanel & { label: string; hint?: string }
  index: number
  count: number
  onMove: (delta: -1 | 1) => void
  onVisible: (v: boolean) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.key
  })
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-2 ${isDragging ? 'relative z-10 bg-[var(--cc-raised)] shadow-sm' : ''}`}
    >
      <button
        type='button'
        {...attributes}
        {...listeners}
        aria-label={`Drag ${panel.label} to reorder`}
        data-tip='Drag to reorder'
        className={`cursor-grab rounded p-1 text-[var(--cc-faint)] hover:bg-[var(--cc-chip)] active:cursor-grabbing ${FOCUS}`}
      >
        <GripVertical className='h-3.5 w-3.5' aria-hidden />
      </button>
      <div className='min-w-0 flex-1'>
        <p
          className={`truncate text-[12.5px] font-medium ${panel.visible ? 'text-[var(--cc-text)]' : 'text-[var(--cc-faint)]'}`}
        >
          {panel.label}
        </p>
        {panel.hint && <p className={`truncate text-[11.5px] ${FAINT}`}>{panel.hint}</p>}
      </div>
      <button
        type='button'
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label={`Move ${panel.label} up`}
        className={`rounded p-1 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)] disabled:opacity-30 ${FOCUS}`}
      >
        <ArrowUp className='h-3.5 w-3.5' aria-hidden />
      </button>
      <button
        type='button'
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        aria-label={`Move ${panel.label} down`}
        className={`rounded p-1 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)] disabled:opacity-30 ${FOCUS}`}
      >
        <ArrowDown className='h-3.5 w-3.5' aria-hidden />
      </button>
      <Switch
        checked={panel.visible}
        onCheckedChange={onVisible}
        aria-label={`Show ${panel.label}`}
        className='data-[state=checked]:bg-nvr-cyan data-[state=unchecked]:bg-[var(--cc-chip-hover)]'
      />
    </li>
  )
}

/** Reorder + show/hide editor over the panels this viewer can have. */
export function PanelOrderEditor({
  panels,
  onChange
}: {
  panels: ResolvedPanel[]
  onChange: (next: ResolvedPanel[]) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const meta = useMemo(() => new Map(CC_PANELS.map((p) => [p.key, p])), [])
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id)
      onChange(movePanelTo(panels, String(e.active.id), String(e.over.id)))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={panels.map((p) => p.key)} strategy={verticalListSortingStrategy}>
        <ol className='divide-y divide-[var(--cc-border)] rounded-md border border-[var(--cc-border)]'>
          {panels.map((p, i) => (
            <SortableRow
              key={p.key}
              panel={{ ...p, label: meta.get(p.key)?.label ?? p.key, hint: meta.get(p.key)?.hint }}
              index={i}
              count={panels.length}
              onMove={(d) => onChange(movePanel(panels, p.key, d))}
              onVisible={(v) => onChange(setPanelVisible(panels, p.key, v))}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
  )
}

function SavedViews() {
  const cc = useCc()
  const save = useSaveCcPrefs()
  const views = cc.prefs?.saved_views ?? []
  const [name, setName] = useState('')
  const inputId = useId()
  const regionLabel = (id: string | null) =>
    id ? (cc.config?.regions.find((r) => r.id === id)?.label ?? 'A region') : 'Everywhere'
  const mapLabel = (k: string | null) =>
    k ? cc.config?.geo_collections.find((g) => g.key === k)?.label || k.replace(/_/g, ' ') : null
  const add = () => {
    const n = name.trim()
    if (!n) return
    const view: CcSavedView = {
      id: `v${Date.now().toString(36)}`,
      name: n.slice(0, 60),
      region: cc.region,
      map_collection: cc.mapCollection,
      filters: cc.filters
    }
    save.mutate({ saved_views: [...views.filter((v) => v.name !== view.name), view].slice(-20) })
    setName('')
  }
  return (
    <section className={SECTION} aria-labelledby={`${inputId}-h`}>
      <h3 id={`${inputId}-h`} className={H3}>
        Saved views
      </h3>
      <p className={`text-[12px] ${MUTED}`}>
        A view keeps the region, the map and its filters, so you can come back to them in one click.
      </p>
      {views.length > 0 && (
        <ul className='divide-y divide-[var(--cc-border)] rounded-md border border-[var(--cc-border)]'>
          {views.map((v) => (
            <li key={v.id} className='flex items-center gap-2 px-2.5 py-2'>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[12.5px] font-medium text-[var(--cc-text)]'>{v.name}</p>
                <p className={`truncate text-[11.5px] ${FAINT}`}>
                  {[regionLabel(v.region), mapLabel(v.map_collection)].filter(Boolean).join(' · ')}
                </p>
              </div>
              <button
                type='button'
                className={`${BUTTON} ${FOCUS}`}
                onClick={() => applySavedView(cc, v)}
              >
                Open
              </button>
              <button
                type='button'
                aria-label={`Delete the view ${v.name}`}
                data-tip='Delete'
                className={`rounded p-1.5 text-[var(--cc-muted)] hover:bg-[var(--cc-chip)] hover:text-[var(--cc-bad-text)] ${FOCUS}`}
                onClick={() => save.mutate({ saved_views: views.filter((x) => x.id !== v.id) })}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className='flex items-center gap-2'
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <label htmlFor={inputId} className='sr-only'>
          Name for the current view
        </label>
        <input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`Name this view (${regionLabel(cc.region)})`}
          maxLength={60}
          className={`${INPUT} ${FOCUS}`}
        />
        <button type='submit' disabled={!name.trim()} className={`${BUTTON} shrink-0 ${FOCUS}`}>
          Save view
        </button>
      </form>
    </section>
  )
}

export function applySavedView(
  cc: Pick<ReturnType<typeof useCc>, 'setRegion' | 'setMapCollection' | 'setFilters'>,
  v: CcSavedView
) {
  cc.setRegion(v.region)
  if (v.map_collection) cc.setMapCollection(v.map_collection)
  cc.setFilters(v.filters)
}

function Appearance() {
  const cc = useCc()
  const save = useSaveCcPrefs()
  const theme = cc.prefs?.theme ?? 'app'
  const cycle = String(cc.prefs?.tv_cycle_seconds ?? DEFAULT_PREFS.tv_cycle_seconds)
  const options: Array<{ value: 'app' | 'dark'; label: string; hint: string }> = [
    { value: 'app', label: 'Follow the app', hint: 'Light or dark, like the rest of Nivaro' },
    { value: 'dark', label: 'Always dark', hint: 'For wall screens and dim rooms' }
  ]
  return (
    <section className={SECTION} aria-labelledby='cc-appearance-h'>
      <h3 id='cc-appearance-h' className={H3}>
        Appearance
      </h3>
      <div role='radiogroup' aria-labelledby='cc-appearance-h' className='grid grid-cols-2 gap-2'>
        {options.map((o) => (
          // biome-ignore lint/a11y/useSemanticElements: a two-card radio group, not a form input
          <button
            key={o.value}
            type='button'
            role='radio'
            aria-checked={theme === o.value}
            onClick={() => save.mutate({ theme: o.value })}
            className={`rounded-md border px-2.5 py-2 text-left ${FOCUS} ${theme === o.value ? 'border-nvr-cyan bg-[var(--cc-chip)]' : 'border-[var(--cc-border)] hover:bg-[var(--cc-chip)]'}`}
          >
            <span className='block text-[12.5px] font-medium text-[var(--cc-text)]'>{o.label}</span>
            <span className={`block text-[11.5px] ${FAINT}`}>{o.hint}</span>
          </button>
        ))}
      </div>
      {(cc.config?.regions.length ?? 0) > 1 && (
        <div className='flex items-center justify-between gap-3 pt-1'>
          <span className='text-[12.5px] text-[var(--cc-text)]'>
            In TV mode, move to the next region every
          </span>
          <SimpleSelect
            ariaLabel='Seconds between regions in TV mode'
            value={cycle}
            onChange={(v) => save.mutate({ tv_cycle_seconds: Number(v) })}
            className='h-8 w-[120px] text-[12.5px]'
            options={[15, 30, 60, 120, 300].map((s) => ({
              value: String(s),
              label: s < 60 ? `${s} seconds` : `${s / 60} minute${s > 60 ? 's' : ''}`
            }))}
          />
        </div>
      )}
    </section>
  )
}

interface RoleRow {
  id: string
  name: string
}

function RoleLayouts() {
  const client = useNivaroClient()
  const isAdmin = true
  const panelsFor = usePanelsFor(isAdmin)
  const known = useMemo(() => panelsFor.map((p) => p.key), [panelsFor])
  const roles = useQuery({
    queryKey: ['command-center', 'roles-list'],
    queryFn: () => client.request<{ data: RoleRow[] }>(get('/roles')).then((r) => r.data),
    staleTime: 60_000
  })
  const defaults = useCcRoleDefaults(true)
  const save = useSaveRoleDefault()
  const [roleId, setRoleId] = useState('')
  const stored: CcLayout | null = roleId ? (defaults.data?.[roleId.toLowerCase()] ?? null) : null
  const [draft, setDraft] = useState<ResolvedPanel[] | null>(null)
  useEffect(() => {
    setDraft(roleId ? resolvePanels(known, stored) : null)
  }, [roleId, stored, known])
  return (
    <section className={SECTION} aria-labelledby='cc-roles-h'>
      <h3 id='cc-roles-h' className={H3}>
        Starting layout for a role
      </h3>
      <p className={`text-[12px] ${MUTED}`}>
        What a role’s people see until they customise their own board.
      </p>
      <SimpleSelect
        ariaLabel='Role'
        value={roleId}
        onChange={setRoleId}
        className='h-8 text-[12.5px]'
        options={[
          { value: '', label: roles.isLoading ? 'Loading roles…' : 'Choose a role' },
          ...(roles.data ?? []).map((r) => ({
            value: String(r.id),
            label: `${r.name}${defaults.data?.[String(r.id).toLowerCase()] ? ' (set)' : ''}`
          }))
        ]}
      />
      {draft && (
        <>
          <PanelOrderEditor panels={draft} onChange={setDraft} />
          <div className='flex flex-wrap justify-end gap-2'>
            <button
              type='button'
              className={`${BUTTON} ${FOCUS}`}
              disabled={!stored || save.isPending}
              onClick={() => save.mutate({ role_id: roleId, layout: null })}
            >
              Back to the built-in layout
            </button>
            <button
              type='button'
              className={`rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-50 ${FOCUS}`}
              disabled={save.isPending}
              onClick={() =>
                save.mutate({ role_id: roleId, layout: layoutToSave(draft, stored, known) })
              }
            >
              Save for this role
            </button>
          </div>
          {save.isError && (
            <p role='alert' className='text-[12px] text-[var(--cc-bad-text)]'>
              Couldn’t save the role’s layout. Try again.
            </p>
          )}
        </>
      )}
    </section>
  )
}

export function CustomizeSheet({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const cc = useCc()
  const save = useSaveCcPrefs()
  const panelsFor = usePanelsFor(cc.isAdmin)
  const known = useMemo(() => panelsFor.map((p) => p.key), [panelsFor])
  const own = cc.prefs?.layout ?? null
  const layout = effectiveLayout(own, cc.prefs?.role_default)
  const panels = useMemo(() => resolvePanels(known, layout), [known, layout])
  const setPanels = (next: ResolvedPanel[]) =>
    save.mutate({ layout: layoutToSave(next, own ?? layout, known) })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        style={ccVars(cc.mode)}
        className='flex w-full flex-col gap-0 border-[var(--cc-border)] bg-[var(--cc-panel)] p-0 text-[var(--cc-text)] sm:max-w-md'
      >
        <SheetHeader className='border-b border-[var(--cc-border)] px-4 py-3 text-left'>
          <SheetTitle className='text-[15px] text-[var(--cc-strong)]'>
            Customise the board
          </SheetTitle>
          <SheetDescription className={`text-[12px] ${MUTED}`}>
            Changes save as you make them and only change your own board.
          </SheetDescription>
        </SheetHeader>
        <div className='flex-1 space-y-4 overflow-y-auto px-4 py-4'>
          <section className={SECTION} aria-labelledby='cc-panels-h'>
            <div className='flex items-center justify-between gap-2'>
              <h3 id='cc-panels-h' className={H3}>
                Panels
              </h3>
              <button
                type='button'
                className={`${BUTTON} ${FOCUS}`}
                disabled={!own || save.isPending}
                onClick={() => save.mutate({ layout: null })}
              >
                {cc.prefs?.role_default ? 'Reset to my role’s layout' : 'Reset'}
              </button>
            </div>
            <p className={`text-[12px] ${MUTED}`}>
              Drag or use the arrows to change the order; switch a panel off to hide it.
            </p>
            <PanelOrderEditor panels={panels} onChange={setPanels} />
          </section>
          <SavedViews />
          <Appearance />
          {cc.isAdmin && <RoleLayouts />}
          {cc.isAdmin && <KioskLinks />}
          {save.isError && (
            <p role='alert' className='text-[12px] text-[var(--cc-bad-text)]'>
              Couldn’t save that change. Check your connection and try again.
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
