import { useQuery } from '@tanstack/react-query'
import { MousePointerClick } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import {
  CANVAS_SLOT_KEYS,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow
} from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { TipLayer } from '../../TipLayer'
import { type DesignTarget, targetKey, useLayoutDesign } from '../design-context'
import { type ApplyOptions, parseBundle } from '../useLayoutDraft'
import { AdvancedTab } from './AdvancedTab'
import {
  type CollectionMeta,
  FieldCtxContext,
  useCollectionMeta,
  useFieldCtxValue,
  useGlobalWriter
} from './field-context'
import { GridTab } from './GridTab'
import { GroupInspector } from './GroupInspector'
import { HeaderItemInspector } from './HeaderItemInspector'
import { GlobalWriterContext, type InspectorEnv, InspectorEnvContext, useInspectorEnv } from './kit'
import { LookTab } from './LookTab'
import {
  asObject,
  describeField,
  findPlacement,
  isDefaultForm,
  layoutTypeOf,
  overrideGroupOps,
  overridePlacementOps,
  SUBTITLE_FIELD
} from './model'
import { PickerTab } from './PickerTab'
import { RulesTab } from './RulesTab'
import { SlotInspector, slotName } from './SlotInspector'
import { SubtitleInspector } from './SubtitleInspector'
import { WidgetInspector } from './WidgetInspector'

export interface InspectorProps {
  bundle: LayoutBundle
  target: DesignTarget | null
  /** useLayoutDraft's apply. */
  apply: (ops: LayoutOp[], opts?: ApplyOptions) => void
  /** useLayoutDraft's flush — typed text goes out on blur. */
  flush?: () => void
  collection: string
  /** Parent layout name when the target comes from it; defaults to the canvas design context. */
  inheritedFrom?: string | null
  /** "Edit in <parent>": opens that layout. Without it the button is not shown. */
  openLayout?: (layoutId: number) => void
}

const WIDGET_RE = /^__widget_\d+__$/
const EXT_RE = /^__ext_[a-z][a-z0-9-]{1,60}__$/
const isSlotField = (f: string) =>
  (CANVAS_SLOT_KEYS as readonly string[]).includes(f) ||
  f === '__owners__' ||
  f === '__pdf__' ||
  EXT_RE.test(f)

type TabKey = 'look' | 'rules' | 'picker' | 'grid' | 'advanced'

function placementOf(target: DesignTarget): { field: string; group_key: string | null } | null {
  switch (target.kind) {
    case 'field':
    case 'slot':
      return { field: target.field, group_key: target.group_key }
    case 'header':
      return {
        field: target.field,
        group_key: target.field === SUBTITLE_FIELD ? null : HEADER_GROUP_KEY
      }
    default:
      return null
  }
}

function useParentBundle(parentId: number | null, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['layout-editor', 'parent-bundle', parentId],
    queryFn: () =>
      client.request<unknown>(get(`/collection-layouts/${parentId}/bundle`)).then(parseBundle),
    enabled: enabled && parentId != null,
    staleTime: 30_000
  })
}

