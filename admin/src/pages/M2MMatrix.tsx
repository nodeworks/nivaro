import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Grid3x3, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'

/**
 * M2M matrix bulk editor (#57): records as rows, link targets as columns,
 * checkboxes toggling junction rows — the zone-scoping-BOM-categories script
 * as a UI. Every write goes through the items service, so RBAC, hooks and
 * junction-driven recomputes (auto-ids, rollups) all fire per toggle.
 */

interface Relation {
  id: number
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

const PAGE = 25
const MAX_COLS = 60

function fallbackLabel(r: Record<string, unknown>): string {
  for (const f of ['name', 'title', 'label', 'short_name', 'subject', 'description']) {
    const v = r[f]
    if (v != null && String(v).trim()) return String(v).slice(0, 60)
  }
  return `#${r.id}`
}

/** Display-template label with dotted-path token resolution over the
 *  expanded row; the name-ish column fallback covers template-less
 *  collections. */
function makeLabeler(template: string | null) {
  return (r: Record<string, unknown>): string => {
    if (!template) return fallbackLabel(r)
    const label = template
      .replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path: string) => {
        let cur: unknown = r
        for (const seg of path.replace(/\[(\d+)\]/g, '.$1').split('.')) {
          if (cur == null || typeof cur !== 'object') return ''
          cur = (cur as Record<string, unknown>)[seg]
        }
        return cur == null ? '' : String(cur)
      })
      .replace(/\s+/g, ' ')
      .trim()
    return label || fallbackLabel(r)
  }
}

/** The fields= param a template needs: id + its tokens (dotted paths expand
 *  server-side). Null template → full rows for the fallback columns. */
