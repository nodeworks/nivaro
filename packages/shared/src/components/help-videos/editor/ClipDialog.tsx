import { Loader2 } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { Button } from '../../ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Input } from '../../ui/input'
import { helpVideoApi, helpVideoError } from '../api'
import { editedDuration } from '../edits'
import { ErrorNote } from '../recorder/RecorderStatus'
import { CLIP_LIMITS, type ClipDto, type ClipKind, type VideoEdits } from '../types'
import { type ClipRange, clampClipRange, clipClock, defaultClipLabel } from './clips'
import { TimeField } from './TimeField'

/** A range the dialog offers as one click ("Chapter: Approve", "Selected piece"). */
export type ClipPreset = { key: string; label: string; range: ClipRange }

const KINDS: Array<{ kind: ClipKind; title: string; hint: string }> = [
  { kind: 'mp4', title: 'MP4', hint: 'Sound, up to 1280 px wide. For chat and mail.' },
  { kind: 'gif', title: 'GIF', hint: 'Silent, 640 px wide, 12 frames a second. Plays anywhere.' }
]

/**
 * "Make a clip" (#1562): the kind, the range (edited time, at most 30 s) and
 * a label. The server cuts it in the background; the clips list shows its
 * progress. The dialog closes once the clip is queued.
 */
