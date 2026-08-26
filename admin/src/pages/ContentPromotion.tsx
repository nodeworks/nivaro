import { useMutation, useQuery } from '@tanstack/react-query'
import { ArrowRightLeft, Check, Download, FileUp, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type Collection = { collection: string; display_name: string | null }
type PreviewStats = Record<
  string,
  { create: number; update: number; unchanged: number; missing_ids: number; error?: string }
>
type ApplyStats = Record<
  string,
  { created: number; updated: number; skipped: number; errors: string[] }
>

type RecordPreview = {
  collection: string
  id: unknown
  exists: boolean
  changes: Array<{ field: string; current: unknown; incoming: unknown }>
  unknown_columns: string[]
  children: Array<{
    collection: string
    create: number
    update: number
    unchanged: number
    error?: string
  }>
}

type RecordApply = {
  record: 'created' | 'updated' | 'unchanged'
  children: Array<{
    collection: string
    created: number
    updated: number
    skipped: number
    errors: string[]
  }>
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

export function ContentPromotionPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [bundle, setBundle] = useState<Record<string, unknown> | null>(null)
  const [bundleName, setBundleName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Single record promotion (#695)
  const [recCollection, setRecCollection] = useState('')
  const [recId, setRecId] = useState('')
  const [includeChildren, setIncludeChildren] = useState(true)
  const [recBundle, setRecBundle] = useState<Record<string, unknown> | null>(null)
  const [recBundleName, setRecBundleName] = useState('')
  const [recMode, setRecMode] = useState<'create' | 'update' | 'upsert'>('upsert')
  const recFileRef = useRef<HTMLInputElement>(null)

  const { data: collections = [] } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api.get<{ data: Collection[] }>('/collections?tables_only=true').then((r) => r.data.data)
  })
  const filtered = collections.filter(
    (c) =>
      !c.collection.startsWith('nivaro_') &&
      c.collection.toLowerCase().includes(search.toLowerCase())
  )

  const exportMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: Record<string, unknown> }>('/promotion/export', {
          collections: [...selected]
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `nivaro-bundle-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Bundle downloaded')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Export failed')
    }
  })

  const previewMut = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api
        .post<{ data: PreviewStats }>('/promotion/preview', { bundle: b })
        .then((r) => r.data.data),
    onError: () => toast.error('Preview failed')
  })

  const applyMut = useMutation({
    mutationFn: () =>
      api.post<{ data: ApplyStats }>('/promotion/apply', { bundle }).then((r) => r.data.data),
    onSuccess: () => toast.success('Bundle applied'),
    onError: () => toast.error('Apply failed')
  })

  const recExportMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: Record<string, unknown> }>('/record-promotion/export', {
          collection: recCollection.trim(),
          id: recId.trim(),
          include_children: includeChildren
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${recCollection.trim()}-${recId.trim()}.record.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Record bundle downloaded')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Export failed')
    }
  })

  const recPreviewMut = useMutation({
    mutationFn: (b: Record<string, unknown>) =>
      api
        .post<{ data: RecordPreview }>('/record-promotion/preview', { bundle: b })
        .then((r) => r.data.data),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Preview failed')
    }
  })

  const recApplyMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: RecordApply }>('/record-promotion/apply', {
          bundle: recBundle,
          mode: recMode
        })
        .then((r) => r.data.data),
    onSuccess: () => toast.success('Record applied'),
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Apply failed')
    }
  })

  function handleRecFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''
    f.text().then((text) => {
      try {
        const parsed = JSON.parse(text)
        if (parsed?.type !== 'nivaro-record-bundle') {
          toast.error('Not a Nivaro record bundle')
          return
        }
        setRecBundle(parsed)
        setRecBundleName(f.name)
        recApplyMut.reset()
        recPreviewMut.mutate(parsed)
      } catch {
        toast.error('Invalid JSON file')
      }
    })
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''
    f.text().then((text) => {
      try {
        const parsed = JSON.parse(text)
        if (parsed?.type !== 'nivaro-content-bundle') {
          toast.error('Not a Nivaro content bundle')
          return
        }
        setBundle(parsed)
        setBundleName(f.name)
        applyMut.reset()
        previewMut.mutate(parsed)
      } catch {
        toast.error('Invalid JSON file')
      }
    })
  }

  const toggle = (c: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <ArrowRightLeft className='h-4.5 w-4.5 text-nvr-cyan' />
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Content Promotion
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Export a content bundle here, preview and apply it on another instance — upserts by
              id, never deletes.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-y-auto'>
        <div className='grid w-full max-w-4xl grid-cols-1 gap-6 p-8 md:grid-cols-2'>
          {/* Export */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Export bundle
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Pick collections to package from this instance (max 10,000 rows each).
            </p>
            <input
              type='text'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Filter collections…'
              className='mb-2 h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
            />
            <div className='mb-3 max-h-64 overflow-y-auto rounded-md border border-slate-100 dark:border-border'>
              {filtered.map((c) => (
                <button
                  key={c.collection}
                  type='button'
                  onClick={() => toggle(c.collection)}
                  className='flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50'
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded border',
                      selected.has(c.collection)
                        ? 'border-[#00ceff] bg-[#00ceff] text-white'
                        : 'border-slate-300'
                    )}
                  >
                    {selected.has(c.collection) && <Check className='h-2.5 w-2.5' />}
                  </span>
                  <span className='truncate text-slate-700 dark:text-slate-300'>
                    {c.collection}
                  </span>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className='px-2.5 py-3 text-center text-[12px] text-slate-400'>No collections</p>
              )}
            </div>
            <Button
              size='sm'
              disabled={selected.size === 0 || exportMut.isPending}
              onClick={() => exportMut.mutate()}
            >
              {exportMut.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Download className='mr-1.5 h-3.5 w-3.5' />
              )}
              Export{' '}
              {selected.size > 0
                ? `${selected.size} collection${selected.size !== 1 ? 's' : ''}`
                : ''}
            </Button>
          </section>

          {/* Import */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Apply bundle
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Load a bundle exported from another instance. You get a diff preview before anything
              is written.
            </p>
            <input
              ref={fileRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={handleFile}
            />
            <Button size='sm' variant='outline' onClick={() => fileRef.current?.click()}>
              <FileUp className='mr-1.5 h-3.5 w-3.5' />
              {bundleName || 'Choose bundle file…'}
            </Button>

            {previewMut.isPending && (
              <p className='mt-3 flex items-center gap-1.5 text-[12px] text-slate-500'>
                <Loader2 className='h-3 w-3 animate-spin' /> Computing diff…
              </p>
            )}

            {previewMut.data && (
              <div className='mt-4 space-y-3'>
                <table className='w-full text-left text-[12px]'>
                  <thead>
                    <tr className='border-b border-slate-100 text-[11px] text-slate-500 dark:border-border'>
                      <th className='py-1.5 font-medium'>Collection</th>
                      <th className='py-1.5 text-right font-medium'>Create</th>
                      <th className='py-1.5 text-right font-medium'>Update</th>
                      <th className='py-1.5 text-right font-medium'>Unchanged</th>
                    </tr>
                  </thead>
                  <tbody className='divide-y divide-slate-50 dark:divide-border'>
                    {Object.entries(previewMut.data).map(([col, s]) => (
                      <tr key={col}>
                        <td className='py-1.5 font-mono text-slate-700 dark:text-slate-300'>
                          {col}
                          {s.error && <span className='ml-1 text-red-500'>({s.error})</span>}
                        </td>
                        <td className='py-1.5 text-right text-green-600'>{s.create}</td>
                        <td className='py-1.5 text-right text-amber-600'>{s.update}</td>
                        <td className='py-1.5 text-right text-slate-400'>{s.unchanged}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {applyMut.data ? (
                  <div className='rounded-md bg-slate-50 p-2.5 text-[12px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                    {Object.entries(applyMut.data).map(([col, s]) => (
                      <p key={col}>
                        <span className='font-mono'>{col}</span>: {s.created} created, {s.updated}{' '}
                        updated, {s.skipped} unchanged
                        {s.errors.length > 0 && (
                          <span className='text-red-500'>
                            {' '}
                            — {s.errors.length} error(s): {s.errors[0]}
                          </span>
                        )}
                      </p>
                    ))}
                  </div>
                ) : (
                  <Button size='sm' disabled={applyMut.isPending} onClick={() => applyMut.mutate()}>
                    {applyMut.isPending ? (
                      <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <ArrowRightLeft className='mr-1.5 h-3.5 w-3.5' />
                    )}
                    Apply to this instance
                  </Button>
                )}
              </div>
            )}
          </section>

          {/* Single record promotion (#695) */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 md:col-span-2 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Single record
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Promote one record (optionally with its child rows, capped at 200 per relation)
              instead of a whole collection bundle.
            </p>
            <div className='grid grid-cols-1 gap-6 md:grid-cols-2'>
              {/* Export one record */}
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                  Export from this instance
                </p>
                <div className='mb-2 flex gap-2'>
                  <input
                    type='text'
                    value={recCollection}
                    onChange={(e) => setRecCollection(e.target.value)}
                    placeholder='collection'
                    className='h-8 w-[180px] rounded-md border border-slate-200 px-2 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
                  />
                  <input
                    type='text'
                    value={recId}
                    onChange={(e) => setRecId(e.target.value)}
                    placeholder='record id'
                    className='h-8 w-[140px] rounded-md border border-slate-200 px-2 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
                  />
                </div>
                <label className='mb-3 flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                  <input
                    type='checkbox'
                    checked={includeChildren}
                    onChange={(e) => setIncludeChildren(e.target.checked)}
                    className='h-3.5 w-3.5 accent-[#00ceff]'
                  />
                  Include child rows (O2M relations)
                </label>
                <Button
                  size='sm'
                  disabled={!recCollection.trim() || !recId.trim() || recExportMut.isPending}
                  onClick={() => recExportMut.mutate()}
                >
                  {recExportMut.isPending ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Download className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  Export record
                </Button>
              </div>

              {/* Apply one record */}
              <div>
                <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                  Apply to this instance
                </p>
                <input
                  ref={recFileRef}
                  type='file'
                  accept='.json'
                  className='hidden'
                  onChange={handleRecFile}
                />
                <Button size='sm' variant='outline' onClick={() => recFileRef.current?.click()}>
                  <FileUp className='mr-1.5 h-3.5 w-3.5' />
                  {recBundleName || 'Choose record bundle…'}
                </Button>

                {recPreviewMut.isPending && (
                  <p className='mt-3 flex items-center gap-1.5 text-[12px] text-slate-500'>
                    <Loader2 className='h-3 w-3 animate-spin' /> Computing diff…
                  </p>
                )}

                {recPreviewMut.data && (
                  <div className='mt-3 space-y-3'>
                    <div className='rounded-md bg-slate-50 p-2.5 text-[12px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                      <p>
                        <span className='font-mono'>{recPreviewMut.data.collection}</span> ·{' '}
                        <span className='font-mono'>{String(recPreviewMut.data.id)}</span> —{' '}
                        {recPreviewMut.data.exists ? (
                          recPreviewMut.data.changes.length > 0 ? (
                            <span className='text-amber-600'>
                              exists, {recPreviewMut.data.changes.length} field(s) differ
                            </span>
                          ) : (
                            <span className='text-slate-400'>exists, identical</span>
                          )
                        ) : (
                          <span className='text-green-600'>would be created</span>
                        )}
                      </p>
                      {recPreviewMut.data.unknown_columns.length > 0 && (
                        <p className='mt-0.5 text-[11px] text-amber-600'>
                          Columns not on this instance (ignored):{' '}
                          {recPreviewMut.data.unknown_columns.join(', ')}
                        </p>
                      )}
                    </div>

                    {recPreviewMut.data.changes.length > 0 && (
                      <table className='w-full text-left text-[12px]'>
                        <thead>
                          <tr className='border-b border-slate-100 text-[11px] text-slate-500 dark:border-border'>
                            <th className='py-1 font-medium'>Field</th>
                            <th className='py-1 font-medium'>Current</th>
                            <th className='py-1 font-medium'>Incoming</th>
                          </tr>
                        </thead>
                        <tbody className='divide-y divide-slate-50 dark:divide-border'>
                          {recPreviewMut.data.changes.slice(0, 30).map((c) => (
                            <tr key={c.field}>
                              <td className='py-1 pr-2 font-mono text-slate-700 dark:text-slate-300'>
                                {c.field}
                              </td>
                              <td className='max-w-[160px] truncate py-1 pr-2 text-slate-400 line-through'>
                                {fmtVal(c.current)}
                              </td>
                              <td className='max-w-[160px] truncate py-1 text-slate-700 dark:text-slate-300'>
                                {fmtVal(c.incoming)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    {recPreviewMut.data.children.length > 0 && (
                      <div className='text-[12px] text-slate-600 dark:text-slate-300'>
                        {recPreviewMut.data.children.map((c) => (
                          <p key={c.collection}>
                            <span className='font-mono'>{c.collection}</span>:{' '}
                            {c.error ? (
                              <span className='text-red-500'>{c.error}</span>
                            ) : (
                              <>
                                <span className='text-green-600'>{c.create} create</span> ·{' '}
                                <span className='text-amber-600'>{c.update} update</span> ·{' '}
                                <span className='text-slate-400'>{c.unchanged} unchanged</span>
                              </>
                            )}
                          </p>
                        ))}
                      </div>
                    )}

                    {recApplyMut.data ? (
                      <div className='rounded-md bg-green-50 p-2.5 text-[12px] text-green-800 dark:bg-green-900/20 dark:text-green-300'>
                        <p>Record: {recApplyMut.data.record}</p>
                        {recApplyMut.data.children.map((c) => (
                          <p key={c.collection}>
                            {c.collection}: {c.created} created, {c.updated} updated, {c.skipped}{' '}
                            unchanged
                            {c.errors.length > 0 && (
                              <span className='text-red-500'> — {c.errors[0]}</span>
                            )}
                          </p>
                        ))}
                      </div>
                    ) : (
                      <div className='flex flex-wrap items-center gap-3'>
                        <div className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                          {(['create', 'update', 'upsert'] as const).map((m) => (
                            <label key={m} className='flex items-center gap-1'>
                              <input
                                type='radio'
                                name='rec-mode'
                                checked={recMode === m}
                                onChange={() => setRecMode(m)}
                                className='h-3 w-3 accent-[#00ceff]'
                              />
                              {m}
                            </label>
                          ))}
                        </div>
                        <Button
                          size='sm'
                          disabled={recApplyMut.isPending}
                          onClick={() => recApplyMut.mutate()}
                        >
                          {recApplyMut.isPending ? (
                            <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                          ) : (
                            <ArrowRightLeft className='mr-1.5 h-3.5 w-3.5' />
                          )}
                          Apply record
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
