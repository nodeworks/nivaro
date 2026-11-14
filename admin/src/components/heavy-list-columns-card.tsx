import { toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatNumber, formatRelative, titleCase } from '@/lib/utils'

/**
 * Heavy list columns (2026-11-13). The Unit Types list opened on its Units column (230,336
 * units over 101 unit types) and froze production web processes. GET
 * /collections/:c/list-weight measures every "link to many" field and says whether the list's
 * default columns show a heavy one; this card names them and saves a default view without
 * them through the ordinary saved-views API. Admin page only; renders nothing when the list
 * is fine.
 */

type ViewColumn = string | { key: string; [k: string]: unknown }

export interface ListWeightField {
  field: string
  label: string
  kind: 'o2m' | 'm2m'
  related_collection: string
  heavy: boolean
  in_default: boolean
  in_role_defaults: string[]
  measure: { status: 'ok' | 'timeout' | 'error'; avg: number; max: number } | null
}

export interface ListWeightDefault {
  source: 'baseline' | 'collection_view' | 'role_view'
  view_id: number | null
  view_name: string | null
  role_name: string | null
  columns: string[]
  heavy: string[]
  suggested_columns: ViewColumn[]
}

export interface ListWeightReport {
  collection: string
  thresholds: { avg_children: number; max_children: number }
  fields: ListWeightField[]
  defaults: ListWeightDefault[]
  heavy_in_default: string[]
  partial: boolean
  measured_at: string
}

export const listWeightKey = (collection: string) => ['collection-list-weight', collection]

/** "Units shows up to 2,341 linked units per row on this list — slow and unreadable." */
export function heavySentence(f: ListWeightField): string {
  const what = titleCase(f.related_collection).toLowerCase()
  const max = formatNumber(f.measure?.max ?? 0)
  return `${f.label} shows up to ${max} linked ${what} per row on this list — slow and unreadable.`
}

const names = (fields: ListWeightField[], keys: string[]) =>
  keys.map((k) => fields.find((f) => f.field === k)?.label ?? k).join(' and ')

/** What the fix does to one default: create the collection default, or trim a view. */
function fixLabel(d: ListWeightDefault, count: number): string {
  const it = count === 1 ? 'it' : 'them'
  if (d.source === 'baseline') return `Create a default view without ${it}`
  if (d.source === 'collection_view') return `Remove ${it} from the default view`
  return `Remove ${it} from ${d.role_name ?? 'the role'}’s default view`
}

function whereShown(d: ListWeightDefault): string {
  if (d.source === 'baseline')
    return 'The list has no default view, so it opens on its first 7 fields.'
  if (d.source === 'collection_view')
    return `The default view “${d.view_name ?? 'Default'}” shows ${d.heavy.length === 1 ? 'it' : 'them'}.`
  const role = d.role_name ?? 'a role'
  const named = d.view_name && d.view_name !== d.role_name ? ` (“${d.view_name}”)` : ''
  return `The default view for ${role}${named} shows ${d.heavy.length === 1 ? 'it' : 'them'}.`
}

export function HeavyListColumnsCard({ collection }: { collection: string }) {
  const qc = useQueryClient()
  const { data, isFetching } = useQuery({
    queryKey: listWeightKey(collection),
    queryFn: () =>
      api
        .get<{ data: ListWeightReport }>(
          `/collections/${encodeURIComponent(collection)}/list-weight`
        )
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10 * 60_000,
    retry: false
  })
  const recheck = useMutation({
    mutationFn: () =>
      api
        .get<{ data: ListWeightReport }>(
          `/collections/${encodeURIComponent(collection)}/list-weight?fresh=1`
        )
        .then((r) => r.data.data),
    onSuccess: (report) => qc.setQueryData(listWeightKey(collection), report),
    onError: (err) => toastError(err, 'Could not measure the list columns')
  })
  const fix = useMutation({
    mutationFn: async (d: ListWeightDefault): Promise<void> => {
      if (d.source === 'baseline' || d.view_id == null)
        await api.post('/saved-views', {
          collection,
          name: 'Default',
          is_default: true,
          is_shared: true,
          columns: d.suggested_columns
        })
      else await api.patch(`/saved-views/${d.view_id}`, { columns: d.suggested_columns })
    },
    onSuccess: (_r, d) => {
      toast.success(
        d.source === 'baseline'
          ? `The list now opens without ${names(data?.fields ?? [], d.heavy)}`
          : `Removed ${names(data?.fields ?? [], d.heavy)} from the default view`
      )
      void qc.invalidateQueries({ queryKey: listWeightKey(collection) })
      void qc.invalidateQueries({ queryKey: ['collections-list-weight'] })
      void qc.invalidateQueries({ queryKey: ['cbv-views', collection] })
    },
    onError: (err) => toastError(err, 'Could not save the default view')
  })

  if (!data || data.heavy_in_default.length === 0) return null
  const heavy = data.fields.filter((f) => data.heavy_in_default.includes(f.field))
  const targets = data.defaults.filter((d) => d.heavy.length > 0)

  return (
    <section
      data-heavy-list-card
      aria-label='Heavy list columns'
      className='overflow-hidden rounded-lg border border-amber-200 bg-amber-50/60 dark:border-amber-400/25 dark:bg-amber-400/[0.06]'
    >
      <div className='flex gap-3 px-4 py-3'>
        <AlertTriangle
          className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400'
          aria-hidden='true'
        />
        <div className='min-w-0 flex-1 space-y-2.5'>
          <div>
            <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>
              Heavy columns on this list
            </p>
            <ul className='mt-1 space-y-0.5'>
              {heavy.map((f) => (
                <li key={f.field} className='text-[12.5px] text-slate-700 dark:text-slate-200'>
                  {heavySentence(f)}{' '}
                  <span className='text-slate-500 dark:text-slate-400'>
                    (about {formatNumber(Math.round(f.measure?.avg ?? 0))} on average)
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {targets.map((d) => (
            <div
              key={`${d.source}:${d.view_id ?? 'baseline'}`}
              className='flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5'
            >
              <p className='min-w-0 text-[12px] text-slate-600 dark:text-slate-300'>
                {whereShown(d)}
              </p>
              <Button
                size='sm'
                variant='outline'
                className='h-7 shrink-0 bg-white text-[12px] dark:bg-transparent'
                disabled={fix.isPending}
                onClick={() => fix.mutate(d)}
              >
                {fix.isPending && fix.variables === d && (
                  <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' aria-hidden='true' />
                )}
                {fixLabel(d, d.heavy.length)}
              </Button>
            </div>
          ))}
          <p className='flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500 dark:text-slate-400'>
            <span>
              Heavy = more than {data.thresholds.avg_children} linked rows per record on average, or{' '}
              {data.thresholds.max_children} on one record. People can still add the column to their
              own views. Measured {formatRelative(data.measured_at)}.
            </span>
            <button
              type='button'
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending || isFetching}
              className='inline-flex items-center gap-1 rounded text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:opacity-60 dark:text-slate-400 dark:hover:text-slate-200'
            >
              <RefreshCw
                className={`h-3 w-3 ${recheck.isPending ? 'animate-spin' : ''}`}
                aria-hidden='true'
              />
              Check again
            </button>
          </p>
        </div>
      </div>
    </section>
  )
}
