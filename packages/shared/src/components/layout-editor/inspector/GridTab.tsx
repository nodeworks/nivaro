import { useQueries } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { titleCase } from '../../../lib/utils'
import { type CascadeRuleCfg, CascadeRuleRow } from '../editors/cascade-rule-row'
import {
  type ColumnPresetItem,
  ColumnPresetRow,
  type DrawerRelationItem,
  DrawerRelationRow,
  isM2MIfacePreset,
  PRESET_NON_DISPLAY_TYPES,
  PRESET_SENTINEL_FIELDS,
  PRESET_SPECIAL_GROUP_KEYS,
  type PresetOptionGroup
} from '../editors/grid-presets'
import { LayoutPicker } from '../editors/layout-picker'
import { RowRuleLint, RowRuleTester } from '../editors/row-rule-check'
import {
  NUMERIC_FIELD_TYPES,
  ROW_RULE_SKIP_TYPES,
  type RowRuleItem,
  RowRuleRow,
  reorder
} from '../editors/row-rule-row'
import { useFieldCtx } from './field-context'
import {
  AddButton,
  Buffered,
  Choice,
  FieldMultiPicker,
  JsonInput,
  Section,
  Segmented,
  Setting,
  TextInput,
  Toggle,
  useGlobalValue
} from './kit'
import { asArray, relKindOf } from './model'
import { useRelationsFor } from './PickerTab'
import { useFieldRows } from './RulesTab'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const SKIP_TYPES = new Set(['alias', 'o2m', 'm2m', 'm2a', 'presentation', 'group', 'divider'])
const O2M_IFACES = new Set(['inline-table', 'inline-grid', 'list-o2m', 'relation-list'])

/** The JSON-configured grid features: key, label, effect, example, what must be present. */
const JSON_KEYS: Array<{
  key: string
  label: string
  effect: string
  placeholder: string
  rows?: number
  enforced?: boolean
  check: (v: unknown) => string | null
}> = [
  {
    key: 'catalog_mode',
    label: 'Catalog picker',
    effect:
      'Replaces the grid with the full catalog of item_field’s records under sections by section_by; a quantity creates the row.',
    placeholder: '{ "item_field": "item", "section_by": "categories.name" }',
    check: (v) =>
      isObj(v) && v.item_field && v.section_by ? null : 'Needs item_field and section_by'
  },
  {
    key: 'row_match_panel',
    label: 'Row match panel',
    effect: 'In the row editor, shows the record this row is matched to, or which key disagrees.',
    placeholder:
      '{ "relation": "po_line_items", "columns": [{ "path": "number", "label": "PO #" }] }',
    check: (v) =>
      isObj(v) && v.relation && Array.isArray(v.columns) ? null : 'Needs relation and columns[]'
  },
  {
    key: 'header_summary',
    label: 'Header figure',
    effect: 'A number over these rows shown in the record header; the formula runs per row.',
    placeholder: '{ "label": "Unallocated", "formula": "item.amount - item.allocated_total" }',
    check: (v) => (isObj(v) && v.label && v.formula ? null : 'Needs label and formula')
  },
  {
    key: 'line_sla',
    label: 'Line SLA',
    effect:
      'Rows still missing a field N days after a state get a clock and a daily notice. Off until enabled is true.',
    placeholder: '{ "enabled": false, "field": "requisition_id", "days": 5 }',
    enforced: true,
    check: (v) =>
      isObj(v) && v.field && typeof v.days === 'number' ? null : 'Needs field and a number of days'
  },
  {
    key: 'row_lints',
    label: 'Row checks',
    effect: 'When the first condition holds the second must too; failing rows get a marker.',
    placeholder:
      '[{ "label": "…", "when": { "field": "a", "value": "1" }, "expect": { "field": "b", "op": "nnull" } }]',
    enforced: true,
    check: (v) => (Array.isArray(v) && v.length ? null : 'Needs a list of checks')
  },
  {
    key: 'stats',
    label: 'Figure strip',
    effect: 'Figures above the grid. Tokens: {{$parent.field}}, {{$sum.column}}, {{$count}}.',
    placeholder: '[{ "label": "Left", "value": "{{$parent.amount}} - {{$sum.total}}" }]',
    check: (v) => (Array.isArray(v) && v.length ? null : 'Needs a list of figures')
  },
  {
    key: 'sum_cap',
    label: 'Sum cap',
    effect: 'A row cannot be saved when the column total would pass the cap (browser side).',
    placeholder: '{ "field": "total", "cap": "{{$parent.amount}}" }',
    rows: 3,
    check: (v) => (isObj(v) && v.field && v.cap != null ? null : 'Needs field and cap')
  },
  {
    key: 'spread_remaining',
    label: 'Spread remaining',
    effect: 'A row-editor button that spreads the remaining amount over empty fields.',
    placeholder:
      '{ "fields": ["january", "february"], "remaining": "{{$parent.amount}} - {{$sum.total}}" }',
    rows: 3,
    check: (v) =>
      isObj(v) && Array.isArray(v.fields) && v.remaining ? null : 'Needs fields[] and remaining'
  },
  {
    key: 'compare_series',
    label: 'Comparison series',
    effect: 'A read-only second line of figures under the cells, from an endpoint.',
    placeholder: '{ "endpoint": "/my-extension/actuals/{{$parent.id}}", "label": "Actual" }',
    rows: 3,
    check: (v) =>
      isObj(v) && typeof v.endpoint === 'string' && v.endpoint ? null : 'Needs endpoint'
  },
  {
    key: 'row_split',
    label: 'Plan grid',
    effect: 'Shows rows as a key × period plan grid with split and merge.',
    placeholder:
      '{ "key_field": "year", "category_field": "category", "value_fields": ["january"] }',
    check: (v) =>
      isObj(v) && v.key_field && v.category_field && Array.isArray(v.value_fields)
        ? null
        : 'Needs key_field, category_field and value_fields[]'
  }
]

