import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Clock,
  Download,
  File,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Loader2,
  Plus,
  Upload,
  X
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useApiFetchConfig, useGridFlush, useNivaroClient, useParentDraft } from '../../context'
import { useFileHealth } from '../../hooks/useFileHealth'
import { del, get, post } from '../../lib/commands'
import { trackedUpload } from '../../lib/upload-presence'
import { cn, formatDateTime } from '../../lib/utils'
import { FileDownloadCount, useFileDownloadStats } from './FileDownloadCount'
import { FileUsageChip, useFileUsage, useOnceVisible } from './FileUsage'
import { useFileDownload } from './file-download'
import {
  noteOwnFileChange,
  OWN_FILE_CHANGE_MS,
  REMOVED_FADE_MS,
  REMOVED_SHOW_MS,
  lastWriterName,
  RemovedFileRow,
  useLiveFileList
} from './file-live'
import {
  chipThumbUrl,
  FileProcessingBadge,
  FileProcessingTile,
  useFileProcessing
} from './file-processing'
import { liveRecordWrite } from './live-record-marks'
import { useM2MStaging } from './M2MStagingContext'
import { RemoteUploadRows } from './RemoteUploads'
import type { CMSRelation } from './types'

/** The name a file shows by: its title, with the stored file's extension when the title lacks one
 *  ("Quote" → "Quote.pdf"), else the stored name. Client-side only (b01-N11). */
export function fileDisplayName(
  file: { title?: string | null; filename_download?: string | null } | null | undefined
): string {
  const title = (file?.title ?? '').trim()
  const stored = (file?.filename_download ?? '').trim()
  if (!title) return stored
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(stored)?.[1]
  if (!ext) return title
  return new RegExp(`\\.${ext}$`, 'i').test(title) ? title : `${title}.${ext}`
}

interface NivaroFile {
  id: string
  filename_download: string
  missing_at?: string | null
  title: string | null
  type: string | null
  filesize: number | null
  width: number | null
  height: number | null
  uploaded_on: string | null
  uploaded_by_name: string | null
}

