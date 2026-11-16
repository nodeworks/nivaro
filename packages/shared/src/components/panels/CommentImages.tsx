import { ImageOff, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../context'
import {
  imageFilesFrom,
  MAX_COMMENT_IMAGES,
  splitCommentImages,
  withCommentImages
} from '../../lib/comment-images'
import { startFileUpload } from '../../lib/upload-file'
import { cn } from '../../lib/utils'
import { AutolinkedText } from '../AutolinkedText'
import { FilePreviewLightbox } from '../FilePreviewLightbox'

/**
 * Screenshots pasted or dropped into a comment box: each uploads at once with
 * progress, shows as a removable thumbnail under the box, and posts as one
 * `![name](/api/files/<id>)` line at the end of the comment text
 * (lib/comment-images.ts). A posted comment draws those lines as thumbnails
 * that open the file preview.
 */

interface PendingImage {
  key: string
  name: string
  /** Local blob URL, so the thumbnail shows before the upload finishes. */
  preview: string
  progress: number
  id: string | null
  error: string | null
  abort: () => void
}

export interface CommentImages {
  items: PendingImage[]
  /** Pasted or dropped files in; non-images are ignored. */
  addFiles: (files: File[]) => void
  remove: (key: string) => void
  reset: () => void
  /** At least one image is still on its way up. */
  uploading: boolean
  /** Something to post besides the typed text. */
  hasReady: boolean
  /** The typed text plus a line for every finished image. */
  compose: (text: string) => string
}

export function useCommentImages(): CommentImages {
  const cfg = useApiFetchConfig()
  const [items, setItems] = useState<PendingImage[]>([])
  const live = useRef<PendingImage[]>([])
  live.current = items

  useEffect(
    () => () => {
      for (const i of live.current) {
        if (!i.id) i.abort()
        URL.revokeObjectURL(i.preview)
      }
    },
    []
  )

  const addFiles = useCallback(
    (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith('image/'))
      if (images.length === 0) return
      const room = MAX_COMMENT_IMAGES - live.current.length
      if (room <= 0 || images.length > room) {
        toast.error(`A comment can carry up to ${MAX_COMMENT_IMAGES} images.`)
      }
      for (const file of images.slice(0, Math.max(0, room))) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
        const update = (patch: Partial<PendingImage>) =>
          setItems((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)))
        const { abort } = startFileUpload(cfg, file, {
          onProgress: (progress) => update({ progress }),
          onDone: (id) => update({ id, progress: 1 }),
          onError: (error) => update({ error })
        })
        setItems((prev) => [
          ...prev,
          {
            key,
            name: file.name,
            preview: URL.createObjectURL(file),
            progress: 0,
            id: null,
            error: null,
            abort
          }
        ])
      }
    },
    [cfg]
  )

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((p) => p.key === key)
      if (gone) {
        if (!gone.id && !gone.error) gone.abort()
        URL.revokeObjectURL(gone.preview)
      }
      return prev.filter((p) => p.key !== key)
    })
  }, [])

  const reset = useCallback(() => {
    for (const i of live.current) URL.revokeObjectURL(i.preview)
    setItems([])
  }, [])

  return {
    items,
    addFiles,
    remove,
    reset,
    uploading: items.some((i) => !i.id && !i.error),
    hasReady: items.some((i) => i.id),
    compose: (text) =>
      withCommentImages(
        text,
        items.filter((i) => i.id).map((i) => ({ id: i.id as string, name: i.name }))
      )
  }
}

/** Drop handlers for a box that takes pasted or dropped images. */
export function imageDropProps(addFiles: (files: File[]) => void) {
  return {
    onPaste: (e: React.ClipboardEvent) => {
      const files = imageFilesFrom(e.clipboardData)
      if (files.length === 0) return
      e.preventDefault()
      addFiles(files)
    },
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    },
    onDrop: (e: React.DragEvent) => {
      const files = imageFilesFrom(e.dataTransfer)
      if (files.length === 0) return
      e.preventDefault()
      addFiles(files)
    }
  }
}

