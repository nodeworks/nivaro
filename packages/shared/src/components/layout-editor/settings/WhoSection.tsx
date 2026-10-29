import { useState } from 'react'
import { RecordConditionsEditor, RecordConditionsJson } from '../editors/RecordConditionsEditor'
import { RolesPicker } from '../editors/RolesPicker'
import { DependencyDiagram } from '../ops/DependencyDiagram'
import { useLayoutDependencies } from '../ops/ops-api'
import { LAYOUT_TYPES } from '../overview/OverviewActions'
import { useRoleNames } from '../overview/overview-api'
import { roleIdsPatch } from '../testing/testing-model'
import { quietText, Segmented, Setting, smallBtn } from './controls'
import { ActiveDatesSetting, PhoneVersionSetting, TabletVersionSetting } from './ResolveSettings'
import { changeLabel, flag, type SectionProps } from './section-props'
import { useCollectionLayoutList, useFieldSources } from './settings-api'
import { type LayoutKind, layoutKindOf } from './settings-registry'
import { TextSetting } from './TextSetting'
import { ToggleSetting } from './ToggleSetting'

const kindLabel = (k: LayoutKind) => LAYOUT_TYPES.find((t) => t.type === k)?.label ?? k

/** Link names: lowercase letters, digits and _ (what the server keeps). */
export const sanitizeSlug = (raw: string) => raw.toLowerCase().replace(/[^a-z0-9_]/g, '_')

const slugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')

function roleIdsOf(conditions: unknown): string[] {
  let c = conditions
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c)
    } catch {
      return []
    }
  }
  const ids = (c as { role_ids?: unknown } | null)?.role_ids
  return Array.isArray(ids) ? ids.map(String) : []
}

export function WhoSection(props: SectionProps) {
  const { layout, collection } = props
  const { fields, columns, relations } = useFieldSources(collection)
  const { data: roles = [] } = useRoleNames(true)
  const roleIds = roleIdsOf(layout.conditions)
  return (
    <>
      <KindSetting {...props} />
      <Setting
        k='layout.record_conditions'
        note={
          <RecordConditionsJson
            value={layout.record_conditions}
            onApply={(rules) =>
              props.set({ record_conditions: rules }, changeLabel('layout.record_conditions'))
            }
          />
        }
      >
        <RecordConditionsEditor
          json={false}
          collection={collection}
          value={layout.record_conditions}
          fields={fields}
          columns={columns}
          relations={relations}
          onBlur={props.flush}
          onChange={(rules, { text }) =>
            (text ? props.setText : props.set)(
              { record_conditions: rules },
              changeLabel('layout.record_conditions')
            )
          }
        />
      </Setting>
      <Setting k='layout.conditions.role_ids'>
        <RolesPicker
          value={roleIds}
          roles={roles}
          onChange={(ids) =>
            props.set(
              // Keeps the layout's pinned test records (conditions.testing).
              roleIdsPatch(layout.conditions, ids),
              ids.length > roleIds.length ? 'Add a role' : 'Remove a role'
            )
          }
        />
      </Setting>
      <TextSetting
        k='layout.slug'
        props={props}
        mono
        placeholder='e.g. unit_order'
        sanitize={sanitizeSlug}
        blurOnly
        extra={
          !layout.slug && typeof layout.name === 'string' && slugFromName(layout.name) ? (
            <button
              type='button'
              className={smallBtn}
              onClick={() =>
                props.set({ slug: slugFromName(String(layout.name)) }, 'Generate link name')
              }
            >
              Generate
            </button>
          ) : null
        }
        note={
          layout.slug ? (
            <>
              Opens with <code className='font-mono'>?layout={String(layout.slug)}</code>
              <SlugUsers layoutId={Number(layout.id)} />
            </>
          ) : null
        }
      />
      <TextSetting
        k='layout.create_label'
        props={props}
        placeholder={typeof layout.name === 'string' ? layout.name : ''}
      />
      <ToggleSetting k='layout.create_hidden' props={props} />
      <ActiveDatesSetting {...props} />
      <PhoneVersionSetting {...props} />
      <TabletVersionSetting {...props} />
    </>
  )
}