function fmtSize(bytes: number | null) {
  if (!bytes) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** One date-time format app-wide ("Jun 8, 2026, 8:19 AM"), honouring the display zone. */
function fmtDate(iso: string | null) {
  return iso ? formatDateTime(iso) : null
}

function isImage(type: string | null) {
  return !!type && type.startsWith('image/')
}

/** A file's kind in words people use ("PDF", "Spreadsheet") — never a raw MIME type. */
export function friendlyFileType(type: string | null | undefined, name?: string | null): string {
  const t = (type ?? '').toLowerCase()
  const ext = (name ?? '').split('.').pop()?.toUpperCase() ?? ''
  if (t === 'application/pdf') return 'PDF'
  if (t === 'text/csv') return 'CSV'
  if (t.includes('spreadsheet') || t.includes('excel')) return 'Spreadsheet'
  if (t.includes('wordprocessing') || t.includes('msword')) return 'Word document'
  if (t.includes('presentation') || t.includes('powerpoint')) return 'Presentation'
  if (t.startsWith('image/')) return `Image${ext && name?.includes('.') ? ` (${ext})` : ''}`
  if (t.startsWith('video/')) return 'Video'
  if (t.startsWith('audio/')) return 'Audio'
  if (t.includes('zip') || t.includes('compressed')) return 'ZIP archive'
  if (t === 'text/plain') return 'Text'
  if (t.includes('json')) return 'JSON'
  if (t.includes('xml')) return 'XML'
  if (ext && ext.length <= 5 && name?.includes('.')) return ext
  return 'File'
}

/** The tile behind a file's icon: a quiet tint per kind, with a dark partner. */
function fileTileTone(type: string | null): string {
  const t = (type ?? '').toLowerCase()
  if (t === 'application/pdf') return 'bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300'
  if (t.includes('spreadsheet') || t.includes('excel') || t === 'text/csv')
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  if (t.includes('wordprocessing') || t.includes('msword'))
    return 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300'
  return 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-300'
}

function fileIcon(type: string | null, cls: string) {
  if (!type) return <File className={cls} strokeWidth={1.5} />
  if (type.startsWith('video/')) return <FileVideo className={cls} strokeWidth={1.5} />
  if (type.startsWith('audio/')) return <FileAudio className={cls} strokeWidth={1.5} />
  if (type === 'application/pdf') return <FileText className={cls} strokeWidth={1.5} />
  if (type.startsWith('text/')) return <FileText className={cls} strokeWidth={1.5} />
  if (type.includes('spreadsheet') || type.includes('excel') || type === 'text/csv')
    return <FileSpreadsheet className={cls} strokeWidth={1.5} />
  if (type.includes('wordprocessing') || type.includes('msword'))
    return <FileText className={cls} strokeWidth={1.5} />
  if (
    type.includes('json') ||
    type.includes('javascript') ||
    type.includes('typescript') ||
    type.includes('xml')
  )
    return <FileCode className={cls} strokeWidth={1.5} />
  return <File className={cls} strokeWidth={1.5} />
}

function FileThumb({
  url,
  type,
  filename,
  size = 'md',
  processing = false
}: {
  url: string
  type: string | null
  filename: string
  size?: 'sm' | 'md' | 'lg'
  /** rt3 #17 — the thumbnail is still being made: a quiet tile until it is ready. */
  processing?: boolean
}) {
  const dim = size === 'sm' ? 'h-10 w-10' : size === 'lg' ? 'h-20 w-20' : 'h-14 w-14'
  // The small rendition the server prepares after upload; the original if that fails.
  const [thumbFailed, setThumbFailed] = useState(false)
  if (isImage(type) && processing) return <FileProcessingTile className={dim} />
  if (isImage(type)) {
    return (
      <img
        src={thumbFailed ? url : chipThumbUrl(url)}
        alt={filename}
        data-file-thumb
        className={cn(dim, 'object-cover rounded shrink-0')}
        loading='lazy'
        onError={(e) => {
          if (!thumbFailed && chipThumbUrl(url) !== url) {
            setThumbFailed(true)
            return
          }
          ;(e.target as HTMLImageElement).style.display = 'none'
        }}
      />
    )
  }
  return (
    <div
      className={cn(dim, 'flex items-center justify-center rounded shrink-0', fileTileTone(type))}
    >
      {fileIcon(type, size === 'sm' ? 'h-4 w-4' : 'h-6 w-6')}
    </div>
  )
}

function FileBrowserPanel({
  selected,
  multi,
  onSelect,
  onClose,
  getUrl
}: {
  selected: string[]
  multi: boolean
  onSelect: (id: string) => void
  onClose: () => void
  getUrl: (id: string) => string
}) {
  const client = useNivaroClient()
  const [search, setSearch] = useState('')

  const { data: files = [], isLoading } = useQuery<NivaroFile[]>({
    queryKey: ['file-browser', search],
    queryFn: () =>
      client
        .request<{ data: NivaroFile[] }>(
          get('/files', {
            limit: '60',
            sort: '-uploaded_on',
            fields: 'id,filename_download,title,type,filesize,width,height,missing_at',
            ...(search ? { search } : {})
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })

  return (
    <div className='flex flex-col' style={{ width: 480, maxHeight: 420 }}>
      <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 shrink-0'>
        <p className='text-[12px] font-medium text-slate-700'>Select file{multi ? 's' : ''}</p>
        <button
          type='button'
          aria-label='Close'
          onClick={onClose}
          className='text-slate-400 hover:text-slate-600'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='px-3 pt-2 pb-1 shrink-0'>
        <input
          type='text'
          placeholder='Search files…'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='w-full h-7 rounded border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
          autoFocus
        />
      </div>
      <div className='overflow-y-auto flex-1 p-3'>
        {isLoading && (
          <div className='flex justify-center py-6'>
            <Loader2 className='h-5 w-5 animate-spin text-slate-300' />
          </div>
        )}
        {!isLoading && files.length === 0 && (
          <p className='text-center text-[12px] text-slate-400 py-6'>No files found</p>
        )}
        {!isLoading && files.length > 0 && (
          <div className='grid grid-cols-5 gap-2'>
            {files.map((f) => {
              const isSel = selected.includes(f.id)
              return (
                <button
                  key={f.id}
                  type='button'
                  onClick={() => onSelect(f.id)}
                  className={cn(
                    'nvr-rise-in group flex flex-col items-center gap-1 rounded-lg p-1.5 text-left transition-colors border',
                    isSel
                      ? 'border-nvr-cyan bg-nvr-cyan/5'
                      : 'border-transparent hover:border-slate-200 hover:bg-slate-50'
                  )}
                >
                  <div className='relative'>
                    <FileThumb
                      url={getUrl(f.id)}
                      type={f.type}
                      filename={f.filename_download}
                      size='md'
                    />
                    {isSel && (
                      <div className='absolute inset-0 flex items-center justify-center rounded bg-nvr-cyan/20'>
                        <div className='h-4 w-4 rounded-full bg-nvr-cyan flex items-center justify-center'>
                          <svg
                            className='h-2.5 w-2.5 text-white'
                            fill='none'
                            stroke='currentColor'
                            viewBox='0 0 24 24'
                          >
                            <path
                              strokeLinecap='round'
                              strokeLinejoin='round'
                              strokeWidth={3}
                              d='M5 13l4 4L19 7'
                            />
                          </svg>
                        </div>
                      </div>
                    )}
                  </div>
                  <span
                    data-file-name
                    className='text-[10px] text-slate-500 truncate w-full text-center leading-tight'
                  >
                    {fileDisplayName(f)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Single file (M2O → nivaro_files) ────────────────────────────────────────

export function FilePickerField({
  field,
  value,
  onChange,
  disabled,
  allowUpload = true,
  allowPick = true,
  showUsage = true,
  showDownloads = true
}: {
  /** The record field this picker edits — names the field co-viewers see an upload go into. */
  field?: string
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  allowUpload?: boolean
  allowPick?: boolean
  /** The "used in" chip (layout `file_used_in`, on by default). */
  showUsage?: boolean
  /** The download count, administrators only (layout `file_downloads`, on by default). */
  showDownloads?: boolean
}) {
  const client = useNivaroClient()
  const uploadCfg = useApiFetchConfig()
  const qc = useQueryClient()
  const flush = useGridFlush()
  const flushKey = useId()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const fileId = !pendingFile && value ? String(value) : null
  const getUrl = (id: string) => client.fileUrl(id)
  const downloadClick = useFileDownload()

  // #1288 — what carried this file on the record (addendum / push / email /
  // generated). Read once the chip is on screen; never on a new record.
  const parentDraft = useParentDraft()
  const recordId = parentDraft?.draft?.id != null ? String(parentDraft.draft.id) : null
  // rt3 #17 — "Processing…" while a new file's thumbnail / text is made.
  const processing = useFileProcessing(fileId ? [fileId] : [], {
    collection: parentDraft?.collection,
    itemId: recordId
  })
  const [usageRef, usageVisible] = useOnceVisible<HTMLDivElement>(!!fileId)
  const usage = useFileUsage(
    parentDraft?.collection,
    recordId,
    fileId ? [fileId] : [],
    usageVisible && showUsage
  )
  const downloads = useFileDownloadStats(
    parentDraft?.collection,
    recordId,
    fileId ? [fileId] : [],
    usageVisible && showDownloads
  )

  // manage object URL lifecycle
  useEffect(() => {
    if (!pendingFile) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(pendingFile)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [pendingFile])

  // register/unregister flush callback when a pending file exists
  useEffect(() => {
    if (!flush || !pendingFile) return
    flush.register(flushKey, async () => {
      const result = await client.upload(pendingFile)
      onChange(result.id)
      setPendingFile(null)
      qc.invalidateQueries({ queryKey: ['file-browser'] })
    })
    return () => flush.unregister(flushKey)
  }, [flush, pendingFile, flushKey, client, onChange, qc])

  // Auto-check on load: re-verify the referenced file against storage so a
  // dead link shows immediately, not after the nightly sweep.
  const health = useFileHealth([fileId])
  const { data: file, isLoading } = useQuery<NivaroFile | null>({
    queryKey: ['file-meta', fileId],
    queryFn: () =>
      client
        .request<{ data: NivaroFile }>(get(`/files/${fileId}/meta`))
        .then((r) => r.data ?? null),
    enabled: !!fileId,
    staleTime: 60_000
  })

  // Realtime 3: the value moved because someone else changed the record (a live write mark for
  // this record, and not this person's own pick) — the new file fades in; a removed one stays
  // a moment as a quiet "Removed" row.
  const ownPickAt = useRef(0)
  const prevFileId = useRef(fileId)
  const lastName = useRef<string | null>(null)
  const [freshFile, setFreshFile] = useState(false)
  const [removed, setRemoved] = useState<{ name: string; leaving: boolean } | null>(null)
  const liveTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  if (file) lastName.current = fileDisplayName(file) || lastName.current
  // biome-ignore lint/correctness/useExhaustiveDependencies: reacts to the value only
  useEffect(() => {
    const prev = prevFileId.current
    prevFileId.current = fileId
    if (prev === fileId || pendingFile) return
    const own = Date.now() - ownPickAt.current < OWN_FILE_CHANGE_MS
    const coll = parentDraft?.collection
    if (own || !coll || !recordId || !liveRecordWrite(coll, recordId)) return
    const later = (fn: () => void, ms: number) => liveTimers.current.push(setTimeout(fn, ms))
    if (fileId) {
      setRemoved(null)
      setFreshFile(true)
      later(() => setFreshFile(false), 2000)
    } else if (prev) {
      setRemoved({ name: lastName.current ?? 'A file', leaving: false })
      later(
        () => setRemoved((r) => (r ? { ...r, leaving: true } : r)),
        REMOVED_SHOW_MS - REMOVED_FADE_MS
      )
      later(() => setRemoved(null), REMOVED_SHOW_MS)
    }
  }, [fileId])
  useEffect(() => {
    const timers = liveTimers.current
    return () => {
      for (const t of timers) clearTimeout(t)
    }
  }, [])

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (uploadRef.current) uploadRef.current.value = ''
    ownPickAt.current = Date.now()
    if (flush) {
      setPendingFile(f)
    } else {
      setUploading(true)
      setUploadPct(null)
      try {
        // rt9 #9: co-viewers see "Beth is uploading quote.pdf (60%)" on this field.
        const result = await trackedUpload(f, {
          cfg: uploadCfg,
          fallback: (file) => client.upload(file),
          field,
          collection: parentDraft?.collection,
          item: recordId ?? undefined,
          onProgress: setUploadPct
        })
        onChange(result.id)
        qc.invalidateQueries({ queryKey: ['file-browser'] })
      } catch {
        /* ignore */
      } finally {
        setUploading(false)
        setUploadPct(null)
      }
    }
  }

  function handlePickExisting(id: string) {
    ownPickAt.current = Date.now()
    setPendingFile(null)
    onChange(id)
    setOpen(false)
  }

  function handleRemove() {
    ownPickAt.current = Date.now()
    setPendingFile(null)
    onChange(null)
  }

  const hasPending = !!pendingFile
  const hasFile = hasPending || !!fileId

  return (
    <div className='relative'>
      {!hasFile && removed && (
        <div className='mb-1.5'>
          <RemovedFileRow
            name={removed.name}
            leaving={removed.leaving}
            by={lastWriterName(
              qc.getQueryData(['last-touch', parentDraft?.collection, String(recordId)])
            )}
          />
        </div>
      )}
      {hasFile ? (
        <div
          ref={usageRef}
          key={fileId ?? 'pending'}
          data-file-fresh={freshFile ? '' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-lg border border-slate-200 p-2 bg-slate-50 dark:border-border dark:bg-white/[0.03]',
            freshFile && 'nvr-row-enter'
          )}
        >
          {hasPending ? (
            <FileThumb
              url={previewUrl ?? ''}
              type={pendingFile!.type || null}
              filename={pendingFile!.name}
              size='sm'
            />
          ) : isLoading ? (
            <div className='h-10 w-10 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))] animate-pulse' />
          ) : (
            // Every file click downloads (2026-11-08): no in-app preview.
            <a
              href={`${getUrl(fileId!)}?download=1`}
              download={file?.filename_download || true}
              onClick={downloadClick(`${getUrl(fileId!)}?download=1`, file?.filename_download)}
              title='Download'
              className='shrink-0'
            >
              <FileThumb
                url={getUrl(fileId!)}
                type={file?.type ?? null}
                filename={file?.filename_download ?? ''}
                size='sm'
                processing={!!fileId && processing.isProcessing(fileId)}
              />
            </a>
          )}
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-1'>
              {!hasPending && !!fileId && processing.isProcessing(fileId) && (
                <FileProcessingBadge />
              )}
              {hasPending && <Clock className='h-3 w-3 text-amber-400 shrink-0' />}
              <p
                data-file-name
                className='text-[12px] font-medium text-slate-700 truncate dark:text-slate-100'
              >
                {hasPending ? pendingFile!.name : fileDisplayName(file) || fileId}
              </p>
              {/* Dead link: the row exists but the bytes are gone — stamped by
                  the file-integrity sweep / verify route. */}
              {!hasPending && (health.verdict(fileId) ?? !!file?.missing_at) && (
                <span
                  className='shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                  title='The stored file is missing from storage — downloading or previewing will fail. Re-upload it.'
                >
                  file missing
                </span>
              )}
            </div>
            <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
              {hasPending ? (
                <>
                  {pendingFile!.type && (
                    <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                      {friendlyFileType(pendingFile!.type, pendingFile!.name)}
                    </span>
                  )}
                  <span className='text-[10px] text-slate-400'>{fmtSize(pendingFile!.size)}</span>
                  <span className='text-[10px] text-amber-500'>Pending upload</span>
                </>
              ) : (
                <>
                  {file?.type && (
                    <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                      {friendlyFileType(file.type, file.filename_download)}
                    </span>
                  )}
                  {file?.filesize != null && (
                    <span className='text-[10px] text-slate-400'>{fmtSize(file.filesize)}</span>
                  )}
                  {file?.uploaded_on && (
                    <span className='text-[10px] text-slate-400'>{fmtDate(file.uploaded_on)}</span>
                  )}
                  {file?.uploaded_by_name && (
                    <span className='text-[10px] text-slate-500'>by {file.uploaded_by_name}</span>
                  )}
                </>
              )}
            </div>
          </div>
          {showUsage && !hasPending && fileId && (
            <FileUsageChip
              fileId={fileId}
              uses={usage.data?.[fileId]}
              loading={usage.isLoading}
              collection={parentDraft?.collection}
              itemId={recordId}
            />
          )}
          {showDownloads && !hasPending && fileId && (
            <FileDownloadCount fileId={fileId} stat={downloads.data?.[fileId]} />
          )}
          {!hasPending && fileId && (
            <a
              href={`${getUrl(fileId)}?download=1`}
              onClick={downloadClick(`${getUrl(fileId)}?download=1`, file?.filename_download)}
              title='Download'
              className='shrink-0 text-slate-400 hover:text-nvr-cyan p-0.5'
            >
              <Download className='h-3.5 w-3.5' />
            </a>
          )}
          {!disabled && (
            <div className='flex items-center gap-1 shrink-0'>
              {allowPick && (
                <button
                  type='button'
                  onClick={() => setOpen(true)}
                  className='h-6 px-2 rounded border border-slate-200 text-[11px] text-slate-600 hover:border-slate-400'
                >
                  Replace
                </button>
              )}
              {allowUpload && (
                <>
                  <button
                    type='button'
                    onClick={() => uploadRef.current?.click()}
                    disabled={uploading}
                    className='h-6 px-2 rounded border border-slate-200 text-[11px] text-slate-600 hover:border-slate-400 disabled:opacity-40 flex items-center gap-1'
                  >
                    {uploading ? (
                      <Loader2 className='h-3 w-3 animate-spin' />
                    ) : (
                      <Upload className='h-3 w-3' />
                    )}
                    <span className='tabular-nums'>
                      {uploading && uploadPct != null ? `${uploadPct}%` : 'Upload'}
                    </span>
                  </button>
                  <input ref={uploadRef} type='file' className='hidden' onChange={handleUpload} />
                </>
              )}
              <button
                type='button'
                aria-label='Remove file'
                onClick={handleRemove}
                className='text-slate-300 hover:text-red-400 p-0.5'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className='flex items-center gap-2'>
          {allowPick && (
            <button
              type='button'
              disabled={disabled}
              onClick={() => setOpen(true)}
              className='flex h-9 flex-1 items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 dark:border-border dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200 disabled:opacity-40 transition-colors'
            >
              Select file…
            </button>
          )}
          {allowUpload && !disabled && (
            <>
              <button
                type='button'
                onClick={() => uploadRef.current?.click()}
                disabled={uploading}
                className='flex h-9 items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 dark:border-border dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200 disabled:opacity-40 transition-colors'
              >
                {uploading ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Upload className='h-3.5 w-3.5' />
                )}
                <span className='tabular-nums'>
                  {uploading && uploadPct != null ? `${uploadPct}%` : 'Upload'}
                </span>
              </button>
              <input ref={uploadRef} type='file' className='hidden' onChange={handleUpload} />
            </>
          )}
        </div>
      )}
      <RemoteUploadRows collection={parentDraft?.collection} item={recordId} field={field} />

      {open && (
        <div
          className='absolute z-50 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'
          style={{ minWidth: 480 }}
        >
          <FileBrowserPanel
            selected={fileId ? [fileId] : []}
            multi={false}
            onSelect={handlePickExisting}
            onClose={() => setOpen(false)}
            getUrl={getUrl}
          />
        </div>
      )}
    </div>
  )
}

// ─── Multi-file (M2M → nivaro_files) ─────────────────────────────────────────

export function FileM2MField({
  relation,
  parentId,
  allRelations: _allRelations,
  disabled,
  allowUpload = true,
  allowPick = true,
  pendingSave = false,
  showUsage = true,
  showDownloads = true
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  disabled?: boolean
  allowUpload?: boolean
  allowPick?: boolean
  pendingSave?: boolean
  /** The "used in" chip (layout `file_used_in`, on by default). */
  showUsage?: boolean
  /** The download count, administrators only (layout `file_downloads`, on by default). */
  showDownloads?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const flush = useGridFlush()
  const flushKey = useId()
  const pendingSaveFlushKey = useId()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const uploadCfg = useApiFetchConfig()
  const [uploadPct, setUploadPct] = useState<number | null>(null)
  const [pendingFiles, setPendingFiles] = useState<{ file: File; url: string }[]>([])
  const uploadRef = useRef<HTMLInputElement>(null)
  // pending-save mode: track local adds/removes without hitting API until parent saves
  const [localAdds, setLocalAdds] = useState<string[]>([])
  const [localRemovals, setLocalRemovals] = useState<Set<string>>(new Set())
  // Realtime 3: this person's own adds/removes (no fade, no "Removed" row for them).
  const ownFiles = useRef(new Map<string, number>())
  // Last known names, so a file someone else removed still reads by name for a moment.
  const knownNames = useRef(new Map<string, string>())

  const junctionField = relation.junction_field ?? ''
  const manyField = relation.many_field ?? ''
  const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`
  const isNew = parentId === 'new'
  const getUrl = (id: string) => client.fileUrl(id)
  const downloadClick = useFileDownload()

  // cleanup pending object URLs on unmount
  useEffect(() => {
    return () => {
      setPendingFiles((prev) => {
        prev.forEach((pf) => URL.revokeObjectURL(pf.url))
        return []
      })
    }
  }, [])

  // register/unregister flush callback when pending files exist (non-pending-save mode)
  useEffect(() => {
    if (!flush || !pendingFiles.length || pendingSave) return
    const snapshot = pendingFiles
    flush.register(flushKey, async () => {
      for (const pf of snapshot) {
        const result = await client.upload(pf.file)
        URL.revokeObjectURL(pf.url)
        await addFile(result.id)
      }
      setPendingFiles([])
      qc.invalidateQueries({ queryKey: ['file-browser'] })
    })
    return () => flush.unregister(flushKey)
  }, [flush, pendingFiles, flushKey, pendingSave]) // eslint-disable-line react-hooks/exhaustive-deps

  // pending-save mode: commit all local adds/removes + pending uploads on parent form save
  useEffect(() => {
    if (!flush || !pendingSave) return
    const hasWork = localAdds.length > 0 || localRemovals.size > 0 || pendingFiles.length > 0
    if (!hasWork) {
      flush.unregister(pendingSaveFlushKey)
      return
    }
    const snapshotAdds = localAdds
    const snapshotRemovals = new Set(localRemovals)
    const snapshotPending = pendingFiles
    flush.register(pendingSaveFlushKey, async () => {
      // upload pending files first, collect IDs
      const uploadedIds: string[] = []
      for (const pf of snapshotPending) {
        const result = await client.upload(pf.file)
        URL.revokeObjectURL(pf.url)
        uploadedIds.push(result.id)
      }
      // commit adds
      for (const fileId of [...snapshotAdds, ...uploadedIds]) {
        noteOwnFileChange(ownFiles, fileId)
        await client.request(
          post(`/items/${relation.many_collection}`, {
            [manyField]: parentId,
            [junctionField]: fileId
          })
        )
      }
      // commit removes
      for (const fileId of snapshotRemovals) {
        noteOwnFileChange(ownFiles, fileId)
        const junction = junctionItems.find((j) => String(j[junctionField]) === fileId)
        if (junction?.id) {
          await client.request(del(`/items/${relation.many_collection}/${junction.id}`))
        }
      }
      setLocalAdds([])
      setLocalRemovals(new Set())
      setPendingFiles([])
      qc.invalidateQueries({
        queryKey: ['m2m-items', relation.many_collection, manyField, parentId]
      })
      qc.invalidateQueries({ queryKey: ['file-browser'] })
    })
    return () => flush.unregister(pendingSaveFlushKey)
  }, [flush, pendingSave, localAdds, localRemovals, pendingFiles, pendingSaveFlushKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: junctionItems = [], isFetched: junctionFetched } = useQuery<
    Record<string, unknown>[]
  >({
    queryKey: ['m2m-items', relation.many_collection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: '200',
            fields: `id,${junctionField}`
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!parentId && !isNew,
    staleTime: 30_000
  })

  const stagedLinks = isNew && staging ? (staging.getStagedLinks(stagingKey) as string[]) : []
  const committedIds = junctionItems.map((j) => String(j[junctionField]))
  const allFileIds = isNew
    ? stagedLinks
    : pendingSave
      ? [...committedIds.filter((id) => !localRemovals.has(id)), ...localAdds]
      : committedIds
  // Someone else's file arriving fades in; one they removed stays a moment as "Removed".
  const live = useLiveFileList(isNew || !junctionFetched ? null : committedIds, ownFiles)

  // #1288 — what carried each committed file on the record; one read for the
  // whole list once the rows are on screen, never on a new record.
  const parentDraft = useParentDraft()
  // The record's collection: the edit form's draft knows it; the read view (Summary)
  // has no draft, so fall back to the relation's own parent side — otherwise the
  // "used in" and download chips never load there.
  const ownerCollection = parentDraft?.collection ?? relation.one_collection ?? null
  // rt3 #17 — "Processing…" while a new file's thumbnail / text is made; updates in place.
  const processing = useFileProcessing(isNew ? [] : committedIds, {
    collection: ownerCollection,
    itemId: isNew ? null : parentId
  })
  const [usageRef, usageVisible] = useOnceVisible<HTMLDivElement>(committedIds.length > 0)
  const usage = useFileUsage(
    ownerCollection,
    isNew ? null : parentId,
    committedIds,
    usageVisible && showUsage
  )
  const downloads = useFileDownloadStats(
    ownerCollection,
    isNew ? null : parentId,
    committedIds,
    usageVisible && showDownloads
  )

  // Auto-check on load — live storage verdict beats the stored stamp.
  const health = useFileHealth(allFileIds)
  const { data: filesMap = {} } = useQuery<Record<string, NivaroFile>>({
    queryKey: ['files-meta', ...allFileIds.sort()],
    queryFn: async () => {
      if (!allFileIds.length) return {}
      const data = await client
        .request<{ data: NivaroFile[] }>(
          get('/files', {
            filter: JSON.stringify({ id: { _in: allFileIds } }),
            limit: String(allFileIds.length),
            fields:
              'id,filename_download,title,type,filesize,uploaded_on,uploaded_by_name,missing_at'
          })
        )
        .then((r) => r.data ?? [])
      const map: Record<string, NivaroFile> = {}
      for (const f of data) map[f.id] = f
      return map
    },
    enabled: allFileIds.length > 0,
    staleTime: 60_000,
    // A changed id list keeps the names already known on screen while the new read runs.
    placeholderData: (prev) => prev
  })
  for (const [id, f] of Object.entries(filesMap)) {
    const name = fileDisplayName(f)
    if (name) knownNames.current.set(id.toLowerCase(), name)
  }
  const removedRows = live.removed.filter(
    (id) => !allFileIds.some((a) => a.toLowerCase() === id.toLowerCase())
  )

  async function removeFile(fileId: string) {
    noteOwnFileChange(ownFiles, fileId)
    if (isNew && staging) {
      staging.unstageLink(stagingKey, fileId)
      return
    }
    if (pendingSave) {
      if (localAdds.includes(fileId)) {
        setLocalAdds((prev) => prev.filter((id) => id !== fileId))
      } else {
        setLocalRemovals((prev) => new Set([...prev, fileId]))
      }
      return
    }
    const junction = junctionItems.find((j) => String(j[junctionField]) === fileId)
    if (!junction?.id) return
    await client.request(del(`/items/${relation.many_collection}/${junction.id}`))
    qc.invalidateQueries({ queryKey: ['m2m-items', relation.many_collection, manyField, parentId] })
  }

  async function addFile(fileId: string) {
    if (allFileIds.includes(fileId)) return
    noteOwnFileChange(ownFiles, fileId)
    if (isNew && staging) {
      staging.stageLink(stagingKey, fileId)
      return
    }
    if (pendingSave) {
      setLocalAdds((prev) => (prev.includes(fileId) ? prev : [...prev, fileId]))
      return
    }
    await client.request(
      post(`/items/${relation.many_collection}`, { [manyField]: parentId, [junctionField]: fileId })
    )
    qc.invalidateQueries({ queryKey: ['m2m-items', relation.many_collection, manyField, parentId] })
  }

  function removePending(url: string) {
    URL.revokeObjectURL(url)
    setPendingFiles((prev) => prev.filter((pf) => pf.url !== url))
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    if (uploadRef.current) uploadRef.current.value = ''
    if (flush) {
      const newPending = files.map((f) => ({ file: f, url: URL.createObjectURL(f) }))
      setPendingFiles((prev) => [...prev, ...newPending])
    } else {
      setUploading(true)
      try {
        for (const f of files) {
          setUploadPct(null)
          // rt9 #9: co-viewers see each file going in, by name only if they may read this field.
          const result = await trackedUpload(f, {
            cfg: uploadCfg,
            fallback: (file) => client.upload(file),
            field: relation.one_field ?? undefined,
            collection: relation.one_collection ?? undefined,
            item: isNew ? undefined : String(parentId),
            onProgress: setUploadPct
          })
          await addFile(result.id)
        }
        qc.invalidateQueries({ queryKey: ['file-browser'] })
      } catch {
        /* ignore */
      } finally {
        setUploading(false)
        setUploadPct(null)
      }
    }
  }

  return (
    <div className='space-y-2'>
      <RemoteUploadRows
        collection={relation.one_collection}
        item={isNew ? null : String(parentId)}
        field={relation.one_field}
      />
      {(allFileIds.length > 0 || pendingFiles.length > 0 || removedRows.length > 0) && (
        <div ref={usageRef} className='flex flex-col gap-1.5'>
          {allFileIds.map((id) => {
            const f = filesMap[id]
            const fresh = live.fresh.has(id)
            // Someone else's new file waits for its name, then fades in — never a bare id.
            if (fresh && !f) return null
            return (
              <div
                key={id}
                data-file-fresh={fresh ? '' : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-slate-200 p-2 bg-slate-50 dark:border-border dark:bg-white/[0.03]',
                  fresh && 'nvr-row-enter'
                )}
              >
                {/* Every file click downloads (2026-11-08): no in-app preview. */}
                <a
                  href={`${getUrl(id)}?download=1`}
                  download={f?.filename_download || true}
                  onClick={downloadClick(`${getUrl(id)}?download=1`, f?.filename_download)}
                  title='Download'
                  className='shrink-0'
                >
                  <FileThumb
                    url={getUrl(id)}
                    type={f?.type ?? null}
                    filename={f?.filename_download ?? id}
                    size='sm'
                    processing={processing.isProcessing(id)}
                  />
                </a>
                <div className='flex-1 min-w-0'>
                  {processing.isProcessing(id) && (
                    <span className='float-right ml-1.5'>
                      <FileProcessingBadge />
                    </span>
                  )}
                  <a
                    href={`${getUrl(id)}?download=1`}
                    download={f?.filename_download || true}
                    onClick={downloadClick(`${getUrl(id)}?download=1`, f?.filename_download)}
                    title='Download'
                    data-file-name
                    className='block w-full truncate text-left text-[12px] font-medium text-slate-700 hover:underline dark:text-slate-100'
                  >
                    {fileDisplayName(f) || id}
                  </a>
                  <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
                    {f?.type && (
                      <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                        {friendlyFileType(f.type, f.filename_download)}
                      </span>
                    )}
                    {f?.filesize != null && (
                      <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                        {fmtSize(f.filesize)}
                      </span>
                    )}
                    {f?.uploaded_on && (
                      <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                        {fmtDate(f.uploaded_on)}
                      </span>
                    )}
                    {f?.uploaded_by_name && (
                      <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                        by {f.uploaded_by_name}
                      </span>
                    )}
                  </div>
                </div>
                {(health.verdict(id) ?? !!f?.missing_at) && (
                  <span
                    className='shrink-0 self-center rounded bg-red-500/10 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400'
                    title='The stored file is missing from storage — downloading or previewing will fail. Re-upload it.'
                  >
                    file missing
                  </span>
                )}
                {showUsage && !isNew && committedIds.includes(id) && (
                  <FileUsageChip
                    fileId={id}
                    uses={usage.data?.[id]}
                    loading={usage.isLoading}
                    collection={ownerCollection}
                    itemId={parentId}
                  />
                )}
                {showDownloads && !isNew && committedIds.includes(id) && (
                  <FileDownloadCount fileId={id} stat={downloads.data?.[id]} />
                )}
                <a
                  href={`${getUrl(id)}?download=1`}
                  onClick={downloadClick(`${getUrl(id)}?download=1`, f?.filename_download)}
                  title='Download'
                  className='shrink-0 text-slate-400 hover:text-nvr-cyan p-0.5'
                >
                  <Download className='h-3.5 w-3.5' />
                </a>
                {!disabled && (
                  <button
                    type='button'
                    aria-label='Remove file'
                    onClick={() => removeFile(id)}
                    className='text-slate-300 hover:text-red-400 p-0.5 shrink-0'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            )
          })}
          {removedRows.map((id) => (
            <RemovedFileRow
              key={`removed-${id}`}
              name={knownNames.current.get(id.toLowerCase()) ?? 'A file'}
              leaving={live.leaving.has(id)}
              by={lastWriterName(
                qc.getQueryData(['last-touch', ownerCollection, String(parentId)])
              )}
            />
          ))}
          {pendingFiles.map((pf) => (
            <div
              key={pf.url}
              className='flex items-center gap-2 rounded-lg border border-amber-200 p-2 bg-amber-50/50'
            >
              <FileThumb
                url={pf.url}
                type={pf.file.type || null}
                filename={pf.file.name}
                size='sm'
              />
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-1'>
                  <Clock className='h-3 w-3 text-amber-400 shrink-0' />
                  <p
                    data-file-name
                    className='text-[12px] font-medium text-slate-700 truncate dark:text-slate-100'
                  >
                    {pf.file.name}
                  </p>
                </div>
                <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
                  {pf.file.type && (
                    <span className='text-[10px] text-slate-500 dark:text-slate-400'>
                      {friendlyFileType(pf.file.type, pf.file.name)}
                    </span>
                  )}
                  <span className='text-[10px] text-slate-400'>{fmtSize(pf.file.size)}</span>
                  <span className='text-[10px] text-amber-500'>Pending upload</span>
                </div>
              </div>
              {!disabled && (
                <button
                  type='button'
                  aria-label='Remove file'
                  onClick={() => removePending(pf.url)}
                  className='text-slate-300 hover:text-red-400 p-0.5 shrink-0'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!disabled && (
        <div className='flex items-center gap-2'>
          {allowPick && (
            <div className='relative'>
              <button
                type='button'
                onClick={() => setOpen((v) => !v)}
                className='flex h-8 items-center gap-1.5 rounded border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 dark:border-border dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200 transition-colors'
              >
                <Plus className='h-3.5 w-3.5' />
                Add existing…
              </button>
              {open && (
                <div
                  className='absolute z-50 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'
                  style={{ minWidth: 480 }}
                >
                  <FileBrowserPanel
                    selected={allFileIds}
                    multi
                    onSelect={(id) => addFile(id)}
                    onClose={() => setOpen(false)}
                    getUrl={getUrl}
                  />
                </div>
              )}
            </div>
          )}
          {allowUpload && (
            <>
              <button
                type='button'
                onClick={() => uploadRef.current?.click()}
                disabled={uploading}
                className='flex h-8 items-center gap-1.5 rounded border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 dark:border-border dark:text-slate-400 dark:hover:border-slate-500 dark:hover:text-slate-200 disabled:opacity-40 transition-colors'
              >
                {uploading ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Upload className='h-3.5 w-3.5' />
                )}
                <span className='tabular-nums'>
                  {uploading && uploadPct != null ? `Uploading ${uploadPct}%` : 'Upload…'}
                </span>
              </button>
              <input
                ref={uploadRef}
                type='file'
                multiple
                className='hidden'
                onChange={handleUpload}
              />
            </>
          )}
        </div>
      )}
    </div>
  )
}
