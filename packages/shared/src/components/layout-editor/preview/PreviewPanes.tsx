import { X } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import type { LayoutBundle } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { bundleToActiveLayout } from '../bundle-to-active'
import type { DesignMark, DesignOverlay, DesignTarget } from '../design-context'
import type { PreviewAs } from '../EditorTopBar'
import type { DescribeField } from '../overview/describe-conditions'
import { useRoleNames } from '../overview/overview-api'
import { useRolePreview } from '../settings/settings-api'
import { fieldName } from './PreviewModes'
import { useCollectionPipelines, useFieldAccess } from './preview-api'
import {
  compareMarks,
  DEVICE_WIDTH,
  type FieldWho,
  fieldAccessForRole,
  fieldsLockedInState,
  leavingNeeds,
  visibilityChanges,
  whoSeesFields,
  whoTint
} from './preview-model'

// The canvas under the preview modes: one pane (or two, roles side by side),
// at the chosen device width, with the modes' tags and the who-sees tint,
// and a strip above saying what each active mode changes.

/** What one canvas pane renders with (LayoutEditor's Canvas). */
export interface PreviewPane {
  roleId: string | null
  record: Record<string, unknown> | null
  stateKey: string | null
  marks?: (t: DesignTarget) => DesignMark[]
  overlay?: (t: DesignTarget) => DesignOverlay | null
  /** A second pane never drags: one draggable per target. */
  noDnd: boolean
}

const TINT: Record<ReturnType<typeof whoTint>, { cls: string; swatch: string; label: string }> = {
  all: {
    cls: 'bg-emerald-50 dark:bg-emerald-500/10',
    swatch: 'bg-emerald-200 dark:bg-emerald-500/40',
    label: 'Every role'
  },
  most: {
    cls: 'bg-sky-50 dark:bg-sky-500/10',
    swatch: 'bg-sky-200 dark:bg-sky-500/40',
    label: 'Most roles'
  },
  some: {
    cls: 'bg-amber-50 dark:bg-amber-500/10',
    swatch: 'bg-amber-200 dark:bg-amber-500/40',
    label: 'Some roles'
  },
  few: {
    cls: 'bg-orange-50 dark:bg-orange-500/10',
    swatch: 'bg-orange-200 dark:bg-orange-500/40',
    label: 'Few roles'
  },
  none: {
    cls: 'bg-red-50 dark:bg-red-500/10',
    swatch: 'bg-red-200 dark:bg-red-500/40',
    label: 'No role'
  }
}

function RoleList({ title, names }: { title: string; names: string[] }) {
  if (names.length === 0) return null
  return (
    <div className='mt-2 first:mt-0'>
      <p className='text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'>
        {title} ({names.length})
      </p>
      <p className='mt-0.5 text-[12px] leading-snug text-slate-800 dark:text-foreground'>
        {names.join(', ')}
      </p>
    </div>
  )
}

