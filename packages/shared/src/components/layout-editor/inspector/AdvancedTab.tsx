import { useQuery } from '@tanstack/react-query'
import { useContext } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import type { CascadeFilterRule } from '../editors/cascade-filters'
import { tintCard } from '../panel-style'
import { showsRawOption } from './applies'
import { useFieldCtx } from './field-context'
import {
  DraftInput,
  GlobalWriterContext,
  JsonInput,
  Section,
  Setting,
  Toggle,
  useGlobalValue
} from './kit'
import { asArray, withKey } from './model'

/** Stored option keys that have no editor yet — kept and editable as JSON. */
const RAW_OPTION_KEYS: Array<{ key: string; label: string; effect: string }> = [
  {
    key: 'row_bulk_actions',
    label: 'Row bulk actions',
    effect: 'Actions offered on selected rows.'
  },
  { key: 'picker_facets', label: 'Picker facets', effect: 'Filter chips inside the picker.' },
  {
    key: 'option_filter',
    label: 'Option filter',
    effect: 'A filter the picker applies to its options.'
  },
  { key: 'row_filter', label: 'Row filter', effect: 'Which child rows this grid shows.' },
  { key: 'row_defaults', label: 'Row defaults', effect: 'Values a new row starts with.' },
  {
    key: 'allocate_drawer',
    label: 'Allocation drawer',
    effect: 'The allocation panel of each row.'
  },
  { key: 'auto_allocate', label: 'Auto-allocate', effect: 'Fills allocations automatically.' },
  { key: 'upload_template', label: 'Upload template', effect: 'Rows from an uploaded file.' },
  {
    key: 'quick_create',
    label: 'Quick create',
    effect: 'Creating a related record from the picker.'
  }
]

interface FieldImpact {
  source: string
  label: string
  detail: string
}

/** "Layout 'Order form'" → "Order form (layout)": the name first, no quotes. */
export function impactPlace(i: FieldImpact): string {
  const m = /^(.*?)\s*'(.*)'$/.exec(i.label)
  return m ? `${m[2]} (${m[1].toLowerCase()})` : i.label
}

/** What the reference does, in plain words (the API's detail is a machine-ish note). */
export function impactUse(i: FieldImpact): string {
  switch (i.source) {
    case 'layout':
      return i.detail === 'field assignment'
        ? 'Shows this field'
        : 'Shows a value reached through this field'
    case 'display-template':
      return 'Names records in lists and pickers'
    case 'picker-filter':
      return 'Narrows a picker'
    case 'field-rule':
      return i.detail === 'trigger field' ? 'Starts a field rule' : 'Filled in by a field rule'
    case 'at-risk-rule':
      return 'Part of an at-risk condition'
    case 'alert':
      return 'Watched by an alert'
    case 'field-watch':
      return 'Watched for changes'
    case 'rule':
      return 'Used by a rule'
    case 'workflow-transition':
      return 'Checked before a step can move on'
    case 'saved-view':
      return 'May be a column or filter of a saved view'
    default:
      return i.detail ? i.detail.charAt(0).toUpperCase() + i.detail.slice(1) : ''
  }
}

