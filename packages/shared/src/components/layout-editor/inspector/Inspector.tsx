import { MousePointerClick } from 'lucide-react'
import { type ReactNode, useId, useMemo, useState } from 'react'
import {
  CANVAS_SLOT_KEYS,
  type GroupRow,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { cn, titleCase } from '../../../lib/utils'
import { TipLayer } from '../../TipLayer'
import { ArrangeButton } from '../ArrangeButton'
import { AutoArrangeButton } from '../AutoArrange'
import { type DesignTarget, targetKey, useLayoutDesign } from '../design-context'
import { FIELD_HOLDERS } from '../field-zones'
import { PanelBody, PanelHeader, PanelTabs, tabId, tabPanelId } from '../panel-frame'
import { tintCard } from '../panel-style'
import { slotName } from '../slot-names'
import { type ApplyOptions, useLayoutBundle } from '../useLayoutDraft'
import { AdvancedTab } from './AdvancedTab'
import { Breadcrumb } from './Breadcrumb'
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
import { HelpVideoSetting, NoteSetting } from './HelpTab'
import {
  GlobalWriterContext,
  type InspectorEnv,
  InspectorEnvContext,
  ScopeLegend,
  useInspectorEnv
} from './kit'
import { LookTab } from './LookTab'
import {
  asObject,
  describeField,
  type FieldInfo,
  findPlacement,
  isDefaultForm,
  layoutTypeOf,
  NUMERIC_TYPES,
  overrideGroupOps,
  overridePlacementOps,
  SUBTITLE_FIELD
} from './model'
import { OverrideNotice } from './OverrideNotice'
import { PickerTab } from './PickerTab'
import { RulesTab } from './RulesTab'
import { SlotInspector } from './SlotInspector'
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
  /** Select (and reveal) another part: the header breadcrumb's steps and sections. */
  onSelect?: (t: DesignTarget) => void
}

const WIDGET_RE = /^__widget_\d+__$/
const EXT_RE = /^__ext_[a-z][a-z0-9-]{1,60}__$/
const isSlotField = (f: string) =>
  (CANVAS_SLOT_KEYS as readonly string[]).includes(f) ||
  f === '__owners__' ||
  f === '__pdf__' ||
  EXT_RE.test(f)