/** #2613 — before a link name changes: what finds this layout by it, drawn. */
function SlugUsers({ layoutId }: { layoutId: number }) {
  const { data } = useLayoutDependencies(layoutId)
  const [open, setOpen] = useState(false)
  const bySlug = (data?.nodes ?? []).filter((n) => n.breaks.includes('slug')).length
  if (!bySlug) return null
  return (
    <>
      {' · '}
      <button
        type='button'
        data-slug-users
        className='font-medium text-amber-700 hover:underline dark:text-amber-300'
        onClick={() => setOpen((o) => !o)}
      >
        {bySlug} {bySlug === 1 ? 'thing finds' : 'things find'} it by this name
      </button>
      {open && <DependencyDiagram layoutId={layoutId} change='slug' compact className='mt-2' />}
    </>
  )
}

function KindSetting(props: SectionProps) {
  const { layout, kind, bundle } = props
  const [confirm, setConfirm] = useState<LayoutKind | null>(null)
  // #2613 — what relies on this layout is drawn before its kind changes.
  const { data: deps } = useLayoutDependencies(Number(layout.id))
  const used = (deps?.nodes.length ?? 0) > 0
  const placed = bundle.placements.length + bundle.groups.length
  const change = (to: LayoutKind) =>
    props.set({ layout_type: to }, `Change kind to ${kindLabel(to)}`)
  const isDefault = flag(layout.is_active)
  // Through the draft, so the save does not wipe undo; the server applies it
  // through the type-scoped activate rule (the previous default of this kind
  // steps down). Not an undo step: its inverse would leave the kind with no
  // default instead of bringing the previous one back — hence the confirm.
  const [confirmDefault, setConfirmDefault] = useState(false)
  const layouts = useCollectionLayoutList(props.collection)
  const current = layouts.find(
    (l) => l.id !== Number(layout.id) && layoutKindOf(l) === kind && flag(l.is_active)
  )
  const noun = kind === 'grouped' ? 'form' : `${kindLabel(kind).toLowerCase()} layout`
  const makeDefault = () => {
    props.set({ is_active: true }, 'Make default', { undoable: false })
    setConfirmDefault(false)
  }

  // Whether this is the default sits after the effect sentence (Setting's note).
  const defaultNote =
    kind === 'file' ? null : (
      <div className='flex flex-wrap items-center gap-2'>
        {isDefault ? (
          <span className={quietText} data-default-layout>
            This is the default {kindLabel(kind).toLowerCase()} layout: records no rule or role
            catches use it.
          </span>
        ) : confirmDefault ? (
          <div
            data-make-default-confirm
            className='w-full rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'
          >
            <p>
              {current ? (
                <>
                  <strong className='font-semibold'>{current.name}</strong> stops being the default{' '}
                  {noun} for records no rule catches.
                </>
              ) : (
                <>No {noun} is the default yet; this one becomes it.</>
              )}{' '}
              This cannot be undone with Undo.
            </p>
            <div className='mt-1.5 flex gap-1.5'>
              <button
                type='button'
                data-action='make-default-confirm'
                className={smallBtn}
                onClick={makeDefault}
              >
                Yes, make default
              </button>
              <button type='button' className={smallBtn} onClick={() => setConfirmDefault(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type='button'
              data-action='make-default'
              className={smallBtn}
              onClick={() => setConfirmDefault(true)}
            >
              Make default
            </button>
            <span className={quietText}>
              Records no rule or role catches would open with this layout.
            </span>
          </>
        )}
      </div>
    )

  return (
    <Setting k='layout.layout_type' note={defaultNote}>
      <Segmented<LayoutKind>
        ariaLabel='Kind of layout'
        value={kind}
        options={LAYOUT_TYPES.map((t) => ({ value: t.type, label: t.label }))}
        onChange={(to) => (placed > 0 || used ? setConfirm(to) : change(to))}
      />
      {confirm && (
        <div
          data-kind-confirm={confirm}
          className='rounded-md border border-amber-300 bg-amber-50 p-2.5 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'
        >
          <p>
            Make this a {kindLabel(confirm)} layout? Its sections and fields stay, but{' '}
            {confirm === 'file'
              ? 'tabs, widgets and slot cards do not appear in a PDF.'
              : confirm === 'table'
                ? 'grid columns use only its fields, not its sections.'
                : 'some of them may not apply to this kind.'}
          </p>
          {used && (
            <DependencyDiagram
              layoutId={Number(layout.id)}
              change='type'
              compact
              className='mt-2 rounded-md bg-white p-2 text-slate-800 dark:bg-card dark:text-foreground'
            />
          )}
          <div className='mt-1.5 flex gap-1.5'>
            <button
              type='button'
              className={smallBtn}
              onClick={() => {
                change(confirm)
                setConfirm(null)
              }}
            >
              Yes, change it
            </button>
            <button type='button' className={smallBtn} onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Setting>
  )
}
