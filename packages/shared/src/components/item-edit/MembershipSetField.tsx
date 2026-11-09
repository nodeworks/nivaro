import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { cn, matchesAllTokens, titleCase } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { applyDisplayTemplate } from './helpers'
import { RelationCombobox } from './RelationCombobox'
import type { CMSRelation } from './types'

// ─── MembershipSetField ───────────────────────────────────────────────────────
// An O2M whose child rows are MEMBERSHIPS: one row per (key, value), where the
// value may be blank to mean "every value". Editing that as a plain grid makes
// people add the same key once per value; here each key is ONE line and its
// values are a multi-select. The rows underneath stay one per (key, value) —
// the storage shape is untouched:
//
//   nothing selected  → a single row whose value is blank   (= all)
//   values selected   → one row per selected value, no blank row
//
// The first pick re-points the blank row at that value and clearing the last
// pick blanks it again, so a key never drops out of the set mid-edit.
//
// Optional SECOND value (`value_field_2`, e.g. Project Type beside Zone): the
// rows are then the cross product of both picks — Zone 1 + Zone 3 with
// Commercial = two rows; a blank side means "every value" on that side. Edits
// reconcile the key's rows to that product (re-pointing rows before creating,
// deleting only leftovers), so a key always keeps at least one row.

export interface MembershipSetConfig {
  /** Child M2O naming the member (what each line is). */
  key_field: string
  /** Child M2O the line is scoped by; blank on a row = every value. */
  value_field: string
  /** Shown while nothing is selected (default 'All'). */
  empty_label?: string
  key_label?: string
  value_label?: string
  /** Optional second child M2O the line is also scoped by (blank = every value). */
  value_field_2?: string
  value_label_2?: string
  empty_label_2?: string
}

interface Row {
  id: string | number
  key: string
  value: string | null
  value2: string | null
}

type Pair = [string | null, string | null]
const pairKey = (a: string | null, b: string | null) => `${a ?? ''}\u0000${b ?? ''}`

/** The edits that turn `rows` into exactly `want` (cross product of picks). Pure. */
export function planMembershipRows(
  rows: Array<{ id: string | number; value: string | null; value2: string | null }>,
  want: Pair[]
): {
  repoint: Array<{ id: string | number; pair: Pair }>
  create: Pair[]
  remove: Array<string | number>
} {
  const wanted = new Map(want.map((p) => [pairKey(p[0], p[1]), p]))
  const covered = new Set<string>()
  const extras: Array<string | number> = []
  for (const r of rows) {
    const k = pairKey(r.value, r.value2)
    if (wanted.has(k) && !covered.has(k)) covered.add(k)
    else extras.push(r.id)
  }
  const repoint: Array<{ id: string | number; pair: Pair }> = []
  const create: Pair[] = []
  for (const [k, p] of wanted) {
    if (covered.has(k)) continue
    const id = extras.shift()
    if (id !== undefined) repoint.push({ id, pair: p })
    else create.push(p)
  }
  return { repoint, create, remove: extras }
}

const crossPairs = (a: Set<string>, b: Set<string>): Pair[] => {
  const as: Array<string | null> = a.size ? [...a] : [null]
  const bs: Array<string | null> = b.size ? [...b] : [null]
  return as.flatMap((x) => bs.map((y) => [x, y] as Pair))
}

const CHIP_LIMIT = 10

async function readAll(
  client: ReturnType<typeof useNivaroClient>,
  path: string,
  params: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let page = 1; page <= 50; page++) {
    const rows = await client
      .request<{ data: Record<string, unknown>[] }>(get(path, { ...params, limit: 1000, page }))
      .then((r) => r.data ?? [])
    out.push(...rows)
    if (rows.length < 1000) break
  }
  return out
}

const templateFields = (tmpl: string | null | undefined): string[] =>
  [...(tmpl ?? '').matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1])

function useCollectionLabels(collection: string | null, ids: string[] | 'all') {
  const client = useNivaroClient()
  const { data: meta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['collection-display-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string | null } }>(get(`/collections/${collection}`))
        .then((r) => ({ display_template: r.data?.display_template ?? null })),
    enabled: !!collection,
    staleTime: 10 * 60_000
  })
  const tmpl = meta?.display_template ?? null
  const idKey = ids === 'all' ? 'all' : [...ids].sort().join(',')
  const { data: rows = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['membership-set-labels', collection, tmpl, idKey],
    queryFn: async () => {
      const fields = templateFields(tmpl)
      const base = fields.length ? { fields: ['id', ...fields].join(',') } : {}
      if (ids === 'all') return readAll(client, `/items/${collection}`, base)
      const out: Record<string, unknown>[] = []
      for (let i = 0; i < ids.length; i += 150)
        out.push(
          ...(await readAll(client, `/items/${collection}`, {
            ...base,
            filter: JSON.stringify({ id: { _in: ids.slice(i, i + 150) } })
          }))
        )
      return out
    },
    enabled: !!collection && meta !== undefined && (ids === 'all' || ids.length > 0),
    staleTime: 60_000
  })
  const labels = useMemo(() => {
    const map = new Map<string, string>()
    for (const r of rows) {
      const fallback = String(r.name ?? r.title ?? r.label ?? `#${r.id}`)
      map.set(String(r.id), (tmpl ? applyDisplayTemplate(tmpl, r) : '').trim() || fallback)
    }
    return map
  }, [rows, tmpl])
  return { labels, isLoading }
}

