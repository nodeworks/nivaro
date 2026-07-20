import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plus, Trash2, X } from 'lucide-react'
import { useEffect } from 'react'
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
/** Column entry — label/format '' means unset (serialized back to plain string). */
export interface RLColumn {
  field: string
  label: string
  format: string
  color: string
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

function rawColumns(v: unknown): RLColumn[] {
  if (!Array.isArray(v)) return []
  return (v as unknown[]).map((e) => {
    if (typeof e === 'object' && e !== null) {
      const o = e as Record<string, unknown>
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

function columnsToRaw(cols: RLColumn[]): Array<string | Record<string, unknown>> {
  return cols.map((c) => {
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

function useRelationsFor(collection: string) {
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
function hopOptionsForCollection(cur: string, relations: RLRelRow[]): HopOption[] {
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

const STATUS_COLOR_OPTS = [
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

function ReviewListFilterRows({
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

const FORMAT_OPTS = [
  { value: '', label: 'Raw' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date + time' },
  { value: 'flag', label: 'Flag badge' }
]

function MultiFieldPicker({
  fieldOptions,
  value,
  onChange
}: {
  fieldOptions: { value: string; label: string }[]
  value: RLColumn[]
  onChange: (v: RLColumn[]) => void
}) {
  const selected = (field: string) => value.some((c) => c.field === field)
  function toggle(field: string, checked: boolean) {
    onChange(
      checked
        ? [...value, { field, label: '', format: '', color: '' }]
        : value.filter((c) => c.field !== field)
    )
  }
  function upd(field: string, patch: Partial<RLColumn>) {
    onChange(value.map((c) => (c.field === field ? { ...c, ...patch } : c)))
  }
  return (
    <div className='space-y-1.5'>
      <div className='max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2 dark:border-border'>
        {fieldOptions.length === 0 && (
          <p className='text-[11px] text-slate-400'>
            No fields — select a target collection first.
          </p>
        )}
        {fieldOptions.map((f) => (
          <label key={f.value} className='flex items-center gap-2 text-[12px]'>
            <input
              type='checkbox'
              checked={selected(f.value)}
              onChange={(e) => toggle(f.value, e.target.checked)}
              className='h-3.5 w-3.5 rounded border-slate-300'
            />
            <span className='font-mono'>{f.value}</span>
          </label>
        ))}
      </div>
      {value.length > 0 && (
        <div className='space-y-1'>
          {value.map((c) => (
            <div key={c.field} className='flex items-center gap-1.5'>
              <Badge
                variant='outline'
                className='w-[130px] shrink-0 justify-start font-mono text-[10px]'
              >
                <span className='truncate'>{c.field}</span>
              </Badge>
              <Input
                className='h-6 flex-1 text-[11px]'
                value={c.label}
                onChange={(e) => upd(c.field, { label: e.target.value })}
                placeholder='Label override'
              />
              <div className='w-[100px]'>
                <PickCombobox
                  value={c.format}
                  onChange={(v) => upd(c.field, { format: v })}
                  options={FORMAT_OPTS}
                  widthClass='w-[130px]'
                />
              </div>
              {c.format === 'flag' && (
                <div className='w-[90px]'>
                  <PickCombobox
                    value={c.color || 'amber'}
                    onChange={(v) => upd(c.field, { color: v })}
                    options={STATUS_COLOR_OPTS}
                    widthClass='w-[120px]'
                  />
                </div>
              )}
              <Button
                size='icon'
                variant='ghost'
                className='h-6 w-6 shrink-0'
                aria-label={`Remove ${c.field}`}
                onClick={() => onChange(value.filter((x) => x.field !== c.field))}
              >
                <X className='h-3 w-3' />
              </Button>
            </div>
          ))}
        </div>
      )}
      <CustomDotPathInput
        onAdd={(v) => {
          if (!selected(v)) onChange([...value, { field: v, label: '', format: '', color: '' }])
        }}
      />
    </div>
  )
}

function CustomDotPathInput({ onAdd }: { onAdd: (v: string) => void }) {
  return (
    <Input
      className='h-7 font-mono text-[12px]'
      placeholder='dot-path e.g. purchase_order.number — Enter to add'
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const v = e.currentTarget.value.trim()
        if (v) {
          onAdd(v)
          e.currentTarget.value = ''
        }
      }}
    />
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
    <div className='space-y-4'>
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
            Target collection <span className='text-[10px] opacity-60'>(rows being reviewed)</span>
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
          Relation path <span className='text-[10px] opacity-60'>(target → host, hop by hop)</span>
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

      <Separator />

      <div>
        <Label className='mb-2 block text-[11px] text-muted-foreground'>Static filters</Label>
        <ReviewListFilterRows
          rows={cfg.static_filter}
          fieldOptions={targetFieldOpts}
          onChange={(v) => set('static_filter', v)}
        />
      </div>

      <Separator />

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
                  options={FORMAT_OPTS.filter((o) => ['', 'number', 'currency'].includes(o.value))}
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
            "{cfg.aggregate_sum}" only displays if also added to Group meta or Line columns below.
          </p>
        )}

      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>
            Group meta <span className='text-[10px] opacity-60'>(chips on the group row)</span>
          </Label>
          <MultiFieldPicker
            fieldOptions={targetFieldOpts}
            value={cfg.group_meta}
            onChange={(v) => set('group_meta', v)}
          />
        </div>
        <div className='space-y-1'>
          <Label className='text-[11px] text-muted-foreground'>
            Line columns <span className='text-[10px] opacity-60'>(child table columns)</span>
          </Label>
          <MultiFieldPicker
            fieldOptions={targetFieldOpts}
            value={cfg.line_columns}
            onChange={(v) => set('line_columns', v)}
          />
        </div>
      </div>

      <Separator />

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

      <div className='rounded-md bg-slate-50 px-3 py-2 text-[11px] text-slate-500 dark:bg-muted/20 dark:text-muted-foreground'>
        When placing this widget on a layout, bind input{' '}
        <code className='font-mono'>record_id</code> to the record id (Add Widget defaults this
        automatically for review-list widgets — verify it under the widget slot's Bindings section).
      </div>
    </div>
  )
}