function templateFields(template: string | null): string | undefined {
  if (!template) return undefined
  const tokens = [...template.matchAll(/\{\{\s*([\w.[\]]+)/g)].map((m) =>
    m[1].replace(/\[\d+\]/g, '')
  )
  return ['id', ...tokens].join(',')
}

export default function M2MMatrix() {
  const qc = useQueryClient()
  const [collection, setCollection] = useState('')
  const [aliasField, setAliasField] = useState('')
  const [rowSearch, setRowSearch] = useState('')
  const [colSearch, setColSearch] = useState('')
  const [page, setPage] = useState(1)

  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data ?? r.data)
  })

  const { data: rowMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['m2m-matrix-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data ?? r.data),
    enabled: !!collection
  })

  const { data: relations = [] } = useQuery<Relation[]>({
    queryKey: ['m2m-matrix-rels', collection],
    queryFn: () => api.get(`/data-model/relations/for/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  // The collection's M2M aliases: a junction leg whose one_collection is the
  // parent and whose junction_field pairs it with the companion leg.
  const aliases = useMemo(
    () =>
      relations.filter(
        (r) => r.one_collection === collection && r.one_field && r.junction_field && r.many_collection
      ),
    [relations, collection]
  )
  const alias = aliases.find((a) => a.one_field === aliasField) ?? null
  // Companion leg on the same junction — carries the TARGET collection.
  const companion = useMemo(() => {
    if (!alias) return null
    return (
      relations.find(
        (r) =>
          r.many_collection === alias.many_collection &&
          r.many_field === alias.junction_field &&
          r.id !== alias.id
      ) ?? null
    )
  }, [relations, alias])
  const junction = alias?.many_collection ?? null
  const parentFk = alias?.many_field ?? null // junction column → parent id
  const targetFk = alias?.junction_field ?? null // junction column → target id
  const targetCollection = companion?.one_collection ?? null

  const { data: targetMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['m2m-matrix-meta', targetCollection],
    queryFn: () => api.get(`/collections/${targetCollection}`).then((r) => r.data.data ?? r.data),
    enabled: !!targetCollection
  })
  const rowLabel = useMemo(() => makeLabeler(rowMeta?.display_template ?? null), [rowMeta])
  const colLabel = useMemo(() => makeLabeler(targetMeta?.display_template ?? null), [targetMeta])

  // Rows: paged parent records.
  const { data: rowsData } = useQuery<{ data: Array<Record<string, unknown>>; total: number }>({
    queryKey: ['m2m-matrix-rows', collection, rowSearch, page, rowMeta?.display_template ?? null],
    queryFn: () =>
      api
        .get(`/items/${collection}`, {
          params: {
            limit: PAGE,
            page,
            search: rowSearch || undefined,
            sort: 'id',
            fields: templateFields(rowMeta?.display_template ?? null)
          }
        })
        .then((r) => r.data),
    enabled: !!collection && !!alias
  })
  const rows = rowsData?.data ?? []
  const total = rowsData?.total ?? 0

  // Columns: the whole target catalog (capped, searchable).
  const { data: colsData } = useQuery<{ data: Array<Record<string, unknown>> }>({
    queryKey: ['m2m-matrix-cols', targetCollection, colSearch, targetMeta?.display_template ?? null],
    queryFn: () =>
      api
        .get(`/items/${targetCollection}`, {
          params: {
            limit: MAX_COLS + 1,
            search: colSearch || undefined,
            sort: 'id',
            fields: templateFields(targetMeta?.display_template ?? null)
          }
        })
        .then((r) => r.data),
    enabled: !!targetCollection
  })
  const cols = (colsData?.data ?? []).slice(0, MAX_COLS)
  const colsTruncated = (colsData?.data ?? []).length > MAX_COLS

  // Junction rows for the visible page — one query, keyed by parent|target.
  const rowIds = rows.map((r) => String(r.id))
  const { data: links = [] } = useQuery<Array<Record<string, unknown>>>({
    queryKey: ['m2m-matrix-links', junction, rowIds.join(',')],
    queryFn: () =>
      api
        .get(`/items/${junction}`, {
          params: {
            limit: 5000,
            filter: JSON.stringify({ [String(parentFk)]: { _in: rowIds } })
          }
        })
        .then((r) => r.data.data),
    enabled: !!junction && !!parentFk && rowIds.length > 0
  })
  const linkByPair = useMemo(() => {
    const m = new Map<string, string | number>()
    for (const l of links) {
      m.set(`${l[String(parentFk)]}|${l[String(targetFk)]}`, l.id as string | number)
    }
    return m
  }, [links, parentFk, targetFk])

  const toggle = useMutation({
    mutationFn: async ({ rowId, colId }: { rowId: string; colId: string }) => {
      const existing = linkByPair.get(`${rowId}|${colId}`)
      if (existing != null) {
        await api.delete(`/items/${junction}/${existing}`)
      } else {
        await api.post(`/items/${junction}`, { [String(parentFk)]: rowId, [String(targetFk)]: colId })
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['m2m-matrix-links', junction] }),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to toggle link')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Grid3x3 className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              M2M Matrix
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Bulk-edit many-to-many links: records as rows, link targets as columns. Each toggle
              is a normal junction write — hooks and recomputes apply.
            </p>
          </div>
        </div>
        <div className='mt-3 flex flex-wrap items-center gap-2'>
          <Select
            value={collection || undefined}
            onValueChange={(v) => {
              setCollection(v)
              setAliasField('')
              setPage(1)
            }}
          >
            <SelectTrigger className='h-8 w-[220px] text-[12.5px]'>
              <SelectValue placeholder='Collection…' />
            </SelectTrigger>
            <SelectContent>
              {collections
                .map((c) => c.collection)
                .filter((c) => !/^nivaro_/i.test(c))
                .sort()
                .map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          <Select
            value={aliasField || undefined}
            onValueChange={(v) => {
              setAliasField(v)
              setPage(1)
            }}
          >
            <SelectTrigger className='h-8 w-[240px] text-[12.5px]'>
              <SelectValue
                placeholder={
                  !collection ? 'Pick a collection first' : aliases.length === 0 ? 'No M2M fields' : 'M2M field…'
                }
              />
            </SelectTrigger>
            <SelectContent>
              {aliases.map((a) => (
                <SelectItem key={a.id} value={String(a.one_field)}>
                  {a.one_field} → {relations.find((r) => r.many_collection === a.many_collection && r.many_field === a.junction_field && r.id !== a.id)?.one_collection ?? a.many_collection}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {alias && (
            <>
              <div className='relative'>
                <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                <input
                  value={rowSearch}
                  onChange={(e) => {
                    setRowSearch(e.target.value)
                    setPage(1)
                  }}
                  placeholder='Search rows…'
                  className='h-8 w-[180px] rounded-md border border-slate-200 bg-background pl-8 pr-2.5 text-[12.5px] dark:border-border'
                />
              </div>
              <input
                value={colSearch}
                onChange={(e) => setColSearch(e.target.value)}
                placeholder='Filter columns…'
                className='h-8 w-[160px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
              />
            </>
          )}
        </div>
      </header>

      <div className='flex-1 overflow-auto p-4'>
        {!alias ? (
          <p className='px-2 py-10 text-center text-[13px] text-slate-400'>
            Choose a collection and an M2M field to edit its link matrix.
          </p>
        ) : (
          <>
            {colsTruncated && (
              <p className='mb-2 text-[11.5px] text-amber-600'>
                Showing the first {MAX_COLS} targets — use the column filter to narrow.
              </p>
            )}
            <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <table className='w-full text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-100 dark:border-border/60'>
                    <th className='sticky left-0 z-[1] bg-white px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:bg-card'>
                      {collection}
                    </th>
                    {cols.map((c) => (
                      <th
                        key={String(c.id)}
                        className='max-w-[110px] px-1.5 py-2 text-center align-bottom'
                      >
                        <span
                          className='inline-block max-w-[100px] truncate text-[10.5px] font-medium text-slate-600 dark:text-slate-300'
                          data-tip={colLabel(c)}
                        >
                          {colLabel(c)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={String(r.id)} className='border-b border-slate-50 last:border-0 dark:border-border/40'>
                      <td className='sticky left-0 z-[1] max-w-[240px] truncate bg-white px-3 py-1.5 font-medium text-slate-700 dark:bg-card dark:text-slate-200'>
                        {rowLabel(r)}
                      </td>
                      {cols.map((c) => {
                        const key = `${r.id}|${c.id}`
                        const linked = linkByPair.has(key)
                        return (
                          <td key={String(c.id)} className='px-1.5 py-1.5 text-center'>
                            <input
                              type='checkbox'
                              checked={linked}
                              disabled={toggle.isPending}
                              onChange={() =>
                                toggle.mutate({ rowId: String(r.id), colId: String(c.id) })
                              }
                              aria-label={`${rowLabel(r)} ↔ ${colLabel(c)}`}
                              className='h-3.5 w-3.5 accent-[#00ceff]'
                            />
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {total > PAGE && (
              <div className='mt-3 flex items-center justify-between text-[12px] text-slate-500'>
                <span>
                  Page {page} of {Math.max(1, Math.ceil(total / PAGE))} · {total} records
                </span>
                <span className='flex gap-2'>
                  <button
                    type='button'
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                    className='rounded-md border border-slate-200 px-2.5 py-1 disabled:opacity-40 dark:border-border'
                  >
                    Previous
                  </button>
                  <button
                    type='button'
                    disabled={page >= Math.ceil(total / PAGE)}
                    onClick={() => setPage((p) => p + 1)}
                    className='rounded-md border border-slate-200 px-2.5 py-1 disabled:opacity-40 dark:border-border'
                  >
                    Next
                  </button>
                </span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