export function AdvancedTab() {
  const ctx = useFieldCtx()
  const client = useNivaroClient()
  const { info, ov, opts, env, globalDependency } = ctx
  const name = info.label
  const g = info.global
  const deprecated = useGlobalValue('field.deprecated', !!g?.deprecated_at)
  const note = useGlobalValue('field.deprecation_note', g?.deprecation_note ?? '')
  const special = info.field.startsWith('__')

  const { data: impacts, isLoading } = useQuery({
    queryKey: ['layout-editor', 'field-impact', env.collection, info.field],
    queryFn: () =>
      client
        .request<{ data: FieldImpact[] }>(
          get(`/data-model/${env.collection}/fields/${encodeURIComponent(info.field)}/impact`)
        )
        .then((r) => r.data ?? []),
    enabled: !special,
    staleTime: 60_000
  })

  // Raw cascade rows show the pending draft, so a change waits beside the others.
  const draftDependency = useContext(GlobalWriterContext)?.draft.dependency_config
  const cascades = asArray<CascadeFilterRule & Record<string, unknown>>(
    (draftDependency ?? globalDependency).cascade_filters
  )
  const proposeCascade = (
    settingKey: string,
    i: number,
    key: string,
    value: unknown,
    label: string
  ) =>
    ctx.proposeGlobal(
      settingKey,
      value,
      label,
      (d) => {
        const rows = asArray<Record<string, unknown>>(d.dependency_config.cascade_filters)
        const next = rows.map((r, j) => (j === i ? (withKey(r, key, value) ?? {}) : r))
        return {
          ...d,
          dependency_config: withKey(d.dependency_config, 'cascade_filters', next) ?? {}
        }
      },
      `${settingKey}#${i}`
    )

  const rawKeys = RAW_OPTION_KEYS.filter((r) => showsRawOption(r.key, info, opts[r.key]))

  return (
    <div className='space-y-5'>
      {!special && (
        <Setting
          k='field.impact'
          label='Where this field is used'
          effect='Check here before renaming or deleting the field.'
        >
          {isLoading ? (
            <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
              Looking…
            </p>
          ) : (impacts ?? []).length === 0 ? (
            <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
              Nothing else refers to {name}.
            </p>
          ) : (
            <ul className='space-y-1.5 text-[12px]'>
              {(impacts ?? []).slice(0, 30).map((i, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: impact rows can repeat a label
                <li key={n} data-impact={i.source} className='min-w-0'>
                  <p className='truncate text-slate-800 dark:text-foreground'>{impactPlace(i)}</p>
                  <p className='truncate text-slate-500 dark:text-muted-foreground'>
                    {impactUse(i)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Setting>
      )}

      {!special && (
        <Section title='For API callers'>
          <Toggle
            k='field.deprecated'
            label='Deprecated'
            scope='field'
            effect='GraphQL marks the field deprecated; it is removed only after the policy window.'
            checked={deprecated}
            onChange={(v) =>
              ctx.proposeGlobal(
                'field.deprecated',
                v,
                v ? `Deprecate ${name}` : `Stop deprecating ${name}`,
                (d) => ({
                  ...d,
                  columns: v
                    ? { ...d.columns, deprecated: true }
                    : { ...d.columns, deprecated: false, deprecation_note: null }
                })
              )
            }
          />
          <Setting
            k='field.deprecation_note'
            label='What callers should use instead'
            effect='API callers see it as the deprecation reason.'
            scope='field'
          >
            <DraftInput
              ariaLabel='What callers should use instead'
              value={note ?? ''}
              placeholder={deprecated ? 'e.g. use vendor_id' : 'Deprecate the field first'}
              onCommit={(v) =>
                ctx.proposeGlobal(
                  'field.deprecation_note',
                  v,
                  `Change the deprecation note of ${name}`,
                  (d) => ({ ...d, columns: { ...d.columns, deprecation_note: v || null } })
                )
              }
            />
          </Setting>
        </Section>
      )}

      {cascades.length > 0 && (
        <Section title='Cascade filters (raw)' collapsible>
          {cascades.map((r, i) => (
            <div
              key={`${r.parent_field}:${r.filter_column}`}
              className={cn(tintCard, 'space-y-4 p-3')}
            >
              <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
                Filter {i + 1}: by <span className='font-mono'>{r.parent_field}</span> on{' '}
                <span className='font-mono'>{r.filter_column}</span>
              </p>
              <Toggle
                k='field.cascade_filters.filter_via_many'
                confirmAt={`field.cascade_filters.filter_via_many#${i}`}
                label='Filter through the many side'
                effect='Matches options through a many-to-many link instead of a column on the option.'
                scope='field'
                checked={r.filter_via_many === true}
                onChange={(v) =>
                  proposeCascade(
                    'field.cascade_filters.filter_via_many',
                    i,
                    'filter_via_many',
                    v || undefined,
                    `Change filter ${i + 1} of ${name}`
                  )
                }
              />
              <Setting
                k='field.cascade_filters.value_map'
                confirmAt={`field.cascade_filters.value_map#${i}`}
                label='Value map'
                effect='Turns the parent value into the option value before filtering: {"parent": "option"}.'
                scope='field'
              >
                <JsonInput
                  ariaLabel='Value map'
                  rows={3}
                  value={r.value_map ?? null}
                  onCommit={(v) =>
                    proposeCascade(
                      'field.cascade_filters.value_map',
                      i,
                      'value_map',
                      v,
                      `Change the value map of filter ${i + 1} of ${name}`
                    )
                  }
                />
              </Setting>
              <Setting
                k='field.cascade_filters.value_map_default'
                confirmAt={`field.cascade_filters.value_map_default#${i}`}
                label='Value map default'
                effect='Used when the parent value is not in the value map.'
                scope='field'
              >
                <JsonInput
                  ariaLabel='Value map default'
                  rows={1}
                  value={r.value_map_default ?? null}
                  onCommit={(v) =>
                    proposeCascade(
                      'field.cascade_filters.value_map_default',
                      i,
                      'value_map_default',
                      v,
                      `Change the value map default of filter ${i + 1} of ${name}`
                    )
                  }
                />
              </Setting>
            </div>
          ))}
        </Section>
      )}

      <Section title='Edit as JSON' collapsible>
        <Setting
          k='field.overrides_raw'
          label='This form’s settings as JSON'
          effect='Everything this form changes about the field. Saved when you leave the box, if it parses.'
        >
          <JsonInput
            ariaLabel='This form’s settings as JSON'
            rows={6}
            value={Object.keys(ov).length ? ov : null}
            validate={(v) =>
              v && typeof v === 'object' && !Array.isArray(v) ? null : 'Needs a JSON object'
            }
            onCommit={(v) =>
              ctx.setPlacement({ overrides: v ?? null }, `Edit the settings of ${name} as JSON`)
            }
          />
        </Setting>

        {info.iface === 'inline-table' && (
          <Setting
            k='field.row_rules.sources_when'
            label='Row rules as JSON'
            effect='For settings the rule editor does not show, such as a source gate (sources[].when).'
          >
            <JsonInput
              ariaLabel='Row rules as JSON'
              rows={6}
              value={opts.row_rules ?? null}
              validate={(v) => (Array.isArray(v) ? null : 'Needs a list of rules')}
              onCommit={(v) => ctx.setOption('row_rules', v, `Edit the rules of ${name} as JSON`)}
            />
          </Setting>
        )}
      </Section>

      {rawKeys.length > 0 && (
        <Section title='Stored settings without an editor' collapsible>
          {rawKeys.map((r) => (
            <Setting key={r.key} k={`field.${r.key}`} label={r.label} effect={r.effect}>
              <JsonInput
                ariaLabel={r.label}
                rows={2}
                value={opts[r.key] ?? null}
                onCommit={(v) =>
                  ctx.setOption(r.key, v, `Change the ${r.label.toLowerCase()} of ${name}`)
                }
              />
            </Setting>
          ))}
        </Section>
      )}
    </div>
  )
}
