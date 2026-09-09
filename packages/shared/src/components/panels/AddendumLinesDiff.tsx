import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { Fragment, useMemo, useState } from 'react'
import { get } from '../../lib/commands'
import { numericIntlOptions } from '../../lib/format-value'
import { cn, formatDate, formatDateTime, titleCase } from '../../lib/utils'
import { applyDisplayTemplate, SYSTEM_FIELDS } from '../item-edit/helpers'
import type { CMSField, CMSRelation } from '../item-edit/types'

/**
 * What an addendum does to a record's child rows, line by line: which rows
 * it adds, which it removes, and for a changed row each cell as
 * "was → will be" — the same reading a row's history gives, applied to a
 * proposal that has not landed yet.
 */
interface Client {
  request<T>(cmd: unknown): Promise<T>
}

type Row = Record<string, unknown>

const isEmpty = (v: unknown) => v === null || v === undefined || v === ''
const same = (a: unknown, b: unknown) => {
  if (isEmpty(a) && isEmpty(b)) return true
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b)
  if (
    Number.isFinite(Number(a)) &&
    Number.isFinite(Number(b)) &&
    String(a).trim() !== '' &&
    String(b).trim() !== ''
  )
    return Math.abs(Number(a) - Number(b)) < 0.005
  return String(a) === String(b)
}
const parseOpts = (col: CMSField | undefined): Record<string, unknown> => {
  const raw = col?.options
  if (!raw) return {}
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return raw as Record<string, unknown>
}
const HIDDEN = new Set([
  'sort',
  'created',
  'updated',
  'created_at',
  'updated_at',
  'changed',
  'creator'
])

const visibleKey = (k: string, fkField: string) =>
  !SYSTEM_FIELDS.has(k) &&
  !HIDDEN.has(k) &&
  k !== fkField &&
  k !== 'id' &&
  !k.startsWith('__') &&
  !k.includes('.')

/** Rows an addendum adds / changes / removes against the record's current rows. */
export function diffAddendumLines(proposed: Row[], original: Row[], fkField: string) {
  const byId = new Map(original.map((r) => [String(r.id), r]))
  const seen = new Set<string>()
  const added: Row[] = []
  const changed: Array<{
    row: Row
    before: Row
    cells: Array<{ field: string; before: unknown; after: unknown }>
  }> = []
  for (const row of proposed) {
    const id = isEmpty(row.id) ? null : String(row.id)
    const orig = id ? byId.get(id) : undefined
    if (!orig) {
      added.push(row)
      continue
    }
    seen.add(id as string)
    const cells: Array<{ field: string; before: unknown; after: unknown }> = []
    for (const k of Object.keys(row)) {
      if (!visibleKey(k, fkField)) continue
      if (same(orig[k], row[k])) continue
      cells.push({ field: k, before: orig[k], after: row[k] })
    }
    if (cells.length) changed.push({ row, before: orig, cells })
  }
  const removed = original.filter((r) => !seen.has(String(r.id)))
  return { added, changed, removed }
}

