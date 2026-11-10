import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, Minus, Plus, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { cn } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'

/**
 * Bulk add / remove people's RESTRICTED values on one scope dimension (Rob
 * 2026-11-10: "bulk add / remove zones for people … for their restricted
 * zones"). Pick values, Preview (before → after per person, nothing saved),
 * then Apply. Hosts mount it from their people-list bulk bar for administrators
 * (POST /api/user-scopes/bulk is admin only). Defaults are never touched; a
 * person with no restriction is never narrowed; removing someone's last value
 * is held back unless the admin ticks the explicit opt-in.
 */

interface Dimension {
  id: number
  name: string
  label: string
  target_collection: string
  display_field: string | null
  options_sort?: string | null
  is_active?: boolean
}

type Status = 'change' | 'unchanged' | 'refused' | 'not_found'
interface Row {
  user_id: string
  name: string
  before_labels: string[]
  after_labels: string[]
  status: Status
  reason?: string
  error?: string
}
interface BulkAnswer {
  preview: boolean
  label: string
  op: 'add' | 'remove'
  rows: Row[]
  counts: Record<Status | 'failed', number>
}

/** The dimension to edit: the named one, else the one over `divisions` (zones), else the first. */
export function pickBulkDimension(dims: Dimension[], name?: string): Dimension | null {
  const active = dims.filter((d) => d.is_active !== false)
  if (name) return active.find((d) => d.name === name) ?? null
  return active.find((d) => d.target_collection === 'divisions') ?? active[0] ?? null
}

