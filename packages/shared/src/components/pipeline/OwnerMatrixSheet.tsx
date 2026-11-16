import { useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ChevronDown,
  CircleAlert,
  Download,
  FileSpreadsheet,
  Loader2,
  Minus,
  Plus,
  Upload,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useApiFetchConfig } from '../../context'
import type { ErrorDescription } from '../../lib/error-message'
import { toastError } from '../../lib/error-toast'
import { ErrorNotice } from '../ErrorNotice'
import { Button } from '../ui/button'
import { OwnerRecordTrial } from './OwnerRecordTrial'
import type { DraftGroupDelta } from './owner-matrix-draft'

// Owner matrix as a spreadsheet (idea 29): Download as Excel, edit by hand,
// Upload → every change grouped by step + the problems per row → Apply.
// Nothing is written until Apply; Apply is bound to the preview (409 when
// someone changed the matrix in between, with the fresh preview).

interface PersonRef {
  id: string
  name: string
  email: string | null
}
interface TeamRef {
  id: number
  name: string
}
interface GroupChange {
  kind: 'added' | 'removed' | 'changed'
  group_id: string | null
  row: number | null
  state_id: string
  label: string
  filters_before: string[]
  filters_after: string[]
  fields: Array<{ field: 'step' | 'name' | 'default' | 'priority'; before: string; after: string }>
  people_added: PersonRef[]
  people_removed: PersonRef[]
  teams_added: TeamRef[]
  teams_removed: TeamRef[]
}
interface StepChanges {
  state_id: string
  state_label: string
  changes: GroupChange[]
  people_added: number
  people_removed: number
}
interface SheetProblem {
  row: number | null
  column: string | null
  severity: 'error' | 'warning'
  message: string
}
export interface OwnerSheetPreview {
  rows: number
  steps: StepChanges[]
  problems: SheetProblem[]
  problems_hidden: number
  errors: number
  warnings: number
  counts: {
    groups_added: number
    groups_removed: number
    groups_changed: number
    groups_unchanged: number
    people_added: number
    people_removed: number
  }
  draft_groups: DraftGroupDelta[]
  plan_hash: string
  nothing_to_do: boolean
}

type FetchError = Error & { status?: number; code?: string; data?: OwnerSheetPreview }

/** A readable file that is not the owner matrix workbook (no Step, People… columns). */
function wrongFileDescription(fileName: string): ErrorDescription {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase()
  return {
    title:
      ext && !['xlsx', 'xlsm', 'xls'].includes(ext)
        ? `This ${ext.toUpperCase()} file is not the owner matrix`
        : 'This file is not the owner matrix',
    hint: 'Upload the .xlsx file you got from Download as Excel, after editing it. Its Owners sheet is what is read.'
  }
}

/** The file itself could not be used (wrong file, no Owners sheet, too big): say so
 *  plainly instead of the generic "correct the highlighted values". */
