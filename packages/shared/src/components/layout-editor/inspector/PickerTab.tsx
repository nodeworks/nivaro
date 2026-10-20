import { useQuery } from '@tanstack/react-query'
import { useContext, useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { type CascadeFilterRule, CascadeFiltersEditor } from '../editors/cascade-filters'
import { useFieldCtx } from './field-context'
import {
  Choice,
  GlobalWriterContext,
  Section,
  Setting,
  TextInput,
  Toggle,
  useGlobalValue
} from './kit'
import { asArray, asObject, describeField, relKindOf, withKey } from './model'

type Rel = {
  many_collection?: string
  many_field?: string
  one_collection?: string
  one_field?: string | null
  junction_field?: string | null
}

export function useRelationsFor(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<Rel[]>({
    queryKey: ['layout-editor', 'relations-for', collection],
    queryFn: () =>
      client
        .request<{ data: Rel[] }>(get(`/data-model/relations/for/${collection}`))
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: !!collection,
    staleTime: 5 * 60_000
  })
}

export function useLayoutsOf(collection: string | null | undefined) {
  const client = useNivaroClient()
  return useQuery<Array<{ id: number; name: string; slug?: string | null; layout_type?: string }>>({
    queryKey: ['layout-editor', 'layouts-of', collection],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; name: string; layout_type?: string }> }>(
          get('/collection-layouts', { collection })
        )
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: !!collection,
    staleTime: 60_000
  })
}

/** "60%" (10–96) or pixels (320–2000); anything else is not a width. */
export function parsePanelWidth(v: string): string | number | null | 'invalid' {
  const t = v.trim()
  if (!t) return null
  const pct = /^(\d{1,3})%$/.exec(t)
  if (pct) {
    const n = Number(pct[1])
    return n >= 10 && n <= 96 ? `${n}%` : 'invalid'
  }
  if (/^\d+$/.test(t)) {
    const n = Number(t)
    return n >= 320 && n <= 2000 ? n : 'invalid'
  }
  return 'invalid'
}

