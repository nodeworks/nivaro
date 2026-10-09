import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRightLeft, Check, Download, FileUp, Loader2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// Help videos on the Content Promotion page: export published videos as a
// package from one instance, preview and apply it on another. The package is
// downloaded through a short-lived link and uploaded in 8 MB parts, so a
// multi-GB package never sits in page memory or meets a request-size limit.

type VideoRow = { id: string; title: string; category: string | null; duration_ms: number | null }
type Ctx = { kind: 'collection' | 'page'; key: string; state_key: string | null }
type PreviewVideo = {
  id: string
  title: string
  action: 'create' | 'update' | 'rejected'
  reasons: string[]
  target: { title: string; status: string; versions: number } | null
  version: { from_number: number; duration_ms: number; render: 'reuse' | 'queue' } | null
  files: Array<{ role: string; size: number }>
  contexts: { added: Ctx[]; already: Ctx[]; skipped: Array<Ctx & { reason: string }> }
  notes: string[]
}
type Preview = {
  id: string
  source: { instance: string; url: string | null }
  exported_at: string | null
  bytes: number
  videos: PreviewVideo[]
}
type Result = {
  id: string
  title: string
  outcome: 'created' | 'updated' | 'failed' | 'skipped'
  version?: number
  render?: 'reused' | 'queued'
  contexts_skipped?: number
  error?: string
}

const PART = 8 * 1024 * 1024

