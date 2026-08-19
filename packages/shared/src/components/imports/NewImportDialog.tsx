import { useMutation } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FileSpreadsheet,
  Loader2,
  Search,
  Upload,
  X
} from 'lucide-react'
import { type DragEvent, useMemo, useRef, useState } from 'react'
import { useApiFetchConfig } from '../../context'
import { cn, formatFileSize, formatNumber } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { type ImportDefinition, type ImportPreview, definitionTitle } from './types'

/**
 * Upload transport.
 *
 * Queueing and previewing are multipart, and `client.request` takes a `Command`
 * whose body it JSON-stringifies — a `FormData` can't ride it without changing
 * the SDK's published request semantics for every caller. So these go through
 * `useApiFetchConfig`, which exists for exactly this (widget renders, PDF
 * blobs) and derives base URL + auth from the ambient Nivaro client, so a
 * cross-origin token host behaves the same as the same-origin admin.
 */
function useMultipartPost() {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  return async function post<T>(path: string, form: FormData): Promise<T> {
    const res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: authHeaders,
      credentials,
      body: form
    })
    const json = await res.json().catch(() => ({ error: res.statusText }))
    if (!res.ok) {
      throw Object.assign(new Error(json?.error || res.statusText), { status: res.status })
    }
    return json.data as T
  }
}

function acceptFor(def: ImportDefinition | null): string {
  const raw = def?.file_types
  if (!raw) return '.csv,.xlsx,.xls'
  try {
    const list = JSON.parse(raw) as string[]
    if (Array.isArray(list) && list.length > 0) return list.map((t) => `.${t}`).join(',')
  } catch {
    // A malformed file_types is a config problem, not a reason to block an
    // upload — fall through to the default accept list.
  }
  return '.csv,.xlsx,.xls'
}

function TargetLine({ def }: { def: ImportDefinition }) {
  const table = def.staging_table || `staging_${def.key}`
  return (
    <span className='flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
      <span className='truncate'>{table}</span>
      {def.procedure ? (
        <>
          <ArrowRight className='h-3 w-3 shrink-0 text-slate-300 dark:text-slate-600' />
          <span className='truncate'>{def.procedure}</span>
        </>
      ) : (
        <span className='shrink-0 font-sans text-slate-400'>· load only</span>
      )}
    </span>
  )
}

function DefinitionRow({
  def,
  active,
  onPick
}: {
  def: ImportDefinition
  active: boolean
  onPick: (key: string) => void
}) {
  return (
    <button
      type='button'
      onClick={() => onPick(def.key)}
      className={cn(
        'flex w-full flex-col gap-0.5 border-b border-slate-100 px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted/40',
        active && 'bg-nvr-cyan/10 hover:bg-nvr-cyan/15 dark:bg-nvr-cyan/15'
      )}
    >
      <span className='flex items-center gap-1.5 text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
        {active && <Check className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />}
        <span className='truncate'>{definitionTitle(def)}</span>
      </span>
      <TargetLine def={def} />
    </button>
  )
}

