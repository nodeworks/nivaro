import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  LayoutGrid,
  LayoutList,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type CMSFile } from '@/lib/api'
import { formatNumber, formatRelative } from '@/lib/utils'

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** CMSFile plus the expiry column added by the storage migrations. */
type FileRow = CMSFile & { expires_at: string | null }

function formatExpiry(value: string | null): { label: string; expired: boolean } | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return { label: date.toLocaleDateString(), expired: date.getTime() < Date.now() }
}

function formatSize(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : 'file'
}

function fileTypeInfo(type: string | null, name: string): { color: string; label: string } {
  const ext = fileExt(name)
  if (type?.startsWith('image/')) return { color: '#06b6d4', label: ext }
  if (type === 'application/pdf') return { color: '#ef4444', label: 'pdf' }
  if (type?.startsWith('video/')) return { color: '#8b5cf6', label: ext }
  if (type?.startsWith('audio/')) return { color: '#f59e0b', label: ext }
  if (type?.includes('spreadsheet') || type?.includes('excel') || ext === 'csv')
    return { color: '#22c55e', label: ext }
  if (type?.includes('document') || type?.includes('word') || ext === 'docx')
    return { color: '#3b82f6', label: ext }
  if (type?.startsWith('text/')) return { color: '#64748b', label: ext }
  return { color: '#94a3b8', label: ext }
}

function FileTypeIcon({
  type,
  className,
  style
}: {
  type: string | null
  className?: string
  style?: React.CSSProperties
}) {
  const props = { className, style }
  if (type?.startsWith('image/')) return <FileImage {...props} />
  if (type === 'application/pdf') return <FileText {...props} />
  if (type?.startsWith('video/')) return <FileVideo {...props} />
  if (type?.startsWith('audio/')) return <FileAudio {...props} />
  return <File {...props} />
}

// ─── Grid card ────────────────────────────────────────────────────────────────