function readFailure(err: unknown, fileName?: string): ErrorDescription | undefined {
  const e = err as FetchError
  if (!e || !['UNREADABLE', 'NO_FILE', 'FILE_TOO_LARGE'].includes(String(e.code))) return undefined
  // A CSV (or any other non-workbook) has no Owners sheet: name the kind of file and the fix,
  // rather than the reader's "Sheet1 has no data rows".
  const ext = /\.([a-z0-9]+)$/i.exec(fileName ?? '')?.[1]?.toLowerCase()
  if (ext && !['xlsx', 'xlsm', 'xls'].includes(ext))
    return {
      title: `This ${ext.toUpperCase()} file has no owner matrix in it`,
      hint: 'Upload the .xlsx file you got from Download as Excel, after editing it.',
      code: e.code,
      status: e.status
    }
  return {
    title: e.message || 'This file could not be read',
    hint: 'Upload the file you got from Download as Excel — its Owners sheet is what is read.',
    code: e.code,
    status: e.status
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Download + Upload buttons for the Owner Matrix card header; the review drawer opens on upload. */
export function OwnerMatrixSheetActions({
  templateId,
  collections
}: {
  templateId: string
  /** The pipeline's bound collections (for "Try a record"). */
  collections: string[]
}) {
  const fetchCfg = useApiFetchConfig()
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [downloading, setDownloading] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<OwnerSheetPreview | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [stale, setStale] = useState(false)
  const base = `${fetchCfg.apiBase}/pipelines/${encodeURIComponent(templateId)}/owner-matrix/sheet`

  async function send(path: string, f: File): Promise<unknown> {
    const form = new FormData()
    form.append('file', f, f.name)
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: fetchCfg.authHeaders,
      credentials: fetchCfg.credentials,
      body: form
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok)
      throw Object.assign(new Error(json?.error || res.statusText), {
        status: res.status,
        code: json?.code,
        data: json?.data
      }) as FetchError
    return json.data
  }

  async function download() {
    setDownloading(true)
    try {
      const res = await fetch(base, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (!res.ok) throw Object.assign(new Error(res.statusText), { status: res.status })
      const name =
        /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
        'owner matrix.xlsx'
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      toastError(err, 'Could not download the owner matrix')
    } finally {
      setDownloading(false)
    }
  }

  async function check(f: File) {
    setFile(f)
    setPreview(null)
    setError(null)
    setStale(false)
    setLoading(true)
    try {
      setPreview((await send('/preview', f)) as OwnerSheetPreview)
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }

  function close() {
    setFile(null)
    setPreview(null)
    setError(null)
    setStale(false)
  }

  async function apply() {
    if (!file || !preview) return
    setApplying(true)
    try {
      await send(`/apply?hash=${preview.plan_hash}`, file)
      const c = preview.counts
      toast.success('Owner matrix updated', {
        description: [
          c.groups_added && `${plural(c.groups_added, 'group')} added`,
          c.groups_removed && `${plural(c.groups_removed, 'group')} removed`,
          c.groups_changed && `${plural(c.groups_changed, 'group')} changed`
        ]
          .filter(Boolean)
          .join(', ')
      })
      void qc.invalidateQueries({ queryKey: ['pipeline-all-owner-groups', templateId] })
      void qc.invalidateQueries({ queryKey: ['owner-matrix-versions', templateId] })
      void qc.invalidateQueries({ queryKey: ['owner-preview', templateId] })
      close()
    } catch (err) {
      const e = err as FetchError
      if (e.code === 'OWNER_SHEET_STALE' || e.code === 'OWNER_SHEET_PROBLEMS') {
        if (e.data) setPreview(e.data)
        setStale(e.code === 'OWNER_SHEET_STALE')
        if (e.code === 'OWNER_SHEET_STALE' && !e.data && file) void check(file)
      } else toastError(err, 'Could not apply the spreadsheet')
    } finally {
      setApplying(false)
    }
  }

  return (
    <>
      <Button
        size='sm'
        variant='outline'
        className='h-7 shrink-0 gap-1.5 text-[12px]'
        onClick={download}
        disabled={downloading}
        data-owner-sheet-download
      >
        {downloading ? (
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
        ) : (
          <Download className='h-3.5 w-3.5' />
        )}
        Download as Excel
      </Button>
      <Button
        size='sm'
        variant='outline'
        className='h-7 shrink-0 gap-1.5 text-[12px]'
        onClick={() => inputRef.current?.click()}
        data-owner-sheet-upload
      >
        <Upload className='h-3.5 w-3.5' />
        Upload
      </Button>
      <input
        ref={inputRef}
        type='file'
        accept='.xlsx,.xlsm,.xls,.csv'
        className='hidden'
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void check(f)
        }}
      />
      {file && (
        <OwnerSheetDrawer
          templateId={templateId}
          collections={collections}
          fileName={file.name}
          preview={preview}
          loading={loading}
          error={error}
          stale={stale}
          applying={applying}
          onRetry={() => file && void check(file)}
          onPickAnother={() => inputRef.current?.click()}
          onApply={apply}
          onClose={close}
        />
      )}
    </>
  )
}

export function OwnerSheetDrawer({
  templateId,
  collections,
  fileName,
  preview,
  loading,
  error,
  stale,
  applying,
  onRetry,
  onPickAnother,
  onApply,
  onClose
}: {
  templateId: string
  collections: string[]
  fileName: string
  preview: OwnerSheetPreview | null
  loading: boolean
  error: unknown
  stale: boolean
  applying: boolean
  onRetry: () => void
  onPickAnother: () => void
  onApply: () => void
  onClose: () => void
}) {
  const [trial, setTrial] = useState(false)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, applying])

  const blocked = !!preview && preview.errors > 0
  const canApply = !!preview && !blocked && !preview.nothing_to_do && !loading
  // A file with no owner rows and only file-level problems (none of the owner matrix columns,
  // a CSV export of something else) is the wrong file, not eight things to fix one by one.
  const wrongFile =
    !loading &&
    !!preview &&
    preview.rows === 0 &&
    preview.errors > 0 &&
    preview.problems.every((p) => p.row == null)
  const readFail =
    error != null
      ? readFailure(error, fileName)
      : wrongFile
        ? wrongFileDescription(fileName)
        : undefined
  // Nothing to apply at all: the file could not be used, or it matches the matrix. The footer
  // then offers only another file and Close.
  const failed = !loading && (error != null || wrongFile)
  const nothing = !loading && !failed && !!preview && preview.nothing_to_do && !blocked
  // Rows with a problem that stops Apply: their changes are shown as blocked, not as changes.
  const blockedRows = new Set(
    (preview?.problems ?? [])
      .filter((p) => p.severity === 'error' && p.row != null)
      .map((p) => p.row)
  )

  // Portal to body — the page-enter transform re-anchors position:fixed.
  return createPortal(
    <div className='fixed inset-0 z-[120]' data-owner-sheet-drawer>
      <button
        type='button'
        aria-label='Close'
        className='absolute inset-0 bg-black/30'
        onClick={() => !applying && onClose()}
      />
      <div
        role='dialog'
        aria-label='Review the uploaded owner matrix'
        className='absolute inset-y-0 right-0 flex w-full max-w-[760px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-border dark:bg-card'
      >
        <div className='flex shrink-0 items-center gap-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <FileSpreadsheet className='h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
          <div className='min-w-0'>
            <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Review the upload
            </h2>
            <p className='truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {fileName}
              {preview && !wrongFile ? ` · ${plural(preview.rows, 'row')}` : ''}
            </p>
          </div>
          <button
            type='button'
            aria-label='Close'
            onClick={onClose}
            disabled={applying}
            className='ml-auto rounded p-1 text-slate-400 hover:bg-muted hover:text-slate-700 dark:hover:text-slate-200'
          >
            <X className='h-4 w-4' />
          </button>
        </div>

        <div className='min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-4'>
          {loading && (
            <div className='flex items-center gap-2 py-10 text-[13px] text-slate-500 dark:text-muted-foreground'>
              <Loader2 className='h-4 w-4 animate-spin' />
              Reading {fileName} and comparing it with the owner matrix…
            </div>
          )}
          {!loading &&
            (error != null || wrongFile) &&
            (readFail ? (
              <div
                role='alert'
                data-owner-sheet-read-failure
                className='flex items-start gap-2.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2.5 dark:border-rose-900/60 dark:bg-rose-950/30'
              >
                <CircleAlert className='mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400' />
                <div className='min-w-0 space-y-0.5'>
                  <p className='text-[13px] font-semibold text-rose-900 dark:text-rose-100'>
                    {readFail.title}
                  </p>
                  {readFail.hint && (
                    <p className='text-[12.5px] text-rose-800 dark:text-rose-200/90'>
                      {readFail.hint}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <ErrorNotice
                error={error}
                fallback='Could not read the spreadsheet'
                onRetry={onRetry}
              />
            ))}
          {!loading && wrongFile && preview && (
            <details className='group text-[12px]' data-owner-sheet-wrong-file-details>
              <summary className='inline-flex cursor-pointer list-none items-center gap-1 rounded text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 dark:text-muted-foreground dark:hover:text-foreground [&::-webkit-details-marker]:hidden'>
                <ChevronDown className='h-3.5 w-3.5 -rotate-90 transition-transform group-open:rotate-0' />
                What the file is missing
              </summary>
              <div className='mt-2'>
                <Problems preview={preview} />
              </div>
            </details>
          )}
          {!loading && preview && !wrongFile && (
            <>
              {stale && (
                <div className='flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200'>
                  <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0' />
                  <span>
                    Someone changed the owner matrix after you uploaded. Nothing was applied — these
                    are the changes against the matrix as it is now.
                  </span>
                </div>
              )}
              {!preview.nothing_to_do && <Summary preview={preview} blockedRows={blockedRows} />}
              {preview.problems.length > 0 && <Problems preview={preview} />}
              {preview.nothing_to_do && preview.errors === 0 && (
                <p className='rounded-md border border-dashed border-slate-200 px-3 py-6 text-center text-[13px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                  This file matches the owner matrix — there is nothing to change.
                </p>
              )}
              {preview.steps.map((s) => (
                <StepSection key={s.state_id} step={s} blockedRows={blockedRows} />
              ))}
              {canApply && collections.length > 0 && (
                <div className='rounded-md border border-slate-200 dark:border-border'>
                  <button
                    type='button'
                    onClick={() => setTrial((v) => !v)}
                    aria-expanded={trial}
                    data-owner-sheet-trial
                    className='flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan'
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform dark:text-muted-foreground ${trial ? '' : '-rotate-90'}`}
                    />
                    <span className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                      Try a record with these changes
                    </span>
                    <span className='ml-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                      Who would own each step
                    </span>
                  </button>
                  {trial &&
                    (preview.draft_groups.length > 2000 ? (
                      <p className='border-t border-slate-200 px-3 py-2 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                        Too many groups change at once to try a record here.
                      </p>
                    ) : (
                      <div className='border-t border-slate-200 p-3 dark:border-border'>
                        <OwnerRecordTrial
                          templateId={templateId}
                          collections={collections}
                          draft={preview.draft_groups}
                        />
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className='flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 dark:border-border dark:bg-muted/30'>
          <p
            className='min-w-0 flex-1 text-[12px] text-slate-500 dark:text-muted-foreground'
            data-owner-sheet-footer
          >
            {loading
              ? 'Reading the file…'
              : failed
                ? 'Nothing was changed. Upload the workbook from Download as Excel.'
                : nothing
                  ? 'Nothing to apply — the owner matrix already matches this file.'
                  : blocked
                    ? `Fix ${plural(preview?.errors ?? 0, 'problem')} in the file, then upload it again.`
                    : 'Nothing changes until you press Apply.'}
            {!loading && !failed && !nothing && !blocked && (
              <span className='hidden sm:inline'>
                {' '}
                The matrix is saved as a version first, so it can be restored.
              </span>
            )}
          </p>
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12.5px]'
            onClick={onPickAnother}
            disabled={applying}
          >
            Upload another file
          </Button>
          {failed || nothing ? (
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12.5px]'
              onClick={onClose}
              data-owner-sheet-close
            >
              Close
            </Button>
          ) : (
            <Button
              size='sm'
              className='h-8 gap-1.5 bg-nvr-cyan text-[12.5px] text-white hover:bg-nvr-cyan/90 disabled:bg-slate-200 disabled:text-slate-500 disabled:opacity-100 dark:disabled:border dark:disabled:border-border dark:disabled:!bg-transparent dark:disabled:!text-slate-500'
              onClick={onApply}
              disabled={!canApply || applying}
              data-owner-sheet-apply
            >
              {applying && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
              Apply changes
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Whether a change comes from a row whose problem stops Apply. */
const isBlocked = (c: GroupChange, blockedRows: Set<number | null>) =>
  c.row != null && blockedRows.has(c.row)

function Summary({
  preview,
  blockedRows
}: {
  preview: OwnerSheetPreview
  blockedRows: Set<number | null>
}) {
  // The tiles count what an Apply would do: changes from rows waiting on a fix are left out
  // and named once under the tiles.
  const c = { ...preview.counts }
  let waiting = 0
  for (const step of preview.steps) {
    for (const ch of step.changes) {
      if (!isBlocked(ch, blockedRows)) continue
      waiting++
      if (ch.kind === 'added') c.groups_added--
      else if (ch.kind === 'removed') c.groups_removed--
      else c.groups_changed--
      c.people_added -= ch.people_added.length
      c.people_removed -= ch.people_removed.length
    }
  }
  for (const k of Object.keys(c) as Array<keyof typeof c>) c[k] = Math.max(0, c[k])
  const items: Array<{ n: number; label: string; tone: 'add' | 'remove' | 'change' | 'plain' }> = [
    {
      n: c.groups_added,
      label: c.groups_added === 1 ? 'group added' : 'groups added',
      tone: 'add'
    },
    {
      n: c.groups_removed,
      label: c.groups_removed === 1 ? 'group removed' : 'groups removed',
      tone: 'remove'
    },
    {
      n: c.groups_changed,
      label: c.groups_changed === 1 ? 'group changed' : 'groups changed',
      tone: 'change'
    },
    {
      n: c.people_added,
      label: c.people_added === 1 ? 'person added' : 'people added',
      tone: 'add'
    },
    {
      n: c.people_removed,
      label: c.people_removed === 1 ? 'person removed' : 'people removed',
      tone: 'remove'
    }
  ]
  const tone = {
    add: 'text-emerald-700 dark:text-emerald-400',
    remove: 'text-rose-700 dark:text-rose-400',
    change: 'text-amber-700 dark:text-amber-400',
    plain: 'text-slate-700 dark:text-foreground'
  }
  return (
    <div className='space-y-1'>
      <div className='flex flex-wrap gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {items.map((it) => (
          <div key={it.label} className='min-w-[104px] flex-1 bg-white px-3 py-2 dark:bg-card'>
            <div
              className={`text-[17px] font-semibold tabular-nums ${it.n ? tone[it.tone] : 'text-slate-300 dark:text-slate-600'}`}
            >
              {it.n}
            </div>
            <div className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {it.label}
            </div>
          </div>
        ))}
      </div>
      {waiting > 0 && (
        <p
          className='text-[11.5px] text-slate-500 dark:text-muted-foreground'
          data-owner-sheet-waiting
        >
          Not counted: {plural(waiting, 'group change')} waiting on a fix in the file.
        </p>
      )}
    </div>
  )
}

function Problems({ preview }: { preview: OwnerSheetPreview }) {
  return (
    <section aria-label='Problems'>
      <h3 className='mb-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
        {preview.errors > 0
          ? `${plural(preview.errors, 'problem')} to fix`
          : `${plural(preview.warnings, 'thing')} to check`}
        {preview.errors > 0 && preview.warnings > 0 && (
          <span className='font-normal text-slate-500 dark:text-muted-foreground'>
            {' '}
            · {plural(preview.warnings, 'warning')}
          </span>
        )}
      </h3>
      <ul className='divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 dark:divide-border dark:border-border'>
        {preview.problems.map((p, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: problems have no id and never reorder
            key={i}
            className='flex items-start gap-2 px-3 py-1.5 text-[12.5px]'
            data-severity={p.severity}
          >
            {p.severity === 'error' ? (
              <CircleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600 dark:text-rose-400' />
            ) : (
              <AlertTriangle className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
            )}
            <span className='w-[96px] shrink-0 leading-snug text-slate-500 tabular-nums dark:text-muted-foreground'>
              <span className='block whitespace-nowrap'>
                {p.row != null ? `Row ${p.row}` : 'File'}
              </span>
              {p.column && (
                <span className='block truncate text-[11px]' data-tip={p.column}>
                  {p.column}
                </span>
              )}
            </span>
            <span className='min-w-0 leading-snug text-slate-700 dark:text-foreground'>
              {p.message}
            </span>
          </li>
        ))}
        {preview.problems_hidden > 0 && (
          <li className='px-3 py-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            …and {preview.problems_hidden} more
          </li>
        )}
      </ul>
    </section>
  )
}

const KIND = {
  added: {
    label: 'Added',
    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/60'
  },
  removed: {
    label: 'Removed',
    cls: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800/60'
  },
  changed: {
    label: 'Changed',
    cls: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:ring-amber-800/60'
  }
} as const

const FIELD_WORD = { step: 'Step', name: 'Name', default: 'Default', priority: 'Priority' }

function StepSection({
  step,
  blockedRows
}: {
  step: StepChanges
  blockedRows: Set<number | null>
}) {
  // +N / −N count only what an Apply would do; changes waiting on a fix are named apart.
  let added = step.people_added
  let removed = step.people_removed
  let waiting = 0
  for (const ch of step.changes) {
    if (!isBlocked(ch, blockedRows)) continue
    waiting++
    added -= ch.people_added.length
    removed -= ch.people_removed.length
  }
  return (
    <section aria-label={step.state_label}>
      <div className='mb-1.5 flex items-baseline gap-2'>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          {step.state_label}
        </h3>
        <span className='text-[11.5px] text-slate-500 tabular-nums dark:text-muted-foreground'>
          {[
            step.changes.length > waiting ? plural(step.changes.length - waiting, 'group') : '',
            added > 0 ? `+${added}` : '',
            removed > 0 ? `−${removed}` : '',
            waiting > 0 ? `${waiting} waiting on a fix` : ''
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <ul className='divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200 dark:divide-border dark:border-border'>
        {step.changes.map((c) => (
          <ChangeRow
            key={`${c.group_id ?? ''}:${c.row ?? ''}`}
            change={c}
            blocked={isBlocked(c, blockedRows)}
          />
        ))}
      </ul>
    </section>
  )
}

function ChangeRow({ change: c, blocked = false }: { change: GroupChange; blocked?: boolean }) {
  const k = KIND[c.kind]
  return (
    <li
      className={`space-y-1.5 px-3 py-2 ${blocked ? 'bg-slate-50 opacity-70 dark:bg-muted/30' : ''}`}
      data-change-kind={c.kind}
      data-change-blocked={blocked || undefined}
    >
      <div className='flex flex-wrap items-center gap-2'>
        {blocked ? (
          <span className='inline-flex items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-inset ring-rose-200 dark:text-rose-300 dark:ring-rose-800/60'>
            <CircleAlert className='h-3 w-3' />
            Fix row {c.row} first
          </span>
        ) : (
          <span
            className={`rounded px-1.5 py-px text-[10.5px] font-semibold uppercase tracking-wide ring-1 ring-inset ${k.cls}`}
          >
            {k.label}
          </span>
        )}
        <span className='min-w-0 text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
          {c.label}
        </span>
        {c.row != null && (
          <span className='ml-auto text-[11px] text-slate-400 tabular-nums'>row {c.row}</span>
        )}
      </div>
      {c.fields.length > 0 && (
        <div className='flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
          {c.fields.map((f) => (
            <span key={f.field}>
              {FIELD_WORD[f.field]}:{' '}
              <span className='line-through decoration-slate-400'>{f.before || '—'}</span> →{' '}
              <span className='text-slate-800 dark:text-foreground'>{f.after || '—'}</span>
            </span>
          ))}
        </div>
      )}
      {c.kind === 'changed' && c.filters_after.length + c.filters_before.length > 0 && (
        <ValueDiff before={c.filters_before} after={c.filters_after} />
      )}
      {c.kind === 'added' && c.filters_after.length > c.label.split(' · ').length && (
        <div className='text-[12px] text-slate-600 dark:text-muted-foreground'>
          {c.filters_after.join(' · ')}
        </div>
      )}
      {(c.people_added.length > 0 ||
        c.people_removed.length > 0 ||
        c.teams_added.length > 0 ||
        c.teams_removed.length > 0) && (
        <div className='flex flex-wrap gap-1'>
          {c.people_added.map((p) => (
            <Chip key={`+${p.id}`} add title={p.email ?? undefined}>
              {p.name}
            </Chip>
          ))}
          {c.teams_added.map((t) => (
            <Chip key={`+t${t.id}`} add>
              Team {t.name}
            </Chip>
          ))}
          {c.people_removed.map((p) => (
            <Chip key={`-${p.id}`} title={p.email ?? undefined}>
              {p.name}
            </Chip>
          ))}
          {c.teams_removed.map((t) => (
            <Chip key={`-t${t.id}`}>Team {t.name}</Chip>
          ))}
        </div>
      )}
    </li>
  )
}

/** Only the values that differ: "Region: KEY → Region: BLT". */
function ValueDiff({ before, after }: { before: string[]; after: string[] }) {
  const gone = before.filter((v) => !after.includes(v))
  const added = after.filter((v) => !before.includes(v))
  return (
    <div className='flex flex-wrap items-baseline gap-x-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
      <span>Values:</span>
      {gone.length > 0 && (
        <span className='line-through decoration-slate-400'>{gone.join(' · ')}</span>
      )}
      {gone.length > 0 && added.length > 0 && <span aria-hidden>→</span>}
      {added.length > 0 && (
        <span className='text-slate-800 dark:text-foreground'>{added.join(' · ')}</span>
      )}
      {after.length === 0 && (
        <span className='text-slate-800 dark:text-foreground'>any record</span>
      )}
    </div>
  )
}

function Chip({
  add = false,
  title,
  children
}: {
  add?: boolean
  title?: string
  children: React.ReactNode
}) {
  return (
    <span
      data-tip={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] ring-1 ring-inset ${
        add
          ? 'bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:ring-emerald-800/60'
          : 'bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950/40 dark:text-rose-300 dark:ring-rose-800/60'
      }`}
    >
      {add ? <Plus className='h-3 w-3' /> : <Minus className='h-3 w-3' />}
      {children}
    </span>
  )
}