export function NewImportDialog({
  open,
  onOpenChange,
  definitions,
  runCounts = {},
  onQueued
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  definitions: ImportDefinition[]
  /** All-time run count per import key — drives the "Frequently used" section. */
  runCounts?: Record<string, number>
  onQueued: (id: number) => void
}) {
  const postMultipart = useMultipartPost()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [search, setSearch] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [priority, setPriority] = useState('1000')
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = definitions.find((d) => d.key === selectedKey) ?? null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return definitions
    return definitions.filter((d) =>
      [d.key, d.label, d.staging_table, d.procedure, d.description]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    )
  }, [definitions, search])

  // Most-run imports float to the top so regulars don't search every time;
  // everything else lists alphabetically. Searching collapses to one flat
  // result list — grouping a two-item match would just add noise.
  const grouped = useMemo(() => {
    const alpha = [...filtered].sort((a, b) => definitionTitle(a).localeCompare(definitionTitle(b)))
    if (search.trim()) return { frequent: [] as ImportDefinition[], rest: alpha }
    const frequent = [...filtered]
      .filter((d) => (runCounts[d.key] ?? 0) > 0)
      .sort((a, b) => (runCounts[b.key] ?? 0) - (runCounts[a.key] ?? 0))
      .slice(0, 5)
    const freqKeys = new Set(frequent.map((d) => d.key))
    return { frequent, rest: alpha.filter((d) => !freqKeys.has(d.key)) }
  }, [filtered, runCounts, search])

  const preview = useMutation({
    mutationFn: async ({ f, key }: { f: File; key: string }) => {
      const form = new FormData()
      form.append('import_key', key)
      form.append('file', f, f.name)
      return postMultipart<ImportPreview>('/staged-imports/preview', form)
    },
    onError: (err: Error) => setError(err.message)
  })

  const queue = useMutation({
    mutationFn: async () => {
      const form = new FormData()
      form.append('import_key', selectedKey ?? '')
      form.append('sort', priority || '0')
      form.append('file', file as File, (file as File).name)
      return postMultipart<{ id: number }>('/staged-imports', form)
    },
    onSuccess: (data) => {
      onQueued(data.id)
      reset()
      onOpenChange(false)
    },
    onError: (err: Error) => setError(err.message)
  })

  function reset() {
    setSearch('')
    setSelectedKey(null)
    setFile(null)
    setPriority('1000')
    setError(null)
    preview.reset()
    queue.reset()
  }

  function takeFile(next: File | null) {
    setError(null)
    preview.reset()
    setFile(next)
    if (next && selectedKey) preview.mutate({ f: next, key: selectedKey })
  }

  function pickDefinition(key: string) {
    setSelectedKey(key)
    setError(null)
    preview.reset()
    // Re-parse against the newly chosen definition — the column diff is
    // relative to ITS staging table, so the old preview would be misleading.
    if (file) preview.mutate({ f: file, key })
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault()
    setDragging(false)
    takeFile(e.dataTransfer.files?.[0] ?? null)
  }

  const previewData = preview.data
  const hasWarnings =
    !!previewData && (previewData.unknown_columns.length > 0 || previewData.missing_columns.length > 0)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='flex max-h-[88vh] w-[min(920px,94vw)] max-w-none flex-col overflow-hidden dark:bg-card'>
        <DialogHeader className='shrink-0'>
          <DialogTitle className='text-[17px] dark:text-foreground'>New import</DialogTitle>
          <DialogDescription className='text-[12.5px]'>
            The file is loaded into a staging table, then the import's procedure runs over it.
            Nothing is queued until you confirm.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className='min-h-0 flex-1 overflow-y-auto'>
          <div className='grid grid-cols-1 gap-5 lg:grid-cols-[300px_1fr]'>
            {/* ── Which import ───────────────────────────────────────────── */}
            <section className='flex min-h-0 flex-col'>
              <h3 className='mb-2 text-[12px] font-semibold text-slate-900 dark:text-foreground'>
                1 · Which import
              </h3>
              <div className='relative mb-2'>
                <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder='Search imports…'
                  className='h-8 pl-8 text-[12.5px]'
                />
              </div>
              <div className='max-h-[300px] min-h-[140px] overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
                {filtered.length === 0 ? (
                  <p className='px-3 py-6 text-center text-[12px] text-slate-400'>
                    No import matches “{search}”.
                  </p>
                ) : (
                  <>
                    {grouped.frequent.length > 0 && (
                      <>
                        <p className='border-b border-slate-100 bg-slate-50/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:border-border/60 dark:bg-muted/30 dark:text-muted-foreground'>
                          Frequently used
                        </p>
                        {grouped.frequent.map((d) => (
                          <DefinitionRow
                            key={d.key}
                            def={d}
                            active={d.key === selectedKey}
                            onPick={pickDefinition}
                          />
                        ))}
                        {grouped.rest.length > 0 && (
                          <p className='border-b border-slate-100 bg-slate-50/80 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:border-border/60 dark:bg-muted/30 dark:text-muted-foreground'>
                            All imports
                          </p>
                        )}
                      </>
                    )}
                    {grouped.rest.map((d) => (
                      <DefinitionRow
                        key={d.key}
                        def={d}
                        active={d.key === selectedKey}
                        onPick={pickDefinition}
                      />
                    ))}
                  </>
                )}
              </div>
            </section>

            {/* ── File + preview ─────────────────────────────────────────── */}
            <section className='flex min-w-0 flex-col'>
              <h3 className='mb-2 text-[12px] font-semibold text-slate-900 dark:text-foreground'>
                2 · The file
              </h3>

              <input
                ref={fileInputRef}
                type='file'
                className='hidden'
                accept={acceptFor(selected)}
                onChange={(e) => {
                  takeFile(e.target.files?.[0] ?? null)
                  e.target.value = ''
                }}
              />

              {file ? (
                <div className='flex items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-border dark:bg-muted/30'>
                  <FileSpreadsheet className='h-4 w-4 shrink-0 text-slate-400' />
                  <div className='min-w-0 flex-1'>
                    <p className='truncate font-mono text-[12px] text-slate-900 dark:text-foreground'>
                      {file.name}
                    </p>
                    <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {formatFileSize(file.size)}
                    </p>
                  </div>
                  <button
                    type='button'
                    onClick={() => takeFile(null)}
                    className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted'
                    aria-label='Remove file'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </div>
              ) : (
                <button
                  type='button'
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  className={cn(
                    'flex w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed px-4 py-7 transition-colors',
                    dragging
                      ? 'border-nvr-cyan bg-nvr-cyan/10'
                      : 'border-slate-300 hover:border-slate-400 hover:bg-slate-50 dark:border-border dark:hover:bg-muted/30'
                  )}
                >
                  <Upload className='h-4 w-4 text-slate-400' />
                  <span className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
                    Drop a file, or click to choose
                  </span>
                  <span className='text-[11px] text-slate-400'>
                    {acceptFor(selected).split(',').join('  ')}
                  </span>
                </button>
              )}

              {/* Parsed with the worker's own reader, so what's shown here is
                  what the procedure will actually consume. */}
              <div className='mt-3 min-h-[120px]'>
                {preview.isPending && (
                  <p className='flex items-center gap-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                    <Loader2 className='h-3.5 w-3.5 animate-spin' /> Checking the file for errors and
                    warnings — duplicates, missing values, and unmatched references…
                  </p>
                )}

                {!preview.isPending && !previewData && file && !selectedKey && (
                  <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                    Choose an import on the left to preview how this file will be read.
                  </p>
                )}

                {previewData && (
                  <div className='space-y-2.5'>
                    <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                      <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                        {formatNumber(previewData.row_count)}
                      </span>{' '}
                      rows ×{' '}
                      <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                        {previewData.columns.length}
                      </span>{' '}
                      columns
                      {previewData.staging_columns == null && (
                        <span className='text-slate-400'> · staging table will be created</span>
                      )}
                    </p>

                    {previewData.validation && previewData.validation.errors.length > 0 && (
                      <div className='rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11.5px] text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'>
                        <p className='mb-1 flex items-center gap-1.5 font-medium'>
                          <AlertTriangle className='h-3.5 w-3.5' /> This file fails validation — it
                          cannot be queued until fixed
                        </p>
                        {previewData.validation.errors.map((e) => (
                          <p key={e.code + e.message}>
                            {e.message}
                            {e.rows && e.rows.length > 0 && (
                              <span className='text-red-600 dark:text-red-400'>
                                {' '}
                                (rows {e.rows.join(', ')}
                                {e.count && e.count > e.rows.length ? ', …' : ''})
                              </span>
                            )}
                          </p>
                        ))}
                      </div>
                    )}
                    {previewData.validation && previewData.validation.warnings.length > 0 && (
                      <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'>
                        {previewData.validation.warnings.map((w) => (
                          <p key={w.code + w.message}>
                            {w.message}
                            {w.rows && w.rows.length > 0 && (
                              <span className='text-amber-600 dark:text-amber-400'>
                                {' '}
                                (rows {w.rows.join(', ')}
                                {w.count && w.count > w.rows.length ? ', …' : ''})
                              </span>
                            )}
                          </p>
                        ))}
                      </div>
                    )}
                    {previewData.validation &&
                      (previewData.validation.stats.new_rows != null ||
                        previewData.validation.stats.existing_rows != null) && (
                        <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                          <span className='font-semibold tabular-nums text-emerald-600 dark:text-emerald-400'>
                            {formatNumber(Number(previewData.validation.stats.new_rows ?? 0))}
                          </span>{' '}
                          new ·{' '}
                          <span className='font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                            {formatNumber(Number(previewData.validation.stats.existing_rows ?? 0))}
                          </span>{' '}
                          already exist
                          {previewData.validation.truncated && (
                            <span className='text-slate-400'> · counts cover the first 20,000 rows</span>
                          )}
                        </p>
                      )}

                    {hasWarnings && (
                      <div className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300'>
                        <p className='mb-1 flex items-center gap-1.5 font-medium'>
                          <AlertTriangle className='h-3.5 w-3.5' /> This file doesn't match{' '}
                          <span className='font-mono'>{previewData.staging_table}</span>
                        </p>
                        {previewData.unknown_columns.length > 0 && (
                          <p>
                            Not in the staging table:{' '}
                            <span className='font-mono'>
                              {previewData.unknown_columns.join(', ')}
                            </span>
                          </p>
                        )}
                        {previewData.missing_columns.length > 0 && (
                          <p>
                            Expected but absent:{' '}
                            <span className='font-mono'>
                              {previewData.missing_columns.join(', ')}
                            </span>
                          </p>
                        )}
                        <p className='mt-1 text-amber-700 dark:text-amber-400'>
                          The staging table is rebuilt from the file, so the procedure may fail on a
                          column it expects.
                        </p>
                      </div>
                    )}

                    <div className='overflow-x-auto rounded-md border border-slate-200 dark:border-border'>
                      <table className='w-full border-collapse'>
                        <thead>
                          <tr className='bg-slate-50 dark:bg-muted/40'>
                            {previewData.columns.map((c) => (
                              <th
                                key={c}
                                className={cn(
                                  'whitespace-nowrap border-b border-slate-200 px-2.5 py-1.5 text-left font-mono text-[10.5px] font-medium dark:border-border',
                                  previewData.unknown_columns.includes(c)
                                    ? 'text-amber-700 dark:text-amber-400'
                                    : 'text-slate-500 dark:text-muted-foreground'
                                )}
                              >
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewData.rows.slice(0, 8).map((row, i) => (
                            // eslint-disable-next-line react/no-array-index-key
                            <tr key={i} className='border-b border-slate-100 last:border-b-0 dark:border-border/60'>
                              {previewData.columns.map((c) => (
                                <td
                                  key={c}
                                  className='max-w-[220px] truncate whitespace-nowrap px-2.5 py-1 font-mono text-[11px] text-slate-700 dark:text-foreground'
                                  title={row[c] ?? ''}
                                >
                                  {row[c] || <span className='text-slate-300'>—</span>}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {previewData.row_count > 8 && (
                      <p className='text-[11px] text-slate-400'>
                        Showing the first 8 of {formatNumber(previewData.row_count)} rows.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>
        </DialogBody>

        <DialogFooter className='shrink-0 flex-wrap gap-x-4 gap-y-2 dark:border-border'>
          <div className='mr-auto flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1'>
            <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
              Priority
              <Input
                value={priority}
                onChange={(e) => setPriority(e.target.value.replace(/[^\d-]/g, ''))}
                inputMode='numeric'
                className='h-7 w-20 text-right font-mono text-[12px]'
              />
              <span className='text-[11px] text-slate-400'>lower runs first</span>
            </label>
            {selected && (
              <p className='min-w-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {selected.procedure ? (
                  <>
                    Will load into{' '}
                    <span className='font-mono text-slate-700 dark:text-foreground'>
                      {selected.staging_table || `staging_${selected.key}`}
                    </span>
                    , then run{' '}
                    <span className='font-mono text-slate-700 dark:text-foreground'>
                      {selected.procedure}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    Will load into{' '}
                    <span className='font-mono text-slate-700 dark:text-foreground'>
                      {selected.staging_table || `staging_${selected.key}`}
                    </span>
                    . No procedure runs.
                  </>
                )}
              </p>
            )}
          </div>
          {error && (
            <p className='w-full text-[12px] text-red-600 dark:text-red-400 sm:w-auto'>{error}</p>
          )}
          <Button variant='ghost' size='sm' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size='sm'
            disabled={
              !selected ||
              !file ||
              queue.isPending ||
              preview.isPending ||
              (preview.data?.validation?.errors.length ?? 0) > 0
            }
            onClick={() => queue.mutate()}
          >
            {queue.isPending ? (
              <>
                <Loader2 className='h-3.5 w-3.5 animate-spin' /> Queueing…
              </>
            ) : (
              'Queue import'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