export function AddendumLinesDiff({
  client,
  childCollection,
  fkField,
  proposed,
  original,
  label,
  orderField
}: {
  client: Client
  childCollection: string
  fkField: string
  proposed: Row[]
  original: Row[]
  label: string
  /** Row-number column ("line_number") — names a row. */
  orderField?: string
}) {
  const { data: fields = [] } = useQuery<CMSField[]>({
    queryKey: ['field-config', childCollection, null],
    queryFn: () =>
      client
        .request<{ data: CMSField[] }>(get(`/field-config/${childCollection}`))
        .then((r) => r.data ?? []),
    staleTime: 60_000
  })
  const { data: relations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-relations-for', childCollection],
    queryFn: () =>
      client
        .request<{ data: CMSRelation[] }>(get(`/data-model/relations/for/${childCollection}`))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60_000
  })
  const fieldByName = useMemo(() => new Map(fields.map((f) => [f.field, f])), [fields])
  const m2o = useMemo(() => {
    const m = new Map<string, CMSRelation>()
    for (const r of relations) {
      if (
        r.many_collection === childCollection &&
        r.many_field &&
        !r.junction_field &&
        r.one_collection
      )
        m.set(r.many_field, r)
    }
    return m
  }, [relations, childCollection])

  const visible = (k: string) => visibleKey(k, fkField)
  const orderKey = orderField ?? (fieldByName.has('line_number') ? 'line_number' : undefined)

  const diff = useMemo(
    () => diffAddendumLines(proposed, original, fkField),
    [proposed, original, fkField]
  )

  // Labels for foreign keys named in the diff — one batched read per target.
  const lookups = useMemo(() => {
    const wanted = new Map<string, Set<string>>()
    const consider = (field: string, v: unknown) => {
      const rel = m2o.get(field)
      if (!rel?.one_collection || isEmpty(v) || typeof v === 'object') return
      const s = wanted.get(rel.one_collection) ?? new Set<string>()
      s.add(String(v))
      wanted.set(rel.one_collection, s)
    }
    for (const r of [...diff.added, ...diff.removed])
      for (const k of Object.keys(r)) if (visible(k)) consider(k, r[k])
    for (const c of diff.changed)
      for (const cell of c.cells) {
        consider(cell.field, cell.before)
        consider(cell.field, cell.after)
      }
    return wanted
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diff, m2o])
  const lookupKey = [...lookups.entries()]
    .map(([c, ids]) => `${c}:${[...ids].sort().join(',')}`)
    .sort()
    .join('|')
  const { data: labels = {} } = useQuery<Record<string, Record<string, string>>>({
    queryKey: ['addendum-line-labels', lookupKey],
    queryFn: async () => {
      const out: Record<string, Record<string, string>> = {}
      await Promise.all(
        [...lookups.entries()].map(async ([collection, ids]) => {
          const meta = await client
            .request<{ data: { display_template?: string | null } }>(
              get(`/collections/${collection}`)
            )
            .then((r) => r.data)
            .catch(() => null)
          const tmpl = meta?.display_template ?? undefined
          const tmplFields = tmpl ? [...tmpl.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]) : []
          const fieldsParam = tmplFields.some((f) => f.includes('.'))
            ? ['id', ...tmplFields].join(',')
            : undefined
          const rows = await client
            .request<{ data: Row[] }>(
              get(`/items/${collection}`, {
                filter: JSON.stringify({ id: { _in: [...ids] } }),
                limit: ids.size,
                ...(fieldsParam ? { fields: fieldsParam } : {})
              })
            )
            .then((r) => r.data ?? [])
            .catch(() => [])
          out[collection] = {}
          for (const row of rows) out[collection][String(row.id)] = applyDisplayTemplate(tmpl, row)
        })
      )
      return out
    },
    enabled: lookups.size > 0,
    staleTime: 5 * 60_000
  })

  const labelFor = (k: string) => fieldByName.get(k)?.label || titleCase(k)
  const fmt = (field: string, v: unknown): { text: string; mono?: boolean } => {
    if (isEmpty(v)) return { text: '—' }
    const col = fieldByName.get(field)
    const opts = parseOpts(col)
    const rel = m2o.get(field)
    if (rel?.one_collection) {
      const l = labels[rel.one_collection]?.[String(v)]
      return l ? { text: l } : { text: `#${String(v)}`, mono: true }
    }
    if (typeof v === 'boolean' || col?.type === 'boolean')
      return { text: v === true || v === 1 || v === '1' || v === 'true' ? 'Yes' : 'No' }
    if (typeof v === 'object') return { text: JSON.stringify(v), mono: true }
    const type = col?.type ?? ''
    if (opts.format === 'currency' && Number.isFinite(Number(v)))
      return {
        text: Number(v).toLocaleString('en-US', {
          ...numericIntlOptions(opts, 'currency'),
          currency: (opts.currency as string) || 'USD'
        }),
        mono: true
      }
    if (/^(date|dateTime|datetime|timestamp)$/i.test(type)) {
      const s = String(v)
      return { text: /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDate(s) : formatDateTime(s), mono: true }
    }
    if (
      typeof v === 'number' ||
      (/^(integer|decimal|float|bigInteger|money)$/i.test(type) && Number.isFinite(Number(v)))
    )
      return { text: Number(v).toLocaleString('en-US', numericIntlOptions(opts)), mono: true }
    const s = String(v)
    if (/<[a-z][\s\S]*>/i.test(s) && typeof document !== 'undefined') {
      const div = document.createElement('div')
      div.innerHTML = s
      return { text: (div.textContent || '').trim() || '—' }
    }
    return { text: s.length > 80 ? `${s.slice(0, 80)}…` : s }
  }
  const rowName = (r: Row) => {
    const n = orderKey ? r[orderKey] : undefined
    if (!isEmpty(n)) return `Line ${String(n)}`
    return isEmpty(r.id) ? 'New line' : `#${String(r.id)}`
  }
  const rowIdentity = (r: Row) => {
    for (const k of Object.keys(r)) {
      if (!visible(k) || m2o.has(k) || k === orderKey) continue
      const v = r[k]
      if (typeof v === 'string' && v.trim() && !/^-?\d+(\.\d+)?$/.test(v.trim()))
        return v.length > 48 ? `${v.slice(0, 48)}…` : v
    }
    return null
  }
  const snapshotOf = (r: Row) =>
    Object.keys(r)
      .filter((k) => visible(k) && !isEmpty(r[k]))
      .sort(
        (a, b) =>
          (fields.findIndex((f) => f.field === a) ?? 999) -
          (fields.findIndex((f) => f.field === b) ?? 999)
      )

  const [open, setOpen] = useState(true)
  const total = diff.added.length + diff.changed.length + diff.removed.length
  if (total === 0)
    return (
      <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
        {label}: {proposed.length} {proposed.length === 1 ? 'line' : 'lines'} — no changes
      </p>
    )
  const parts: string[] = []
  if (diff.added.length) parts.push(`${diff.added.length} added`)
  if (diff.changed.length) parts.push(`${diff.changed.length} changed`)
  if (diff.removed.length) parts.push(`${diff.removed.length} removed`)

  const dl =
    'mt-1 grid grid-cols-[minmax(84px,max-content)_1fr] gap-x-3 gap-y-0.5 text-[11.5px] leading-[18px]'
  const pill = (kind: 'added' | 'changed' | 'removed') =>
    cn(
      'rounded-full px-1.5 py-px text-[10px] font-medium',
      kind === 'added' &&
        'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
      kind === 'changed' && 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
      kind === 'removed' && 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
    )

  return (
    <div className='rounded-md border border-slate-200 dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] hover:bg-muted/60'
        aria-expanded={open}
      >
        <ChevronDown
          className={cn(
            'h-3 w-3 shrink-0 text-slate-400 transition-transform',
            !open && '-rotate-90'
          )}
          aria-hidden='true'
        />
        <span className='font-medium text-foreground'>{label}</span>
        <span className='text-slate-500 dark:text-slate-400'>{parts.join(' · ')}</span>
      </button>
      {open && (
        <ol className='space-y-2.5 border-t border-slate-100 px-2.5 py-2 dark:border-border'>
          {diff.changed.map((c) => (
            <li key={`c-${String(c.row.id)}`}>
              <div className='flex flex-wrap items-baseline gap-x-1.5 text-[11.5px]'>
                <span className={pill('changed')}>changed</span>
                <span className='font-medium text-foreground'>{rowName(c.before)}</span>
                {rowIdentity(c.before) && (
                  <span className='truncate text-slate-500'>— {rowIdentity(c.before)}</span>
                )}
              </div>
              <dl className={dl}>
                {c.cells.map((cell) => {
                  const from = fmt(cell.field, cell.before)
                  const to = fmt(cell.field, cell.after)
                  return (
                    <Fragment key={cell.field}>
                      <dt className='truncate text-slate-500 dark:text-slate-400'>
                        {labelFor(cell.field)}
                      </dt>
                      <dd className='flex min-w-0 flex-wrap items-baseline gap-x-1.5'>
                        <span
                          className={cn(
                            'text-slate-400 line-through decoration-slate-300 dark:decoration-slate-600',
                            from.mono && 'tabular-nums'
                          )}
                        >
                          {from.text}
                        </span>
                        <span
                          className={cn('font-medium text-foreground', to.mono && 'tabular-nums')}
                        >
                          <span className='mr-1 font-normal text-slate-400' aria-hidden='true'>
                            →
                          </span>
                          {to.text}
                        </span>
                      </dd>
                    </Fragment>
                  )
                })}
              </dl>
            </li>
          ))}
          {diff.added.map((r, i) => (
            <li key={`a-${String(r.id ?? i)}`}>
              <div className='flex flex-wrap items-baseline gap-x-1.5 text-[11.5px]'>
                <span className={pill('added')}>added</span>
                <span className='font-medium text-foreground'>{rowName(r)}</span>
                {rowIdentity(r) && (
                  <span className='truncate text-slate-500'>— {rowIdentity(r)}</span>
                )}
              </div>
              <dl className={dl}>
                {snapshotOf(r)
                  .slice(0, 6)
                  .map((k) => {
                    const v = fmt(k, r[k])
                    return (
                      <Fragment key={k}>
                        <dt className='truncate text-slate-500 dark:text-slate-400'>
                          {labelFor(k)}
                        </dt>
                        <dd className={cn('text-foreground', v.mono && 'tabular-nums')}>
                          {v.text}
                        </dd>
                      </Fragment>
                    )
                  })}
              </dl>
            </li>
          ))}
          {diff.removed.map((r) => (
            <li key={`r-${String(r.id)}`}>
              <div className='flex flex-wrap items-baseline gap-x-1.5 text-[11.5px]'>
                <span className={pill('removed')}>removed</span>
                <span className='font-medium text-foreground'>{rowName(r)}</span>
                {rowIdentity(r) && (
                  <span className='truncate text-slate-500'>— {rowIdentity(r)}</span>
                )}
              </div>
              <dl className={cn(dl, 'text-slate-500')}>
                {snapshotOf(r)
                  .slice(0, 4)
                  .map((k) => {
                    const v = fmt(k, r[k])
                    return (
                      <Fragment key={k}>
                        <dt className='truncate'>{labelFor(k)}</dt>
                        <dd
                          className={cn(
                            'line-through decoration-slate-300 dark:decoration-slate-600',
                            v.mono && 'tabular-nums'
                          )}
                        >
                          {v.text}
                        </dd>
                      </Fragment>
                    )
                  })}
              </dl>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