function FileCard({
  file,
  confirming,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  isDeleting
}: {
  file: CMSFile
  confirming: boolean
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  isDeleting: boolean
}) {
  const isImage = file.type?.startsWith('image/')
  const { color, label } = fileTypeInfo(file.type, file.filename_download)

  return (
    <div className='group relative overflow-hidden rounded-lg border border-slate-200 bg-white transition-shadow hover:shadow-sm'>
      {/* Preview */}
      <div className='relative aspect-square overflow-hidden bg-slate-50'>
        {isImage ? (
          <img
            src={`/api/files/${file.id}`}
            alt={file.title ?? file.filename_download}
            className='h-full w-full object-cover'
            loading='lazy'
          />
        ) : (
          <div
            className='flex h-full items-center justify-center'
            style={{ background: `${color}10` }}
          >
            <FileTypeIcon type={file.type} className='h-10 w-10' style={{ color }} />
          </div>
        )}

        {/* Delete overlay / confirm */}
        {confirming ? (
          <div className='absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/65'>
            <p className='text-[11px] font-medium text-white'>Delete this file?</p>
            <div className='flex gap-1.5'>
              <button
                type='button'
                className='rounded px-2.5 py-1 text-[11px] font-medium bg-red-500 text-white hover:bg-red-600 disabled:opacity-50'
                onClick={onConfirmDelete}
                disabled={isDeleting}
              >
                Delete
              </button>
              <button
                type='button'
                className='rounded px-2.5 py-1 text-[11px] font-medium bg-white/15 text-white hover:bg-white/25'
                onClick={onCancelDelete}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type='button'
            className='absolute right-1.5 top-1.5 rounded-md bg-black/50 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-500'
            onClick={onRequestDelete}
            aria-label='Delete file'
          >
            <Trash2 className='h-3 w-3' />
          </button>
        )}
      </div>

      {/* Info */}
      <div className='p-2.5'>
        <p
          className='truncate text-[12px] font-medium text-slate-700'
          title={file.filename_download}
        >
          {file.filename_download}
        </p>
        <div className='mt-1 flex items-center gap-1.5'>
          <span
            className='rounded px-1 py-px text-[9px] font-semibold text-white'
            style={{ background: color }}
          >
            {label}
          </span>
          <span className='text-[11px] text-slate-400'>{formatSize(file.filesize)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FilesPage() {
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [view, setView] = useState<'grid' | 'list'>('list')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const limit = 50

  const { data, isLoading } = useQuery({
    queryKey: ['files', page],
    queryFn: () =>
      api
        .get<{ data: CMSFile[]; total: number }>('/files', {
          params: { limit, offset: (page - 1) * limit }
        })
        .then((r) => r.data)
  })

  const files: CMSFile[] = data?.data ?? []
  const total: number = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        const fd = new FormData()
        fd.append('file', f)
        await api.post('/files/upload', fd, { headers: { 'Content-Type': undefined } })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] })
      toast.success('Upload complete')
    },
    onError: () => toast.error('Upload failed')
  })

  const deleteFile = useMutation({
    mutationFn: (id: string) => api.delete(`/files/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['files'] })
      setPendingDelete(null)
      toast.success('File deleted')
    },
    onError: () => toast.error('Delete failed')
  })

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) {
      const files = Array.from(e.target.files)
      e.target.value = ''
      upload.mutate(files)
    }
  }

  const start = (page - 1) * limit + 1
  const end = Math.min(page * limit, total)

  return (
    <>
      {/* Header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>Files</h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
                {formatNumber(total)}
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {/* View toggle */}
            <div className='flex items-center rounded-lg border border-slate-200 p-0.5'>
              <button
                type='button'
                onClick={() => setView('grid')}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  view === 'grid'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-400 hover:text-slate-700'
                }`}
                aria-label='Grid view'
              >
                <LayoutGrid className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => setView('list')}
                className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                  view === 'list'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-400 hover:text-slate-700'
                }`}
                aria-label='List view'
              >
                <LayoutList className='h-3.5 w-3.5' />
              </button>
            </div>

            <input
              ref={fileInputRef}
              type='file'
              multiple
              className='hidden'
              onChange={handleFileInput}
            />
            <Button
              size='sm'
              onClick={() => fileInputRef.current?.click()}
              disabled={upload.isPending}
            >
              <Upload className='mr-1.5 h-3.5 w-3.5' />
              {upload.isPending ? 'Uploading…' : 'Upload'}
            </Button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className='p-8'>
        {isLoading ? (
          view === 'grid' ? (
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6'>
              {[...Array(12)].map((_, i) => (
                <Skeleton key={i} className='aspect-square rounded-lg' />
              ))}
            </div>
          ) : (
            <div className='divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white'>
              {[...Array(8)].map((_, i) => (
                <div key={i} className='flex items-center gap-3 px-4 py-3'>
                  <Skeleton className='h-8 w-8 shrink-0 rounded' />
                  <Skeleton className='h-4 w-52' />
                  <Skeleton className='ml-auto h-4 w-20' />
                </div>
              ))}
            </div>
          )
        ) : total === 0 ? (
          <button
            type='button'
            className='flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-200 py-20 text-center transition-colors hover:border-nvr-cyan hover:bg-nvr-cyan/[0.02]'
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className='mx-auto mb-3 h-8 w-8 text-slate-300' />
            <p className='text-[13px] font-medium text-slate-500'>No files yet</p>
            <p className='mt-1 text-[12px] text-slate-400'>Click to upload your first file</p>
          </button>
        ) : view === 'grid' ? (
          <div className='grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6'>
            {files.map((file) => (
              <FileCard
                key={file.id}
                file={file}
                confirming={pendingDelete === file.id}
                onRequestDelete={() => setPendingDelete(file.id)}
                onConfirmDelete={() => deleteFile.mutate(file.id)}
                onCancelDelete={() => setPendingDelete(null)}
                isDeleting={deleteFile.isPending}
              />
            ))}
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white'>
            <table className='w-full text-left'>
              <thead>
                <tr className='border-b border-slate-100 bg-slate-50'>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>File</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Type</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Size</th>
                  <th className='px-4 py-2.5 text-[11px] font-medium text-slate-500'>Uploaded</th>
                  <th className='w-16 px-4 py-2.5' />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100'>
                {files.map((file) => {
                  const { color, label } = fileTypeInfo(file.type, file.filename_download)
                  const isImage = file.type?.startsWith('image/')
                  return (
                    <tr key={file.id} className='group hover:bg-slate-50'>
                      <td className='px-4 py-2.5'>
                        <div className='flex items-center gap-2.5'>
                          <div
                            className='flex h-8 w-8 shrink-0 items-center justify-center rounded overflow-hidden'
                            style={{ background: `${color}15` }}
                          >
                            {isImage ? (
                              <img
                                src={`/api/files/${file.id}`}
                                alt=''
                                className='h-full w-full object-cover'
                                loading='lazy'
                              />
                            ) : (
                              <FileTypeIcon
                                type={file.type}
                                className='h-4 w-4'
                                style={{ color }}
                              />
                            )}
                          </div>
                          <span
                            className='max-w-xs truncate text-[13px] font-medium text-slate-700'
                            title={file.filename_download}
                          >
                            {file.filename_download}
                          </span>
                        </div>
                      </td>
                      <td className='px-4 py-2.5'>
                        <Badge
                          variant='secondary'
                          className='h-4 px-1.5 text-[10px] font-semibold'
                          style={{ background: `${color}20`, color }}
                        >
                          {label}
                        </Badge>
                      </td>
                      <td className='px-4 py-2.5 text-[13px] text-slate-500'>
                        {formatSize(file.filesize)}
                      </td>
                      <td className='px-4 py-2.5 text-[13px] text-slate-500'>
                        {formatRelative(file.uploaded_on)}
                      </td>
                      <td className='px-4 py-2.5'>
                        {pendingDelete === file.id ? (
                          <div className='flex items-center gap-1'>
                            <button
                              type='button'
                              className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600 disabled:opacity-50'
                              onClick={() => deleteFile.mutate(file.id)}
                              disabled={deleteFile.isPending}
                            >
                              Delete
                            </button>
                            <button
                              type='button'
                              className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                              onClick={() => setPendingDelete(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type='button'
                            className='rounded p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-red-500'
                            onClick={() => setPendingDelete(file.id)}
                            aria-label='Delete file'
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > limit && (
          <div className='mt-4 flex items-center justify-between'>
            <p className='text-[12px] text-slate-400'>
              {formatNumber(start)}–{formatNumber(end)} of {formatNumber(total)} files
            </p>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className='text-[12px] text-slate-500'>
                {page} / {totalPages}
              </span>
              <Button
                variant='outline'
                size='sm'
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
