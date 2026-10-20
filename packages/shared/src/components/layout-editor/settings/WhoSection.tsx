import { useState } from 'react'
import { RecordConditionsEditor } from '../editors/RecordConditionsEditor'
import { RolesPicker } from '../editors/RolesPicker'
import { LAYOUT_TYPES } from '../overview/OverviewActions'
import { useRoleNames } from '../overview/overview-api'
import { quietText, Segmented, Setting, smallBtn } from './controls'
import { changeLabel, flag, type SectionProps } from './section-props'
import { useFieldSources } from './settings-api'
import type { LayoutKind } from './settings-registry'
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
      <Setting k='layout.record_conditions'>
        <RecordConditionsEditor
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
              { conditions: ids.length ? { role_ids: ids } : null },
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
    </>
  )
}

function KindSetting(props: SectionProps) {
  const { layout, kind, bundle } = props
  const [confirm, setConfirm] = useState<LayoutKind | null>(null)
  const placed = bundle.placements.length + bundle.groups.length
  const change = (to: LayoutKind) =>
    props.set({ layout_type: to }, `Change kind to ${kindLabel(to)}`)
  const isDefault = flag(layout.is_active)
  // Through the draft like every other setting, so it is one undoable step and
  // the refetch after it does not wipe undo. The server applies it through the
  // type-scoped activate rule (the previous default of this kind steps down).
  const makeDefault = () => props.set({ is_active: true }, 'Make default')

  return (
    <Setting k='layout.layout_type'>
      <Segmented<LayoutKind>
        ariaLabel='Kind of layout'
        value={kind}
        options={LAYOUT_TYPES.map((t) => ({ value: t.type, label: t.label }))}
        onChange={(to) => (placed > 0 ? setConfirm(to) : change(to))}
      />
      {confirm && (
        <div
          data-kind-confirm={confirm}
          className='mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'
        >
          <p>
            Make this a {kindLabel(confirm)} layout? Its sections and fields stay, but{' '}
            {confirm === 'file'
              ? 'tabs, widgets and slot cards do not appear in a PDF.'
              : confirm === 'table'
                ? 'grid columns use only its fields, not its sections.'
                : 'some of them may not apply to this kind.'}
          </p>
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
      {kind !== 'file' && (
        <div className='mt-2 flex items-center gap-2'>
          {isDefault ? (
            <span className={quietText} data-default-layout>
              This is the default {kindLabel(kind).toLowerCase()} layout: records no rule or role
              catches use it.
            </span>
          ) : (
            <>
              <button
                type='button'
                data-action='make-default'
                className={smallBtn}
                onClick={makeDefault}
              >
                Make default
              </button>
              <span className={quietText}>
                Records no rule or role catches would open with this layout.
              </span>
            </>
          )}
        </div>
      )}
    </Setting>
  )
}
