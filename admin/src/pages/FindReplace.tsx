import { useMutation, useQuery } from '@tanstack/react-query'
import { Replace } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Admin Find & Replace (#41) — cross-record value replacement on one text
 * column, with a full hit preview before anything writes. Applies through the
 * items service, so every replacement lands as a normal revisioned edit.
 */

interface PreviewData {
  total: number
  truncated: boolean
  samples: Array<{ id: string | number; old: string; new: string }>
}

export default function FindReplace() {
  const [collection, setCollection] = useState('')
  const [field, setField] = useState('')
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [mode, setMode] = useState<'contains' | 'exact'>('contains')
  const [preview, setPreview] = useState<PreviewData | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [runId, setRunId] = useState<number | null>(null)

  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data ?? r.data)
  })
  const { data: meta } = useQuery<{ fields?: Array<{ field: string; type?: string }> }>({
    queryKey: ['find-replace-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data ?? r.data),
    enabled: !!collection
  })
  const textFields = (meta?.fields ?? [])
    .filter((f) => !f.field.startsWith('__') && /string|text/i.test(String(f.type ?? '')))
    .map((f) => f.field)
    .sort()

  const previewMut = useMutation({
    mutationFn: () =>
      api
        .post('/find-replace/preview', { collection, field, find, replace, mode })
        .then((r) => r.data.data as PreviewData),
    onSuccess: (d) => {
      setPreview(d)
      setConfirming(false)
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Preview failed')
  })

  const applyMut = useMutation({
    mutationFn: () =>
      api
        .post('/find-replace/apply', { collection, field, find, replace, mode })
        .then((r) => r.data.data as { queued: number; run_id: number }),
    onSuccess: (d) => {
      toast.success(`Replacing across ${d.queued} record(s) — running in the background`)
      setRunId(d.run_id)
      setConfirming(false)
      setPreview(null)
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Apply failed')
  })

  // Live progress of the background apply.
  const { data: run } = useQuery<{ status: string; progress: string | null; outcome: string | null }>({
    queryKey: ['find-replace-run', runId],
    queryFn: () =>
      api
        .get('/job-runs', { params: { kind: 'cron', job_id: 'find-replace', limit: 1 } })
        .then((r) => r.data.data?.[0]),
    enabled: runId != null,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false)
  })
  const runProgress = (() => {
    try {
      return run?.progress ? (JSON.parse(run.progress) as { done: number; total: number }) : null
    } catch {
      return null
    }
  })()

  const ready = !!collection && !!field && !!find

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Replace className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Find &amp; Replace
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Replace a value across records with a full preview first. Every change is a normal
              revisioned edit — reversible per record from its history.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 space-y-4 overflow-y-auto p-6'>
        <div className='max-w-[880px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-end gap-3'>
            <label className='block'>
              <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500'>
                Collection
              </span>
              <Select
                value={collection || undefined}
                onValueChange={(v) => {
                  setCollection(v)
                  setField('')
                  setPreview(null)
                }}
              >
                <SelectTrigger className='h-8 w-[220px] text-[12.5px]'>
                  <SelectValue placeholder='Choose…' />
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
            </label>
            <label className='block'>
              <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500'>
                Text field
              </span>
              <Select
                value={field || undefined}
                onValueChange={(v) => {
                  setField(v)
                  setPreview(null)
                }}
              >
                <SelectTrigger className='h-8 w-[200px] text-[12.5px]'>
                  <SelectValue placeholder={collection ? 'Choose…' : 'Pick a collection first'} />
                </SelectTrigger>
                <SelectContent>
                  {textFields.map((f) => (
                    <SelectItem key={f} value={f}>
                      {f}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(['contains', 'exact'] as const).map((m) => (
                <button
                  key={m}
                  type='button'
                  onClick={() => {
                    setMode(m)
                    setPreview(null)
                  }}
                  className={cn(
                    'rounded px-2.5 py-1 text-[12px] font-medium capitalize',
                    mode === m ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground' : 'text-slate-400'
                  )}
                >
                  {m}
                </button>
              ))}
            </span>
          </div>
          <div className='mt-3 flex flex-wrap items-center gap-3'>
            <input
              value={find}
              onChange={(e) => {
                setFind(e.target.value)
                setPreview(null)
              }}
              placeholder={mode === 'exact' ? 'Exact value to find' : 'Substring to find'}
              className='h-8 w-[260px] rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12.5px] dark:border-border'
            />
            <span className='text-[13px] text-slate-400'>→</span>
            <input
              value={replace}
              onChange={(e) => {
                setReplace(e.target.value)
                setPreview(null)
              }}
              placeholder='Replacement'
              className='h-8 w-[260px] rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12.5px] dark:border-border'
            />
            <button
              type='button'
              disabled={!ready || previewMut.isPending}
              onClick={() => previewMut.mutate()}
              className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
            >
              {previewMut.isPending ? 'Previewing…' : 'Preview hits'}
            </button>
          </div>
        </div>

        {run && runId != null && (
          <div className='max-w-[880px] rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12.5px] dark:border-border dark:bg-card'>
            {run.status === 'running' ? (
              <span className='text-slate-600 dark:text-muted-foreground'>
                Replacing… {runProgress ? `${runProgress.done} of ${runProgress.total}` : ''}
              </span>
            ) : (
              <span
                className={
                  run.status === 'completed'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-red-600 dark:text-red-400'
                }
              >
                {run.outcome ?? run.status}
              </span>
            )}
          </div>
        )}

        {preview && (
          <div className='max-w-[880px] overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <div className='flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
              <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
                {preview.total}
                {preview.truncated ? '+' : ''} match{preview.total === 1 ? '' : 'es'}
              </span>
              {preview.truncated && (
                <span className='text-[11.5px] text-amber-600'>
                  Over 2,000 — narrow the find value before applying
                </span>
              )}
              <span className='flex-1' />
              {preview.total > 0 &&
                !preview.truncated &&
                (confirming ? (
                  <span className='flex items-center gap-2'>
                    <span className='text-[12px] text-amber-600'>
                      Replace across {preview.total} record{preview.total === 1 ? '' : 's'}?
                    </span>
                    <button
                      type='button'
                      disabled={applyMut.isPending}
                      onClick={() => applyMut.mutate()}
                      className='h-7 rounded-md bg-amber-500 px-3 text-[12px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
                    >
                      {applyMut.isPending ? 'Starting…' : 'Yes, replace'}
                    </button>
                    <button
                      type='button'
                      onClick={() => setConfirming(false)}
                      className='h-7 rounded-md border border-slate-200 px-2.5 text-[12px] text-slate-500 dark:border-border'
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type='button'
                    onClick={() => setConfirming(true)}
                    className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white'
                  >
                    Apply…
                  </button>
                ))}
            </div>
            <div className='max-h-[440px] overflow-y-auto'>
              <table className='w-full text-[12px]'>
                <thead>
                  <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
                    <th className='px-4 py-1.5 font-medium'>Record</th>
                    <th className='px-4 py-1.5 font-medium'>Current</th>
                    <th className='px-4 py-1.5 font-medium'>After</th>
                  </tr>
                </thead>
                <tbody className='tabular-nums'>
                  {preview.samples.map((s) => (
                    <tr key={String(s.id)} className='border-b border-slate-50 last:border-0 dark:border-border/40'>
                      <td className='px-4 py-1.5 font-mono text-slate-500'>{String(s.id)}</td>
                      <td className='px-4 py-1.5 text-red-600 dark:text-red-400'>
                        <span className='line-clamp-2 break-all'>{s.old || '—'}</span>
                      </td>
                      <td className='px-4 py-1.5 text-emerald-600 dark:text-emerald-400'>
                        <span className='line-clamp-2 break-all'>{s.new || '—'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.total > preview.samples.length && (
                <p className='px-4 py-2 text-[11.5px] text-slate-400'>
                  Showing the first {preview.samples.length} of {preview.total}.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