/** The overlay's chip on a field: how many roles see it; click lists them. */
function WhoChip({ who, label }: { who: FieldWho; label: string }) {
  const sees = who.edit.length + who.read.length
  const total = sees + who.hidden.length
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-who-chip=''
          aria-label={`Who sees ${label}`}
          className='inline-flex items-center rounded bg-white px-1 text-[11px] font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 dark:bg-card dark:text-foreground dark:ring-border dark:hover:bg-muted'
        >
          {sees}/{total} roles
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] p-3' data-design-pass=''>
        <p className='mb-2 text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
          Who sees {label}
        </p>
        <RoleList title='Can edit' names={who.edit} />
        <RoleList title='Read only' names={who.read} />
        <RoleList title='Never see it' names={who.hidden} />
        <p className='mt-2 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'>
          From each role’s permissions and this form’s section and lock rules. Administrators see
          every field.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function StripRow({ children, onClear }: { children: ReactNode; onClear: () => void }) {
  return (
    <div className='flex min-w-0 items-start gap-2'>
      <div className='min-w-0 flex-1 text-[12.5px] leading-snug text-slate-700 dark:text-slate-200'>
        {children}
      </div>
      <button
        type='button'
        aria-label='Turn off'
        data-tip='Turn off'
        onClick={onClear}
        className='inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-muted hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}

const join = (list: string[]) => list.join(', ')

export function PreviewPanes({
  collection,
  bundle,
  parent,
  preview,
  onPreview,
  record,
  fields,
  renderPane
}: {
  collection: string
  bundle: LayoutBundle
  parent: LayoutBundle | null
  preview: PreviewAs
  onPreview: (v: PreviewAs) => void
  record: Record<string, unknown> | null
  fields: DescribeField[]
  renderPane: (pane: PreviewPane) => ReactNode
}) {
  const active = useMemo(() => bundleToActiveLayout(bundle, parent).active, [bundle, parent])
  const label = (f: string) => fieldName(fields, f)
  const groupLabel = (key: string) => {
    const g = active.groups.find((x) => x.key === key)
    return g?.label || key
  }

  // What if: the values laid over the record.
  const values = preview.values && Object.keys(preview.values).length > 0 ? preview.values : null
  const previewRecord = useMemo(
    () => (values ? { ...(record ?? {}), ...values } : record),
    [record, values]
  )
  const changes = useMemo(
    () => (values ? visibilityChanges(active, record ?? {}, previewRecord ?? {}) : null),
    [values, active, record, previewRecord]
  )

  // Roles side by side.
  const roleA = preview.roleId
  const roleB = roleA ? (preview.compareRoleId ?? null) : null
  const { data: accessA = null } = useRolePreview(collection, roleB ? roleA : null)
  const { data: accessB = null } = useRolePreview(collection, roleB)
  const compare = useMemo(() => {
    if (!roleB || !accessA || !accessB) return null
    const fa = fieldAccessForRole(accessA, active)
    const fb = fieldAccessForRole(accessB, active)
    let differ = 0
    for (const [f, v] of fa) if (fb.get(f) && fb.get(f) !== v) differ++
    return { marks: compareMarks(active, accessA, accessB), differ, a: accessA, b: accessB }
  }, [roleB, accessA, accessB, active])

  // Workflow state.
  const state = preview.state ?? null
  const { data: pipelines = [] } = useCollectionPipelines(collection, !!state)
  const stateInfo = useMemo(() => {
    if (!state) return null
    const locked = fieldsLockedInState(active, state.key)
    const pipeline = pipelines.find((p) => p.id === state.pipelineId)
    const needs = leavingNeeds(pipeline?.transitions ?? [], state.id)
    const needOwn = new Map<string, string[]>()
    for (const n of needs)
      if (!n.collection || n.collection === collection)
        for (const f of n.fields) needOwn.set(f, [...(needOwn.get(f) ?? []), n.label])
    return { locked: new Set(locked), needs, needOwn }
  }, [state, active, pipelines, collection])

  // Who sees each field.
  const { data: fieldAccess = [] } = useFieldAccess(collection, !!preview.who)
  const { data: roleNames = [] } = useRoleNames(!!preview.who)
  const who = useMemo(() => {
    if (!preview.who || fieldAccess.length === 0) return null
    // The roles this workspace lists (the server answers every role).
    const ids = new Set(roleNames.map((r) => r.id.toUpperCase()))
    const roles = fieldAccess.filter(
      (r) => !r.role.admin_access && (ids.size === 0 || ids.has(String(r.role.id).toUpperCase()))
    )
    return whoSeesFields(roles, active)
  }, [preview.who, fieldAccess, roleNames, active])

  const marks = useMemo(() => {
    const parts: Array<(t: DesignTarget) => DesignMark[]> = []
    if (compare) parts.push(compare.marks)
    if (stateInfo && state)
      parts.push((t) => {
        if (t.kind !== 'field' && t.kind !== 'header') return []
        const out: DesignMark[] = []
        if (stateInfo.locked.has(t.field))
          out.push({ text: `Locked in ${state.label}`, tone: 'slate' })
        const moves = stateInfo.needOwn.get(t.field)
        if (moves)
          out.push({ text: 'Needed to move on', tone: 'amber', tip: `${join(moves)} needs it` })
        return out
      })
    if (changes && (changes.shown.length || changes.hidden.length)) {
      const shown = new Set(changes.shown)
      const hidden = new Set(changes.hidden)
      parts.push((t) =>
        t.kind !== 'group'
          ? []
          : shown.has(t.key)
            ? [{ text: 'Appears', tone: 'emerald', highlight: true }]
            : hidden.has(t.key)
              ? [{ text: 'Hides', tone: 'slate' }]
              : []
      )
    }
    if (parts.length === 0) return undefined
    // Preview tags rank with the role mark when a node has more tags than fit.
    return (t: DesignTarget) =>
      parts.flatMap((p) => p(t)).map((m): DesignMark => ({ ...m, kind: m.kind ?? 'preview' }))
  }, [compare, stateInfo, state, changes])

  const overlay = useMemo(() => {
    if (!who) return undefined
    return (t: DesignTarget): DesignOverlay | null => {
      if (t.kind !== 'field' && t.kind !== 'header') return null
      const w = who.get(t.field)
      if (!w) return null
      return {
        className: TINT[whoTint(w)].cls,
        chip: <WhoChip who={w} label={fieldName(fields, t.field)} />
      }
    }
  }, [who, fields])

  const width = DEVICE_WIDTH[preview.device ?? 'desktop']
  const paneKey = JSON.stringify(values ?? {})
  const frame = (node: ReactNode) =>
    width ? (
      <div
        data-preview-device={preview.device}
        className='mx-auto w-full border-x border-dashed border-slate-300 bg-white dark:border-slate-600 dark:bg-background'
        style={{ maxWidth: width }}
      >
        {node}
      </div>
    ) : (
      node
    )

  const strip: ReactNode[] = []
  if (roleB)
    strip.push(
      <StripRow key='compare' onClear={() => onPreview({ ...preview, compareRoleId: null })}>
        <b className='font-semibold'>{compare?.a.role.name ?? '…'}</b> beside{' '}
        <b className='font-semibold'>{compare?.b.role.name ?? '…'}</b>
        {compare &&
          (compare.differ === 0
            ? ' — every field is the same for both.'
            : ` — ${compare.differ} ${compare.differ === 1 ? 'field differs' : 'fields differ'}, marked Differs.`)}
      </StripRow>
    )
  if (state && stateInfo)
    strip.push(
      <StripRow key='state' onClear={() => onPreview({ ...preview, state: null })}>
        As if in <b className='font-semibold'>{state.label}</b>:{' '}
        {stateInfo.locked.size === 0
          ? 'no field locks'
          : `${stateInfo.locked.size} ${stateInfo.locked.size === 1 ? 'field locks' : 'fields lock'}`}
        {stateInfo.needs.length > 0 && (
          <>
            {' · '}
            {stateInfo.needs
              .map(
                (n) =>
                  `${n.label} needs ${join(n.fields.map((f) => (n.collection && n.collection !== collection ? f : label(f))))}${n.collection && n.collection !== collection ? ` on ${n.collection}` : ''}`
              )
              .join(' · ')}
          </>
        )}
        .
      </StripRow>
    )
  if (values && changes)
    strip.push(
      <StripRow key='values' onClear={() => onPreview({ ...preview, values: null })}>
        What if{' '}
        <b className='font-semibold'>
          {Object.entries(values)
            .map(([f, v]) => `${label(f)} = ${v == null || v === '' ? 'empty' : String(v)}`)
            .join(', ')}
        </b>
        :{' '}
        {changes.shown.length === 0 && changes.hidden.length === 0
          ? 'nothing appears or disappears.'
          : [
              changes.shown.length ? `shows ${join(changes.shown.map(groupLabel))}` : '',
              changes.hidden.length ? `hides ${join(changes.hidden.map(groupLabel))}` : ''
            ]
              .filter(Boolean)
              .join('; ') + '.'}
      </StripRow>
    )
  if (preview.who)
    strip.push(
      <StripRow key='who' onClear={() => onPreview({ ...preview, who: false })}>
        <span className='mr-2'>Who sees each field:</span>
        <span className='inline-flex flex-wrap items-center gap-x-3 gap-y-1 align-middle'>
          {(['all', 'most', 'some', 'few', 'none'] as const).map((k) => (
            <span key={k} className='inline-flex items-center gap-1 text-[12px]'>
              <span aria-hidden className={cn('h-2.5 w-2.5 rounded-sm', TINT[k].swatch)} />
              {TINT[k].label}
            </span>
          ))}
        </span>
        {!who && <span className='ml-2 text-slate-500 dark:text-muted-foreground'>Loading…</span>}
      </StripRow>
    )
  if (width)
    strip.push(
      <StripRow key='device' onClear={() => onPreview({ ...preview, device: 'desktop' })}>
        {preview.device === 'phone' ? 'Phone' : 'Tablet'} width ({width} px): columns wrap as they
        do on that screen.
      </StripRow>
    )

  const pane = (roleId: string | null, noDnd: boolean) =>
    renderPane({
      roleId,
      record: previewRecord,
      stateKey: state?.key ?? null,
      marks,
      overlay,
      noDnd
    })

  return (
    <div className='flex min-h-full flex-col'>
      {strip.length > 0 && (
        <div
          data-preview-strip=''
          className='sticky top-0 z-20 flex shrink-0 flex-col gap-1 border-b border-slate-200 bg-white px-4 py-2 dark:border-border dark:bg-card'
        >
          {strip}
        </div>
      )}
      {roleB ? (
        <div className='flex min-h-0 flex-1 gap-px bg-slate-200 dark:bg-border'>
          {[
            { id: roleA, name: compare?.a.role.name },
            { id: roleB, name: compare?.b.role.name }
          ].map((r, i) => (
            <section
              key={`${r.id}:${paneKey}`}
              data-preview-pane={i === 0 ? 'a' : 'b'}
              aria-label={`As ${r.name ?? 'role'}`}
              className='flex min-w-0 flex-1 flex-col bg-slate-50 dark:bg-background'
            >
              <p className='shrink-0 border-b border-slate-200 bg-white px-4 py-1.5 text-[12px] font-semibold text-slate-700 dark:border-border dark:bg-card dark:text-foreground'>
                As {r.name ?? '…'}
              </p>
              {frame(pane(r.id, true))}
            </section>
          ))}
        </div>
      ) : (
        <div key={paneKey} className='flex min-h-0 flex-1 flex-col'>
          {frame(pane(roleA, false))}
        </div>
      )}
    </div>
  )
}