export function PickerTab() {
  const ctx = useFieldCtx()
  const { info, ov, opts, env, globalOptions, globalDependency } = ctx
  const name = info.label
  const isM2O = info.relKind === 'M2O'
  const isM2M = info.relKind === 'M2M'
  const isPath = info.iface === 'relation-path' || info.isPath
  const isFile = info.iface === 'file-image' || info.iface === 'files-m2m'
  const isGrouped = info.iface === 'relation-grouped'

  // Drill-down
  const dd = asObject(ov.drilldown) as {
    enabled?: boolean
    layout_id?: number | null
    width?: unknown
  }
  const ddEnabled = dd.enabled ?? isPath
  const ddTarget =
    info.relatedCollection ??
    (typeof globalOptions.path_target_collection === 'string'
      ? globalOptions.path_target_collection
      : null)
  const { data: targetLayouts = [] } = useLayoutsOf(isM2O || isM2M || isPath ? ddTarget : null)
  const detailLayouts = targetLayouts.filter((l) => l.layout_type === 'detail')
  const storedWidth = dd.width == null ? '' : String(dd.width)
  const [widthText, setWidthText] = useState(storedWidth)
  // Undo / another writer: show the stored width unless what is typed already means it.
  useEffect(() => {
    setWidthText((cur) => {
      const w = parsePanelWidth(cur)
      return (w === null ? '' : String(w)) === storedWidth ? cur : storedWidth
    })
  }, [storedWidth])
  const widthParsed = parsePanelWidth(widthText)
  const setDd = (patch: Record<string, unknown>, label: string, text?: boolean) =>
    ctx.setOverride('drilldown', { ...dd, enabled: ddEnabled, ...patch }, label, text)

  // Grouped combobox — M2O fields on the target collection
  const { data: targetRels = [] } = useRelationsFor(isGrouped ? info.relatedCollection : null)
  const targetM2O = targetRels
    .filter(
      (r) => r.many_collection === info.relatedCollection && r.many_field && !r.junction_field
    )
    .map((r) => ({ value: r.many_field as string, label: `${r.many_field} → ${r.one_collection}` }))
  const groupField = useGlobalValue(
    'field.group_field',
    typeof globalOptions.group_field === 'string' ? globalOptions.group_field : ''
  )
  const optionField = useGlobalValue(
    'field.option_field',
    typeof globalOptions.option_field === 'string' ? globalOptions.option_field : ''
  )

  // Cascade filters (nivaro_fields.dependency_config — every form). Read from the
  // pending draft like the raw rows in Advanced, so a change made there is kept.
  const draftDependency = useContext(GlobalWriterContext)?.draft.dependency_config
  const rules = asArray<CascadeFilterRule>((draftDependency ?? globalDependency).cascade_filters)
  const names = new Set<string>(ctx.globals.map((f) => f.field))
  for (const r of ctx.relations) {
    if (r.one_field && r.one_field !== 'id' && r.one_collection === env.collection)
      names.add(r.one_field)
    if (r.many_field && r.many_collection === env.collection) names.add(r.many_field)
  }
  const parents = [...names]
    .filter((f) => f !== info.field)
    .map((f) => ({ f, kind: relKindOf(f, ctx.relations) }))
    .filter((x): x is { f: string; kind: 'M2O' | 'M2M' } => x.kind === 'M2O' || x.kind === 'M2M')
    .map(({ f, kind }) => {
      const placed = env.bundle.placements.find((p) => p.field === f) ?? null
      return {
        field: f,
        label: describeField(f, ctx.globals, ctx.relations, placed).label,
        kind
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const fileOpt = (key: string, fallback: boolean) => {
    const stored =
      typeof globalOptions[key] === 'boolean' ? (globalOptions[key] as boolean) : fallback
    return stored
  }
  const allowUpload = useGlobalValue('field.allow_upload', fileOpt('allow_upload', true))
  const allowPick = useGlobalValue('field.allow_pick', fileOpt('allow_pick', true))
  const pendingSave = useGlobalValue('field.pending_save', fileOpt('pending_save', false))

  return (
    <div className='space-y-4'>
      {(isM2O || isM2M) && (
        <>
          <Toggle
            k='field.inline_relation'
            label='Edit the related record here'
            effect='Shows the picked record’s fields inline so people can change them without leaving.'
            checked={opts.inline_relation === true}
            onChange={(v) =>
              ctx.setOption(
                'inline_relation',
                v ? true : undefined,
                v ? `Edit ${name} inline` : `Stop editing ${name} inline`
              )
            }
          />
          <Setting
            k='field.option_sort'
            label='Order of the options'
            effect='Columns of the related record, "-" for descending; "label" sorts by what people read.'
          >
            <TextInput
              ariaLabel='Order of the options'
              mono
              value={typeof opts.option_sort === 'string' ? opts.option_sort : ''}
              placeholder='-year, name'
              onChange={(v) =>
                ctx.setOption(
                  'option_sort',
                  v.trim() ? v : undefined,
                  `Change the order of ${name} options`,
                  true
                )
              }
            />
          </Setting>
        </>
      )}
      {isM2O && (
        <Toggle
          k='field.enforce_picker_rules'
          label='Refuse values the picker would not offer'
          effect='The server rejects a value outside the cascade filters and option filters, from any writer.'
          enforced
          checked={opts.enforce_picker_rules === true}
          onChange={(v) =>
            ctx.setOption(
              'enforce_picker_rules',
              v ? true : undefined,
              v
                ? `Enforce the picker rules of ${name}`
                : `Stop enforcing the picker rules of ${name}`
            )
          }
        />
      )}

      {(isM2O || isM2M || isPath) && (
        <Section title='Detail panel'>
          <Toggle
            k='field.drilldown.enabled'
            label='Click the value to open it'
            effect='Opens the related record in a side panel.'
            checked={ddEnabled}
            onChange={(v) =>
              setDd(
                { enabled: v },
                v ? `Open ${name} in a panel` : `Stop opening ${name} in a panel`
              )
            }
          />
          <Setting
            k='field.drilldown.layout_id'
            label='Panel layout'
            effect='The layout the side panel shows the record with.'
          >
            <Choice
              ariaLabel='Panel layout'
              disabled={!ddEnabled}
              value={dd.layout_id == null ? '' : String(dd.layout_id)}
              options={[
                { value: '', label: 'The default detail view' },
                ...detailLayouts.map((l) => ({ value: String(l.id), label: l.name }))
              ]}
              onChange={(v) =>
                setDd({ layout_id: v ? Number(v) : null }, `Change the panel layout of ${name}`)
              }
            />
          </Setting>
          <Setting
            k='field.drilldown.width'
            label='Panel width'
            effect='A percent of the window (10–96%) or pixels (320–2000). Empty: the default.'
          >
            <input
              aria-label='Panel width'
              disabled={!ddEnabled}
              value={widthText}
              placeholder='60%'
              onChange={(e) => {
                setWidthText(e.target.value)
                const w = parsePanelWidth(e.target.value)
                if (w !== 'invalid') setDd({ width: w }, `Change the panel width of ${name}`, true)
              }}
              onBlur={() => env.flush()}
              className='h-7 w-full rounded-md border border-slate-200 bg-white px-2 font-mono text-[12px] focus:border-nvr-cyan focus:outline-none disabled:opacity-40 dark:border-border dark:bg-card'
            />
            {widthParsed === 'invalid' && (
              <p className='text-[11px] text-red-600 dark:text-red-400'>
                Not a width — nothing saved
              </p>
            )}
          </Setting>
        </Section>
      )}

      {isGrouped && (
        <Section title='Grouped list'>
          <Setting
            k='field.group_field'
            label='Group options by'
            scope='field'
            effect='A field of the related record whose value heads each group.'
          >
            <Choice
              ariaLabel='Group options by'
              value={groupField}
              options={[{ value: '', label: 'Not grouped' }, ...targetM2O]}
              onChange={(v) =>
                ctx.proposeGlobalOption(
                  'field.group_field',
                  'group_field',
                  v || undefined,
                  `Group the ${name} options`,
                  v
                )
              }
            />
          </Setting>
          <Setting
            k='field.option_field'
            label='Option field'
            scope='field'
            effect='The field whose records are the options inside each group.'
          >
            <Choice
              ariaLabel='Option field'
              value={optionField}
              options={[{ value: '', label: 'The related record itself' }, ...targetM2O]}
              onChange={(v) =>
                ctx.proposeGlobalOption(
                  'field.option_field',
                  'option_field',
                  v || undefined,
                  `Change the ${name} options`,
                  v
                )
              }
            />
          </Setting>
        </Section>
      )}

      {(isM2O || isM2M) && (
        <Setting
          k='field.cascade_filters'
          label='Narrow the options by another field'
          scope='field'
          effect='Only options matching the value picked in a parent field are offered.'
        >
          <CascadeFiltersEditor
            rules={rules}
            m2oFields={parents}
            relatedCollection={info.relatedCollection}
            onChange={(next) =>
              ctx.proposeGlobal(
                'field.cascade_filters',
                next,
                `Change how ${name} options are narrowed`,
                (d) => ({
                  ...d,
                  dependency_config:
                    withKey(
                      d.dependency_config,
                      'cascade_filters',
                      next.length ? next : undefined
                    ) ?? {}
                })
              )
            }
          />
        </Setting>
      )}

      {isFile && (
        <Section title='Files'>
          <Toggle
            k='field.allow_upload'
            label='Allow uploads'
            effect='People can upload new files into this field.'
            scope='field'
            checked={allowUpload}
            onChange={(v) =>
              ctx.proposeGlobalOption(
                'field.allow_upload',
                'allow_upload',
                v,
                v ? `Allow uploads to ${name}` : `Stop uploads to ${name}`
              )
            }
          />
          <Toggle
            k='field.allow_pick'
            label='Allow picking existing files'
            effect='People can attach files that are already stored.'
            scope='field'
            checked={allowPick}
            onChange={(v) =>
              ctx.proposeGlobalOption(
                'field.allow_pick',
                'allow_pick',
                v,
                `Change file picking for ${name}`
              )
            }
          />
          {info.iface === 'files-m2m' && (
            <Toggle
              k='field.pending_save'
              label='Save files with the form'
              scope='field'
              effect='Links wait for the record’s Save instead of saving at once.'
              checked={pendingSave}
              onChange={(v) =>
                ctx.proposeGlobalOption(
                  'field.pending_save',
                  'pending_save',
                  v || undefined,
                  `Change when ${name} files save`,
                  v
                )
              }
            />
          )}
        </Section>
      )}
      {!(isM2O || isM2M || isPath || isFile) && (
        <p className='text-[12px] text-muted-foreground'>
          {name} is not a picker. Nothing to set here.
        </p>
      )}
    </div>
  )
}
