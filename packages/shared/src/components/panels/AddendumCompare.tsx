import { useQueries } from '@tanstack/react-query'
import { useMemo } from 'react'
import { get } from '../../lib/commands'
import { cn, formatDate, titleCase } from '../../lib/utils'
import type { CMSField, CMSRelation } from '../item-edit/types'
import { diffAddendumLines } from './AddendumLinesDiff'

/**
 * Every addendum on a record side by side, oldest first: what each one
 * moves the amount by, which fields it touches, how many lines it adds,
 * changes or removes, and the running total — so "which one raised the
 * amount, which touched lines" is one glance rather than N cards.
 *
 * Line counts are judged against the record's CURRENT rows for every
 * addendum (that is what each proposal was written against); an approved
 * addendum's lines have already landed, so its counts read as zero.
 */
interface Client {
  request<T>(cmd: unknown): Promise<T>
}
interface AddendumLike {
  id: string
  title: string
  status: string
  data: Record<string, unknown> | null
  created_at: string
  cost_impact: number | null
  previous_amount: number | null
  new_amount: number | null
  approved_at: string | null
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const isEmpty = (v: unknown) => v === null || v === undefined || v === ''

export function AddendumCompare({
  client,
  addendums,
  parentCollection,
  parentId,
  relations,
  fieldMap
}: {
  client: Client
  addendums: AddendumLike[]
  parentCollection: string
  parentId: string
  relations: CMSRelation[]
  fieldMap: Record<string, CMSField>
}) {
  const ordered = useMemo(
    () => [...addendums].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
    [addendums]
  )
  // Every O2M alias any addendum proposes rows for.
  const lineRels = useMemo(() => {
    const aliases = new Set<string>()
    for (const a of ordered)
      for (const [k, v] of Object.entries(a.data ?? {})) if (Array.isArray(v)) aliases.add(k)
    return [...aliases]
      .map((field) => ({
        field,
        rel: relations.find(
          (r) =>
            r.one_collection === parentCollection &&
            !r.junction_field &&
            (r.one_field === field || r.many_collection === field)
        )
      }))
      .filter(
        (x): x is { field: string; rel: CMSRelation } =>
          !!x.rel?.many_collection && !!x.rel.many_field
      )
  }, [ordered, relations, parentCollection])
  const originals = useQueries({
    queries: lineRels.map(({ rel }) => ({
      queryKey: ['o2m-rows', rel.many_collection, rel.many_field, parentId],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${rel.many_collection}`, {
              filter: JSON.stringify({ [rel.many_field as string]: { _eq: parentId } }),
              limit: 200
            })
          )
          .then((r) => r.data ?? []),
      staleTime: 30_000
    }))
  })
  const originalByField = Object.fromEntries(
    lineRels.map((x, i) => [x.field, originals[i]?.data ?? null])
  )

  const labelFor = (k: string) => fieldMap[k]?.label || titleCase(k)
  const scalarKeys = (a: AddendumLike) =>
    Object.entries(a.data ?? {})
      .filter(([k, v]) => !k.startsWith('__') && !Array.isArray(v) && !isEmpty(v))
      .map(([k]) => k)
  const impact = (a: AddendumLike): number | null => {
    if (typeof a.cost_impact === 'number') return a.cost_impact
    if (typeof a.new_amount === 'number' && typeof a.previous_amount === 'number')
      return a.new_amount - a.previous_amount
    return null
  }
  const lineCounts = (a: AddendumLike) => {
    let added = 0
    let changed = 0
    let removed = 0
    let known = false
    for (const { field, rel } of lineRels) {
      const proposed = a.data?.[field]
      const orig = originalByField[field]
      if (!Array.isArray(proposed) || !orig) continue
      known = true
      const d = diffAddendumLines(
        proposed as Record<string, unknown>[],
        orig,
        rel.many_field as string
      )
      added += d.added.length
      changed += d.changed.length
      removed += d.removed.length
    }
    return known ? { added, changed, removed } : null
  }
  const statusCls = (s: string) =>
    s === 'approved'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'
      : s === 'rejected' || s === 'reverted'
        ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
        : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'

  let running = 0
  let runningApproved = 0
  const th =
    'px-2 py-1.5 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'
  const td = 'px-2 py-1.5 align-top text-[11.5px]'
  return (
    <div className='overflow-x-auto'>
      <table className='w-full min-w-[640px] border-collapse'>
        <thead className='border-b border-slate-200 dark:border-border'>
          <tr>
            <th className={th}>Addendum</th>
            <th className={th}>Status</th>
            <th className={cn(th, 'text-right')}>Amount</th>
            <th className={th}>Fields touched</th>
            <th className={th}>Lines</th>
            <th
              className={cn(th, 'text-right')}
              data-tip='Running total of every addendum in order; approved-only total beneath'
            >
              Cumulative
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((a, i) => {
            const imp = impact(a)
            const counted = a.status !== 'rejected' && a.status !== 'reverted'
            if (imp != null && counted) running += imp
            if (imp != null && a.status === 'approved') runningApproved += imp
            const keys = scalarKeys(a)
            const lines = lineCounts(a)
            return (
              <tr key={a.id} className='border-b border-slate-100 last:border-0 dark:border-border'>
                <td className={td}>
                  <div className='font-medium text-foreground'>
                    <span className='mr-1.5 text-slate-400 tabular-nums'>{i + 1}.</span>
                    {a.title}
                  </div>
                  <div className='text-[10.5px] text-slate-500'>{formatDate(a.created_at)}</div>
                </td>
                <td className={td}>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-px text-[10px] font-medium',
                      statusCls(a.status)
                    )}
                  >
                    {a.status}
                  </span>
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>
                  {imp == null ? (
                    <span className='text-slate-400'>—</span>
                  ) : (
                    <span
                      className={cn(
                        'font-medium',
                        imp > 0
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : imp < 0
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-slate-500'
                      )}
                    >
                      {imp > 0 ? '+' : imp < 0 ? '−' : ''}
                      {usd.format(Math.abs(imp))}
                    </span>
                  )}
                  {typeof a.previous_amount === 'number' && typeof a.new_amount === 'number' && (
                    <div className='text-[10.5px] text-slate-500'>
                      {usd.format(a.previous_amount)} → {usd.format(a.new_amount)}
                    </div>
                  )}
                </td>
                <td className={td}>
                  {keys.length === 0 ? (
                    <span className='text-slate-400'>none</span>
                  ) : (
                    <span className='text-slate-700 dark:text-slate-300'>
                      {keys.slice(0, 4).map(labelFor).join(', ')}
                      {keys.length > 4 && (
                        <span className='text-slate-400'> +{keys.length - 4}</span>
                      )}
                    </span>
                  )}
                </td>
                <td className={cn(td, 'tabular-nums')}>
                  {!lines ? (
                    <span className='text-slate-400'>—</span>
                  ) : lines.added + lines.changed + lines.removed === 0 ? (
                    <span className='text-slate-400'>no line changes</span>
                  ) : (
                    <span className='inline-flex gap-1.5'>
                      {lines.added > 0 && (
                        <span className='text-emerald-700 dark:text-emerald-400'>
                          +{lines.added}
                        </span>
                      )}
                      {lines.changed > 0 && (
                        <span className='text-amber-700 dark:text-amber-300'>~{lines.changed}</span>
                      )}
                      {lines.removed > 0 && (
                        <span className='text-red-600 dark:text-red-400'>−{lines.removed}</span>
                      )}
                    </span>
                  )}
                </td>
                <td className={cn(td, 'text-right tabular-nums')}>
                  <div
                    className={cn(
                      'font-medium',
                      counted ? 'text-foreground' : 'text-slate-400 line-through'
                    )}
                  >
                    {running > 0 ? '+' : running < 0 ? '−' : ''}
                    {usd.format(Math.abs(running))}
                  </div>
                  <div className='text-[10.5px] text-slate-500'>
                    approved {runningApproved > 0 ? '+' : runningApproved < 0 ? '−' : ''}
                    {usd.format(Math.abs(runningApproved))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
