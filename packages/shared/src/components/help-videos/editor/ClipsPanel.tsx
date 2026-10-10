import { useQueryClient } from '@tanstack/react-query'
import { Download, Film, Link2, Loader2, Plus, Trash2 } from 'lucide-react'
import { memo, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import { helpVideoApi, helpVideoKeys, useHelpVideoClips } from '../api'
import { CLIP_LIMITS, type ClipDto, type VideoEdits } from '../types'
import { ClipDialog, type ClipPreset } from './ClipDialog'
import { type ClipRange, clipLink, clipMeta } from './clips'

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success('Link copied')
  } catch {
    toast(text, { description: 'Copy this link', duration: 15_000 })
  }
}

const iconButton =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:pointer-events-none disabled:opacity-40 motion-reduce:transition-none'

/**
 * The clips of a video as rows: name, kind, length and state, with Copy link
 * and Download once ready, and Delete for authors. Shared by the editor's
 * Clips section and the viewer's sheet.
 */
export function ClipRows({
  clips,
  onDelete,
  deleting
}: {
  clips: ClipDto[]
  /** Authors: delete a clip. Absent = no Delete button. */
  onDelete?: (clip: ClipDto) => void
  deleting?: string | null
}) {
  const { apiBase } = useApiFetchConfig()
  const pageOrigin = typeof window === 'undefined' ? '' : window.location.origin
  return (
    <ul className='-mx-1.5 space-y-px' data-hv-clip-rows={clips.length}>
      {clips.map((c) => {
        const link = c.url ? clipLink(apiBase, c.url, pageOrigin) : null
        const busy = c.status === 'queued' || c.status === 'rendering'
        return (
          <li
            key={c.id}
            className='flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px]'
            data-hv-clip={c.id}
            data-hv-clip-status={c.status}
          >
            {busy ? (
              <Loader2
                className='h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none'
                aria-hidden
              />
            ) : (
              <Film className='h-4 w-4 shrink-0 text-muted-foreground' aria-hidden />
            )}
            <div className='min-w-0 flex-1'>
              <p className='truncate text-foreground'>{c.label || 'Clip'}</p>
              <p
                className={`truncate text-[12px] ${c.status === 'failed' ? 'text-rose-700 dark:text-rose-300' : 'text-muted-foreground'}`}
                data-hv-clip-meta
              >
                {clipMeta(c)}
              </p>
            </div>
            {link && (
              <>
                <button
                  type='button'
                  className={iconButton}
                  onClick={() => void copyText(link)}
                  aria-label={`Copy link to ${c.label || 'clip'}`}
                  title='Copy link'
                  data-hv-clip-copy={c.id}
                  data-hv-clip-url={link}
                >
                  <Link2 className='h-3.5 w-3.5' aria-hidden />
                </button>
                <a
                  href={`${link}&download=1`}
                  download
                  className={iconButton}
                  aria-label={`Download ${c.label || 'clip'} (${c.kind.toUpperCase()})`}
                  title='Download'
                  data-hv-clip-download={c.id}
                >
                  <Download className='h-3.5 w-3.5' aria-hidden />
                </a>
              </>
            )}
            {onDelete && (
              <button
                type='button'
                className={iconButton}
                onClick={() => onDelete(c)}
                disabled={deleting === c.id}
                aria-label={`Delete ${c.label || 'clip'}`}
                title='Delete'
                data-hv-clip-delete={c.id}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden />
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The editor's Clips section (#1562): the video's clips and "Make a clip",
 * which starts from the chapter or piece selected on the timeline.
 */
export const ClipsPanel = memo(function ClipsPanel({
  headless,
  videoId,
  edits,
  draft,
  presets,
  initialRange,
  playheadRange,
  request,
  onNote
}: {
  headless?: boolean
  videoId: string
  edits: VideoEdits
  /** Clips of the draft (the editor) or of the published version (the viewer). */
  draft: boolean
  /** Ranges offered as one click: the selection, the chapters. */
  presets: () => ClipPreset[]
  /** Where the dialog starts: the selection when there is one. */
  initialRange: () => ClipRange | null
  /** Around the playhead, read when the dialog opens. */
  playheadRange: () => ClipRange | null
  /** A request from elsewhere (a chapter row's clip button) to open the
   *  dialog on this range; a new `n` opens it again. */
  request?: { n: number; range: ClipRange } | null
  onNote?: (n: string | null) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const headingId = useId()
  const clips = useHelpVideoClips(videoId)
  const [dialog, setDialog] = useState<{ initial: ClipRange | null; presets: ClipPreset[] } | null>(
    null
  )
  const [deleting, setDeleting] = useState<string | null>(null)
  const list = clips.data ?? []
  const live = list.filter((c) => c.status !== 'failed').length
  const full = live >= CLIP_LIMITS.maxPerVideo

  const open = (initial?: ClipRange) => {
    const around = playheadRange()
    const ps = presets()
    if (around) ps.push({ key: 'playhead', label: 'Around the playhead', range: around })
    setDialog({ initial: initial ?? initialRange() ?? ps[0]?.range ?? around, presets: ps })
  }
  // The request's `n` is the trigger; the range and the opener ride along.
  const openRef = useRef(open)
  openRef.current = open
  const requestN = request?.n ?? 0
  const requestRange = request?.range ?? null
  useEffect(() => {
    if (requestN > 0 && requestRange) openRef.current(requestRange)
  }, [requestN, requestRange])
  const remove = async (c: ClipDto) => {
    setDeleting(c.id)
    try {
      await helpVideoApi(client).deleteClip(videoId, c.id)
      qc.setQueryData<ClipDto[]>(helpVideoKeys.clips(videoId), (cur) =>
        cur?.filter((x) => x.id !== c.id)
      )
    } catch (err) {
      onNote?.(`The clip could not be deleted. ${(err as Error).message}`)
    } finally {
      setDeleting(null)
      void qc.invalidateQueries({ queryKey: helpVideoKeys.clips(videoId) })
    }
  }

  return (
    <section className='space-y-2' aria-labelledby={headingId} data-hv-clips>
      <div className='flex items-center justify-between gap-2'>
        <h3
          id={headingId}
          className={headless ? 'sr-only' : 'text-[13px] font-semibold text-foreground'}
        >
          Clips
        </h3>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={() => open()}
          disabled={full}
          title={
            full
              ? `A video can have at most ${CLIP_LIMITS.maxPerVideo} clips`
              : 'Make a short MP4 or GIF of a chapter, the selection or a range'
          }
          data-hv-make-clip
        >
          <Plus className='!size-3.5' aria-hidden /> Make a clip
        </Button>
      </div>
      {clips.error ? (
        <p className='text-[12px] text-rose-700 dark:text-rose-300'>
          The clips could not be loaded. {(clips.error as Error).message}
        </p>
      ) : list.length === 0 ? (
        <p className='text-[12px] leading-snug text-muted-foreground'>
          A clip is a short MP4 or GIF of a chapter, the selected piece or any range up to{' '}
          {CLIP_LIMITS.maxMs / 1000} seconds, with a link to paste into chat, a document or mail.
          Everyone who can watch the video can open it.
        </p>
      ) : (
        <ClipRows clips={list} onDelete={(c) => void remove(c)} deleting={deleting} />
      )}
      {dialog && (
        <ClipDialog
          videoId={videoId}
          edits={edits}
          draft={draft}
          initial={dialog.initial}
          presets={dialog.presets}
          onQueued={(clip) => {
            qc.setQueryData<ClipDto[]>(helpVideoKeys.clips(videoId), (cur) => [
              clip,
              ...(cur ?? []).filter((x) => x.id !== clip.id)
            ])
            void qc.invalidateQueries({ queryKey: helpVideoKeys.clips(videoId) })
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  )
})
