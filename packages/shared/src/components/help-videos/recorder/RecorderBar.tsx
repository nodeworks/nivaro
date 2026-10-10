import { ChevronRight, Mic, MicOff, Pause, Play, Square } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { NO_BACKUP_SENTENCE } from './RecorderStatus'
import { frameNote, type Size, sizeLabel } from './recordingWindow'
import { NEXT_STEP_KEY_LABEL, teleprompterView } from './script'
import { LAST_MINUTE_MS, MAX_MS, WARN_MS } from './useScreenCapture'

/** m:ss from whole seconds. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The small control bar shown during the countdown and while recording.
 * It portals into `host`: the hosting [role="dialog"] when there is one, else
 * document.body (see HelpVideoRecorder). With a script (#1491) a teleprompter
 * strip sits above it: the current step large, the next one dimmed, and Next.
 */
export function RecorderBar({
  host,
  stage,
  count,
  elapsed,
  paused,
  muted,
  hasMic,
  micMissing,
  retrying,
  durable,
  announce,
  script,
  step = 0,
  frame,
  onCancel,
  onPause,
  onMute,
  onStop,
  onNext
}: {
  host: HTMLElement
  stage: 'countdown' | 'recording'
  count: number
  elapsed: number
  paused: boolean
  muted: boolean
  hasMic: boolean
  micMissing: boolean
  retrying: boolean
  /** False when parts live only in memory (no backup if the tab closes). */
  durable: boolean
  announce: string
  /** Script mode (#1491): the steps; `step` is the current one (0-based). */
  script?: string[] | null
  step?: number
  /** Inside a recording window (#1516): the size asked for and the real one. */
  frame?: { wanted: Size; actual: Size } | null
  onCancel: () => void
  onPause: () => void
  onMute: () => void
  onStop: () => void
  /** Marks the next step (absent or at the last step = nothing to move to). */
  onNext?: () => void
}) {
  const remainingS = Math.ceil((MAX_MS - elapsed) / 1000)
  const lastMinute = elapsed >= LAST_MINUTE_MS
  const place = useViewportCorner(host)
  const prompter = script?.length ? teleprompterView(script, step) : null
  const sizeNote = frame ? frameNote(frame.wanted, frame.actual) : null
  return createPortal(
    <div
      style={place ?? undefined}
      data-hv-recorder-bar
      className='nvr-rise-in fixed bottom-4 left-4 z-[140] flex max-w-[calc(100vw-2rem)] flex-col items-start gap-2 font-sans'
    >
      <span className='sr-only' aria-live='polite'>
        {announce}
      </span>
      {stage === 'recording' && prompter && (
        <section
          aria-label='Script'
          data-hv-teleprompter
          className='w-[min(440px,calc(100vw-2rem))] rounded-2xl bg-[#0b0f17] px-4 py-3 text-white shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_4px_rgba(0,0,0,0.15)] ring-1 ring-white/15'
        >
          <div className='flex items-center justify-between gap-3'>
            <span
              className='text-[11.5px] font-semibold uppercase tracking-wide text-white/60'
              data-hv-step-label
            >
              {prompter.label}
            </span>
            <button
              type='button'
              onClick={onNext}
              disabled={prompter.last || !onNext}
              title={prompter.last ? 'This is the last step' : `Next step (${NEXT_STEP_KEY_LABEL})`}
              className='inline-flex h-7 items-center gap-1 rounded-full bg-white/10 pl-2.5 pr-1.5 text-[12px] font-medium text-white transition-colors duration-150 hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40 disabled:hover:bg-white/10 motion-reduce:transition-none'
              data-hv-next-step
            >
              Next
              <kbd className='rounded bg-white/10 px-1 font-sans text-[10.5px] text-white/70'>
                {NEXT_STEP_KEY_LABEL}
              </kbd>
              <ChevronRight className='h-3.5 w-3.5' aria-hidden />
            </button>
          </div>
          <p
            className='mt-1.5 text-[15px] font-semibold leading-snug'
            aria-live='polite'
            data-hv-step-current
          >
            {prompter.current}
          </p>
          {prompter.next && (
            <p
              className='mt-1 truncate text-[12.5px] text-white/50'
              title={prompter.next}
              data-hv-step-next
            >
              Next: {prompter.next}
            </p>
          )}
        </section>
      )}
      <div
        role='toolbar'
        aria-label='Recording controls'
        className='flex max-w-full flex-wrap items-center gap-x-1 gap-y-1 rounded-full bg-[#0b0f17] py-1 pl-3.5 pr-1 text-[12.5px] font-medium text-white shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_4px_rgba(0,0,0,0.15)] ring-1 ring-white/15'
      >
        {stage === 'countdown' ? (
          <>
            <span data-hv-countdown className='pr-2'>
              Recording starts in <span className='tabular-nums font-semibold'>{count}</span>
            </span>
            <BarButton label='Cancel recording' onClick={onCancel}>
              Cancel
            </BarButton>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                paused ? 'bg-slate-400' : 'animate-pulse bg-rose-500 motion-reduce:animate-none'
              }`}
            />
            <span className='sr-only'>{paused ? 'Paused' : 'Recording'}</span>
            <span data-hv-timer className='ml-1 tabular-nums'>
              {clock(Math.floor(elapsed / 1000))}
            </span>
            {lastMinute ? (
              <span
                data-hv-remaining
                className='ml-1.5 rounded-full bg-amber-300 px-2 py-0.5 text-[11.5px] font-semibold tabular-nums text-amber-950'
              >
                {clock(remainingS)} left
              </span>
            ) : elapsed >= WARN_MS ? (
              <span className='ml-1.5 hidden text-white/70 sm:inline'>stops at 30:00</span>
            ) : null}
            {frame &&
              (sizeNote ? (
                <span
                  className='ml-1.5 text-amber-300'
                  title={sizeNote}
                  data-hv-frame-size
                  data-hv-frame-mismatch
                >
                  {sizeLabel(frame.actual)}
                  <span className='sr-only'> {sizeNote}</span>
                </span>
              ) : (
                <span className='ml-1.5 hidden text-white/70 sm:inline' data-hv-frame-size>
                  {sizeLabel(frame.actual)}
                </span>
              ))}
            {retrying && (
              <span className='ml-1.5 text-amber-300' data-hv-reconnecting>
                Reconnecting…
              </span>
            )}
            {!durable && (
              <span className='ml-1.5 text-amber-300' title={NO_BACKUP_SENTENCE} data-hv-no-backup>
                Keep this tab open
                <span className='sr-only'> {NO_BACKUP_SENTENCE}</span>
              </span>
            )}
            {micMissing && (
              <span
                className='ml-1.5 inline-flex text-white/70'
                title='No microphone was available, so this recording has no narration'
              >
                <MicOff className='h-3.5 w-3.5' aria-hidden />
                <span className='sr-only'>
                  No microphone was available, so this recording has no narration.
                </span>
              </span>
            )}
            <span aria-hidden className='mx-1.5 h-4 w-px bg-white/20' />
            <BarButton label={paused ? 'Resume' : 'Pause'} onClick={onPause}>
              {paused ? (
                <Play className='h-3.5 w-3.5 fill-current' />
              ) : (
                <Pause className='h-3.5 w-3.5 fill-current' />
              )}
            </BarButton>
            {hasMic && (
              <BarButton label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={onMute}>
                {muted ? <MicOff className='h-3.5 w-3.5' /> : <Mic className='h-3.5 w-3.5' />}
              </BarButton>
            )}
            <BarButton label='Stop recording' tone='stop' onClick={onStop} data-hv-stop>
              <Square className='h-3 w-3 fill-current' />
              <span>Stop</span>
            </BarButton>
          </>
        )}
      </div>
    </div>,
    host
  )
}

/**
 * Inside a host with a CSS transform (a centred dialog), `position: fixed`
 * is relative to the host, not the viewport. Offsets that put the bar 16 px
 * from the viewport's bottom-left again; null when no correction is needed.
 */
function useViewportCorner(host: HTMLElement): { left: number; bottom: number } | null {
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null)
  useLayoutEffect(() => {
    if (host === document.body) return
    const update = () => {
      if (getComputedStyle(host).transform === 'none') return setPlace(null)
      const rect = host.getBoundingClientRect()
      setPlace({ left: 16 - rect.left, bottom: rect.bottom - window.innerHeight + 16 })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [host])
  return place
}

function BarButton({
  label,
  onClick,
  children,
  tone = 'plain',
  ...rest
}: {
  label: string
  onClick: () => void
  children: ReactNode
  tone?: 'plain' | 'stop'
} & Record<`data-${string}`, unknown>) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`inline-flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-full px-2.5 text-white transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none ${
        tone === 'stop' ? 'bg-rose-600 hover:bg-rose-700' : 'hover:bg-white/10'
      }`}
      {...rest}
    >
      {children}
    </button>
  )
}
