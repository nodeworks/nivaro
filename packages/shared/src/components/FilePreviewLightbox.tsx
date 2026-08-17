import { Download, X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Inline attachment preview — click a file, see it, without a download round
 * trip. Images, PDFs, video and audio render in an overlay; anything else
 * gets an honest "no preview" panel with the Download action front and center.
 *
 * Plain portal to document.body at z-[130] (above popovers at 110 and the
 * tooltip layer at 120). The asset URL is the same cookie/session-authed
 * /api/files/:id URL every <img> in the app already uses.
 */

export interface PreviewFile {
  id: string
  url: string
  name: string
  type: string | null
  size?: number | null
}

export function canPreviewFile(type: string | null | undefined): boolean {
  if (!type) return false
  return (
    type.startsWith('image/') ||
    type === 'application/pdf' ||
    type.startsWith('video/') ||
    type.startsWith('audio/') ||
    type.startsWith('text/')
  )
}

function fmtBytes(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function FilePreviewLightbox({
  file,
  onClose
}: {
  file: PreviewFile
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const type = file.type ?? ''
  const size = fmtBytes(file.size)

  let body: React.ReactNode
  if (type.startsWith('image/')) {
    body = (
      <img
        src={file.url}
        alt={file.name}
        className='max-h-[82vh] max-w-full rounded object-contain'
      />
    )
  } else if (type === 'application/pdf' || type.startsWith('text/')) {
    body = (
      <iframe
        src={file.url}
        title={file.name}
        className='h-[82vh] w-[min(920px,92vw)] rounded border-0 bg-white'
      />
    )
  } else if (type.startsWith('video/')) {
    // biome-ignore lint/a11y/useMediaCaption: user uploads carry no captions
    body = <video src={file.url} controls className='max-h-[82vh] max-w-full rounded' />
  } else if (type.startsWith('audio/')) {
    // biome-ignore lint/a11y/useMediaCaption: user uploads carry no captions
    body = <audio src={file.url} controls className='w-[min(480px,90vw)]' />
  } else {
    body = (
      <div className='flex w-[min(420px,90vw)] flex-col items-center gap-3 rounded-lg bg-white p-8 text-center dark:bg-card'>
        <p className='text-[13px] font-medium text-slate-700 dark:text-slate-200'>{file.name}</p>
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          No inline preview for this file type{type ? ` (${type})` : ''}.
        </p>
        <a
          href={`${file.url}?download=1`}
          className='inline-flex items-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110'
        >
          <Download className='h-3.5 w-3.5' /> Download
        </a>
      </div>
    )
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled globally above
    <div
      className='fixed inset-0 z-[130] flex flex-col bg-black/70 backdrop-blur-[2px]'
      onClick={onClose}
      data-file-lightbox
    >
      <div
        className='flex items-center gap-3 px-4 py-2.5'
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        <p className='min-w-0 flex-1 truncate text-[13px] font-medium text-white'>
          {file.name}
          {size && <span className='ml-2 text-[11px] font-normal text-white/60'>{size}</span>}
        </p>
        <a
          href={`${file.url}?download=1`}
          title='Download'
          className='rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white'
        >
          <Download className='h-4 w-4' />
        </a>
        <button
          type='button'
          onClick={onClose}
          title='Close (Esc)'
          className='rounded p-1.5 text-white/80 hover:bg-white/10 hover:text-white'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      <div
        className='flex min-h-0 flex-1 items-center justify-center p-4 pt-0'
        onClick={(e) => e.stopPropagation()}
        onKeyDown={() => {}}
      >
        {body}
      </div>
    </div>,
    document.body
  )
}