export function Inspector(props: InspectorProps) {
  const { bundle, target, apply, collection } = props
  const design = useLayoutDesign()
  const env: InspectorEnv = useMemo(
    () => ({
      bundle,
      apply,
      flush: props.flush ?? (() => {}),
      collection,
      layoutType: layoutTypeOf(bundle.layout),
      defaultForm: isDefaultForm(bundle.layout)
    }),
    [bundle, apply, props.flush, collection]
  )

  const at = target ? placementOf(target) : null
  const row = at ? findPlacement(bundle, at.field, at.group_key) : null
  const group =
    target?.kind === 'group' ? (bundle.groups.find((g) => g.key === target.key) ?? null) : null
  const missing =
    !!target &&
    (target.kind === 'group'
      ? !group
      : !row && !isSlotField(at?.field ?? '') && at?.field !== SUBTITLE_FIELD)
  const parentId =
    typeof bundle.layout.parent_layout_id === 'number' ? bundle.layout.parent_layout_id : null
  const parentName =
    props.inheritedFrom ?? (target ? (design?.inheritedFrom(target) ?? null) : null)
  const { data: parent } = useParentBundle(parentId, missing)
  const parentRow = missing && parent && at ? findPlacement(parent, at.field, at.group_key) : null
  const parentGroup =
    missing && parent && target?.kind === 'group'
      ? (parent.groups.find((g) => g.key === target.key) ?? null)
      : null
  const inherited = missing && (!!parentRow || !!parentGroup || !!parentName)

  if (!target) {
    return (
      <Shell>
        <div className='flex flex-col items-center gap-2 py-10 text-center text-muted-foreground'>
          <MousePointerClick className='h-5 w-5' />
          <p className='text-[12px]'>Select a field, section or panel on the form to change it.</p>
        </div>
      </Shell>
    )
  }

  if (inherited) {
    const name = parent?.layout.name
      ? String(parent.layout.name)
      : (parentName ?? 'the parent form')
    // Read-only view of the parent's settings: writes go nowhere.
    const roEnv: InspectorEnv = { ...env, bundle: parent ?? bundle, apply: () => {} }
    const override = () => {
      if (!parent) return
      const ops = parentGroup
        ? overrideGroupOps(bundle, parent, parentGroup)
        : parentRow
          ? overridePlacementOps(bundle, parent, parentRow)
          : []
      if (ops.length) apply(ops, { label: `Override ${titleOf(target)} on this form` })
    }
    return (
      <Shell>
        <div
          data-setting='inspector.inherited_override'
          className='space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2.5 dark:border-border dark:bg-muted'
        >
          <p className='text-[12px] text-foreground'>
            This comes from <span className='font-medium'>{name}</span>. Change it there for every
            form built on it, or override it on this form only.
          </p>
          <div className='flex flex-wrap gap-2'>
            <button
              type='button'
              data-override-here=''
              disabled={!parent || (!parentRow && !parentGroup)}
              onClick={override}
              className='rounded-md bg-nvr-cyan px-2.5 py-1 text-[12px] font-medium text-nvr-navy hover:bg-[#00b8e0] disabled:opacity-40'
            >
              Override here
            </button>
            {parentId != null && props.openLayout && (
              <button
                type='button'
                data-edit-in-parent=''
                onClick={() => props.openLayout?.(parentId)}
                className='rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-muted dark:border-border'
              >
                Edit in {name}
              </button>
            )}
          </div>
        </div>
        <InspectorEnvContext.Provider value={roEnv}>
          {/* Tabs still switch; the controls sit in a disabled fieldset and writes go nowhere. */}
          <div data-inherited-view='' className='opacity-70'>
            {parentGroup ? (
              <GroupInspector group={parentGroup} readOnly />
            ) : parentRow ? (
              <PlacementInspector target={target} row={parentRow} readOnly />
            ) : null}
          </div>
        </InspectorEnvContext.Provider>
      </Shell>
    )
  }

  return (
    <Shell>
      <InspectorEnvContext.Provider value={env}>
        {target.kind === 'group' ? (
          group && (
            <>
              <Heading title={group.label || titleCase(group.key)} kind='Section' sub={group.key} />
              <GroupInspector key={group.key} group={group} />
            </>
          )
        ) : missing ? (
          <p className='text-[12px] text-muted-foreground'>
            {titleOf(target)} is not on this form any more.
          </p>
        ) : (
          <PlacementInspector key={targetKey(target)} target={target} row={row} />
        )}
      </InspectorEnvContext.Provider>
    </Shell>
  )
}

function titleOf(t: DesignTarget): string {
  if (t.kind === 'group') return titleCase(t.key)
  if (t.field.startsWith('__')) return slotName(t.field)
  return titleCase(t.field.split('.').pop() ?? t.field)
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div data-inspector='' className='min-w-0 space-y-4 text-[12px]'>
      {/* Hints are data-tip; a second TipLayer on the page stays idle. */}
      <TipLayer />
      {children}
    </div>
  )
}

function Heading({ title, kind, sub }: { title: string; kind: string; sub?: string }) {
  return (
    <div className='space-y-1'>
      <div className='flex items-center gap-2'>
        <h2 className='truncate text-[14px] font-semibold text-foreground'>{title}</h2>
        <span className='shrink-0 rounded-full border border-slate-200 px-1.5 text-[11px] text-muted-foreground dark:border-border'>
          {kind}
        </span>
      </div>
      {sub && <p className='font-mono text-[11px] text-muted-foreground'>{sub}</p>}
    </div>
  )
}