/** The thumbnails under a comment box: progress while uploading, a note on failure, ✕ to drop one. */
export function CommentImageStrip({
  images,
  className
}: {
  images: CommentImages
  className?: string
}) {
  if (images.items.length === 0) return null
  return (
    <ul
      data-comment-images=''
      className={cn('m-0 flex list-none flex-wrap gap-2 p-0', className)}
      aria-label='Attached images'
    >
      {images.items.map((i) => (
        <li
          key={i.key}
          data-comment-image={i.id ? 'done' : i.error ? 'failed' : 'uploading'}
          className='group relative h-16 w-16 overflow-hidden rounded-md border border-slate-200 bg-slate-50 dark:border-border dark:bg-muted'
        >
          <img
            src={i.preview}
            alt={i.name}
            className={cn('h-full w-full object-cover', !i.id && 'opacity-50')}
          />
          {!i.id && !i.error && (
            <span
              role='progressbar'
              aria-valuenow={Math.round(i.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className='absolute inset-x-0 bottom-0 h-1 bg-slate-200/80 dark:bg-white/20'
            >
              <span
                className='block h-full bg-nvr-cyan transition-[width]'
                style={{ width: `${Math.max(6, Math.round(i.progress * 100))}%` }}
              />
            </span>
          )}
          {i.error && (
            <span
              data-tip={i.error}
              className='absolute inset-0 flex items-center justify-center bg-red-50/85 px-1 text-center text-[9.5px] font-medium leading-tight text-red-700 dark:bg-red-950/70 dark:text-red-300'
            >
              {i.error}
            </span>
          )}
          <button
            type='button'
            onClick={() => images.remove(i.key)}
            aria-label={`Remove ${i.name}`}
            className='absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900/70 text-white opacity-90 transition-opacity hover:bg-slate-900 focus-visible:opacity-100'
          >
            <X aria-hidden className='h-2.5 w-2.5' />
          </button>
        </li>
      ))}
    </ul>
  )
}

function PostedImage({ id, name, onOpen }: { id: string; name: string; onOpen: () => void }) {
  const client = useNivaroClient()
  const [broken, setBroken] = useState(false)
  const url = client.fileUrl(id)
  if (broken) {
    return (
      <span
        data-comment-image='unavailable'
        className='inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-1 text-[11.5px] text-slate-500 dark:border-border dark:text-muted-foreground'
      >
        <ImageOff aria-hidden className='h-3 w-3' /> Image not available
      </span>
    )
  }
  return (
    // On a phone the image takes the comment's width (contained, never cropped) instead of
    // shrinking with the column; on wider screens it keeps its own size up to 176 px tall.
    <button
      type='button'
      onClick={onOpen}
      data-comment-image='posted'
      aria-label={`Open ${name}`}
      className='block max-w-full overflow-hidden rounded-md border border-slate-200 bg-slate-50 transition-colors hover:border-nvr-cyan max-sm:w-full dark:border-border dark:bg-muted'
    >
      <img
        src={url}
        alt={name}
        loading='lazy'
        onError={() => setBroken(true)}
        className='block max-h-44 max-w-full object-contain max-sm:mx-auto max-sm:min-h-24'
      />
    </button>
  )
}

/** A posted comment's text; pasted images draw as thumbnails that open the file preview. */
export function CommentBody({
  text,
  className,
  record,
  caption
}: {
  text: string
  className?: string
  /** The record the comment is on: an opened image hears when its file changes (rt8 #19). */
  record?: { collection: string; itemId: string | number } | null
  /** Who posted it and when ("Review Admin · just now") — the opened image's title. */
  caption?: string | null
}) {
  const client = useNivaroClient()
  const [opened, setOpened] = useState<number | null>(null)
  const parts = splitCommentImages(text)
  const images = parts.flatMap((p) => (p.kind === 'image' ? [{ id: p.id, name: p.name }] : []))
  if (images.length === 0) {
    return (
      <p className={className}>
        <AutolinkedText text={text} />
      </p>
    )
  }
  const shown = opened != null ? images[opened] : null
  let imageNo = -1
  return (
    <div className={className}>
      {parts.map((p, n) => {
        if (p.kind === 'text')
          return p.text.trim() ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
            <p key={`t${n}`} className='m-0'>
              <AutolinkedText text={p.text.replace(/^\n+|\n+$/g, '')} />
            </p>
          ) : null
        imageNo += 1
        const at = imageNo
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder
          <div key={`i${n}`} className='my-1.5 whitespace-normal'>
            <PostedImage id={p.id} name={p.name} onOpen={() => setOpened(at)} />
          </div>
        )
      })}
      {shown && opened != null && (
        <FilePreviewLightbox
          file={{
            id: shown.id,
            url: client.fileUrl(shown.id),
            name: shown.name,
            type: 'image/png'
          }}
          record={record}
          caption={caption}
          nav={
            images.length > 1
              ? {
                  index: opened,
                  count: images.length,
                  onPrev: () => setOpened((i) => ((i ?? 0) - 1 + images.length) % images.length),
                  onNext: () => setOpened((i) => ((i ?? 0) + 1) % images.length)
                }
              : null
          }
          onClose={() => setOpened(null)}
        />
      )}
    </div>
  )
}