function errText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
}
function mb(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(n / 1024))} KB`
}
function ctxLabel(c: Ctx): string {
  return c.kind === 'page' ? `Page ${c.key}` : c.state_key ? `${c.key} · ${c.state_key}` : c.key
}

export function HelpVideoPromotion() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState('')
  const [progress, setProgress] = useState<number | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [results, setResults] = useState<Result[] | null>(null)
  const [busy, setBusy] = useState(false)

  const videos = useQuery({
    queryKey: ['help-videos', 'promotion-list'],
    queryFn: () =>
      api
        .get<{ data: VideoRow[] }>('/help-videos', { params: { status: 'published', limit: 100 } })
        .then((r) => r.data.data)
  })
  const shown = (videos.data ?? []).filter((v) =>
    v.title.toLowerCase().includes(search.toLowerCase())
  )

  const exportMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { url: string; count: number } }>('/help-videos/packages', {
          ids: [...selected]
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      // A plain navigation: the browser streams the package straight to disk.
      const a = document.createElement('a')
      a.href = d.url
      a.click()
      toast.success(`Package of ${d.count} video${d.count === 1 ? '' : 's'} is downloading`)
    },
    onError: (err) => toast.error(errText(err, 'Export failed'))
  })

  async function upload(f: File) {
    setPreview(null)
    setResults(null)
    setFileName(f.name)
    setBusy(true)
    setProgress(0)
    let id: string | null = null
    try {
      const open = await api.post<{ data: { id: string; max_bytes: number } }>(
        '/help-videos/packages/imports'
      )
      id = open.data.data.id
      if (f.size > open.data.data.max_bytes) {
        throw new Error(`Packages may be at most ${mb(open.data.data.max_bytes)} here`)
      }
      for (let n = 0, at = 0; at < f.size; n++, at += PART) {
        await api.put(`/help-videos/packages/imports/${id}/parts/${n}`, f.slice(at, at + PART), {
          headers: { 'Content-Type': 'application/octet-stream' }
        })
        setProgress(Math.min(1, (at + PART) / f.size))
      }
      setProgress(null)
      const p = await api.post<{ data: Preview }>(`/help-videos/packages/imports/${id}/preview`)
      setPreview(p.data.data)
    } catch (err) {
      setProgress(null)
      toast.error(errText(err, (err as Error).message || 'The package could not be read'))
      if (id) await api.delete(`/help-videos/packages/imports/${id}`).catch(() => undefined)
      setFileName('')
    } finally {
      setBusy(false)
    }
  }

  async function apply() {
    if (!preview) return
    setBusy(true)
    try {
      const r = await api.post<{ data: { results: Result[] } }>(
        `/help-videos/packages/imports/${preview.id}/apply`
      )
      setResults(r.data.data.results)
      const ok = r.data.data.results.filter((x) => x.outcome !== 'failed').length
      toast.success(`${ok} video${ok === 1 ? '' : 's'} imported`)
      void videos.refetch()
    } catch (err) {
      toast.error(errText(err, 'Apply failed'))
    } finally {
      setBusy(false)
    }
  }

  async function discard() {
    if (preview) await api.delete(`/help-videos/packages/imports/${preview.id}`).catch(() => {})
    setPreview(null)
    setResults(null)
    setFileName('')
  }

  const usable = preview?.videos.filter((v) => v.action !== 'rejected') ?? []
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <section
      className='rounded-lg border border-slate-200 bg-white p-5 md:col-span-2 dark:border-border dark:bg-card'
      data-hv-promotion
    >
      <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
        Help videos
      </h2>
      <p className='mb-4 max-w-[75ch] text-[12px] text-muted-foreground'>
        Record and polish videos here, then move them to another instance. A package carries each
        video's published version, its render, captions and poster, and where it shows. Who can
        watch and required viewing stay behind: role ids differ between instances.
      </p>
      <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
        <div>
          <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Export from this instance
          </p>
          <input
            type='text'
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Filter published videos…'
            className='mb-2 h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-border dark:bg-background'
          />
          <div className='mb-3 max-h-64 overflow-y-auto rounded-md border border-slate-100 dark:border-border'>
            {videos.isLoading && (
              <p className='flex items-center gap-1.5 px-2.5 py-3 text-[12px] text-slate-500'>
                <Loader2 className='h-3 w-3 animate-spin' /> Loading videos…
              </p>
            )}
            {shown.map((v) => (
              <button
                key={v.id}
                type='button'
                onClick={() => toggle(v.id)}
                className='flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50'
                data-hv-promotion-video={v.id}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                    selected.has(v.id)
                      ? 'border-nvr-cyan bg-nvr-cyan text-white'
                      : 'border-slate-300 dark:border-slate-600'
                  )}
                >
                  {selected.has(v.id) && <Check className='h-2.5 w-2.5' />}
                </span>
                <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-300'>
                  {v.title || 'Untitled'}
                </span>
                {v.category && (
                  <span className='shrink-0 text-[11px] text-slate-500 dark:text-slate-400'>
                    {v.category}
                  </span>
                )}
              </button>
            ))}
            {!videos.isLoading && shown.length === 0 && (
              <p className='px-2.5 py-3 text-center text-[12px] text-slate-500 dark:text-slate-400'>
                No published videos
              </p>
            )}
          </div>
          <Button
            size='sm'
            disabled={selected.size === 0 || exportMut.isPending}
            onClick={() => exportMut.mutate()}
            data-hv-promotion-export
          >
            {exportMut.isPending ? (
              <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
            ) : (
              <Download className='mr-1.5 h-3.5 w-3.5' />
            )}
            Export{' '}
            {selected.size > 0 ? `${selected.size} video${selected.size !== 1 ? 's' : ''}` : ''}
          </Button>
        </div>

        <div>
          <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Import into this instance
          </p>
          <input
            ref={fileRef}
            type='file'
            accept='.tar,application/x-tar'
            className='hidden'
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void upload(f)
            }}
            data-hv-promotion-file
          />
          <Button
            size='sm'
            variant='outline'
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            data-hv-promotion-choose
          >
            <FileUp className='mr-1.5 h-3.5 w-3.5' />
            {fileName || 'Choose package…'}
          </Button>

          {progress !== null && (
            <div className='mt-3' role='status' aria-live='polite'>
              <div className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                <div
                  className='h-full bg-nvr-cyan transition-[width] duration-200'
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
                Uploading {Math.round(progress * 100)}%
              </p>
            </div>
          )}
          {busy && progress === null && !preview && (
            <p className='mt-3 flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
              <Loader2 className='h-3 w-3 animate-spin' /> Checking the package…
            </p>
          )}

          {preview && (
            <div className='mt-3 space-y-3' data-hv-promotion-preview>
              <p className='text-[12px] text-slate-600 dark:text-slate-300'>
                From <span className='font-medium'>{preview.source.instance}</span>
                {preview.exported_at && ` · ${new Date(preview.exported_at).toLocaleString()}`} ·{' '}
                {mb(preview.bytes)}
              </p>
              <ul className='divide-y divide-slate-100 rounded-md border border-slate-100 dark:divide-border dark:border-border'>
                {preview.videos.map((v) => {
                  const r = results?.find((x) => x.id === v.id)
                  return (
                    <li
                      key={v.id}
                      className='space-y-1 px-3 py-2 text-[12px]'
                      data-hv-promotion-item={v.id}
                      data-action={v.action}
                    >
                      <div className='flex items-center gap-2'>
                        <span className='min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-200'>
                          {v.title || v.id}
                        </span>
                        <ActionPill action={v.action} />
                      </div>
                      {v.action === 'rejected' ? (
                        <p className='text-rose-700 dark:text-rose-300'>{v.reasons.join(' · ')}</p>
                      ) : (
                        <>
                          <p className='text-slate-600 dark:text-slate-400'>
                            {v.target
                              ? `Adds version ${v.target.versions + 1} here (was v${v.version?.from_number} there)`
                              : `New video (v${v.version?.from_number} there)`}{' '}
                            ·{' '}
                            {v.version?.render === 'reuse'
                              ? 'render included'
                              : 'renders after import'}{' '}
                            · {v.files.map((f) => `${f.role} ${mb(f.size)}`).join(', ')}
                          </p>
                          {v.contexts.added.length + v.contexts.already.length > 0 && (
                            <p className='text-slate-600 dark:text-slate-400'>
                              Shows on:{' '}
                              {[...v.contexts.already, ...v.contexts.added]
                                .map(ctxLabel)
                                .join(', ')}
                            </p>
                          )}
                          {v.contexts.skipped.map((c) => (
                            <p
                              key={`${c.kind}-${c.key}-${c.state_key}`}
                              className='text-amber-800 dark:text-amber-200'
                              data-hv-promotion-skipped
                            >
                              Skipped {ctxLabel(c)}: {c.reason}
                            </p>
                          ))}
                          {v.notes.map((n) => (
                            <p key={n} className='text-slate-500 dark:text-slate-400'>
                              {n}
                            </p>
                          ))}
                        </>
                      )}
                      {r && (
                        <p
                          className={cn(
                            r.outcome === 'failed'
                              ? 'text-rose-700 dark:text-rose-300'
                              : 'text-emerald-700 dark:text-emerald-300'
                          )}
                          data-hv-promotion-result={r.outcome}
                        >
                          {r.outcome === 'failed'
                            ? `Failed: ${r.error}`
                            : r.outcome === 'skipped'
                              ? 'Skipped'
                              : `${r.outcome === 'created' ? 'Created' : 'Updated'} as version ${r.version} · render ${r.render}`}
                        </p>
                      )}
                    </li>
                  )
                })}
              </ul>
              {!results && (
                <div className='flex items-center gap-2'>
                  <Button
                    size='sm'
                    disabled={busy || usable.length === 0}
                    onClick={() => void apply()}
                    data-hv-promotion-apply
                  >
                    {busy ? (
                      <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <ArrowRightLeft className='mr-1.5 h-3.5 w-3.5' />
                    )}
                    Apply {usable.length} video{usable.length === 1 ? '' : 's'}
                  </Button>
                  <Button size='sm' variant='ghost' disabled={busy} onClick={() => void discard()}>
                    <X className='mr-1.5 h-3.5 w-3.5' /> Discard
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function ActionPill({ action }: { action: PreviewVideo['action'] }) {
  const cls =
    action === 'create'
      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'
      : action === 'update'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-500/15 dark:text-amber-200'
        : 'bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-300'
  const text = action === 'create' ? 'New' : action === 'update' ? 'Update' : "Can't import"
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', cls)}>{text}</span>
}