type TabKey = 'look' | 'rules' | 'picker' | 'grid' | 'help' | 'advanced'

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
      defaultForm: isDefaultForm(bundle.layout),
      select: props.onSelect
    }),
    [bundle, apply, props.flush, collection, props.onSelect]
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
    bundle.layout.parent_layout_id != null ? Number(bundle.layout.parent_layout_id) : null
  const parentName =
    props.inheritedFrom ?? (target ? (design?.inheritedFrom(target) ?? null) : null)
  // Also for the layout's own nodes: an override of the parent's gets Reset to parent.
  const { data: parent } = useLayoutBundle(parentId)
  const parentRow = missing && parent && at ? findPlacement(parent, at.field, at.group_key) : null
  const parentGroup =
    missing && parent && target?.kind === 'group'
      ? (parent.groups.find((g) => g.key === target.key) ?? null)
      : null
  const inherited = missing && (!!parentRow || !!parentGroup || !!parentName)

  if (!target) {
    return (
      <Shell>
        <div className='flex flex-1 flex-col items-center justify-center gap-2 px-8 pb-16 text-center'>
          <MousePointerClick className='h-5 w-5 text-slate-400' />
          <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>
            Select a field, section or panel on the form to change it.
          </p>
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
    const notice = (
      <div data-setting='inspector.inherited_override' className={cn(tintCard, 'space-y-2.5 p-3')}>
        <p className='text-[12px] leading-snug text-slate-700 dark:text-foreground'>
          This comes from <span className='font-medium'>{name}</span>. Change it there for every
          form built on it, or override it on this form only.
        </p>
        <div className='flex flex-wrap gap-2'>
          <button
            type='button'
            data-override-here=''
            disabled={!parent || (!parentRow && !parentGroup)}
            onClick={override}
            className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-40'
          >
            Override here
          </button>
          {parentId != null && props.openLayout && (
            <button
              type='button'
              data-edit-in-parent=''
              onClick={() => props.openLayout?.(parentId)}
              className='h-7 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted'
            >
              Edit in {name}
            </button>
          )}
        </div>
      </div>
    )
    return (
      <Shell>
        <InspectorEnvContext.Provider value={roEnv}>
          {parentGroup ? (
            <GroupPanel group={parentGroup} notice={notice} readOnly />
          ) : parentRow ? (
            <PlacementInspector target={target} row={parentRow} notice={notice} readOnly />
          ) : (
            <>
              <PanelHeader title={titleOf(target)} />
              <PanelBody>{notice}</PanelBody>
            </>
          )}
        </InspectorEnvContext.Provider>
      </Shell>
    )
  }

  const overrideNotice = !missing ? (
    <OverrideNotice
      bundle={bundle}
      parent={parent}
      target={target}
      title={titleOf(target)}
      apply={apply}
    />
  ) : null
  return (
    <Shell>
      <InspectorEnvContext.Provider value={env}>
        {target.kind === 'group' ? (
          group && <GroupPanel key={group.key} group={group} notice={overrideNotice} />
        ) : missing ? (
          <>
            <PanelHeader title={titleOf(target)} />
            <PanelBody>
              <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>
                {titleOf(target)} is not on this form any more.
              </p>
            </PanelBody>
          </>
        ) : (
          <PlacementInspector
            key={targetKey(target)}
            target={target}
            row={row}
            notice={overrideNotice}
          />
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
    <div data-inspector='' className='flex h-full min-h-0 min-w-0 flex-col text-[12px]'>
      {/* Hints are data-tip; a second TipLayer on the page stays idle. */}
      <TipLayer />
      {children}
    </div>
  )
}

/** "Basic Information" — the section a placement sits in, by its label. */
function sectionLabel(bundle: LayoutBundle, key: string | null): string | null {
  if (!key || key === UNGROUPED_KEY) return null
  if (key === HEADER_GROUP_KEY) return 'Header strip'
  const g = bundle.groups.find((x) => x.key === key)
  return g ? g.label || titleCase(g.key) : titleCase(key)
}

/** What a field holds, in words: "picks one record", "number". */
function fieldKindWords(info: FieldInfo): string {
  if (info.isPath) return 'shows a linked value'
  if (info.computedType) return 'calculated'
  if (info.relKind === 'M2O') return 'picks one record'
  if (info.relKind === 'M2M') return 'picks several records'
  if (info.relKind === 'O2M')
    return info.iface === 'inline-table' ? 'table of related rows' : 'related rows'
  if (info.relKind) return 'related records'
  if (NUMERIC_TYPES.has(info.type)) return 'number'
  switch (info.type) {
    case 'boolean':
      return 'yes or no'
    case 'date':
      return 'date'
    case 'datetime':
    case 'timestamp':
      return 'date and time'
    case 'time':
      return 'time'
    case 'json':
      return 'JSON'
    case 'text':
      return 'long text'
    case 'uuid':
      return 'ID'
    case 'string':
      return 'text'
    default:
      return info.type
  }
}

function KeyLine({ words, k, setting }: { words?: string; k: string; setting?: string }) {
  return (
    <span data-setting={setting}>
      {words && <>{words} · </>}
      <span className='font-mono text-[11px]'>{k}</span>
    </span>
  )
}

/** "Step", "Section", "Tabs holder" — the breadcrumb follows ("Step · Request"). */
function groupKindWord(bundle: LayoutBundle, group: GroupRow): string {
  const parent = group.parent_key
    ? (bundle.groups.find((g) => g.key === group.parent_key) ?? null)
    : null
  return group.type === 'tab'
    ? parent?.tab_mode === 'steps'
      ? 'Step'
      : 'Tab'
    : group.type === 'container'
      ? group.tab_mode === 'steps'
        ? 'Steps holder'
        : 'Tabs holder'
      : group.type === 'content'
        ? 'Text block'
        : group.type === 'metadata'
          ? 'Record info'
          : 'Section'
}

function GroupPanel({
  group,
  notice,
  readOnly = false
}: {
  group: GroupRow
  notice?: ReactNode
  readOnly?: boolean
}) {
  const env = useInspectorEnv()
  const body = <GroupInspector group={group} readOnly={readOnly} />
  return (
    <>
      <PanelHeader
        eyebrow={
          <Breadcrumb
            kind={groupKindWord(env.bundle, group)}
            target={{ kind: 'group', key: group.key }}
          />
        }
        title={group.label || titleCase(group.key)}
        sub={<KeyLine k={group.key} setting='group.key' />}
      />
      <PanelBody>
        {notice}
        {readOnly ? (
          // Inputs sit in a disabled fieldset and writes go nowhere.
          <div data-inherited-view='' className='opacity-70'>
            {body}
          </div>
        ) : (
          <>
            <ScopeLegend />
            <div className='flex flex-wrap gap-2'>
              <ArrangeButton targets={[{ kind: 'group', key: group.key }]} />
              {FIELD_HOLDERS.has(group.type) &&
                env.layoutType !== 'table' &&
                env.layoutType !== 'file' && (
                  <AutoArrangeButton
                    bundle={env.bundle}
                    apply={env.apply}
                    zone={group.key}
                    zoneLabel={group.label || titleCase(group.key)}
                  />
                )}
            </div>
            {body}
            {/* #2615 / #2608: help video and editor note for the section. */}
            <div
              data-group-help=''
              className='mt-5 space-y-5 border-t border-slate-100 pt-5 dark:border-border/60'
            >
              <HelpVideoSetting
                kind='section'
                name={group.key}
                label={group.label || titleCase(group.key)}
              />
              <NoteSetting
                target={{ kind: 'group', key: group.key }}
                name={group.label || titleCase(group.key)}
              />
            </div>
          </>
        )}
      </PanelBody>
    </>
  )
}

/** A placement panel without tabs: header, legend, body. */
function SimplePanel({
  eyebrow,
  title,
  sub,
  notice,
  readOnly,
  children
}: {
  eyebrow: ReactNode
  title: string
  sub?: ReactNode
  notice?: ReactNode
  readOnly: boolean
  children: ReactNode
}) {
  return (
    <>
      <PanelHeader eyebrow={eyebrow} title={title} sub={sub} />
      <PanelBody>
        {notice}
        {readOnly ? (
          <div data-inherited-view='' className='opacity-70'>
            <fieldset disabled className='min-w-0'>
              {children}
            </fieldset>
          </div>
        ) : (
          <>
            <ScopeLegend />
            {children}
          </>
        )}
      </PanelBody>
    </>
  )
}

/** A placement: a field, a slot card, a widget, a header strip item or the subtitle. */
function PlacementInspector({
  target,
  row,
  notice,
  readOnly = false
}: {
  target: DesignTarget
  row: PlacementRow | null
  /** Shown first in the body (inherited: where it comes from). */
  notice?: ReactNode
  readOnly?: boolean
}) {
  const env = useInspectorEnv()
  const field = target.kind === 'group' ? '' : target.field
  const groupKey =
    row?.group_key ?? (target.kind === 'group' ? null : (placementOf(target)?.group_key ?? null))
  const where = sectionLabel(env.bundle, groupKey)

  if (field === SUBTITLE_FIELD)
    return (
      <SimplePanel eyebrow='Header' title='Subtitle' notice={notice} readOnly={readOnly}>
        <SubtitleInspector />
      </SimplePanel>
    )
  if (row && (WIDGET_RE.test(field) || row.widget_id != null))
    return (
      <SimplePanel
        eyebrow={<Breadcrumb kind='Widget' target={target} where={where} />}
        title={row.label_override || 'Widget'}
        notice={notice}
        readOnly={readOnly}
      >
        <WidgetInspector row={row} />
      </SimplePanel>
    )
  if (isSlotField(field))
    return (
      <SimplePanel
        eyebrow={<Breadcrumb kind='Panel' target={target} where={where} />}
        title={slotName(field)}
        notice={notice}
        readOnly={readOnly}
      >
        <SlotInspector field={field} groupKey={groupKey} row={row} />
      </SimplePanel>
    )
  if (!row) return null
  if (target.kind === 'header' || row.group_key === HEADER_GROUP_KEY)
    return <HeaderItem row={row} notice={notice} readOnly={readOnly} />
  return (
    <FieldInspector target={target} row={row} where={where} notice={notice} readOnly={readOnly} />
  )
}

function HeaderItem({
  row,
  notice,
  readOnly
}: {
  row: PlacementRow
  notice?: ReactNode
  readOnly: boolean
}) {
  const env = useInspectorEnv()
  const { data: meta } = useCollectionMeta(env.collection)
  const label = describeField(row.field, meta?.fields ?? [], meta?.relations ?? [], null).label
  return (
    <SimplePanel
      eyebrow='Header strip'
      title={row.label_override || label}
      sub={<KeyLine k={row.field} />}
      notice={notice}
      readOnly={readOnly}
    >
      <HeaderItemInspector row={row} label={label} />
    </SimplePanel>
  )
}

const EMPTY_META: CollectionMeta = { fields: [], relations: [], label: '' }

function FieldInspector({
  target,
  row,
  where,
  notice,
  readOnly
}: {
  target: DesignTarget
  row: PlacementRow
  where: string | null
  notice?: ReactNode
  readOnly: boolean
}) {
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
      dependency_config: asObject(info.global?.dependency_config),
      columns: {
        deprecated: !!info.global?.deprecated_at,
        deprecation_note: info.global?.deprecation_note || null
      }
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
    { key: 'help', label: 'Help' },
    { key: 'advanced', label: 'Advanced' }
  ]
  const [tab, setTab] = useState<TabKey>('look')
  const tabsId = useId()
  const active = tabs.some((t) => t.key === tab) ? tab : 'look'
  // Tabs still switch in a read-only (inherited) view; the fieldset disables the controls.
  const tabBody = (
    <fieldset disabled={readOnly} className='min-w-0'>
      {!meta ? (
        <p className='text-[13px] text-slate-500 dark:text-muted-foreground'>Loading the field…</p>
      ) : active === 'look' ? (
        <LookTab />
      ) : active === 'rules' ? (
        <RulesTab />
      ) : active === 'picker' ? (
        <PickerTab />
      ) : active === 'grid' ? (
        <GridTab />
      ) : active === 'help' ? (
        <div data-help-tab='' className='space-y-5'>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Help text and the placeholder are on the Look tab.
          </p>
          <HelpVideoSetting kind='field' name={row.field} label={info.label} />
          <NoteSetting
            target={{ kind: 'field', field: row.field, group_key: row.group_key }}
            name={info.label}
          />
        </div>
      ) : (
        <AdvancedTab />
      )}
    </fieldset>
  )

  return (
    <FieldCtxContext.Provider value={ctx}>
      <GlobalWriterContext.Provider value={writer}>
        <PanelHeader
          eyebrow={<Breadcrumb kind='Field' target={target} where={where} />}
          title={info.label}
          sub={<KeyLine words={meta ? fieldKindWords(info) : undefined} k={row.field} />}
        >
          <PanelTabs
            idBase={tabsId}
            label={`Settings of ${info.label}`}
            tabs={tabs}
            active={active}
            onChange={(t) => {
              env.flush()
              setTab(t)
            }}
          />
        </PanelHeader>
        {/* Keyed by tab: a new tab opens at its top, not where the last one was scrolled. */}
        <PanelBody
          key={active}
          tabpanel={{ id: tabPanelId(tabsId), labelledBy: tabId(tabsId, active) }}
        >
          {notice}
          {readOnly ? (
            <div data-inherited-view='' className='opacity-70'>
              {tabBody}
            </div>
          ) : (
            <>
              <ScopeLegend field />
              {tabBody}
            </>
          )}
        </PanelBody>
      </GlobalWriterContext.Provider>
    </FieldCtxContext.Provider>
  )
}
