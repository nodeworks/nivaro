import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { api } from '@/lib/api'
import { PickCombobox, useCollectionOptions, useFieldOptions } from '../Widgets'

// ─── review_list widget config editor ──────────────────────────────────────
//
// Config shape mirrors api/src/services/review-list.ts's ReviewListConfig
// exactly (see docs/superpowers/specs/2026-07-19-review-list-widget-design.md
// §1/§5). Server re-validates on save — this form only gates the obviously
// incomplete cases (empty path, path not landing on host, no status options)
// so the 400 path stays a backstop, not the primary UX.

export interface RLPathHop {
  kind: 'm2o' | 'm2m'
  field: string
}
export interface RLFilterRow {
  field: string
  op: 'eq' | 'neq' | 'nnull'
  value: string
}
export interface RLStatusOption {
  value: string
  label: string
  color: string
}
/** Column entry — label/format '' means unset (serialized back to plain string).
 * `raw` is set only for lookup columns: the original config object (label/
 * format/color/lookup), round-tripped untouched except for label/format/color
 * edits made in the editor. The server assigns the lookup's `field` key
 * (`$lookup.<collection>.<field>.<local~remote>…`) — the editor never
 * computes or displays it (spec §2). */
export interface RLColumn {
  field: string
  label: string
  format: string
  color: string
  raw?: Record<string, unknown>
}
/** Lookup adder draft state — not part of any serialized shape. */
interface RLLookupMatchDraft {
  local: string
  remote: string
}
export interface ReviewListCfg {
  host_collection: string
  collection: string
  path: RLPathHop[]
  static_filter: RLFilterRow[]
  group_by: string
  aggregate_sum: string
  aggregate_sum_format: string
  group_meta: RLColumn[]
  line_columns: RLColumn[]
  status_field: string
  status_options: RLStatusOption[]
  status_empty_label: string
  status_empty_color: string
  stamp_user_field: string
  stamp_date_field: string
}

export function rawColumns(v: unknown): RLColumn[] {
  if (!Array.isArray(v)) return []
  return (v as unknown[]).map((e) => {
    if (typeof e === 'object' && e !== null) {
      const o = e as Record<string, unknown>
      if (o.lookup && typeof o.lookup === 'object') {
        return {
          field: '',
          label: o.label != null ? String(o.label) : '',
          format: o.format != null ? String(o.format) : '',
          color: o.color != null ? String(o.color) : '',
          raw: o
        }
      }
      return {
        field: String(o.field ?? ''),
        label: o.label != null ? String(o.label) : '',
        format: o.format != null ? String(o.format) : '',
        color: o.color != null ? String(o.color) : ''
      }
    }
    return { field: String(e), label: '', format: '', color: '' }
  })
}

export function columnsToRaw(cols: RLColumn[]): Array<string | Record<string, unknown>> {
  return cols.map((c) => {
    if (c.raw) {
      const out: Record<string, unknown> = { ...c.raw, label: c.label }
      delete out.format
      delete out.color
      if (c.format) out.format = c.format
      if (c.format === 'flag' && c.color) out.color = c.color
      return out
    }
    if (!c.label && !c.format) return c.field
    const out: Record<string, unknown> = { field: c.field }
    if (c.label) out.label = c.label
    if (c.format) out.format = c.format
    if (c.format === 'flag' && c.color) out.color = c.color
    return out
  })
}