export function ClipDialog({
  videoId,
  edits,
  draft,
  initial,
  presets,
  onQueued,
  onClose,
  container
}: {
  videoId: string
  /** The version's edits (the clip's times are edited time of it). */
  edits: VideoEdits
  /** Cut the draft (the editor) instead of the published version (the viewer). */
  draft: boolean
  /** The range to start from (the chapter or selection the click came from). */
  initial: ClipRange | null
  presets: ClipPreset[]
  onQueued: (clip: ClipDto) => void
  onClose: () => void
  container?: HTMLElement | null
}) {
  const client = useNivaroClient()
  const total = editedDuration(edits)
  const [kind, setKind] = useState<ClipKind>('mp4')
  const [range, setRange] = useState<ClipRange>(
    () =>
      initial ??
      clampClipRange({ start_ms: 0, end_ms: 10_000 }, total) ?? { start_ms: 0, end_ms: 0 }
  )
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const headingId = useId()
  const lengthMs = range.end_ms - range.start_ms
  const tooLong = lengthMs > CLIP_LIMITS.maxMs
  const tooShort = lengthMs < CLIP_LIMITS.minMs
  const placeholder = defaultClipLabel(edits, range)

  const setStart = (ms: number) => {
    const start = Math.max(0, Math.min(ms, total - CLIP_LIMITS.minMs))
    setRange((r) => ({ start_ms: start, end_ms: Math.max(start + CLIP_LIMITS.minMs, r.end_ms) }))
    setError(null)
  }
  const setEnd = (ms: number) => {
    const end = Math.max(CLIP_LIMITS.minMs, Math.min(ms, total))
    setRange((r) => ({ start_ms: Math.min(r.start_ms, end - CLIP_LIMITS.minMs), end_ms: end }))
    setError(null)
  }
  const make = async () => {
    if (inflight.current || pending || tooLong || tooShort) return
    inflight.current = true
    setPending(true)
    setError(null)
    try {
      const clip = await helpVideoApi(client).createClip(videoId, {
        kind,
        start_ms: range.start_ms,
        end_ms: range.end_ms,
        label: label.trim() || placeholder,
        draft
      })
      onQueued(clip)
      onClose()
    } catch (err) {
      const e = helpVideoError(err)
      setError(
        e?.code === 'HELP_VIDEO_CLIP_LIMIT'
          ? `A video can have at most ${CLIP_LIMITS.maxPerVideo} clips. Delete one to make another.`
          : e?.code === 'HELP_VIDEO_CLIP_NO_FFMPEG'
            ? 'This server cannot cut videos (ffmpeg is not installed).'
            : e?.code === 'HELP_VIDEO_CLIPS_MIGRATION_PENDING'
              ? 'Clips need a database migration this server has not run yet.'
              : (err as Error).message || 'The clip could not be queued.'
      )
    } finally {
      inflight.current = false
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent
        container={container}
        className='w-[calc(100vw-2rem)] max-w-[520px] dark:bg-card'
        aria-labelledby={headingId}
        data-hv-clip-dialog
      >
        <DialogHeader>
          <DialogTitle id={headingId} className='text-[16px] dark:text-foreground'>
            Make a clip
          </DialogTitle>
          <DialogDescription className='text-[13px] text-muted-foreground'>
            A short piece of the {draft ? 'draft' : 'video'} for chat, docs and mail — up to{' '}
            {CLIP_LIMITS.maxMs / 1000} seconds. It is cut from the finished video when the render is
            current; otherwise cuts, speed, crop and blurs are applied, and callouts, zooms, cards
            and music are left out.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-4'>
          <fieldset className='space-y-1.5'>
            <legend className='text-[12px] font-medium text-foreground'>Kind</legend>
            <div className='grid grid-cols-2 gap-2'>
              {KINDS.map((k) => {
                const on = kind === k.kind
                return (
                  <button
                    key={k.kind}
                    type='button'
                    aria-pressed={on}
                    onClick={() => setKind(k.kind)}
                    className={`flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${on ? 'border-nvr-cyan/60 bg-nvr-cyan/10' : 'border-border bg-background hover:bg-muted'}`}
                    data-hv-clip-kind={k.kind}
                  >
                    <span className='text-[13px] font-semibold text-foreground'>{k.title}</span>
                    <span className='text-[12px] leading-snug text-muted-foreground'>{k.hint}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>
          {presets.length > 0 && (
            <div className='space-y-1.5'>
              <p className='text-[12px] font-medium text-foreground'>Range</p>
              <div className='flex flex-wrap gap-1.5'>
                {presets.map((p) => {
                  const on = p.range.start_ms === range.start_ms && p.range.end_ms === range.end_ms
                  return (
                    <button
                      key={p.key}
                      type='button'
                      aria-pressed={on}
                      onClick={() => {
                        setRange(p.range)
                        setError(null)
                      }}
                      className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${on ? 'border-nvr-cyan/60 bg-nvr-cyan/10 text-foreground' : 'border-border bg-background text-foreground hover:bg-muted'}`}
                      data-hv-clip-preset={p.key}
                    >
                      <span className='truncate'>{p.label}</span>
                      <span className='shrink-0 tabular-nums text-muted-foreground'>
                        {clipClock(p.range.start_ms)}–{clipClock(p.range.end_ms)}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className='grid grid-cols-2 gap-3'>
            <TimeField
              label='Starts'
              ms={range.start_ms}
              onCommit={setStart}
              onInvalid={setError}
              earlier='Start 0.1 seconds earlier'
              later='Start 0.1 seconds later'
              data='clip-start'
            />
            <TimeField
              label='Ends'
              ms={range.end_ms}
              onCommit={setEnd}
              onInvalid={setError}
              earlier='End 0.1 seconds earlier'
              later='End 0.1 seconds later'
              data='clip-end'
            />
          </div>
          <p
            className={`text-[12px] ${tooLong || tooShort ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground'}`}
            role='status'
            data-hv-clip-length={lengthMs}
          >
            {tooLong
              ? `That is ${(lengthMs / 1000).toFixed(1)} s; a clip is at most ${CLIP_LIMITS.maxMs / 1000} s. Move the end earlier.`
              : tooShort
                ? 'A clip is at least half a second long.'
                : `${(lengthMs / 1000).toFixed(1)} seconds of the ${draft ? 'draft' : 'video'} (${clipClock(range.start_ms)} to ${clipClock(range.end_ms)}).`}
          </p>
          <div className='space-y-1'>
            <label
              htmlFor={`${headingId}-label`}
              className='text-[12px] font-medium text-foreground'
            >
              Label
            </label>
            <Input
              id={`${headingId}-label`}
              value={label}
              maxLength={CLIP_LIMITS.labelMax}
              placeholder={placeholder}
              onChange={(e) => setLabel(e.target.value)}
              className='h-8 text-[13px]'
              data-hv-clip-label
            />
          </div>
          {error && <ErrorNote data-hv-clip-error>{error}</ErrorNote>}
        </DialogBody>
        <DialogFooter className='flex-wrap border-border'>
          <Button variant='outline' onClick={() => !pending && onClose()} aria-disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => void make()}
            aria-disabled={pending || tooLong || tooShort}
            className={pending || tooLong || tooShort ? 'opacity-60' : undefined}
            data-hv-clip-make
          >
            {pending ? (
              <Loader2 className='h-4 w-4 animate-spin motion-reduce:animate-none' />
            ) : null}
            {pending ? 'Queuing…' : `Make ${kind.toUpperCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
