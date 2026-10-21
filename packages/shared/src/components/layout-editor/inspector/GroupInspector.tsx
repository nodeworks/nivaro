import { useEffect, useState } from 'react'
import { readGroupStructure } from '../../../lib/form-structure'
import type { GroupPatch, GroupRow } from '../../../lib/layout-ops'
import { lazySectionPatch, lazySectionsOf } from '../../../lib/layout-resolve'
import { titleCase } from '../../../lib/utils'
import { RuleWriter } from '../ai-rules/RuleWriter'
import { RoleConditionRow } from '../editors/lock-conditions'
import { O2MAggFieldCombobox } from '../editors/o2m-agg-field'
import { SwapConfigEditor } from '../editors/swap-config'
import { IconPicker } from '../pickers/icon-picker'
import { SectionReuseActions } from '../reuse/SectionReuseActions'
import { emptyTextOp, rowUpdatePlan, stickyPlan } from '../section-structure'
import { useCollectionMeta } from './field-context'
import {
  Choice,
  ConditionBuilder,
  FieldMultiPicker,
  type RecordCondition,
  Section,
  Segmented,
  Setting,
  TextArea,
  TextInput,
  Toggle,
  useInspectorEnv
} from './kit'
import { asArray, describeField, groupFields, relatedCollectionOf, relKindOf } from './model'
import { GroupTranslations } from './Translations'

const TYPE_LABELS: Record<string, string> = {
  section: 'Section',
  tab: 'Tab or step',
  metadata: 'Record info (read-only)',
  container: 'Tabs or steps holder',
  content: 'Text block'
}

type SummaryEntry = {
  field: string
  label?: string | null
  agg?: string
  agg_field?: string
  field_options?: string | null
}

function toEntry(x: unknown): SummaryEntry | null {
  if (typeof x === 'string') return { field: x }
  if (x && typeof x === 'object' && typeof (x as SummaryEntry).field === 'string')
    return x as SummaryEntry
  return null
}

function fromEntry(e: SummaryEntry): unknown {
  const { field, label, agg, agg_field, field_options } = e
  if (!label && !agg) return field
  return {
    field,
    ...(label ? { label } : {}),
    ...(agg ? { agg, agg_field, ...(field_options ? { field_options } : {}) } : {})
  }
}

const jsonList = (list: unknown[]): string | null => (list.length ? JSON.stringify(list) : null)