function drawerItems(stored: unknown[]): DrawerRelationItem[] {
  return stored.map((d, i) =>
    typeof d === 'string'
      ? { field: d, sumField: '', capField: '', _key: `d${i}` }
      : {
          field: String((d as Obj)?.field ?? ''),
          sumField: String(((d as Obj)?.hint as Obj | undefined)?.sum_field ?? ''),
          capField: String(((d as Obj)?.hint as Obj | undefined)?.cap_field ?? ''),
          _key: `d${i}`
        }
  )
}

function drawerStored(items: DrawerRelationItem[]): unknown[] {
  return items
    .filter((d) => d.field)
    .map((d) =>
      d.sumField && d.capField
        ? { field: d.field, hint: { sum_field: d.sumField, cap_field: d.capField } }
        : d.field
    )
}

export function GridTab() {
  const ctx = useFieldCtx()
  const client = useNivaroClient()
  const { info, opts, env, row } = ctx
  const name = info.label
  const isTable = info.iface === 'inline-table'
  const child = info.relatedCollection
  const collection = env.collection

  const { data: childRels = [] } = useRelationsFor(child)
  const { data: childAllFields = [] } = useFieldRows(isTable ? child : null)
  const { data: parentAllFields = [] } = useFieldRows(isTable ? collection : null)
  const { data: parentRels = [] } = useRelationsFor(isTable ? collection : null)
  const gridLayoutId = typeof opts.layout_id === 'number' ? opts.layout_id : null
  const { data: presetLayoutFields = [] } = useFieldRows(isTable ? child : null, gridLayoutId)

  const childM2OFields = childRels
    .filter((r) => r.many_collection === child && r.many_field && !r.junction_field)
    .map((r) => ({ value: r.many_field as string, label: `${r.many_field} → ${r.one_collection}` }))
  const childM2ORels = childRels
    .filter(
      (r) => r.many_collection === child && r.many_field && r.one_collection && !r.junction_field
    )
    .map((r) => ({
      many_field: r.many_field as string,
      one_collection: r.one_collection as string
    }))
  const childO2MRels = childRels
    .filter((r) => r.one_collection === child && r.many_collection && !r.junction_field)
    .map((r) => ({
      one_field: !r.one_field || r.one_field === 'id' ? (r.many_collection as string) : r.one_field,
      many_collection: r.many_collection as string
    }))
  const drawerRelationOptions = childO2MRels.map((r) => ({
    value: r.one_field,
    label: `${r.one_field} → ${r.many_collection}`,
    collection: r.many_collection
  }))
  const parentM2OFields = useMemo(() => {
    const names = new Set<string>()
    for (const r of ctx.relations)
      if (r.many_collection === collection && r.many_field && r.one_collection && !r.junction_field)
        names.add(r.many_field)
    return [...names]
      .filter((f) => relKindOf(f, ctx.relations) === 'M2O')
      .map((f) => ({
        value: f,
        label: ctx.globals.find((g) => g.field === f)?.label || titleCase(f)
      }))
  }, [ctx.relations, ctx.globals, collection])
  const parentRelated = useMemo(() => {
    const map: Record<string, string> = {}
    for (const r of parentRels) {
      if (r.many_collection === collection && r.many_field && r.one_collection && !r.junction_field)
        map[r.many_field] = r.one_collection
      if (r.one_collection === collection && r.junction_field && r.many_collection && r.one_field) {
        const far = parentRels.find(
          (c) =>
            c.many_collection === r.many_collection &&
            c.many_field === r.junction_field &&
            c.one_collection !== collection
        )
        if (far?.one_collection) map[r.one_field] = far.one_collection
      }
    }
    return map
  }, [parentRels, collection])

  const ruleFields = useMemo(() => {
    const seen = new Map<string, (typeof childAllFields)[number]>()
    for (const f of childAllFields) {
      if (f.hidden || f.field === 'id' || f.field.startsWith('__')) continue
      if (ROW_RULE_SKIP_TYPES.has(f.type ?? '')) continue
      if (O2M_IFACES.has((f as { interface?: string | null }).interface ?? '')) continue
      const existing = seen.get(f.field)
      if (!existing || (!existing.label && f.label)) seen.set(f.field, f)
    }
    return [...seen.values()]
  }, [childAllFields])
  const uniqueByOptions = childAllFields.filter(
    (f) => !f.hidden && f.field !== 'id' && !SKIP_TYPES.has(f.type ?? '')
  )
  const numericChildFields = uniqueByOptions.filter((f) => NUMERIC_FIELD_TYPES.has(f.type ?? ''))

  // ── Layout-local lists ──
  const parentCascades = asArray<CascadeRuleCfg>(opts.parent_cascades)
  const setCascades = (next: CascadeRuleCfg[], label: string, text?: boolean) =>
    ctx.setOption('parent_cascades', next.length ? next : undefined, label, text)

  const rules = asArray<RowRuleItem>(opts.row_rules)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.sort ?? a.i) - (b.r.sort ?? b.i))
    .map(({ r }) => r)
  const setRules = (next: RowRuleItem[], label: string, text?: boolean) =>
    ctx.setOption(
      'row_rules',
      next.length ? next.map((r, i) => ({ ...r, sort: i })) : undefined,
      label,
      text
    )
  const parentContext = asArray<string>(opts.parent_context_fields)
  const parentContextRich = parentContext.map((field) => ({
    field,
    label: parentAllFields.find((pf) => pf.field === field)?.label || field,
    one_collection: parentRelated[field] ?? null
  }))
  const uniqueBy = asArray<string>(opts.unique_by)
  const sortField = typeof opts.sort_field === 'string' ? opts.sort_field : ''
  const sortDir = opts.sort_dir === 'desc' ? 'desc' : 'asc'
  const storedGroupBy = typeof opts.section_group_by === 'string' ? opts.section_group_by : ''
  const [groupBy, setGroupBy] = useState(storedGroupBy)
  useEffect(() => {
    setGroupBy((cur) => (cur.trim() && !cur.includes('.') ? cur : storedGroupBy))
  }, [storedGroupBy])

  // Drawer relations: partial hints stay on screen until both halves are picked.
  const storedDrawer = asArray<unknown>(opts.drawer_relations)
  const storedDrawerSig = JSON.stringify(storedDrawer)
  const [drawer, setDrawer] = useState<DrawerRelationItem[]>(() => drawerItems(storedDrawer))
  useEffect(() => {
    setDrawer((cur) =>
      JSON.stringify(drawerStored(cur)) === storedDrawerSig
        ? cur
        : drawerItems(JSON.parse(storedDrawerSig) as unknown[])
    )
  }, [storedDrawerSig])
  const changeDrawer = (next: DrawerRelationItem[], label: string) => {
    setDrawer(next)
    const stored = drawerStored(next)
    if (JSON.stringify(stored) !== storedDrawerSig)
      ctx.setOption('drawer_relations', stored.length ? stored : undefined, label)
  }

  // ── Every-form grid keys (nivaro_fields.options) ──
  const g = ctx.globalOptions
  const showTotals = useGlobalValue('field.grid_show_totals', g.grid_show_totals === true)
  const storedPresets = useMemo(
    () =>
      asArray<{ name: string; columns: string[] }>(g.column_presets).map((p, i) => ({
        name: p.name ?? '',
        columns: Array.isArray(p.columns) ? p.columns : [],
        _key: `p${i}`
      })),
    [g.column_presets]
  )
  const presets = useGlobalValue<ColumnPresetItem[]>('field.column_presets', storedPresets)
  const defaultPreset = useGlobalValue(
    'field.default_preset',
    typeof g.default_preset === 'string' ? g.default_preset : ''
  )
  const proposePresets = (next: ColumnPresetItem[]) =>
    ctx.proposeGlobal(
      'field.column_presets',
      next,
      {
        options: (() => {
          const valid = next
            .filter((p) => p.name.trim() && p.columns.length)
            .map((p) => ({ name: p.name.trim(), columns: p.columns }))
          const o: Obj = { ...g }
          if (valid.length) o.column_presets = valid
          else delete o.column_presets
          return o
        })()
      },
      `Change the column presets of ${name}`
    )

  // Column preset picker: the child layout's display columns + drawer relation members.
  const childToParent = childRels.find(
    (r) =>
      r.many_collection === child &&
      r.one_collection === collection &&
      !r.junction_field &&
      (r.one_field === info.field ||
        ((!r.one_field || r.one_field === 'id') && r.many_collection === info.field))
  )?.many_field
  const grandCollections = [
    ...new Set(
      drawer
        .map((d) => drawerRelationOptions.find((o) => o.value === d.field)?.collection)
        .filter((c): c is string => !!c)
    )
  ]
  const grandQueries = useQueries({
    queries: grandCollections.map((gc) => ({
      queryKey: ['layout-editor', 'field-rows', gc, null],
      queryFn: () =>
        client
          .request<{
            data: Array<{
              field: string
              label?: string | null
              type?: string
              hidden?: boolean
              group_key?: string | null
            }>
          }>(get(`/field-config/${gc}`))
          .then((r) => (Array.isArray(r.data) ? r.data : [])),
      staleTime: 60_000
    }))
  })
  const presetGroups: PresetOptionGroup[] = [
    {
      options: (presetLayoutFields as Array<Obj & { field: string }>)
        .filter(
          (f) =>
            !f.hidden &&
            (!PRESET_NON_DISPLAY_TYPES.has(String(f.type ?? '')) ||
              isM2MIfacePreset(f.interface as string | null)) &&
            f.field !== childToParent &&
            f.field !== 'id' &&
            (!gridLayoutId || f.layout_assigned === true) &&
            !PRESET_SENTINEL_FIELDS.has(f.field) &&
            !PRESET_SPECIAL_GROUP_KEYS.has(String(f.group_key ?? ''))
        )
        .map((f) => ({ field: f.field, label: String(f.label || titleCase(f.field)) }))
    },
    ...drawer.flatMap((d) => {
      const gc = drawerRelationOptions.find((o) => o.value === d.field)?.collection
      const rows = gc ? (grandQueries[grandCollections.indexOf(gc)]?.data ?? []) : []
      const options = rows
        .filter(
          (f) =>
            !f.hidden &&
            !PRESET_NON_DISPLAY_TYPES.has(f.type ?? '') &&
            f.field !== 'id' &&
            !PRESET_SENTINEL_FIELDS.has(f.field)
        )
        .map((f) => ({
          field: `${d.field}.${f.field}`,
          label: `${d.field} → ${f.label || titleCase(f.field)}`
        }))
      return options.length ? [{ heading: d.field, options }] : []
    })
  ]

  if (!child) {
    return (
      <p className='text-[12px] text-muted-foreground'>No related collection found for {name}.</p>
    )
  }

  return (
    <div className='space-y-4'>
      <Setting
        k='field.grid_layout'
        label='Rows use the layout'
        effect={
          isTable ? 'A table layout of the row collection.' : 'A form layout of the row collection.'
        }
      >
        <LayoutPicker
          collection={child}
          value={gridLayoutId}
          onChange={(id, slug) =>
            ctx.setOptions(
              { layout_id: id ?? undefined, layout_slug: slug ?? undefined },
              `Change the row layout of ${name}`
            )
          }
          layoutType={isTable ? 'table' : 'grouped'}
        />
      </Setting>

      {!isTable && (
        <Toggle
          k='field.grid_show_totals'
          label='Column totals'
          scope='field'
          effect='A totals row under number columns.'
          checked={showTotals}
          onChange={(v) =>
            ctx.proposeGlobalOption(
              'field.grid_show_totals',
              'grid_show_totals',
              v || undefined,
              `Change the totals of ${name}`
            )
          }
        />
      )}

      {isTable && (
        <>
          <Toggle
            k='field.save_mode'
            label='Save rows with the form'
            effect='Row edits wait for the record’s Save.'
            checked={opts.save_mode === 'pending'}
            onChange={(v) =>
              ctx.setOption(
                'save_mode',
                v ? 'pending' : 'immediate',
                v ? `Save ${name} with the form` : `Save ${name} rows at once`
              )
            }
          />
          <Toggle
            k='field.show_line_numbers'
            label='Line numbers'
            checked={opts.show_line_numbers === true}
            onChange={(v) =>
              ctx.setOption(
                'show_line_numbers',
                v || undefined,
                `Change the line numbers of ${name}`
              )
            }
          />
          <Toggle
            k='field.enable_reorder'
            label='Drag rows to reorder'
            checked={opts.enable_reorder !== false}
            onChange={(v) => ctx.setOption('enable_reorder', v, `Change row reordering of ${name}`)}
          />
          <Toggle
            k='field.row_comments'
            label='Line comments'
            effect='Comment threads on single rows, rolled into the record’s notes.'
            checked={opts.row_comments === true}
            onChange={(v) =>
              ctx.setOption('row_comments', v || undefined, `Change line comments of ${name}`)
            }
          />
          <Toggle
            k='field.freeze_first_column'
            label='Freeze the first column'
            effect='The grid scrolls sideways with the first column pinned.'
            checked={opts.freeze_first_column === true}
            onChange={(v) =>
              ctx.setOption(
                'freeze_first_column',
                v || undefined,
                `Change the first column of ${name}`
              )
            }
          />
          <Toggle
            k='field.show_row_revisions'
            label='Row history'
            effect='Each row shows who changed what.'
            checked={row.show_row_revisions}
            onChange={(v) =>
              ctx.setPlacement(
                { show_row_revisions: v },
                v ? `Show row history of ${name}` : `Hide row history of ${name}`
              )
            }
          />
          {row.show_row_revisions && (
            <Toggle
              k='field.allow_revision_restore'
              label='Allow restoring a row'
              checked={row.allow_revision_restore !== false}
              onChange={(v) =>
                ctx.setPlacement({ allow_revision_restore: v }, `Change row restore of ${name}`)
              }
            />
          )}

          <Section title='Cascade from the record'>
            <Setting
              k='field.parent_cascades'
              label='Narrow row pickers by a field of this record'
              effect='Parent: a picker on this form. Row field: a picker on each row.'
            >
              <Buffered value={parentCascades} className='space-y-1.5'>
                {(cascades, keep) => (
                  <>
                    {cascades.map((r, i) => (
                      <CascadeRuleRow
                        // biome-ignore lint/suspicious/noArrayIndexKey: cascade rows are positional
                        key={i}
                        rule={r}
                        parentFields={parentM2OFields}
                        childFields={childM2OFields}
                        onChange={(u) =>
                          setCascades(
                            keep(cascades.map((x, j) => (j === i ? u : x))),
                            `Change a cascade of ${name}`,
                            true
                          )
                        }
                        onRemove={() =>
                          setCascades(
                            keep(cascades.filter((_, j) => j !== i)),
                            `Remove a cascade from ${name}`
                          )
                        }
                      />
                    ))}
                    <AddButton
                      onClick={() =>
                        setCascades(
                          keep([...cascades, { parent_field: '', child_field: '' }]),
                          `Add a cascade to ${name}`
                        )
                      }
                    >
                      + Add cascade
                    </AddButton>
                  </>
                )}
              </Buffered>
            </Setting>
          </Section>

          <Section title='Row rules'>
            <Setting
              k='field.row_rules'
              label='Fill row fields automatically'
              effect='Each rule watches a row field and sets another when its condition holds.'
              enforced
            >
              <Buffered value={rules} className='space-y-1.5'>
                {(list, keep) => {
                  const save = (next: RowRuleItem[], label: string, text?: boolean) =>
                    setRules(keep(next), label, text)
                  return (
                    <>
                      {list.map((rule, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
                        <div key={i} className='flex items-start gap-1'>
                          <div
                            className='flex shrink-0 flex-col pt-1.5'
                            data-setting='field.row_rules.sort'
                          >
                            <button
                              type='button'
                              aria-label='Move rule up'
                              disabled={i === 0}
                              onClick={() =>
                                save(reorder(list, i, i - 1), `Move a rule of ${name} up`)
                              }
                              className='text-slate-400 hover:text-nvr-cyan disabled:opacity-30'
                            >
                              <ChevronUp className='h-3.5 w-3.5' />
                            </button>
                            <button
                              type='button'
                              aria-label='Move rule down'
                              disabled={i === list.length - 1}
                              onClick={() =>
                                save(reorder(list, i, i + 1), `Move a rule of ${name} down`)
                              }
                              className='text-slate-400 hover:text-nvr-cyan disabled:opacity-30'
                            >
                              <ChevronDown className='h-3.5 w-3.5' />
                            </button>
                          </div>
                          <div className='min-w-0 flex-1'>
                            <RowRuleRow
                              rule={rule}
                              childFields={ruleFields}
                              m2oRels={childM2ORels}
                              o2mRels={childO2MRels}
                              parentContextFields={parentContextRich}
                              onChange={(u) =>
                                save(
                                  list.map((x, j) => (j === i ? u : x)),
                                  `Change a rule of ${name}`,
                                  true
                                )
                              }
                              onRemove={() =>
                                save(
                                  list.filter((_, j) => j !== i),
                                  `Remove a rule from ${name}`
                                )
                              }
                            />
                          </div>
                        </div>
                      ))}
                      <AddButton
                        onClick={() =>
                          save(
                            [
                              ...list,
                              {
                                trigger_field: null,
                                trigger_op: 'nnull',
                                target_field: '',
                                target_type: 'relation_field'
                              }
                            ],
                            `Add a rule to ${name}`
                          )
                        }
                      >
                        + Add rule
                      </AddButton>
                    </>
                  )
                }}
              </Buffered>
            </Setting>
            {rules.length > 0 && (
              <div data-setting='field.row_rules_lint'>
                <RowRuleLint
                  rules={rules}
                  childFieldNames={new Set(childAllFields.map((f) => f.field))}
                />
              </div>
            )}
            {rules.length > 0 && (
              <div data-setting='field.row_rules_tester'>
                <RowRuleTester
                  childCollection={child}
                  parentCollection={collection}
                  rowRules={rules}
                  parentContextFields={parentContext}
                />
              </div>
            )}
            <Setting
              k='field.parent_context_fields'
              label='Record fields rules can read'
              effect='Available to rules as $parent.field.'
            >
              <FieldMultiPicker
                ariaLabel='Record fields rules can read'
                value={parentContext}
                options={parentAllFields
                  .filter(
                    (f) =>
                      f.field !== 'id' &&
                      !SKIP_TYPES.has(f.type ?? '') &&
                      !O2M_IFACES.has((f as { interface?: string | null }).interface ?? '')
                  )
                  .map((f) => ({ value: f.field, label: f.label || titleCase(f.field) }))}
                onChange={(v) =>
                  ctx.setOption(
                    'parent_context_fields',
                    v.length ? v : undefined,
                    `Change the record fields ${name} rules read`
                  )
                }
              />
            </Setting>
          </Section>

          <Section title='Rows'>
            <Setting
              k='field.unique_by'
              label='No two rows alike by'
              effect='Blocks a row that repeats these values.'
            >
              <FieldMultiPicker
                ariaLabel='No two rows alike by'
                placeholder='Not checked'
                value={uniqueBy}
                options={uniqueByOptions.map((f) => ({
                  value: f.field,
                  label: f.label || titleCase(f.field),
                  hint: f.type
                }))}
                onChange={(v) =>
                  ctx.setOption(
                    'unique_by',
                    v.length ? v : undefined,
                    `Change duplicate rows of ${name}`
                  )
                }
              />
            </Setting>
            {uniqueBy.length > 0 && (
              <Toggle
                k='field.unique_by_enforce_on_write'
                label='Refuse duplicates on the server too'
                effect='Binds every writer of these rows: other forms, imports and the API.'
                checked={opts.enforce_on_write === true}
                onChange={(v) =>
                  ctx.setOption(
                    'enforce_on_write',
                    v || undefined,
                    `Change duplicate checks of ${name}`
                  )
                }
              />
            )}
            <Setting k='field.sort_field' label='Sort rows by'>
              <Choice
                ariaLabel='Sort rows by'
                value={sortField}
                options={[
                  { value: '', label: 'Their saved order' },
                  ...uniqueByOptions.map((f) => ({
                    value: f.field,
                    label: f.label || titleCase(f.field)
                  }))
                ]}
                onChange={(v) =>
                  ctx.setOptions(
                    { sort_field: v || undefined, sort_dir: v ? sortDir : undefined },
                    `Sort ${name} rows`
                  )
                }
              />
            </Setting>
            <Setting k='field.sort_dir' label='Direction'>
              <Segmented
                disabled={!sortField}
                value={sortDir}
                options={[
                  { value: 'asc', label: 'Ascending' },
                  { value: 'desc', label: 'Descending' }
                ]}
                onChange={(v) =>
                  ctx.setOption('sort_dir', v, `Sort ${name} rows ${v === 'asc' ? 'up' : 'down'}`)
                }
              />
            </Setting>
            <Setting
              k='field.section_group_by'
              label='Group rows into sections by'
              effect='A dotted path on the row, e.g. item.category.name. Empty: no sections.'
            >
              <TextInput
                ariaLabel='Group rows into sections by'
                mono
                value={groupBy}
                placeholder='item.category.name'
                onChange={(v) => {
                  setGroupBy(v)
                  if (!v.trim() || v.includes('.'))
                    ctx.setOption(
                      'section_group_by',
                      v.trim() || undefined,
                      `Group ${name} rows`,
                      true
                    )
                }}
              />
              {groupBy.trim() && !groupBy.includes('.') && (
                <p className='text-[11px] text-red-600 dark:text-red-400'>
                  Use a dotted path — nothing saved
                </p>
              )}
            </Setting>
          </Section>

          <Section title='Column presets'>
            <Setting
              k='field.column_presets'
              label='Sets of columns people can switch between'
              scope='field'
            >
              <div className='space-y-1.5'>
                {presets.map((p, i) => (
                  <ColumnPresetRow
                    key={p._key}
                    preset={p}
                    optionGroups={presetGroups}
                    onChange={(u) => proposePresets(presets.map((x, j) => (j === i ? u : x)))}
                    onRemove={() => proposePresets(presets.filter((_, j) => j !== i))}
                    onMoveUp={() => proposePresets(reorder(presets, i, i - 1))}
                    onMoveDown={() => proposePresets(reorder(presets, i, i + 1))}
                    isFirst={i === 0}
                    isLast={i === presets.length - 1}
                  />
                ))}
                <AddButton
                  onClick={() =>
                    proposePresets([
                      ...presets,
                      { name: '', columns: [], _key: `n${presets.length}-${Date.now()}` }
                    ])
                  }
                >
                  + Add preset
                </AddButton>
              </div>
            </Setting>
            {presets.length >= 2 && (
              <Setting k='field.default_preset' label='Opens with' scope='field'>
                <Choice
                  ariaLabel='Opens with'
                  value={defaultPreset}
                  options={[
                    { value: '', label: 'The first preset' },
                    { value: '__all__', label: 'All columns' },
                    ...presets
                      .filter((p) => p.name.trim())
                      .map((p) => ({ value: p.name.trim(), label: p.name.trim() }))
                  ]}
                  onChange={(v) =>
                    ctx.proposeGlobalOption(
                      'field.default_preset',
                      'default_preset',
                      v || undefined,
                      `Change the opening columns of ${name}`
                    )
                  }
                />
              </Setting>
            )}
          </Section>

          <Section title='Row drawer'>
            <Setting
              k='field.drawer_relations'
              label='Related lists inside each row'
              effect='Shown when a row opens. Sum / cap: a hint comparing a total with a row figure (pick both).'
            >
              <div className='space-y-1.5'>
                {drawer.map((d, i) => (
                  <DrawerRelationRow
                    key={d._key}
                    entry={d}
                    relationOptions={drawerRelationOptions}
                    capFieldOptions={numericChildFields}
                    onChange={(u) =>
                      changeDrawer(
                        drawer.map((x, j) => (j === i ? u : x)),
                        `Change the drawer of ${name}`
                      )
                    }
                    onRemove={() =>
                      changeDrawer(
                        drawer.filter((_, j) => j !== i),
                        `Change the drawer of ${name}`
                      )
                    }
                  />
                ))}
                <AddButton
                  onClick={() =>
                    setDrawer([
                      ...drawer,
                      { field: '', sumField: '', capField: '', _key: `n${Date.now()}` }
                    ])
                  }
                >
                  + Add relation
                </AddButton>
              </div>
            </Setting>
          </Section>

          <Section title='More grid features'>
            {JSON_KEYS.map((j) => (
              <Setting
                key={j.key}
                k={`field.${j.key}`}
                label={j.label}
                effect={j.effect}
                enforced={j.enforced}
              >
                <JsonInput
                  ariaLabel={j.label}
                  value={opts[j.key]}
                  rows={j.rows}
                  placeholder={j.placeholder}
                  validate={j.check}
                  onCommit={(v) =>
                    ctx.setOption(j.key, v, `Change the ${j.label.toLowerCase()} of ${name}`)
                  }
                />
              </Setting>
            ))}
          </Section>
        </>
      )}
    </div>
  )
}