export function MembershipSetField({
  relatedCollection,
  manyField,
  parentId,
  config,
  readOnly
}: {
  relatedCollection: string
  manyField: string
  parentId: string | number
  config: MembershipSetConfig
  readOnly?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const isNew = parentId === 'new'
  const { key_field: keyField, value_field: valueField } = config
  const valueField2 = config.value_field_2 || null
  const emptyLabel = config.empty_label ?? 'All'
  const emptyLabel2 = config.empty_label_2 ?? emptyLabel
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: childRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-relations', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/collections/${relatedCollection}`))
        .then((r) => (r.data as { relations?: CMSRelation[] })?.relations ?? []),
    staleTime: 10 * 60_000
  })
  const targetOf = (f: string) =>
    childRelations.find((r) => r.many_collection === relatedCollection && r.many_field === f)
      ?.one_collection ?? null
  const keyCollection = targetOf(keyField)
  const valueCollection = targetOf(valueField)
  const valueCollection2 = valueField2 ? targetOf(valueField2) : null

  const rowsKey = ['membership-set-rows', relatedCollection, manyField, String(parentId)]
  const { data: rows = [], isLoading } = useQuery<Row[]>({
    queryKey: rowsKey,
    queryFn: async () =>
      (
        await readAll(client, `/items/${relatedCollection}`, {
          fields: [`id`, keyField, valueField, ...(valueField2 ? [valueField2] : [])].join(','),
          filter: JSON.stringify({ [manyField]: { _eq: parentId } })
        })
      )
        .filter((r) => r[keyField] != null)
        .map((r) => ({
          id: r.id as string | number,
          key: String(r[keyField]),
          value: r[valueField] == null ? null : String(r[valueField]),
          value2: !valueField2 || r[valueField2] == null ? null : String(r[valueField2])
        })),
    enabled: !isNew,
    staleTime: 15_000
  })

  const byKey = useMemo(() => {
    const map = new Map<string, Row[]>()
    for (const r of rows) map.set(r.key, [...(map.get(r.key) ?? []), r])
    return map
  }, [rows])
  const keyIds = useMemo(() => [...byKey.keys()], [byKey])
  const { labels: keyLabels } = useCollectionLabels(keyCollection, keyIds)
  const { labels: valueLabels } = useCollectionLabels(valueCollection, 'all')
  const { labels: valueLabels2 } = useCollectionLabels(valueCollection2, 'all')
  const toOptions = (labels: Map<string, string>) =>
    [...labels.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  const valueOptions = useMemo(() => toOptions(valueLabels), [valueLabels])
  const valueOptions2 = useMemo(() => toOptions(valueLabels2), [valueLabels2])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: rowsKey })
    qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection] })
  }
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
    } catch (e) {
      const resp = (e as { response?: { error?: string } })?.response
      setError(resp?.error ?? userErrorMessage(e, 'Could not save'))
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const picksOf = (key: string) => {
    const mine = byKey.get(key) ?? []
    return {
      a: new Set(mine.filter((r) => r.value !== null).map((r) => r.value as string)),
      b: new Set(mine.filter((r) => r.value2 !== null).map((r) => r.value2 as string))
    }
  }
  const rowBody = ([a, b]: Pair) => ({
    [valueField]: a,
    ...(valueField2 ? { [valueField2]: b } : {})
  })
  // Every edit = "these are the picks now"; the rows follow (planMembershipRows).
  const reconcile = (key: string, a: Set<string>, b: Set<string>) =>
    run(key, async () => {
      const plan = planMembershipRows(byKey.get(key) ?? [], crossPairs(a, b))
      for (const r of plan.repoint)
        await client.request(patch(`/items/${relatedCollection}/${r.id}`, rowBody(r.pair)))
      for (const p of plan.create)
        await client.request(
          post(`/items/${relatedCollection}`, {
            [manyField]: parentId,
            [keyField]: key,
            ...rowBody(p)
          })
        )
      for (const id of plan.remove) await client.request(del(`/items/${relatedCollection}/${id}`))
    })
  const flip = (set: Set<string>, id: string) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }
  const toggle = (key: string, valueId: string, side: 1 | 2 = 1) => {
    const { a, b } = picksOf(key)
    return side === 1 ? reconcile(key, flip(a, valueId), b) : reconcile(key, a, flip(b, valueId))
  }
  const clearValues = (key: string, side: 1 | 2 = 1) => {
    const { a, b } = picksOf(key)
    if ((side === 1 ? a : b).size === 0) return
    return side === 1 ? reconcile(key, new Set(), b) : reconcile(key, a, new Set())
  }

  const removeKey = (key: string) =>
    run(key, async () => {
      for (const r of byKey.get(key) ?? [])
        await client.request(del(`/items/${relatedCollection}/${r.id}`))
    })

  const addKey = (id: unknown) => {
    if (id == null || id === '' || byKey.has(String(id))) return
    run(String(id), () =>
      client.request(
        post(`/items/${relatedCollection}`, {
          [manyField]: parentId,
          [keyField]: id,
          ...rowBody([null, null])
        })
      )
    )
  }

  const lines = useMemo(() => {
    const all = keyIds
      .map((k) => ({ key: k, label: keyLabels.get(k) ?? `#${k}` }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
    const q = search.trim()
    return q ? all.filter((l) => matchesAllTokens(l.label, q)) : all
  }, [keyIds, keyLabels, search])

  const keyTitle = config.key_label ?? titleCase(keyCollection ?? keyField)
  const valueTitle = config.value_label ?? titleCase(valueCollection ?? valueField)
  const valueTitle2 = valueField2
    ? (config.value_label_2 ?? titleCase(valueCollection2 ?? valueField2))
    : ''
  const gridCols = valueField2
    ? 'grid-cols-[minmax(140px,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_28px]'
    : 'grid-cols-[minmax(140px,1fr)_minmax(0,2fr)_28px]'

  if (isNew)
    return (
      <p className='rounded-lg border border-dashed border-slate-200 px-3 py-4 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
        Save this record first, then add {keyTitle.toLowerCase()} here.
      </p>
    )

  return (
    <div data-membership-set={`${relatedCollection}:${manyField}`} className='space-y-2'>
      {!readOnly && keyCollection && (
        <div className='flex flex-wrap items-center gap-2'>
          <div className='w-[320px] max-w-full'>
            <RelationCombobox
              key={keyIds.length}
              collection={keyCollection}
              value={null}
              onChange={addKey}
              placeholder={`Add ${keyTitle.toLowerCase()}…`}
              extraFilter={
                keyIds.length && keyIds.length <= 400 ? { id: { _nin: keyIds } } : undefined
              }
            />
          </div>
          {keyIds.length > 8 && (
            <label className='relative ml-auto block w-[220px] max-w-full'>
              <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Filter ${keyIds.length}…`}
                aria-label={`Filter ${keyTitle}`}
                className='h-8 w-full rounded-md border border-slate-200 bg-background pl-7 pr-2 text-[12px] outline-none focus:border-nvr-cyan dark:border-border'
              />
            </label>
          )}
        </div>
      )}

      <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
        <div
          className={cn(
            gridCols,
            'grid gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-slate-500 dark:border-border dark:bg-muted dark:text-muted-foreground'
          )}
        >
          <span>{keyTitle}</span>
          <span>
            {valueTitle}{' '}
            <span className='normal-case tracking-normal text-slate-400'>
              · none picked = {emptyLabel.toLowerCase()}
            </span>
          </span>
          {valueField2 && (
            <span>
              {valueTitle2}{' '}
              <span className='normal-case tracking-normal text-slate-400'>
                · none picked = {emptyLabel2.toLowerCase()}
              </span>
            </span>
          )}
          <span />
        </div>
        {isLoading ? (
          <div className='space-y-2 p-3'>
            {[0, 1, 2].map((i) => (
              <div key={i} className='h-6 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
            ))}
          </div>
        ) : lines.length === 0 ? (
          <p className='px-3 py-5 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
            {keyIds.length ? 'Nothing matches that filter.' : `No ${keyTitle.toLowerCase()} yet.`}
          </p>
        ) : (
          <ul className='max-h-[480px] divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
            {lines.map((line) => {
              const mine = byKey.get(line.key) ?? []
              const picked = new Set(
                mine.filter((r) => r.value !== null).map((r) => r.value as string)
              )
              const picked2 = new Set(
                mine.filter((r) => r.value2 !== null).map((r) => r.value2 as string)
              )
              return (
                <li
                  key={line.key}
                  data-membership-key={line.key}
                  className={cn(
                    gridCols,
                    'grid items-center gap-3 px-3 py-1.5 text-[12px]',
                    busy === line.key && 'opacity-60'
                  )}
                >
                  <span
                    className='truncate font-medium text-slate-800 dark:text-foreground'
                    data-tip={line.label}
                  >
                    {line.label}
                  </span>
                  <ValuePicker
                    options={valueOptions}
                    picked={picked}
                    emptyLabel={emptyLabel}
                    valueTitle={valueTitle}
                    disabled={!!readOnly || busy === line.key}
                    onToggle={(v) => toggle(line.key, v)}
                    onClear={() => clearValues(line.key)}
                  />
                  {valueField2 && (
                    <ValuePicker
                      options={valueOptions2}
                      picked={picked2}
                      emptyLabel={emptyLabel2}
                      valueTitle={valueTitle2}
                      disabled={!!readOnly || busy === line.key}
                      onToggle={(v) => toggle(line.key, v, 2)}
                      onClear={() => clearValues(line.key, 2)}
                    />
                  )}
                  {!readOnly ? (
                    <button
                      type='button'
                      onClick={() => removeKey(line.key)}
                      disabled={busy === line.key}
                      aria-label={`Remove ${line.label}`}
                      data-tip='Remove'
                      className='flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
      {error && <p className='text-[12px] text-red-600 dark:text-red-400'>{error}</p>}
    </div>
  )
}

function ValuePicker({
  options,
  picked,
  emptyLabel,
  valueTitle,
  disabled,
  onToggle,
  onClear
}: {
  options: Array<{ id: string; label: string }>
  picked: Set<string>
  emptyLabel: string
  valueTitle: string
  disabled: boolean
  onToggle: (id: string) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const none = picked.size === 0

  if (options.length <= CHIP_LIMIT)
    return (
      <div className='flex flex-wrap items-center gap-1' data-membership-values>
        <button
          type='button'
          disabled={disabled || none}
          aria-pressed={none}
          onClick={onClear}
          className={cn(
            'h-6 rounded-full border px-2 text-[11px] transition-colors',
            none
              ? 'border-nvr-cyan/40 bg-nvr-cyan/10 font-medium text-slate-800 dark:text-foreground'
              : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border dark:text-muted-foreground'
          )}
        >
          {emptyLabel}
        </button>
        {options.map((o) => {
          const on = picked.has(o.id)
          return (
            <button
              key={o.id}
              type='button'
              disabled={disabled}
              aria-pressed={on}
              data-membership-value={o.id}
              onClick={() => onToggle(o.id)}
              className={cn(
                'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] transition-colors',
                on
                  ? 'border-nvr-cyan/40 bg-nvr-cyan/10 font-medium text-slate-800 dark:text-foreground'
                  : 'border-slate-200 text-slate-500 hover:bg-muted dark:border-border dark:text-muted-foreground'
              )}
            >
              {on && <Check className='h-3 w-3' />}
              {o.label}
            </button>
          )
        })}
      </div>
    )

  const shown = q.trim() ? options.filter((o) => matchesAllTokens(o.label, q)) : options
  const summary = none
    ? emptyLabel
    : options
        .filter((o) => picked.has(o.id))
        .map((o) => o.label)
        .join(', ')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className='flex h-7 w-full items-center justify-between gap-2 rounded-md border border-slate-200 bg-background px-2 text-left text-[12px] dark:border-border'
        >
          <span className={cn('truncate', none && 'text-slate-500 dark:text-muted-foreground')}>
            {summary}
          </span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[260px] p-1'>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${valueTitle.toLowerCase()}…`}
          className='mb-1 h-7 w-full rounded border border-slate-200 bg-background px-2 text-[12px] outline-none dark:border-border'
        />
        <ul className='max-h-[240px] overflow-y-auto'>
          {/* One press back to "every value" — 30 project types are too many to untick (2026-11-09). */}
          {!q.trim() && (
            <li className='mb-1 border-b border-slate-100 pb-1 dark:border-border'>
              <button
                type='button'
                onClick={() => {
                  if (!none) onClear()
                }}
                aria-pressed={none}
                data-membership-clear
                className='flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] font-medium hover:bg-muted'
              >
                <Check className={cn('h-3.5 w-3.5', none ? 'opacity-100' : 'opacity-0')} />
                {emptyLabel}
              </button>
            </li>
          )}
          {shown.map((o) => (
            <li key={o.id}>
              <button
                type='button'
                onClick={() => onToggle(o.id)}
                className='flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-muted'
              >
                <Check
                  className={cn('h-3.5 w-3.5', picked.has(o.id) ? 'opacity-100' : 'opacity-0')}
                />
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