/** A placement: a field, a slot card, a widget, a header strip item or the subtitle. */
function PlacementInspector({
  target,
  row,
  readOnly = false
}: {
  target: DesignTarget
  row: PlacementRow | null
  readOnly?: boolean
}) {
  const field = target.kind === 'group' ? '' : target.field
  const groupKey =
    row?.group_key ?? (target.kind === 'group' ? null : (placementOf(target)?.group_key ?? null))

  if (field === SUBTITLE_FIELD)
    return (
      <>
        <Heading title='Subtitle' kind='Header' />
        <SubtitleInspector />
      </>
    )
  if (row && (WIDGET_RE.test(field) || row.widget_id != null))
    return (
      <>
        <Heading title={row.label_override || 'Widget'} kind='Widget' />
        <WidgetInspector row={row} />
      </>
    )
  if (isSlotField(field))
    return (
      <>
        <Heading title={slotName(field)} kind='Panel' />
        <SlotInspector field={field} groupKey={groupKey} row={row} />
      </>
    )
  if (!row) return null
  if (target.kind === 'header' || row.group_key === HEADER_GROUP_KEY)
    return <HeaderItem row={row} />
  return <FieldInspector row={row} readOnly={readOnly} />
}

function HeaderItem({ row }: { row: PlacementRow }) {
  const env = useInspectorEnv()
  const { data: meta } = useCollectionMeta(env.collection)
  const label = describeField(row.field, meta?.fields ?? [], meta?.relations ?? [], null).label
  return (
    <>
      <Heading title={row.label_override || label} kind='Header item' sub={row.field} />
      <HeaderItemInspector row={row} label={label} />
    </>
  )
}

const EMPTY_META: CollectionMeta = { fields: [], relations: [], label: '' }

function FieldInspector({ row, readOnly }: { row: PlacementRow; readOnly: boolean }) {
  const env = useInspectorEnv()
  const { data: meta } = useCollectionMeta(env.collection)
  const m = meta ?? EMPTY_META
  const info = describeField(row.field, m.fields, m.relations, row)
  const writer = useGlobalWriter({
    collection: env.collection,
    collectionLabel: m.label || titleCase(env.collection),
    field: row.field,
    fieldLabel: info.label,
    stored: {
      options: asObject(info.global?.options),
      dependency_config: asObject(info.global?.dependency_config)
    }
  })
  const ctx = useFieldCtxValue({ env, row, meta: m, writer, readOnly })
  const showPicker =
    info.relKind === 'M2O' ||
    info.relKind === 'M2M' ||
    info.isPath ||
    info.iface === 'relation-path' ||
    info.iface === 'file-image' ||
    info.iface === 'files-m2m'
  const showGrid =
    info.relKind === 'O2M' && (info.iface === 'inline-grid' || info.iface === 'inline-table')
  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: 'look', label: 'Look' },
    { key: 'rules', label: 'Rules' },
    ...(showPicker ? [{ key: 'picker' as const, label: 'Picker' }] : []),
    ...(showGrid
      ? [{ key: 'grid' as const, label: info.iface === 'inline-table' ? 'Table' : 'Grid' }]
      : []),
    { key: 'advanced', label: 'Advanced' }
  ]
  const [tab, setTab] = useState<TabKey>('look')
  const active = tabs.some((t) => t.key === tab) ? tab : 'look'

  return (
    <FieldCtxContext.Provider value={ctx}>
      <GlobalWriterContext.Provider value={writer}>
        <Heading title={info.label} kind={info.relKind ?? titleCase(info.type)} sub={row.field} />
        <p className='text-[11px] text-muted-foreground'>
          Each setting says whether it changes this form only or every form that shows {info.label}.
        </p>
        <div role='tablist' className='flex gap-1 border-b border-slate-200 dark:border-border'>
          {tabs.map((t) => (
            <button
              key={t.key}
              type='button'
              role='tab'
              aria-selected={active === t.key}
              data-inspector-tab={t.key}
              onClick={() => {
                env.flush()
                setTab(t.key)
              }}
              className={cn(
                '-mb-px border-b-2 px-2 py-1.5 text-[12px] transition-colors',
                active === t.key
                  ? 'border-nvr-cyan font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <fieldset disabled={readOnly} className='min-w-0'>
          {!meta ? (
            <p className='text-[12px] text-muted-foreground'>Loading the field…</p>
          ) : active === 'look' ? (
            <LookTab />
          ) : active === 'rules' ? (
            <RulesTab />
          ) : active === 'picker' ? (
            <PickerTab />
          ) : active === 'grid' ? (
            <GridTab />
          ) : (
            <AdvancedTab />
          )}
        </fieldset>
      </GlobalWriterContext.Provider>
    </FieldCtxContext.Provider>
  )
}
