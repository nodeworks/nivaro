import { useQuery } from '@tanstack/react-query'
import { useContext } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import type { CascadeFilterRule } from '../editors/cascade-filters'
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
    ctx.proposeGlobal(settingKey, value, label, (d) => {
      const rows = asArray<Record<string, unknown>>(d.dependency_config.cascade_filters)
      const next = rows.map((r, j) => (j === i ? (withKey(r, key, value) ?? {}) : r))
      return {
        ...d,
        dependency_config: withKey(d.dependency_config, 'cascade_filters', next) ?? {}
      }
    })

  return (
    <div className='space-y-4'>
      {!special && (
        <Setting
          k='field.impact'
          label='Where this field is used'
          effect='Check here before renaming or deleting the field.'
        >
          {isLoading ? (
            <p className='text-[11px] text-muted-foreground'>Looking…</p>
          ) : (impacts ?? []).length === 0 ? (
            <p className='text-[11px] text-muted-foreground'>Nothing else refers to {name}.</p>
          ) : (
            <ul className='space-y-0.5 text-[12px]'>
              {(impacts ?? []).slice(0, 30).map((i, n) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: impact rows can repeat a label
                <li key={n} className='flex justify-between gap-2'>
                  <span className='truncate text-foreground'>{i.label}</span>
                  <span className='shrink-0 text-[11px] text-muted-foreground'>{i.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </Setting>
      )}

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
        <Section title='Cascade filters (raw)'>
          {cascades.map((r, i) => (
            <div
              key={`${r.parent_field}:${r.filter_column}`}
              className='space-y-2 rounded-md border border-slate-200 p-2 dark:border-border'
            >
              <p className='text-[11px] text-muted-foreground'>
                Filter {i + 1}: by <span className='font-mono'>{r.parent_field}</span> on{' '}
                <span className='font-mono'>{r.filter_column}</span>
              </p>
              <Toggle
                k='field.cascade_filters.filter_via_many'
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

      <Section title='Stored settings without an editor'>
        {RAW_OPTION_KEYS.map((r) => (
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
    </div>
  )
}