export function rawToReviewList(r: Record<string, unknown>): ReviewListCfg {
  const path = Array.isArray(r.path)
    ? (r.path as Array<Record<string, unknown>>).map((h) => ({
        kind: h.kind === 'm2m' ? ('m2m' as const) : ('m2o' as const),
        field: String(h.field ?? '')
      }))
    : []
  const staticFilter = Array.isArray(r.static_filter)
    ? (r.static_filter as Array<Record<string, unknown>>).map((f) => ({
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
  const status = (typeof r.status === 'object' && r.status ? r.status : {}) as Record<
    string,
    unknown
  >
  const statusOptions = Array.isArray(status.options)
    ? (status.options as Array<Record<string, unknown>>).map((o) => ({
        value: String(o.value ?? ''),
        label: String(o.label ?? ''),
        color: String(o.color ?? 'slate')
      }))
    : []
  return {
    host_collection: String(r.host_collection ?? ''),
    collection: String(r.collection ?? ''),
    path,
    static_filter: staticFilter,
    group_by: String(r.group_by ?? ''),
    aggregate_sum: r.aggregate_sum != null ? String(r.aggregate_sum) : '',
    aggregate_sum_format: r.aggregate_sum_format != null ? String(r.aggregate_sum_format) : '',
    group_meta: rawColumns(r.group_meta),
    line_columns: rawColumns(r.line_columns),
    status_field: String(status.field ?? ''),
    status_options: statusOptions,
    status_empty_label: status.empty_label != null ? String(status.empty_label) : '',
    status_empty_color: status.empty_color != null ? String(status.empty_color) : '',
    stamp_user_field: status.stamp_user_field != null ? String(status.stamp_user_field) : '',
    stamp_date_field: status.stamp_date_field != null ? String(status.stamp_date_field) : ''
  }
}

export function reviewListToRaw(c: ReviewListCfg): Record<string, unknown> {
  const out: Record<string, unknown> = {
    host_collection: c.host_collection,
    collection: c.collection,
    path: c.path.map((h) => ({ kind: h.kind, field: h.field })),
    group_by: c.group_by
  }
  const filters = c.static_filter.filter((f) => f.field.trim())
  if (filters.length) {
    out.static_filter = filters.map((f) =>
      f.op === 'nnull' ? { field: f.field, op: f.op } : { field: f.field, op: f.op, value: f.value }
    )
  }
  if (c.aggregate_sum) out.aggregate_sum = c.aggregate_sum
  if (c.aggregate_sum && c.aggregate_sum_format) out.aggregate_sum_format = c.aggregate_sum_format
  if (c.group_meta.length) out.group_meta = columnsToRaw(c.group_meta)
  if (c.line_columns.length) out.line_columns = columnsToRaw(c.line_columns)
  const status: Record<string, unknown> = { field: c.status_field, options: c.status_options }
  if (c.status_empty_label) {
    status.empty_label = c.status_empty_label
    if (c.status_empty_color) status.empty_color = c.status_empty_color
  }
  if (c.stamp_user_field) status.stamp_user_field = c.stamp_user_field
  if (c.stamp_date_field) status.stamp_date_field = c.stamp_date_field
  out.status = status
  return out
}

// ── relation-path resolution ────────────────────────────────────────────────

interface RLRelRow {
  many_collection: string
  many_field: string
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

interface HopOption {
  kind: 'm2o' | 'm2m'
  field: string
  resultCollection: string
  label: string
}

export function useRelationsFor(collection: string) {
  return useQuery({
    queryKey: ['review-list-relations', collection],
    queryFn: () =>
      api
        .get<{ data: RLRelRow[] }>(`/data-model/relations/for/${collection}`)
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })
}

// Mirrors findM2oRelation / findM2mAlias in api/src/services/review-list.ts,
// but solving "all hop options FROM this collection" rather than resolving a
// single named field — the editor needs to list choices, the server needs to
// validate one.
export function hopOptionsForCollection(cur: string, relations: RLRelRow[]): HopOption[] {
  const opts: HopOption[] = []
  for (const r of relations) {
    if (r.many_collection === cur && !r.junction_field && r.one_collection) {
      opts.push({
        kind: 'm2o',
        field: r.many_field,
        resultCollection: r.one_collection,
        label: `${r.many_field} → ${r.one_collection}`
      })
    }
  }
  for (const r of relations) {
    if (r.one_collection === cur && r.junction_field) {
      const aliasField = r.one_field || r.many_collection
      const companion = relations.find(
        (c) => c.many_collection === r.many_collection && c.many_field === r.junction_field
      )
      if (companion?.one_collection) {
        opts.push({
          kind: 'm2m',
          field: aliasField,
          resultCollection: companion.one_collection,
          label: `${aliasField} → ${companion.one_collection}`
        })
      }
    }
  }
  return opts
}

export const STATUS_COLOR_OPTS = [
  { value: 'green', label: 'Green' },
  { value: 'red', label: 'Red' },
  { value: 'amber', label: 'Amber' },
  { value: 'blue', label: 'Blue' },
  { value: 'purple', label: 'Purple' },
  { value: 'slate', label: 'Slate' }
]

const FILTER_OP_OPTS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'nnull', label: 'is not empty' }
]

export function ReviewListFilterRows({
  rows,
  fieldOptions,
  onChange
}: {
  rows: RLFilterRow[]
  fieldOptions: { value: string; label: string }[]
  onChange: (r: RLFilterRow[]) => void
}) {
  function upd(i: number, patch: Partial<RLFilterRow>) {
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  }
  return (
    <div className='space-y-1.5'>
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable list
        <div key={i} className='flex items-center gap-1.5'>
          <div className='w-[180px]'>
            <PickCombobox
              value={r.field}
              onChange={(v) => upd(i, { field: v })}
              options={fieldOptions}
              placeholder='field…'
            />
          </div>
          <div className='w-[140px]'>
            <PickCombobox
              value={r.op}
              onChange={(v) => upd(i, { op: v as RLFilterRow['op'] })}
              options={FILTER_OP_OPTS}
              widthClass='w-[160px]'
            />
          </div>
          {r.op !== 'nnull' && (
            <Input
              className='h-7 flex-1 font-mono text-[12px]'
              value={r.value}
              onChange={(e) => upd(i, { value: e.target.value })}
              placeholder='value'
            />
          )}
          <Button
            size='icon'
            variant='ghost'
            className='h-7 w-7 shrink-0'
            aria-label='Remove filter'
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
          >
            <X className='h-3.5 w-3.5' />
          </Button>
        </div>
      ))}
      <Button
        size='sm'
        variant='outline'
        className='h-7 text-[12px]'
        onClick={() => onChange([...rows, { field: '', op: 'eq', value: '' }])}
      >
        <Plus className='mr-1 h-3 w-3' />
        Add filter
      </Button>
    </div>
  )
}