export function BulkRestrictedScopes({
  userIds,
  dimension,
  onDone,
  onClose
}: {
  userIds: string[]
  /** Scope dimension name; absent = the zone dimension (target `divisions`). */
  dimension?: string
  /** After a successful Apply (the host clears its selection / refetches). */
  onDone?: () => void
  onClose?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [op, setOp] = useState<'add' | 'remove'>('add')
  const [picked, setPicked] = useState<Array<string | number>>([])
  const [allowEmpty, setAllowEmpty] = useState(false)
  const [preview, setPreview] = useState<BulkAnswer | null>(null)

  const dims = useQuery({
    queryKey: ['scope-dimensions'],
    staleTime: 60_000,
    queryFn: () =>
      client.request<{ data: Dimension[] }>(get('/scope-dimensions')).then((r) => r.data ?? [])
  })
  const dim = useMemo(() => pickBulkDimension(dims.data ?? [], dimension), [dims.data, dimension])
  const display = dim?.display_field || 'id'
  const options = useQuery({
    enabled: !!dim,
    queryKey: ['bulk-scope-options', dim?.target_collection, display],
    staleTime: 60_000,
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dim!.target_collection}`, {
            fields: display === 'id' ? 'id' : `id,${display}`,
            limit: 500,
            sort: dim!.options_sort || display
          })
        )
        .then((r) =>
          (r.data ?? []).map((x) => ({
            id: x.id as string | number,
            label: String(x[display] ?? x.id)
          }))
        )
  })
  const noun = (dim?.label ?? 'value').toLowerCase()

  const run = useMutation({
    mutationFn: (dry: boolean) =>
      client
        .request<{ data: BulkAnswer }>(
          post('/user-scopes/bulk', {
            user_ids: userIds,
            dimension: dim?.name,
            op,
            values: picked,
            preview: dry,
            allow_empty: allowEmpty
          })
        )
        .then((r) => r.data),
    onSuccess: (answer, dry) => {
      if (dry) {
        setPreview(answer)
        return
      }
      const c = answer.counts
      const changed = c.change ?? 0
      const left = (c.unchanged ?? 0) + (c.refused ?? 0) + (c.not_found ?? 0)
      if ((c.failed ?? 0) > 0)
        toast.error(
          `${changed} updated, ${c.failed} could not be saved — open Preview again to see who`
        )
      else
        toast.success(
          `${changed} ${changed === 1 ? 'person' : 'people'} updated${left ? `, ${left} left as they were` : ''}`
        )
      setPreview(null)
      setPicked([])
      void qc.invalidateQueries({ queryKey: ['user-scopes'] })
      void qc.invalidateQueries({ queryKey: ['users'] })
      onDone?.()
    },
    onError: (e) => {
      toastError(e, `Could not change restricted ${noun}s`)
    }
  })

  const reset = () => setPreview(null)
  const toggle = (id: string | number) => {
    reset()
    setPicked((p) =>
      p.some((x) => String(x) === String(id))
        ? p.filter((x) => String(x) !== String(id))
        : [...p, id]
    )
  }
  const changeCount = preview?.counts.change ?? 0
  const refusedCount = preview?.counts.refused ?? 0

  if (dims.isError || options.isError)
    return (
      <ErrorNotice
        error={dims.error ?? options.error}
        what={`the ${noun}s`}
        onRetry={() => {
          void dims.refetch()
          void options.refetch()
        }}
      />
    )

  return (
    <div
      className='w-full space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-[12px] shadow-sm dark:border-border dark:bg-card'
      data-bulk-restricted-scopes
    >
      <div className='flex items-center gap-2'>
        <p className='font-semibold text-slate-800 dark:text-slate-100'>
          Restricted {noun}s · {userIds.length} {userIds.length === 1 ? 'person' : 'people'}
        </p>
        <div className='ml-auto inline-flex rounded-lg border border-slate-200 p-0.5 dark:border-border'>
          {(['add', 'remove'] as const).map((o) => (
            <button
              key={o}
              type='button'
              aria-pressed={op === o}
              onClick={() => {
                reset()
                setOp(o)
              }}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition-colors',
                op === o
                  ? 'bg-nvr-cyan text-white'
                  : 'text-slate-600 hover:bg-muted dark:text-slate-300'
              )}
            >
              {o === 'add' ? <Plus className='h-3 w-3' /> : <Minus className='h-3 w-3' />}
              {o === 'add' ? 'Add' : 'Remove'}
            </button>
          ))}
        </div>
        {onClose && (
          <button
            type='button'
            onClick={onClose}
            aria-label='Close'
            className='rounded-md p-1 text-slate-400 hover:bg-muted hover:text-slate-600 dark:hover:text-slate-200'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        )}
      </div>

      <fieldset className='m-0 flex flex-wrap gap-1.5 border-0 p-0' aria-label={`${noun}s`}>
        {options.isLoading || dims.isLoading ? (
          <span className='inline-flex items-center gap-1 text-slate-500'>
            <Loader2 className='h-3 w-3 animate-spin' /> Loading {noun}s…
          </span>
        ) : (
          (options.data ?? []).map((o) => {
            const on = picked.some((x) => String(x) === String(o.id))
            return (
              <button
                key={String(o.id)}
                type='button'
                aria-pressed={on}
                onClick={() => toggle(o.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-medium transition-colors',
                  on
                    ? 'border-nvr-cyan bg-nvr-cyan/10 text-slate-900 dark:text-slate-100'
                    : 'border-slate-200 text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
                )}
              >
                {on && <Check className='h-3 w-3 text-nvr-cyan' />}
                {o.label}
              </button>
            )
          })
        )}
      </fieldset>

      {preview && (
        <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
          <div className='max-h-72 overflow-y-auto'>
            <table className='w-full text-[11.5px]'>
              <thead className='sticky top-0 bg-slate-50 text-left text-slate-500 dark:bg-muted dark:text-slate-400'>
                <tr>
                  <th className='px-2 py-1.5 font-medium'>Person</th>
                  <th className='px-2 py-1.5 font-medium'>Now</th>
                  <th className='px-2 py-1.5 font-medium'>After</th>
                  <th className='px-2 py-1.5 font-medium'>Note</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => (
                  <tr
                    key={r.user_id}
                    className='border-t border-slate-100 dark:border-border'
                    data-bulk-scope-row={r.status}
                  >
                    <td className='px-2 py-1.5 font-medium text-slate-800 dark:text-slate-100'>
                      {r.name}
                    </td>
                    <td className='px-2 py-1.5 text-slate-600 dark:text-slate-300'>
                      {r.before_labels.join(', ') || `Every ${noun}`}
                    </td>
                    <td
                      className={cn(
                        'px-2 py-1.5',
                        r.status === 'change'
                          ? 'font-medium text-slate-900 dark:text-slate-50'
                          : 'text-slate-400'
                      )}
                    >
                      {r.status === 'change' ? r.after_labels.join(', ') || `Every ${noun}` : '—'}
                    </td>
                    <td className='px-2 py-1.5'>
                      {r.status === 'change' ? (
                        <span className='text-emerald-700 dark:text-emerald-300'>Changes</span>
                      ) : r.status === 'refused' ? (
                        <span className='inline-flex items-start gap-1 text-amber-700 dark:text-amber-300'>
                          <AlertTriangle className='mt-px h-3 w-3 shrink-0' />
                          {r.reason}
                        </span>
                      ) : (
                        <span className='text-slate-500 dark:text-slate-400'>{r.reason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview && op === 'remove' && refusedCount > 0 && (
        <label className='flex items-start gap-2 text-amber-800 dark:text-amber-200'>
          <input
            type='checkbox'
            className='mt-0.5'
            checked={allowEmpty}
            onChange={(e) => {
              setAllowEmpty(e.target.checked)
              reset()
            }}
          />
          <span>
            Also remove the last restricted {noun} for {refusedCount}{' '}
            {refusedCount === 1 ? 'person' : 'people'} — they would then see every {noun}
          </span>
        </label>
      )}

      <div className='flex items-center gap-2'>
        <button
          type='button'
          disabled={picked.length === 0 || run.isPending || !dim}
          onClick={() => run.mutate(true)}
          className='rounded-lg border border-slate-200 px-3 py-1.5 font-medium text-slate-700 transition-colors hover:bg-muted disabled:opacity-40 dark:border-border dark:text-slate-200'
          data-bulk-scope-preview
        >
          {run.isPending && run.variables === true ? 'Checking…' : 'Preview'}
        </button>
        <button
          type='button'
          disabled={!preview || changeCount === 0 || run.isPending}
          onClick={() => run.mutate(false)}
          className='rounded-lg bg-nvr-cyan px-3 py-1.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40'
          data-bulk-scope-apply
        >
          {run.isPending && run.variables === false
            ? 'Saving…'
            : `Apply to ${changeCount} ${changeCount === 1 ? 'person' : 'people'}`}
        </button>
        <span className='text-[11px] text-slate-500 dark:text-slate-400'>
          {!preview
            ? picked.length === 0
              ? `Pick the ${noun}s to ${op}`
              : 'Preview shows who changes — nothing is saved until Apply'
            : null}
        </span>
      </div>
    </div>
  )
}
