import { ArrowRight, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { PickCombobox, useCollectionOptions, useFieldOptions } from '../Widgets'
import {
  ColumnListEditor,
  columnsToRaw,
  FORMAT_OPTS,
  fieldLabelOf,
  hopOptionsForCollection,
  ReviewListFilterRows,
  type RLColumn,
  type RLFilterRow,
  type RLPathHop,
  rawColumns,
  Section,
  useRelationsFor
} from './ReviewListConfigForm'

// ─── rollup widget config editor ───────────────────────────────────────────
//
// Config shape mirrors api/src/services/rollup.ts's RollupConfig exactly (see
// docs/superpowers/specs/2026-07-20-rollup-widget-lookup-columns-design.md
// §1). Data source + row filters reuse the exact guided pieces built for
// review_list (same path-walk semantics); levels/leaf columns/measures are
// rollup-specific. Server re-validates on save — this form only gates the
// obviously incomplete cases so the 400 path stays a backstop.

export interface RollupLevel {
  field: string
  label: string
}
export interface RollupMeasure {
  key: string
  label: string
  sum: string
  format: string
  filter: RLFilterRow[]
}
export interface RollupCfg {
  host_collection: string
  collection: string
  path: RLPathHop[]
  static_filter: RLFilterRow[]
  levels: RollupLevel[]
  leaf_columns: RLColumn[]
  merge_leaf_by: string[]
  measures: RollupMeasure[]
  show_totals: boolean
}

function rawFilterRows(v: unknown): RLFilterRow[] {
  return Array.isArray(v)
    ? (v as Array<Record<string, unknown>>).map((f) => ({
        field: String(f.field ?? ''),
        op:
          f.op === 'neq'
            ? ('neq' as const)
            : f.op === 'nnull'
              ? ('nnull' as const)
              : ('eq' as const),
        value: f.value != null ? String(f.value) : ''
      }))
    : []
}

function filterRowsToRaw(rows: RLFilterRow[]): Array<Record<string, unknown>> {
  return rows
    .filter((f) => f.field.trim())
    .map((f) =>
      f.op === 'nnull' ? { field: f.field, op: f.op } : { field: f.field, op: f.op, value: f.value }
    )
}

export function rawToRollup(r: Record<string, unknown>): RollupCfg {
  const path = Array.isArray(r.path)
    ? (r.path as Array<Record<string, unknown>>).map((h) => ({
        kind: h.kind === 'm2m' ? ('m2m' as const) : ('m2o' as const),
        field: String(h.field ?? '')
      }))
    : []
  const levels = Array.isArray(r.levels)
    ? (r.levels as Array<Record<string, unknown>>).map((l) => ({
        field: String(l.field ?? ''),
        label: l.label != null ? String(l.label) : ''
      }))
    : []
  const measures = Array.isArray(r.measures)
    ? (r.measures as Array<Record<string, unknown>>).map((m) => ({
        key: String(m.key ?? ''),
        label: m.label != null ? String(m.label) : '',
        sum: String(m.sum ?? ''),
        format: m.format != null ? String(m.format) : '',
        filter: rawFilterRows(m.filter)
      }))
    : []
  return {
    host_collection: String(r.host_collection ?? ''),
    collection: String(r.collection ?? ''),
    path,
    static_filter: rawFilterRows(r.static_filter),
    levels,
    leaf_columns: rawColumns(r.leaf_columns),
    merge_leaf_by: Array.isArray(r.merge_leaf_by) ? (r.merge_leaf_by as unknown[]).map(String) : [],
    measures,
    show_totals: r.show_totals === true
  }
}

export function rollupToRaw(c: RollupCfg): Record<string, unknown> {
  const out: Record<string, unknown> = {
    host_collection: c.host_collection,
    collection: c.collection,
    path: c.path.map((h) => ({ kind: h.kind, field: h.field }))
  }
  const filters = filterRowsToRaw(c.static_filter)
  if (filters.length) out.static_filter = filters
  out.levels = c.levels.map((l) =>
    l.label ? { field: l.field, label: l.label } : { field: l.field }
  )
  if (c.leaf_columns.length) out.leaf_columns = columnsToRaw(c.leaf_columns)
  if (c.merge_leaf_by.length) out.merge_leaf_by = c.merge_leaf_by
  out.measures = c.measures.map((m) => {
    const mo: Record<string, unknown> = { key: m.key, label: m.label, sum: m.sum }
    if (m.format) mo.format = m.format
    const mf = filterRowsToRaw(m.filter)
    if (mf.length) mo.filter = mf
    return mo
  })
  out.show_totals = c.show_totals
  return out
}

/** Measure keys are never typed — auto-derived from the label so they stay
 * valid identifiers (api/src/services/rollup.ts's isPlainIdentifier) and
 * unique (index-suffixed) without the editor exposing the concept of a key. */
function slugifyMeasureKey(label: string, index: number): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug || 'measure'}_${index}`.replace(/^(\d)/, 'm_$1')
}

// Guided level picker — same field-or-one-hop-related shape as
// ColumnListEditor's adders, capped at 3 ordered levels, each with an
// optional column-header label override.
function LevelsEditor({
  collection,
  fieldOptions,
  value,
  onChange
}: {
  collection: string
  fieldOptions: { value: string; label: string }[]
  value: RollupLevel[]
  onChange: (v: RollupLevel[]) => void
}) {
  const relQ = useRelationsFor(collection)
  const m2oOpts = (relQ.data ?? [])
    .filter((r) => r.many_collection === collection && !r.junction_field && r.one_collection)
    .map((r) => ({
      field: r.many_field,
      related: r.one_collection as string,
      label: fieldLabelOf(fieldOptions, r.many_field)
    }))
  const [relField, setRelField] = useState('')
  const activeRel = m2oOpts.find((o) => o.field === relField) ?? null
  const relatedFieldOpts = useFieldOptions(activeRel?.related ?? '')

  const has = (field: string) => value.some((l) => l.field === field)
  function add(field: string) {
    if (field && !has(field) && value.length < 3) onChange([...value, { field, label: '' }])
  }
  function upd(i: number, patch: Partial<RollupLevel>) {
    onChange(value.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  }
  function displayName(l: RollupLevel): string {
    const [head, sub] = l.field.split('.')
    if (sub) return `${fieldLabelOf(fieldOptions, head)} → ${sub.replace(/_/g, ' ')}`
    return fieldLabelOf(fieldOptions, l.field)
  }

  return (
    <div className='space-y-2'>
      {value.length > 0 && (
        <div className='space-y-1.5'>
          {value.map((l, i) => (
            <div
              key={l.field}
              className='flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
            >
              <span className='shrink-0 font-mono text-[11px] text-slate-400'>{i + 1}.</span>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[12px] text-slate-700 dark:text-slate-300'>
                  {displayName(l)}
                </p>
                <p className='truncate font-mono text-[10px] text-slate-400 dark:text-slate-500'>
                  {l.field}
                </p>
              </div>
              <Input
                className='h-7 w-[150px] text-[11px]'
                value={l.label}
                onChange={(e) => upd(i, { label: e.target.value })}
                placeholder='Column label'
              />
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7 shrink-0'
                aria-label={`Remove ${displayName(l)}`}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className='h-3.5 w-3.5' />
              </Button>
            </div>
          ))}
        </div>
      )}
      {value.length >= 3 ? (
        <p className='text-[11px] text-slate-400'>Maximum 3 levels.</p>
      ) : fieldOptions.length === 0 ? (
        <p className='text-[11px] text-slate-400'>Select a target collection first.</p>
      ) : (
        <div className='flex flex-wrap items-center gap-1.5'>
          <div className='w-[200px]'>
            <PickCombobox
              value=''
              onChange={add}
              options={fieldOptions.filter((f) => !has(f.value))}
              placeholder='Add level…'
            />
          </div>
          <div className='w-[200px]'>
            <PickCombobox
              value={relField}
              onChange={setRelField}
              options={m2oOpts.map((o) => ({ value: o.field, label: `${o.label} → ${o.related}` }))}
              placeholder='From related record…'
            />
          </div>
          {activeRel && (
            <div className='w-[200px]'>
              <PickCombobox
                value=''
                onChange={(v) => {
                  add(`${relField}.${v}`)
                  setRelField('')
                }}
                options={relatedFieldOpts}
                placeholder={`Field on ${activeRel.related}…`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MeasuresEditor({
  fieldOptions,
  value,
  onChange
}: {
  fieldOptions: { value: string; label: string }[]
  value: RollupMeasure[]
  onChange: (v: RollupMeasure[]) => void
}) {
  function upd(i: number, patch: Partial<RollupMeasure>) {
    onChange(
      value.map((m, j) => {
        if (j !== i) return m
        const next = { ...m, ...patch }
        if (patch.label !== undefined) next.key = slugifyMeasureKey(patch.label, i)
        return next
      })
    )
  }
  function add() {
    const i = value.length
    onChange([
      ...value,
      { key: slugifyMeasureKey('', i), label: '', sum: '', format: '', filter: [] }
    ])
  }

  return (
    <div className='space-y-2'>
      {value.map((m, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list — removal only truncates from the end
          key={i}
          className='space-y-1.5 rounded-md border border-slate-200 p-2.5 dark:border-border'
        >
          <div className='flex items-center gap-1.5'>
            <Input
              className='h-7 flex-1 text-[12px]'
              value={m.label}
              onChange={(e) => upd(i, { label: e.target.value })}
              placeholder='Measure label'
            />
            <div className='w-[170px]'>
              <PickCombobox
                value={m.sum}
                onChange={(v) => upd(i, { sum: v })}
                options={fieldOptions}
                placeholder='Sum field…'
                widthClass='w-[220px]'
              />
            </div>
            <div className='w-[110px]'>
              <PickCombobox
                value={m.format}
                onChange={(v) => upd(i, { format: v })}
                options={FORMAT_OPTS.filter((o) => ['', 'number', 'currency'].includes(o.value))}
                widthClass='w-[140px]'
              />
            </div>
            <Button
              size='icon'
              variant='ghost'
              className='h-7 w-7 shrink-0'
              aria-label='Remove measure'
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </Button>
          </div>
          <div>
            <Label className='text-[10px] text-muted-foreground'>
              Filter{' '}
              <span className='opacity-60'>(optional — sums only rows matching every filter)</span>
            </Label>
            <ReviewListFilterRows
              rows={m.filter}
              fieldOptions={fieldOptions}
              onChange={(v) => upd(i, { filter: v })}
            />
          </div>
        </div>
      ))}
      <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={add}>
        <Plus className='mr-1 h-3 w-3' />
        Add measure
      </Button>
    </div>
  )
}

export function RollupConfigForm({
  cfg,
  onChange,
  onValidityChange
}: {
  cfg: RollupCfg
  onChange: (c: RollupCfg) => void
  onValidityChange?: (valid: boolean) => void
}) {
  const colOpts = useCollectionOptions()
  const targetFieldOpts = useFieldOptions(cfg.collection)

  function set<K extends keyof RollupCfg>(k: K, v: RollupCfg[K]) {
    onChange({ ...cfg, [k]: v })
  }

  // Fixed 4-hop hook budget (MAX_PATH_HOPS in rollup.ts, same as
  // review-list.ts) — each hop's source collection is only known once the
  // prior hop's relations resolve, so these chain sequentially, but the hook
  // COUNT stays constant every render (rules-of-hooks safe).
  const relQ0 = useRelationsFor(cfg.collection)
  const opts0 = hopOptionsForCollection(cfg.collection, relQ0.data ?? [])
  const hop0 = cfg.path[0]
  const result0 = hop0
    ? (opts0.find((o) => o.kind === hop0.kind && o.field === hop0.field)?.resultCollection ?? null)
    : null

  const relQ1 = useRelationsFor(result0 ?? '')
  const opts1 = result0 ? hopOptionsForCollection(result0, relQ1.data ?? []) : []
  const hop1 = cfg.path[1]
  const result1 =
    hop1 && result0
      ? (opts1.find((o) => o.kind === hop1.kind && o.field === hop1.field)?.resultCollection ??
        null)
      : null

  const relQ2 = useRelationsFor(result1 ?? '')
  const opts2 = result1 ? hopOptionsForCollection(result1, relQ2.data ?? []) : []
  const hop2 = cfg.path[2]
  const result2 =
    hop2 && result1
      ? (opts2.find((o) => o.kind === hop2.kind && o.field === hop2.field)?.resultCollection ??
        null)
      : null

  const relQ3 = useRelationsFor(result2 ?? '')
  const opts3 = result2 ? hopOptionsForCollection(result2, relQ3.data ?? []) : []
  const hop3 = cfg.path[3]
  const result3 =
    hop3 && result2
      ? (opts3.find((o) => o.kind === hop3.kind && o.field === hop3.field)?.resultCollection ??
        null)
      : null

  const chainOptsArr = [opts0, opts1, opts2, opts3]
  const chainResultsArr = [result0, result1, result2, result3]
  const chainSourceArr = [cfg.collection, result0, result1, result2]

  const finalResolved = cfg.path.length > 0 ? chainResultsArr[cfg.path.length - 1] : null
  const pathValid =
    !!cfg.host_collection &&
    cfg.path.length > 0 &&
    finalResolved !== null &&
    finalResolved === cfg.host_collection

  const levelsValid = cfg.levels.length > 0
  const measuresValid =
    cfg.measures.length > 0 && cfg.measures.every((m) => m.label.trim() && m.sum.trim())

  const valid =
    !!cfg.host_collection && !!cfg.collection && pathValid && levelsValid && measuresValid

  // biome-ignore lint/correctness/useExhaustiveDependencies: report whenever the derived validity signal changes
  useEffect(() => {
    onValidityChange?.(valid)
  }, [valid])

  function setHostCollection(v: string) {
    onChange({ ...cfg, host_collection: v, path: [] })
  }
  function setCollection(v: string) {
    onChange({
      ...cfg,
      collection: v,
      path: [],
      levels: [],
      leaf_columns: [],
      merge_leaf_by: [],
      measures: []
    })
  }

  const mergeCandidateFields = [
    ...new Set([
      ...cfg.levels.map((l) => l.field),
      ...cfg.leaf_columns.filter((c) => !c.raw).map((c) => c.field)
    ])
  ].filter(Boolean)

  return (
    <div className='space-y-5'>
      <Section
        title='Data source'
        hint='Which records are summarized, and how they connect to the record this widget sits on.'
      >
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Host collection{' '}
              <span className='text-[10px] opacity-60'>(record the widget is placed on)</span>
            </Label>
            <PickCombobox
              value={cfg.host_collection}
              onChange={setHostCollection}
              options={colOpts}
              placeholder='Select host collection…'
            />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Target collection <span className='text-[10px] opacity-60'>(rows being summed)</span>
            </Label>
            <PickCombobox
              value={cfg.collection}
              onChange={setCollection}
              options={colOpts}
              placeholder='Select target collection…'
            />
          </div>
        </div>

        <div className='space-y-1.5'>
          <Label className='text-[11px] text-muted-foreground'>
            Relation path{' '}
            <span className='text-[10px] opacity-60'>(target → host, hop by hop)</span>
          </Label>
          {!cfg.collection || !cfg.host_collection ? (
            <p className='text-[11px] text-slate-400'>Select host and target collections first.</p>
          ) : (
            <div className='space-y-1.5'>
              {cfg.path.map((hop, i) => {
                const source = chainSourceArr[i] ?? ''
                const opts = chainOptsArr[i] ?? []
                const resolved = chainResultsArr[i]
                const matched = opts.find((o) => o.kind === hop.kind && o.field === hop.field)
                return (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable list — removing truncates from this index
                    key={i}
                    className='flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
                  >
                    <span className='shrink-0 font-mono text-[11px] text-slate-400'>{i + 1}.</span>
                    <span className='flex-1 font-mono text-[12px]'>
                      {source || '?'}
                      <ArrowRight className='mx-1 inline h-3 w-3 text-slate-400' />
                      {hop.field}
                      <Badge variant='outline' className='ml-1.5 h-4 px-1 text-[10px] uppercase'>
                        {hop.kind}
                      </Badge>
                    </span>
                    <span className='shrink-0 font-mono text-[11px] text-slate-500'>
                      {resolved ?? (matched ? matched.resultCollection : 'unresolved')}
                    </span>
                    <Button
                      size='icon'
                      variant='ghost'
                      className='h-6 w-6 shrink-0'
                      aria-label='Remove hop'
                      onClick={() => set('path', cfg.path.slice(0, i))}
                    >
                      <X className='h-3 w-3' />
                    </Button>
                  </div>
                )
              })}
              {cfg.path.length < 4 && (
                <div className='w-[320px]'>
                  <PickCombobox
                    value=''
                    onChange={(v) => {
                      const opts = chainOptsArr[cfg.path.length] ?? []
                      const opt = opts.find((o) => `${o.kind}::${o.field}` === v)
                      if (opt) set('path', [...cfg.path, { kind: opt.kind, field: opt.field }])
                    }}
                    options={(chainOptsArr[cfg.path.length] ?? []).map((o) => ({
                      value: `${o.kind}::${o.field}`,
                      label: `${o.label} (${o.kind.toUpperCase()})`
                    }))}
                    placeholder={
                      cfg.path.length === 0 ? `Add hop from ${cfg.collection}…` : 'Add next hop…'
                    }
                    disabled={cfg.path.length > 0 && finalResolved === null}
                  />
                </div>
              )}
              {!pathValid && (
                <p className='text-[11px] text-amber-600 dark:text-amber-500'>
                  Path must end at host collection "{cfg.host_collection}"
                  {finalResolved ? ` — currently ends at "${finalResolved}"` : ' — incomplete'}.
                </p>
              )}
            </div>
          )}
        </div>
      </Section>

      <Separator />

      <Section
        title='Row filters'
        hint='Only rows matching every filter contribute to the rollup (e.g. is_on_hold = true).'
      >
        <ReviewListFilterRows
          rows={cfg.static_filter}
          fieldOptions={targetFieldOpts}
          onChange={(v) => set('static_filter', v)}
        />
      </Section>

      <Separator />

      <Section
        title='Levels'
        hint='1-3 ordered group levels, outermost first. Each level nests inside the one before it.'
      >
        <LevelsEditor
          collection={cfg.collection}
          fieldOptions={targetFieldOpts}
          value={cfg.levels}
          onChange={(v) => set('levels', v)}
        />
      </Section>

      <Separator />

      <Section
        title='Leaf columns'
        hint='Shown on each row within the innermost level, before the measure cells.'
      >
        <ColumnListEditor
          collection={cfg.collection}
          fieldOptions={targetFieldOpts}
          value={cfg.leaf_columns}
          onChange={(v) => set('leaf_columns', v)}
          allowLookup={false}
        />
      </Section>

      <Separator />

      <Section
        title='Measures'
        hint='1-4 numeric sums, each optionally filtered to a subset of rows (e.g. Labor vs Material).'
      >
        <MeasuresEditor
          fieldOptions={targetFieldOpts}
          value={cfg.measures}
          onChange={(v) => set('measures', v)}
        />
      </Section>

      <Separator />

      <Section title='Options'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>
            Merge leaf rows by{' '}
            <span className='text-[10px] opacity-60'>
              (optional — leaves with equal values on ALL selected fields merge, measures summed)
            </span>
          </Label>
          {mergeCandidateFields.length === 0 ? (
            <p className='text-[11px] text-slate-400'>Add levels or leaf columns first.</p>
          ) : (
            <div className='flex flex-wrap gap-1.5'>
              {mergeCandidateFields.map((f) => {
                const active = cfg.merge_leaf_by.includes(f)
                return (
                  <button
                    key={f}
                    type='button'
                    onClick={() =>
                      set(
                        'merge_leaf_by',
                        active
                          ? cfg.merge_leaf_by.filter((x) => x !== f)
                          : [...cfg.merge_leaf_by, f]
                      )
                    }
                    className={cn(
                      'rounded border px-2 py-1 text-[11px] transition-colors',
                      active
                        ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan'
                        : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-slate-300'
                    )}
                  >
                    {fieldLabelOf(targetFieldOpts, f)}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className='flex items-center gap-2'>
          <Switch checked={cfg.show_totals} onCheckedChange={(v) => set('show_totals', v)} />
          <Label className='text-[11px] text-muted-foreground'>
            Show grand-total row + summary strip
          </Label>
        </div>
      </Section>

      <div className='rounded-md bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-muted/20 dark:text-muted-foreground'>
        When placing this widget on a layout, bind input{' '}
        <code className='font-mono'>record_id</code> to the record id (Add Widget defaults this
        automatically for rollup widgets — verify it under the widget slot's Bindings section).
      </div>
    </div>
  )
}