export const FORMAT_OPTS = [
  { value: '', label: 'Raw' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
  { value: 'flag', label: 'Flag badge' }
]

/** "Vendor Name (vendor_name)" → "Vendor Name"; falls back to the raw field. */
export function fieldLabelOf(options: { value: string; label: string }[], field: string): string {
  const opt = options.find((o) => o.value === field)
  if (!opt) return field
  const suffix = ` (${field})`
  return opt.label.endsWith(suffix) ? opt.label.slice(0, -suffix.length) : opt.label
}

// Guided column editor — columns are added through pickers (target fields, or
// one M2O hop into a related record), never typed as raw dot-paths. Each
// selected column row carries its own label override and display format.
export function ColumnListEditor({
  collection,
  fieldOptions,
  value,
  onChange,
  allowLookup = true
}: {
  collection: string
  fieldOptions: { value: string; label: string }[]
  value: RLColumn[]
  onChange: (v: RLColumn[]) => void
  /** Lookup entries validate only on review_list's group_meta/line_columns
   * (api/src/services/review-list.ts) — rollup's leaf_columns validator has
   * no lookup branch (api/src/services/rollup.ts), so RollupConfigForm opts
   * out to avoid building a config the server always rejects on save. */
  allowLookup?: boolean
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

  // Lookup adder — collapsed by default (calm default per spec §2 editor
  // paragraph). Reuses useCollectionOptions/useFieldOptions like the rest of
  // this editor; the resulting entry carries the raw lookup object untouched
  // (see RLColumn.raw) — the server assigns the `$lookup...` field key.
  const [lookupOpen, setLookupOpen] = useState(false)
  const [lookupCollection, setLookupCollection] = useState('')
  const [lookupField, setLookupField] = useState('')
  const [lookupPairs, setLookupPairs] = useState<RLLookupMatchDraft[]>([{ local: '', remote: '' }])
  const [lookupLabel, setLookupLabel] = useState('')
  const allCollectionOpts = useCollectionOptions()
  const lookupFieldOpts = useFieldOptions(lookupCollection)

  const has = (field: string) => value.some((c) => !c.raw && c.field === field)
  function add(field: string) {
    if (field && !has(field)) onChange([...value, { field, label: '', format: '', color: '' }])
  }
  function updAt(i: number, patch: Partial<RLColumn>) {
    onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  }
  function removeAt(i: number) {
    onChange(value.filter((_, j) => j !== i))
  }
  function displayName(c: RLColumn): string {
    if (c.label) return c.label
    if (c.raw) return 'Lookup column'
    const [head, sub] = c.field.split('.')
    if (sub) return `${fieldLabelOf(fieldOptions, head)} → ${sub.replace(/_/g, ' ')}`
    return fieldLabelOf(fieldOptions, c.field)
  }
  function lookupSummary(c: RLColumn): string {
    const lookup = c.raw?.lookup as
      | { collection?: string; field?: string; match?: Array<{ local?: string }> }
      | undefined
    if (!lookup) return ''
    const locals = (lookup.match ?? [])
      .map((m) => m.local)
      .filter(Boolean)
      .join('+')
    return `${lookup.collection ?? '?'}.${lookup.field ?? '?'} via ${locals}`
  }

  const completePairs = lookupPairs.filter((p) => p.local && p.remote)
  const canAddLookup =
    !!lookupCollection && !!lookupField && completePairs.length >= 1 && !!lookupLabel.trim()

  function addLookup() {
    if (!canAddLookup) return
    const raw: Record<string, unknown> = {
      label: lookupLabel.trim(),
      lookup: {
        collection: lookupCollection,
        field: lookupField,
        match: completePairs.map((p) => ({ local: p.local, remote: p.remote }))
      }
    }
    onChange([...value, { field: '', label: lookupLabel.trim(), format: '', color: '', raw }])
    setLookupOpen(false)
    setLookupCollection('')
    setLookupField('')
    setLookupPairs([{ local: '', remote: '' }])
    setLookupLabel('')
  }

  return (
    <div className='space-y-2'>
      {value.length > 0 && (
        <div className='space-y-1.5'>
          {value.map((c, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: stable list — removal only truncates from the end
              key={i}
              className='flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 dark:border-border'
            >
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[12px] text-slate-700 dark:text-slate-300'>
                  {displayName(c)}
                </p>
                <p className='truncate font-mono text-[10px] text-slate-400 dark:text-slate-500'>
                  {c.raw ? lookupSummary(c) : c.field}
                </p>
              </div>
              <Input
                className='h-7 w-[150px] text-[11px]'
                value={c.label}
                onChange={(e) => updAt(i, { label: e.target.value })}
                placeholder='Custom label'
              />
              <div className='w-[104px]'>
                <PickCombobox
                  value={c.format}
                  onChange={(v) => updAt(i, { format: v })}
                  options={FORMAT_OPTS}
                  widthClass='w-[130px]'
                />
              </div>
              {c.format === 'flag' && (
                <div className='w-[92px]'>
                  <PickCombobox
                    value={c.color || 'amber'}
                    onChange={(v) => updAt(i, { color: v })}
                    options={STATUS_COLOR_OPTS}
                    widthClass='w-[120px]'
                  />
                </div>
              )}
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7 shrink-0'
                aria-label={`Remove ${displayName(c)}`}
                onClick={() => removeAt(i)}
              >
                <X className='h-3.5 w-3.5' />
              </Button>
            </div>
          ))}
        </div>
      )}
      {fieldOptions.length === 0 ? (
        <p className='text-[11px] text-slate-400'>Select a target collection first.</p>
      ) : (
        <div className='flex flex-wrap items-center gap-1.5'>
          <div className='w-[200px]'>
            <PickCombobox
              value=''
              onChange={add}
              options={fieldOptions.filter((f) => !has(f.value))}
              placeholder='Add field…'
            />
          </div>
          <div className='w-[200px]'>
            <PickCombobox
              value={relField}
              onChange={setRelField}
              options={m2oOpts.map((o) => ({
                value: o.field,
                label: `${o.label} → ${o.related}`
              }))}
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
      {allowLookup && (
        <div>
          <Button
            size='sm'
            variant='ghost'
            className='h-6 gap-1 px-2 text-[11px] text-muted-foreground'
            onClick={() => setLookupOpen((o) => !o)}
          >
            <Plus className='h-3 w-3' />
            Lookup column…
          </Button>
          {lookupOpen && (
            <div className='mt-2 space-y-1.5 rounded-md border border-dashed border-slate-300 p-2.5 dark:border-border'>
              <div className='flex flex-wrap items-center gap-1.5'>
                <div className='w-[200px]'>
                  <PickCombobox
                    value={lookupCollection}
                    onChange={(v) => {
                      setLookupCollection(v)
                      setLookupField('')
                      setLookupPairs([{ local: '', remote: '' }])
                    }}
                    options={allCollectionOpts}
                    placeholder='Lookup collection…'
                  />
                </div>
                <div className='w-[200px]'>
                  <PickCombobox
                    value={lookupField}
                    onChange={setLookupField}
                    options={lookupFieldOpts}
                    placeholder='Field to display…'
                    disabled={!lookupCollection}
                  />
                </div>
              </div>
              <div className='space-y-1'>
                <Label className='text-[10px] text-muted-foreground'>
                  Match on ({collection || 'target'} = {lookupCollection || '…'})
                </Label>
                {lookupPairs.map((p, i) => (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                    key={i}
                    className='flex items-center gap-1.5'
                  >
                    <div className='w-[170px]'>
                      <PickCombobox
                        value={p.local}
                        onChange={(v) =>
                          setLookupPairs((pairs) =>
                            pairs.map((x, j) => (j === i ? { ...x, local: v } : x))
                          )
                        }
                        options={fieldOptions}
                        placeholder='target field…'
                      />
                    </div>
                    <span className='text-[11px] text-slate-400'>=</span>
                    <div className='w-[170px]'>
                      <PickCombobox
                        value={p.remote}
                        onChange={(v) =>
                          setLookupPairs((pairs) =>
                            pairs.map((x, j) => (j === i ? { ...x, remote: v } : x))
                          )
                        }
                        options={lookupFieldOpts}
                        placeholder='lookup field…'
                        disabled={!lookupCollection}
                      />
                    </div>
                    {lookupPairs.length > 1 && (
                      <Button
                        size='icon'
                        variant='ghost'
                        className='h-7 w-7 shrink-0'
                        aria-label='Remove match pair'
                        onClick={() => setLookupPairs((pairs) => pairs.filter((_, j) => j !== i))}
                      >
                        <X className='h-3.5 w-3.5' />
                      </Button>
                    )}
                  </div>
                ))}
                {lookupPairs.length < 3 && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-7 text-[12px]'
                    onClick={() => setLookupPairs((pairs) => [...pairs, { local: '', remote: '' }])}
                  >
                    <Plus className='mr-1 h-3 w-3' />
                    Add match pair
                  </Button>
                )}
              </div>
              <Input
                className='h-7 text-[12px]'
                value={lookupLabel}
                onChange={(e) => setLookupLabel(e.target.value)}
                placeholder='Label (required)'
              />
              <Button
                size='sm'
                className='h-7 text-[12px]'
                disabled={!canAddLookup}
                onClick={addLookup}
              >
                <Plus className='mr-1 h-3 w-3' />
                Add
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Titled form region — carries the semantic grouping of the config editor. */
export function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className='space-y-3'>
      <div>
        <h4 className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>{title}</h4>
        {hint && <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function ReviewListConfigForm({
  cfg,
  onChange,
  onValidityChange
}: {
  cfg: ReviewListCfg
  onChange: (c: ReviewListCfg) => void
  onValidityChange?: (valid: boolean) => void
}) {
  const colOpts = useCollectionOptions()
  const targetFieldOpts = useFieldOptions(cfg.collection)
  const nullableTargetFieldOpts = [{ value: '', label: 'None' }, ...targetFieldOpts]

  function set<K extends keyof ReviewListCfg>(k: K, v: ReviewListCfg[K]) {
    onChange({ ...cfg, [k]: v })
  }

  // Fixed 4-hop hook budget (MAX_PATH_HOPS in review-list.ts) — each hop's
  // source collection is only known once the prior hop's relations resolve,
  // so these chain sequentially, but the hook COUNT stays constant every
  // render (rules-of-hooks safe).
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

  const statusValid =
    cfg.status_field !== '' &&
    cfg.status_options.length > 0 &&
    cfg.status_options.every((o) => o.value.trim() && o.label.trim() && o.color.trim()) &&
    new Set(cfg.status_options.map((o) => o.value)).size === cfg.status_options.length

  const valid =
    !!cfg.host_collection && !!cfg.collection && pathValid && cfg.group_by !== '' && statusValid

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
      group_by: '',
      aggregate_sum: '',
      group_meta: [],
      line_columns: [],
      status_field: '',
      stamp_user_field: '',
      stamp_date_field: ''
    })
  }

  return (
    <div className='space-y-5'>
      <Section
        title='Data source'
        hint='Which records are reviewed, and how they connect to the record this widget sits on.'
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
              Target collection{' '}
              <span className='text-[10px] opacity-60'>(rows being reviewed)</span>
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
        hint='Only rows matching every filter appear in the list (e.g. is_on_hold = true).'
      >
        <ReviewListFilterRows
          rows={cfg.static_filter}
          fieldOptions={targetFieldOpts}
          onChange={(v) => set('static_filter', v)}
        />
      </Section>

      <Separator />

      <Section
        title='Grouping & totals'
        hint='Rows are grouped into collapsible bands; the total shows in each band header.'
      >
        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>Group by</Label>
            <PickCombobox
              value={cfg.group_by}
              onChange={(v) => set('group_by', v)}
              options={targetFieldOpts}
              placeholder='Select field…'
              disabled={!cfg.collection}
            />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Sum aggregate <span className='text-[10px] opacity-60'>(optional)</span>
            </Label>
            <div className='flex items-center gap-1.5'>
              <div className='flex-1'>
                <PickCombobox
                  value={cfg.aggregate_sum}
                  onChange={(v) => set('aggregate_sum', v)}
                  options={nullableTargetFieldOpts}
                  placeholder='None'
                  disabled={!cfg.collection}
                />
              </div>
              {cfg.aggregate_sum && (
                <div className='w-[100px]'>
                  <PickCombobox
                    value={cfg.aggregate_sum_format}
                    onChange={(v) => set('aggregate_sum_format', v)}
                    options={FORMAT_OPTS.filter((o) =>
                      ['', 'number', 'currency'].includes(o.value)
                    )}
                    widthClass='w-[130px]'
                  />
                </div>
              )}
            </div>
          </div>
        </div>
        {cfg.aggregate_sum &&
          !cfg.group_meta.some((c) => c.field === cfg.aggregate_sum) &&
          !cfg.line_columns.some((c) => c.field === cfg.aggregate_sum) && (
            <p className='text-[11px] text-amber-600 dark:text-amber-500'>
              "{cfg.aggregate_sum}" only displays if also added to Group chips or Line columns
              below.
            </p>
          )}
      </Section>

      <Separator />

      <Section
        title='Columns'
        hint='What each group shows. Add fields from the target collection, or reach one hop into a related record.'
      >
        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Group chips <span className='text-[10px] opacity-60'>(shown on the band header)</span>
            </Label>
            <ColumnListEditor
              collection={cfg.collection}
              fieldOptions={targetFieldOpts}
              value={cfg.group_meta}
              onChange={(v) => set('group_meta', v)}
            />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Line columns <span className='text-[10px] opacity-60'>(the expanded table)</span>
            </Label>
            <ColumnListEditor
              collection={cfg.collection}
              fieldOptions={targetFieldOpts}
              value={cfg.line_columns}
              onChange={(v) => set('line_columns', v)}
            />
          </div>
        </div>
      </Section>

      <Separator />

      <Section
        title='Review actions'
        hint='The status written by the Approve/Reject-style buttons, and who/when stamps.'
      >
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>Status field</Label>
          <PickCombobox
            value={cfg.status_field}
            onChange={(v) => set('status_field', v)}
            options={targetFieldOpts}
            placeholder='Select field…'
            disabled={!cfg.collection}
          />
        </div>

        <div>
          <div className='mb-2 flex items-center justify-between'>
            <Label className='text-[11px] text-muted-foreground'>Status options</Label>
            <Button
              size='sm'
              variant='outline'
              className='h-6 gap-1 px-2 text-[11px]'
              onClick={() =>
                set('status_options', [
                  ...cfg.status_options,
                  { value: '', label: '', color: 'green' }
                ])
              }
            >
              <Plus className='h-3 w-3' />
              Add
            </Button>
          </div>
          <div className='space-y-1.5'>
            {cfg.status_options.length === 0 && (
              <p className='text-[11px] text-slate-400'>No status options — add at least one.</p>
            )}
            {cfg.status_options.map((opt, i) => {
              const upd = (patch: Partial<RLStatusOption>) =>
                set(
                  'status_options',
                  cfg.status_options.map((o, j) => (j === i ? { ...o, ...patch } : o))
                )
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                <div key={i} className='flex items-center gap-1.5'>
                  <Input
                    className='h-7 w-[120px] font-mono text-[12px]'
                    value={opt.value}
                    onChange={(e) => upd({ value: e.target.value })}
                    placeholder='value'
                  />
                  <Input
                    className='h-7 flex-1 text-[12px]'
                    value={opt.label}
                    onChange={(e) => upd({ label: e.target.value })}
                    placeholder='Label'
                  />
                  <div className='w-[110px]'>
                    <PickCombobox
                      value={opt.color}
                      onChange={(v) => upd({ color: v })}
                      options={STATUS_COLOR_OPTS}
                      widthClass='w-[140px]'
                    />
                  </div>
                  <Button
                    size='icon'
                    variant='ghost'
                    className='h-7 w-7 shrink-0'
                    aria-label='Remove option'
                    onClick={() =>
                      set(
                        'status_options',
                        cfg.status_options.filter((_, j) => j !== i)
                      )
                    }
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </Button>
                </div>
              )
            })}
          </div>
        </div>

        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>
            Empty status badge{' '}
            <span className='text-[10px] opacity-60'>(shown when a row has no status yet)</span>
          </Label>
          <div className='flex items-center gap-1.5'>
            <Input
              className='h-7 flex-1 text-[12px]'
              value={cfg.status_empty_label}
              onChange={(e) => set('status_empty_label', e.target.value)}
              placeholder='e.g. Unreviewed — empty for a plain dash'
            />
            {cfg.status_empty_label && (
              <div className='w-[110px]'>
                <PickCombobox
                  value={cfg.status_empty_color || 'blue'}
                  onChange={(v) => set('status_empty_color', v)}
                  options={STATUS_COLOR_OPTS}
                  widthClass='w-[140px]'
                />
              </div>
            )}
          </div>
        </div>

        <div className='grid grid-cols-2 gap-3'>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Stamp user field <span className='text-[10px] opacity-60'>(optional)</span>
            </Label>
            <PickCombobox
              value={cfg.stamp_user_field}
              onChange={(v) => set('stamp_user_field', v)}
              options={nullableTargetFieldOpts}
              placeholder='None'
              disabled={!cfg.collection}
            />
          </div>
          <div className='space-y-1'>
            <Label className='text-[11px] text-muted-foreground'>
              Stamp date field <span className='text-[10px] opacity-60'>(optional)</span>
            </Label>
            <PickCombobox
              value={cfg.stamp_date_field}
              onChange={(v) => set('stamp_date_field', v)}
              options={nullableTargetFieldOpts}
              placeholder='None'
              disabled={!cfg.collection}
            />
          </div>
        </div>
      </Section>

      <div className='rounded-md bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-muted/20 dark:text-muted-foreground'>
        When placing this widget on a layout, bind input{' '}
        <code className='font-mono'>record_id</code> to the record id (Add Widget defaults this
        automatically for review-list widgets — verify it under the widget slot's Bindings section).
      </div>
    </div>
  )
}
