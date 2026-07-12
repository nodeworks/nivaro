import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, Download, File, FileAudio, FileCode, FileSpreadsheet, FileText, FileVideo, Loader2, Plus, Upload, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useGridFlush, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { useM2MStaging } from './M2MStagingContext'
import type { CMSRelation } from './types'

interface NivaroFile {
  id: string
  filename_download: string
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

function fmtDate(iso: string | null) {
  if (!iso) return null
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

function isImage(type: string | null) {
  return !!type && type.startsWith('image/')
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
  if (type.includes('json') || type.includes('javascript') || type.includes('typescript') || type.includes('xml'))
    return <FileCode className={cls} strokeWidth={1.5} />
  return <File className={cls} strokeWidth={1.5} />
}

function FileThumb({
  url,
  type,
  filename,
  size = 'md'
}: {
  url: string
  type: string | null
  filename: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const dim = size === 'sm' ? 'h-10 w-10' : size === 'lg' ? 'h-20 w-20' : 'h-14 w-14'
  if (isImage(type)) {
    return (
      <img
        src={url}
        alt={filename}
        className={cn(dim, 'object-cover rounded shrink-0')}
        loading='lazy'
        onError={e => {
          ;(e.target as HTMLImageElement).style.display = 'none'
        }}
      />
    )
  }
  return (
    <div className={cn(dim, 'flex items-center justify-center rounded bg-slate-100 shrink-0')}>
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
            fields: 'id,filename_download,title,type,filesize,width,height',
            ...(search ? { search } : {})
          })
        )
        .then(r => r.data ?? []),
    staleTime: 30_000
  })

  return (
    <div className='flex flex-col' style={{ width: 480, maxHeight: 420 }}>
      <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 shrink-0'>
        <p className='text-[12px] font-medium text-slate-700'>
          Select file{multi ? 's' : ''}
        </p>
        <button type='button' onClick={onClose} className='text-slate-400 hover:text-slate-600'>
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='px-3 pt-2 pb-1 shrink-0'>
        <input
          type='text'
          placeholder='Search files…'
          value={search}
          onChange={e => setSearch(e.target.value)}
          className='w-full h-7 rounded border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff]'
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
            {files.map(f => {
              const isSel = selected.includes(f.id)
              return (
                <button
                  key={f.id}
                  type='button'
                  onClick={() => onSelect(f.id)}
                  className={cn(
                    'group flex flex-col items-center gap-1 rounded-lg p-1.5 text-left transition-colors border',
                    isSel
                      ? 'border-[#00ceff] bg-[#00ceff]/5'
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
                      <div className='absolute inset-0 flex items-center justify-center rounded bg-[#00ceff]/20'>
                        <div className='h-4 w-4 rounded-full bg-[#00ceff] flex items-center justify-center'>
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
                  <span className='text-[10px] text-slate-500 truncate w-full text-center leading-tight'>
                    {f.title || f.filename_download}
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
  value,
  onChange,
  disabled,
  allowUpload = true,
  allowPick = true
}: {
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  allowUpload?: boolean
  allowPick?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const flush = useGridFlush()
  const flushKey = useId()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const uploadRef = useRef<HTMLInputElement>(null)

  const fileId = !pendingFile && value ? String(value) : null
  const getUrl = (id: string) => client.fileUrl(id)

  // manage object URL lifecycle
  useEffect(() => {
    if (!pendingFile) { setPreviewUrl(null); return }
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

  const { data: file, isLoading } = useQuery<NivaroFile | null>({
    queryKey: ['file-meta', fileId],
    queryFn: () =>
      client
        .request<{ data: NivaroFile }>( get(`/files/${fileId}/meta`) )
        .then(r => r.data ?? null),
    enabled: !!fileId,
    staleTime: 60_000
  })

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (uploadRef.current) uploadRef.current.value = ''
    if (flush) {
      setPendingFile(f)
    } else {
      setUploading(true)
      try {
        const result = await client.upload(f)
        onChange(result.id)
        qc.invalidateQueries({ queryKey: ['file-browser'] })
      } catch {
        /* ignore */
      } finally {
        setUploading(false)
      }
    }
  }

  function handlePickExisting(id: string) {
    setPendingFile(null)
    onChange(id)
    setOpen(false)
  }

  function handleRemove() {
    setPendingFile(null)
    onChange(null)
  }

  const hasPending = !!pendingFile
  const hasFile = hasPending || !!fileId

  return (
    <div className='relative'>
      {hasFile ? (
        <div className='flex items-center gap-2 rounded-lg border border-slate-200 p-2 bg-slate-50'>
          {hasPending ? (
            <FileThumb
              url={previewUrl ?? ''}
              type={pendingFile!.type || null}
              filename={pendingFile!.name}
              size='sm'
            />
          ) : isLoading ? (
            <div className='h-10 w-10 rounded bg-slate-200 animate-pulse' />
          ) : (
            <FileThumb
              url={getUrl(fileId!)}
              type={file?.type ?? null}
              filename={file?.filename_download ?? ''}
              size='sm'
            />
          )}
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-1'>
              {hasPending && <Clock className='h-3 w-3 text-amber-400 shrink-0' />}
              <p className='text-[12px] font-medium text-slate-700 truncate'>
                {hasPending ? pendingFile!.name : (file?.title || file?.filename_download || fileId)}
              </p>
            </div>
            <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
              {hasPending ? (
                <>
                  {pendingFile!.type && <span className='text-[10px] text-slate-400'>{pendingFile!.type}</span>}
                  <span className='text-[10px] text-slate-400'>{fmtSize(pendingFile!.size)}</span>
                  <span className='text-[10px] text-amber-500'>Pending upload</span>
                </>
              ) : (
                <>
                  {file?.type && <span className='text-[10px] text-slate-400'>{file.type}</span>}
                  {file?.filesize != null && <span className='text-[10px] text-slate-400'>{fmtSize(file.filesize)}</span>}
                  {file?.uploaded_on && <span className='text-[10px] text-slate-400'>{fmtDate(file.uploaded_on)}</span>}
                  {file?.uploaded_by_name && <span className='text-[10px] text-slate-500'>by {file.uploaded_by_name}</span>}
                </>
              )}
            </div>
          </div>
          {!hasPending && fileId && (
            <a
              href={`${getUrl(fileId)}?download=1`}
              title='Download'
              className='shrink-0 text-slate-400 hover:text-[#00ceff] p-0.5'
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
                    Upload
                  </button>
                  <input ref={uploadRef} type='file' className='hidden' onChange={handleUpload} />
                </>
              )}
              <button
                type='button'
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
              className='flex h-9 flex-1 items-center gap-2 rounded-md border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors'
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
                className='flex h-9 items-center gap-1.5 rounded-md border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors'
              >
                {uploading ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Upload className='h-3.5 w-3.5' />
                )}
                Upload
              </button>
              <input ref={uploadRef} type='file' className='hidden' onChange={handleUpload} />
            </>
          )}
        </div>
      )}

      {open && (
        <div
          className='absolute z-50 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg'
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
  pendingSave = false
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  disabled?: boolean
  allowUpload?: boolean
  allowPick?: boolean
  pendingSave?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const flush = useGridFlush()
  const flushKey = useId()
  const pendingSaveFlushKey = useId()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<{ file: File; url: string }[]>([])
  const uploadRef = useRef<HTMLInputElement>(null)
  // pending-save mode: track local adds/removes without hitting API until parent saves
  const [localAdds, setLocalAdds] = useState<string[]>([])
  const [localRemovals, setLocalRemovals] = useState<Set<string>>(new Set())

  const junctionField = relation.junction_field ?? ''
  const manyField = relation.many_field ?? ''
  const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`
  const isNew = parentId === 'new'
  const getUrl = (id: string) => client.fileUrl(id)

  // cleanup pending object URLs on unmount
  useEffect(() => {
    return () => {
      setPendingFiles(prev => { prev.forEach(pf => URL.revokeObjectURL(pf.url)); return [] })
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
    if (!hasWork) { flush.unregister(pendingSaveFlushKey); return }
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
        await client.request(
          post(`/items/${relation.many_collection}`, { [manyField]: parentId, [junctionField]: fileId })
        )
      }
      // commit removes
      for (const fileId of snapshotRemovals) {
        const junction = junctionItems.find(j => String(j[junctionField]) === fileId)
        if (junction?.id) {
          await client.request(del(`/items/${relation.many_collection}/${junction.id}`))
        }
      }
      setLocalAdds([])
      setLocalRemovals(new Set())
      setPendingFiles([])
      qc.invalidateQueries({ queryKey: ['m2m-items', relation.many_collection, manyField, parentId] })
      qc.invalidateQueries({ queryKey: ['file-browser'] })
    })
    return () => flush.unregister(pendingSaveFlushKey)
  }, [flush, pendingSave, localAdds, localRemovals, pendingFiles, pendingSaveFlushKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: junctionItems = [] } = useQuery<Record<string, unknown>[]>({
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
        .then(r => r.data ?? []),
    enabled: !!parentId && !isNew,
    staleTime: 30_000
  })

  const stagedLinks = isNew && staging ? (staging.getStagedLinks(stagingKey) as string[]) : []
  const committedIds = junctionItems.map(j => String(j[junctionField]))
  const allFileIds = isNew
    ? stagedLinks
    : pendingSave
      ? [...committedIds.filter(id => !localRemovals.has(id)), ...localAdds]
      : committedIds

  const { data: filesMap = {} } = useQuery<Record<string, NivaroFile>>({
    queryKey: ['files-meta', ...allFileIds.sort()],
    queryFn: async () => {
      if (!allFileIds.length) return {}
      const data = await client
        .request<{ data: NivaroFile[] }>(
          get('/files', {
            filter: JSON.stringify({ id: { _in: allFileIds } }),
            limit: String(allFileIds.length),
            fields: 'id,filename_download,title,type,filesize,uploaded_on,uploaded_by_name'
          })
        )
        .then(r => r.data ?? [])
      const map: Record<string, NivaroFile> = {}
      for (const f of data) map[f.id] = f
      return map
    },
    enabled: allFileIds.length > 0,
    staleTime: 60_000
  })

  async function removeFile(fileId: string) {
    if (isNew && staging) {
      staging.unstageLink(stagingKey, fileId)
      return
    }
    if (pendingSave) {
      if (localAdds.includes(fileId)) {
        setLocalAdds(prev => prev.filter(id => id !== fileId))
      } else {
        setLocalRemovals(prev => new Set([...prev, fileId]))
      }
      return
    }
    const junction = junctionItems.find(j => String(j[junctionField]) === fileId)
    if (!junction?.id) return
    await client.request(del(`/items/${relation.many_collection}/${junction.id}`))
    qc.invalidateQueries({ queryKey: ['m2m-items', relation.many_collection, manyField, parentId] })
  }

  async function addFile(fileId: string) {
    if (allFileIds.includes(fileId)) return
    if (isNew && staging) {
      staging.stageLink(stagingKey, fileId)
      return
    }
    if (pendingSave) {
      setLocalAdds(prev => prev.includes(fileId) ? prev : [...prev, fileId])
      return
    }
    await client.request(
      post(`/items/${relation.many_collection}`, { [manyField]: parentId, [junctionField]: fileId })
    )
    qc.invalidateQueries({ queryKey: ['m2m-items', relation.many_collection, manyField, parentId] })
  }

  function removePending(url: string) {
    URL.revokeObjectURL(url)
    setPendingFiles(prev => prev.filter(pf => pf.url !== url))
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    if (uploadRef.current) uploadRef.current.value = ''
    if (flush) {
      const newPending = files.map(f => ({ file: f, url: URL.createObjectURL(f) }))
      setPendingFiles(prev => [...prev, ...newPending])
    } else {
      setUploading(true)
      try {
        for (const f of files) {
          const result = await client.upload(f)
          await addFile(result.id)
        }
        qc.invalidateQueries({ queryKey: ['file-browser'] })
      } catch {
        /* ignore */
      } finally {
        setUploading(false)
      }
    }
  }

  return (
    <div className='space-y-2'>
      {(allFileIds.length > 0 || pendingFiles.length > 0) && (
        <div className='flex flex-col gap-1.5'>
          {allFileIds.map(id => {
            const f = filesMap[id]
            return (
              <div key={id} className='flex items-center gap-2 rounded-lg border border-slate-200 p-2 bg-slate-50'>
                <FileThumb
                  url={getUrl(id)}
                  type={f?.type ?? null}
                  filename={f?.filename_download ?? id}
                  size='sm'
                />
                <div className='flex-1 min-w-0'>
                  <p className='text-[12px] font-medium text-slate-700 truncate'>
                    {f?.title || f?.filename_download || id}
                  </p>
                  <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
                    {f?.type && <span className='text-[10px] text-slate-400'>{f.type}</span>}
                    {f?.filesize != null && <span className='text-[10px] text-slate-400'>{fmtSize(f.filesize)}</span>}
                    {f?.uploaded_on && <span className='text-[10px] text-slate-400'>{fmtDate(f.uploaded_on)}</span>}
                    {f?.uploaded_by_name && <span className='text-[10px] text-slate-500'>by {f.uploaded_by_name}</span>}
                  </div>
                </div>
                <a
                  href={`${getUrl(id)}?download=1`}
                  title='Download'
                  className='shrink-0 text-slate-400 hover:text-[#00ceff] p-0.5'
                >
                  <Download className='h-3.5 w-3.5' />
                </a>
                {!disabled && (
                  <button
                    type='button'
                    onClick={() => removeFile(id)}
                    className='text-slate-300 hover:text-red-400 p-0.5 shrink-0'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            )
          })}
          {pendingFiles.map(pf => (
            <div key={pf.url} className='flex items-center gap-2 rounded-lg border border-amber-200 p-2 bg-amber-50/50'>
              <FileThumb
                url={pf.url}
                type={pf.file.type || null}
                filename={pf.file.name}
                size='sm'
              />
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-1'>
                  <Clock className='h-3 w-3 text-amber-400 shrink-0' />
                  <p className='text-[12px] font-medium text-slate-700 truncate'>{pf.file.name}</p>
                </div>
                <div className='flex flex-wrap items-center gap-x-2 mt-0.5'>
                  {pf.file.type && <span className='text-[10px] text-slate-400'>{pf.file.type}</span>}
                  <span className='text-[10px] text-slate-400'>{fmtSize(pf.file.size)}</span>
                  <span className='text-[10px] text-amber-500'>Pending upload</span>
                </div>
              </div>
              {!disabled && (
                <button
                  type='button'
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
                onClick={() => setOpen(v => !v)}
                className='flex h-8 items-center gap-1.5 rounded border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 transition-colors'
              >
                <Plus className='h-3.5 w-3.5' />
                Add existing…
              </button>
              {open && (
                <div
                  className='absolute z-50 mt-1 rounded-lg border border-slate-200 bg-white shadow-lg'
                  style={{ minWidth: 480 }}
                >
                  <FileBrowserPanel
                    selected={allFileIds}
                    multi
                    onSelect={id => addFile(id)}
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
                className='flex h-8 items-center gap-1.5 rounded border border-dashed border-slate-300 px-3 text-[12px] text-slate-400 hover:border-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors'
              >
                {uploading ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Upload className='h-3.5 w-3.5' />
                )}
                Upload…
              </button>
              <input ref={uploadRef} type='file' multiple className='hidden' onChange={handleUpload} />
            </>
          )}
        </div>
      )}
    </div>
  )
}