export function GroupInspector({ group, readOnly }: { group: GroupRow; readOnly?: boolean }) {
  const env = useInspectorEnv()
  const { data: meta } = useCollectionMeta(env.collection)
  const globals = meta?.fields ?? []
  const relations = meta?.relations ?? []
  const name = group.label || titleCase(group.key)
  const type = group.type
  const update = (patch: GroupPatch, label: string, text?: boolean) =>
    env.apply([{ op: 'group_update', key: group.key, patch }], { label, text })

  const children = env.bundle.groups.filter((g) => g.parent_key === group.key)
  const containers = env.bundle.groups.filter((g) => g.type === 'container' && g.key !== group.key)
  // A tabs holder shows only its tabs and a text block only its text, so a group that holds
  // fields is not offered either (the save refuses it too: the fields would show nowhere).
  const holdsFields = env.bundle.placements.some((p) => p.group_key === group.key)
  const typeOptions = (group.parent_key ? ['tab'] : Object.keys(TYPE_LABELS))
    .filter((t) => t === type || !(holdsFields && (t === 'container' || t === 'content')))
    .map((t) => ({ value: t, label: TYPE_LABELS[t] }))
  const sectionLike = type === 'section' || type === 'metadata' || type === 'tab'
  // #2713: kept in the layout's conditions.lazy_sections, by section key.
  const lazy = lazySectionsOf(env.bundle.layout.conditions).includes(group.key)
  const accordion = !!env.bundle.layout.accordion_mode
  const structure = readGroupStructure(group.swap_config)

  // Fields of the collection, by label (pickers + condition builder)
  const fieldOptions = globals
    .filter((f) => !f.field.startsWith('__') && f.type !== 'alias')
    .map((f) => ({ value: f.field, label: f.label || titleCase(f.field) }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // Collapsed summary — the fields this section places
  const placed = groupFields(env.bundle, group.key)
  const summary = asArray<unknown>(group.summary_fields)
    .map(toEntry)
    .filter((e): e is SummaryEntry => !!e)
  const setSummary = (next: SummaryEntry[], label: string, text?: boolean) =>
    update({ summary_fields: jsonList(next.map(fromEntry)) }, label, text)

  // Step conditions: incomplete rows stay on screen, complete ones are saved.
  const stored = asArray<RecordCondition>(group.visible_when)
  const storedSig = JSON.stringify(stored)
  const [conds, setConds] = useState<RecordCondition[]>(stored)
  useEffect(() => {
    setConds((cur) =>
      JSON.stringify(cur.filter((c) => c.field)) === storedSig
        ? cur
        : (JSON.parse(storedSig) as RecordCondition[])
    )
  }, [storedSig])

  const [confirmDelete, setConfirmDelete] = useState(false)

  return (
    <fieldset disabled={readOnly} className='min-w-0 space-y-5'>
      <Setting k='group.label' label='Name' effect='The heading people see.'>
        <TextInput
          ariaLabel='Name'
          value={group.label}
          onChange={(v) => update({ label: v }, `Rename ${name}`, true)}
        />
      </Setting>
      <Setting k='group.icon' label='Icon' effect='Shown before the section title.'>
        <IconPicker
          className='h-8 rounded-md border-slate-200 bg-white px-2.5 text-[13px] hover:bg-white dark:border-border dark:bg-background dark:hover:bg-background'
          value={group.icon ?? ''}
          onChange={(v) => update({ icon: v || null }, `Change the icon of ${name}`)}
        />
      </Setting>
      <Setting
        k='group.type'
        label='Kind'
        effect={
          type === 'container' && children.length
            ? 'Move its tabs out before changing what this is.'
            : holdsFields && !group.parent_key
              ? 'What this part of the form is. To make it a tabs holder or a text block, move its fields out first.'
              : 'What this part of the form is.'
        }
      >
        <Choice
          ariaLabel='Kind'
          disabled={type === 'container' && children.length > 0}
          value={type}
          options={typeOptions}
          onChange={(v) =>
            update(
              v === 'container' ? { type: v, tab_mode: group.tab_mode ?? 'tabs' } : { type: v },
              `Make ${name} a ${TYPE_LABELS[v]?.toLowerCase()}`
            )
          }
        />
      </Setting>

      {type === 'container' && (
        <Setting
          k='group.tab_mode'
          label='Show its tabs as'
          effect='Steps walk people through in order.'
        >
          <Segmented
            value={group.tab_mode === 'steps' ? 'steps' : 'tabs'}
            options={[
              { value: 'tabs', label: 'Tabs' },
              { value: 'steps', label: 'Steps' }
            ]}
            onChange={(v) => update({ tab_mode: v }, `Show ${name} as ${v}`)}
          />
        </Setting>
      )}
      {type === 'tab' && (
        <Setting
          k='group.container_id'
          label='Sits in'
          effect='Tabs show inside a tabs or steps holder.'
        >
          <Choice
            ariaLabel='Sits in'
            value={group.parent_key ?? ''}
            options={[
              { value: '', label: 'The form itself' },
              ...containers.map((c) => ({ value: c.key, label: c.label || titleCase(c.key) }))
            ]}
            onChange={(v) =>
              env.apply(
                [
                  {
                    op: 'group_move',
                    key: group.key,
                    parent_key: v || null,
                    index: Number.MAX_SAFE_INTEGER
                  }
                ],
                { label: v ? `Move ${name} into a holder` : `Move ${name} out of its holder` }
              )
            }
          />
        </Setting>
      )}
      {(type === 'section' || type === 'metadata') && (
        <Toggle
          k='group.is_collapsed'
          label='Starts collapsed'
          effect='The section opens folded; people unfold it.'
          checked={group.is_collapsed}
          onChange={(v) => update({ is_collapsed: v }, v ? `Collapse ${name}` : `Expand ${name}`)}
        />
      )}
      {(type === 'section' || type === 'metadata') && (
        <Toggle
          k='group.load_on_open'
          label='Load when opened'
          effect={
            group.is_collapsed || accordion
              ? 'Its pickers, grids and widgets load only once someone opens it; a lighter open for every record.'
              : 'Turn on Starts collapsed first: an open section loads straight away.'
          }
          checked={lazy}
          disabled={!lazy && !group.is_collapsed && !accordion}
          onChange={(v) =>
            env.apply(
              [
                {
                  op: 'layout_update',
                  patch: lazySectionPatch(env.bundle.layout.conditions, group.key, v)
                }
              ],
              { label: v ? `Load ${name} when opened` : `Load ${name} with the form` }
            )
          }
        />
      )}
      {type === 'content' && (
        <>
          <Setting
            k='group.content_tone'
            label='Style'
            effect='Note and Warning are coloured boxes; Divider is a line with the text.'
          >
            <Segmented
              value={group.content_tone ?? 'info'}
              options={[
                { value: 'info', label: 'Note' },
                { value: 'warn', label: 'Warning' },
                { value: 'divider', label: 'Divider' }
              ]}
              onChange={(v) => update({ content_tone: v }, `Change the style of ${name}`)}
            />
          </Setting>
          <Setting k='group.content' label='Text' effect='The words this block shows on the form.'>
            <TextArea
              ariaLabel='Text'
              value={group.content ?? ''}
              onChange={(v) => update({ content: v || null }, `Edit the text of ${name}`, true)}
            />
          </Setting>
        </>
      )}
      {(type === 'section' || type === 'tab') && (
        <>
          <Setting
            k='group.content'
            label='Intro'
            effect='A short note at the top: what to fill in here and why. Empty shows none.'
          >
            <TextArea
              ariaLabel='Intro'
              value={group.content ?? ''}
              onChange={(v) => update({ content: v || null }, `Edit the intro of ${name}`, true)}
            />
          </Setting>
          {!!group.content?.trim() && (
            <Setting
              k='group.content_tone'
              label='Intro style'
              effect='Note is a quiet box; Warning is amber.'
            >
              <Segmented
                value={group.content_tone === 'warn' ? 'warn' : 'info'}
                options={[
                  { value: 'info', label: 'Note' },
                  { value: 'warn', label: 'Warning' }
                ]}
                onChange={(v) => update({ content_tone: v }, `Change the intro style of ${name}`)}
              />
            </Setting>
          )}
        </>
      )}

      {sectionLike && (
        <>
          <Setting
            k='group.visibility_mode'
            label='Show'
            effect='On new records, existing ones or both.'
          >
            <Segmented
              value={group.visibility_mode ?? 'always'}
              options={[
                { value: 'always', label: 'Always' },
                { value: 'new_only', label: 'New records' },
                { value: 'existing_only', label: 'Existing' }
              ]}
              onChange={(v) => update({ visibility_mode: v }, `Change when ${name} shows`)}
            />
          </Setting>
          <Toggle
            k='group.hide_when_empty'
            label='Hide when all its fields are empty'
            effect='The section disappears while none of its fields has a value.'
            checked={group.hide_when_empty}
            onChange={(v) => update({ hide_when_empty: v }, `Change when ${name} hides`)}
          />
          <Setting
            k='group.read_width'
            label='Width when reading'
            effect='On the read view, summary and detail panels. Automatic: half for a short list, full for grids.'
          >
            <Segmented
              value={group.read_width ?? ''}
              options={[
                { value: '', label: 'Automatic' },
                { value: 'full', label: 'Full' },
                { value: 'half', label: '½' },
                { value: 'third', label: '⅓' }
              ]}
              onChange={(v) =>
                update({ read_width: v || null }, `Change the read width of ${name}`)
              }
            />
          </Setting>
          <Setting
            k='group.empty_text'
            label='When nothing is filled'
            effect='Shown in the read view and the PDF instead of empty values, such as “No shipping details yet”. Empty: the values show as dashes.'
          >
            <TextInput
              ariaLabel='When nothing is filled'
              value={structure.emptyText ?? ''}
              placeholder='No details yet'
              onChange={(v) =>
                env.apply([emptyTextOp(group, v)], {
                  label: `Change the empty text of ${name}`,
                  text: true
                })
              }
            />
          </Setting>
          {type === 'section' && !group.parent_key && (
            <Toggle
              k='group.sticky'
              label='Stick to the top'
              effect='Stays at the top of the form while people scroll the rest, for totals or status. One section per form; not on phones.'
              checked={structure.sticky}
              onChange={(v) => {
                const plan = stickyPlan(env.bundle, group.key, v)
                if (plan.ok) env.apply(plan.ops, { label: plan.label })
              }}
            />
          )}
        </>
      )}

      {(type === 'section' || type === 'tab') && (
        <Section title='Side by side'>
          <Setting
            k='group.row_groups'
            label='Rows of fields'
            effect='Short fields that share one row under one label, like Street / City / Zip. To add one, select the fields on the form, right-click and pick Put side by side.'
          >
            {structure.rows.length === 0 ? (
              <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                No rows yet.
              </p>
            ) : (
              <div className='space-y-2'>
                {structure.rows.map((r) => (
                  <div key={r.key} className='space-y-1' data-row-group-setting={r.key}>
                    <div className='flex items-center gap-1.5'>
                      <div className='min-w-0 flex-1'>
                        <TextInput
                          ariaLabel={`Label of the row ${r.label}`}
                          value={r.label}
                          onChange={(v) => {
                            const plan = rowUpdatePlan(env.bundle, group.key, r.key, { label: v })
                            if (plan.ok) env.apply(plan.ops, { label: plan.label, text: true })
                          }}
                        />
                      </div>
                      <button
                        type='button'
                        onClick={() => {
                          const plan = rowUpdatePlan(env.bundle, group.key, r.key, null)
                          if (plan.ok) env.apply(plan.ops, { label: plan.label })
                        }}
                        className='shrink-0 rounded-md px-2 py-1 text-[12px] text-slate-600 hover:bg-muted hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                      >
                        Take apart
                      </button>
                    </div>
                    <p className='truncate text-[12px] text-slate-500 dark:text-muted-foreground'>
                      {r.fields
                        .map((f) => {
                          const placement =
                            env.bundle.placements.find(
                              (p) => p.field === f && p.group_key === group.key
                            ) ?? null
                          return describeField(f, globals, relations, placement).label
                        })
                        .join(' · ')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Setting>
        </Section>
      )}

      {type === 'tab' && (
        <Section title='As a step'>
          <Setting
            k='group.skip_if_filled'
            label='Skip as the first step when filled'
            effect='Opens on a later step when these fields already have values.'
          >
            <FieldMultiPicker
              ariaLabel='Skip as the first step when filled'
              value={asArray<string>(group.skip_if_filled)}
              options={fieldOptions}
              onChange={(v) =>
                update({ skip_if_filled: jsonList(v) }, `Change when ${name} is skipped`)
              }
            />
          </Setting>
          <Setting
            k='group.visible_when'
            label='Only when'
            effect='The step shows only while every condition holds. No conditions: always.'
          >
            <ConditionBuilder
              value={conds}
              fields={fieldOptions}
              onChange={(next) => {
                setConds(next)
                const complete = next.filter((c) => c.field)
                if (JSON.stringify(complete) !== storedSig)
                  update({ visible_when: jsonList(complete) }, `Change when ${name} shows`, true)
              }}
            />
            <RuleWriter
              layoutId={Number(env.bundle.layout.id)}
              target={{ kind: 'step', group: group.key }}
              bundle={env.bundle}
              apply={(ops, o) => env.apply(ops, o)}
              disabled={readOnly}
            />
          </Setting>
        </Section>
      )}

      {sectionLike && (
        <Section title='Who'>
          <Setting
            k='group.hidden_for_roles'
            label='Hidden for'
            effect='People in these roles do not see it. Admins always do.'
          >
            <RoleConditionRow
              roleIds={asArray<string>(group.hidden_for_roles)}
              onRoleIdsChange={(ids) =>
                update({ hidden_for_roles: jsonList(ids) }, `Change who sees ${name}`)
              }
            />
          </Setting>
          <Setting
            k='group.locked_for_roles'
            label='Read-only for'
            effect='People in these roles cannot change it; the server drops their writes. Admins are exempt.'
          >
            <RoleConditionRow
              roleIds={asArray<string>(group.locked_for_roles)}
              onRoleIdsChange={(ids) =>
                update({ locked_for_roles: jsonList(ids) }, `Change who can edit ${name}`)
              }
            />
          </Setting>
        </Section>
      )}

      {sectionLike && (
        <Section title='When collapsed'>
          <Setting
            k='group.summary_fields'
            label='Show these values in the heading'
            effect='A short summary while the section is closed.'
          >
            {placed.length === 0 ? (
              <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                Place fields in {name} first.
              </p>
            ) : (
              <div className='space-y-1.5'>
                {placed.map((f) => {
                  const entry = summary.find((e) => e.field === f)
                  const isO2M = relKindOf(f, relations) === 'O2M'
                  const placement = env.bundle.placements.find((p) => p.field === f) ?? null
                  const label = describeField(f, globals, relations, placement).label
                  const patchEntry = (patch: Partial<SummaryEntry>, l: string, text?: boolean) =>
                    setSummary(
                      summary.map((e) => (e.field === f ? { ...e, ...patch } : e)),
                      l,
                      text
                    )
                  return (
                    <div key={f} className='space-y-1'>
                      <label className='flex items-center gap-2 text-[12px]'>
                        <input
                          type='checkbox'
                          checked={!!entry}
                          onChange={(e) =>
                            setSummary(
                              e.target.checked
                                ? [...summary, isO2M ? { field: f, agg: 'count' } : { field: f }]
                                : summary.filter((x) => x.field !== f),
                              `Change the summary of ${name}`
                            )
                          }
                          className='h-3.5 w-3.5 accent-nvr-cyan'
                        />
                        <span className='flex-1 truncate'>{label}</span>
                        {isO2M && (
                          <span className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                            list
                          </span>
                        )}
                      </label>
                      {entry && (
                        <div className='space-y-1 pl-5'>
                          <div data-setting='group.summary_fields.label'>
                            <TextInput
                              ariaLabel={`Label for ${label}`}
                              value={entry.label ?? ''}
                              placeholder={`Label (${label})`}
                              onChange={(v) =>
                                patchEntry(
                                  { label: v || null },
                                  `Change the summary of ${name}`,
                                  true
                                )
                              }
                            />
                          </div>
                          {isO2M && (
                            <div className='flex gap-1'>
                              <div className='flex-1' data-setting='group.summary_fields.agg'>
                                <Choice
                                  ariaLabel='Show'
                                  value={entry.agg ?? 'count'}
                                  options={[
                                    { value: 'count', label: 'Count' },
                                    { value: 'sum', label: 'Sum' },
                                    { value: 'avg', label: 'Average' },
                                    { value: 'min', label: 'Smallest' },
                                    { value: 'max', label: 'Largest' }
                                  ]}
                                  onChange={(v) =>
                                    patchEntry(
                                      v === 'count'
                                        ? { agg: v, agg_field: undefined, field_options: undefined }
                                        : { agg: v },
                                      `Change the summary of ${name}`
                                    )
                                  }
                                />
                              </div>
                              {(entry.agg ?? 'count') !== 'count' && (
                                <div
                                  className='flex-1'
                                  data-setting='group.summary_fields.agg_field'
                                >
                                  <O2MAggFieldCombobox
                                    relatedCollection={relatedCollectionOf(f, relations)}
                                    value={entry.agg_field ?? ''}
                                    onChange={(field, fieldOptions) =>
                                      patchEntry(
                                        { agg_field: field, field_options: fieldOptions },
                                        `Change the summary of ${name}`
                                      )
                                    }
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Setting>
          <Toggle
            k='group.summary_hide_empty'
            label='Leave out empty values'
            effect='Fields without a value are left out of the summary line.'
            checked={group.summary_hide_empty}
            onChange={(v) => update({ summary_hide_empty: v }, `Change the summary of ${name}`)}
          />
        </Section>
      )}

      {sectionLike && (
        <SwapConfigEditor
          group={{ id: group.id ?? 0, swap_config: group.swap_config }}
          allFields={globals.map((f) => ({ field: f.field, type: f.type ?? undefined }))}
          onGroupSettings={(_id, patch) => update(patch, `Change the field swap of ${name}`)}
        />
      )}

      {!readOnly && (
        <SectionReuseActions bundle={env.bundle} collection={env.collection} group={group} />
      )}
      <GroupTranslations group={group} />

      <div
        data-setting='group.delete'
        className='border-t border-slate-200 pt-3 dark:border-border'
      >
        {confirmDelete ? (
          <div className='space-y-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-[12px] text-red-900 dark:border-red-800/60 dark:bg-red-950/30 dark:text-red-100'>
            <p>
              Delete {name}? Its fields move to the top of the form
              {children.length ? ' and its tabs move out' : ''}. Undo brings it back.
            </p>
            <div className='flex gap-2'>
              <button
                type='button'
                onClick={() =>
                  env.apply([{ op: 'group_remove', key: group.key, placements: 'ungroup' }], {
                    label: `Delete ${name}`
                  })
                }
                className='rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-700'
              >
                Delete
              </button>
              <button
                type='button'
                onClick={() => setConfirmDelete(false)}
                className='rounded-md px-2.5 py-1 text-[12px] hover:bg-red-100 dark:hover:bg-red-900/40'
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <button
            type='button'
            onClick={() => setConfirmDelete(true)}
            className='text-[12px] text-red-600 hover:underline dark:text-red-400'
          >
            Delete {TYPE_LABELS[type]?.toLowerCase() ?? 'section'}
          </button>
        )}
      </div>
    </fieldset>
  )
}
