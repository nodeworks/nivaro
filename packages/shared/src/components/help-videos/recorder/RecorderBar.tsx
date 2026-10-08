import { Mic, MicOff, Pause, Play, Square } from 'lucide-react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { LAST_MINUTE_MS, MAX_MS, WARN_MS } from './useScreenCapture'

/** m:ss from whole seconds. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The small control bar shown during the countdown and while recording.
 * It portals into `host`: the hosting [role="dialog"] when there is one, else
 * document.body (see HelpVideoRecorder).
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
  announce,
  onCancel,
  onPause,
  onMute,
  onStop
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
  announce: string
  onCancel: () => void
  onPause: () => void
  onMute: () => void
  onStop: () => void
}) {
  const remainingS = Math.ceil((MAX_MS - elapsed) / 1000)
  const lastMinute = elapsed >= LAST_MINUTE_MS
  return createPortal(
    <div
      data-hv-recorder-bar
      role='toolbar'
      aria-label='Recording controls'
      className='nvr-rise-in fixed bottom-4 left-4 z-[140] flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-x-1 gap-y-1 rounded-full bg-[#0b0f17] py-1 pl-3.5 pr-1 font-sans text-[12.5px] font-medium text-white shadow-[0_4px_16px_rgba(0,0,0,0.25),0_1px_4px_rgba(0,0,0,0.15)] ring-1 ring-white/15'
    >
      <span className='sr-only' aria-live='polite'>
        {announce}
      </span>
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
          {retrying && (
            <span className='ml-1.5 text-amber-300' data-hv-reconnecting>
              Reconnecting…
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
    </div>,
    host
  )
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
        tone === 'stop' ? 'bg-rose-600 hover:bg-rose-500' : 'hover:bg-white/10'
      }`}
      {...rest}
    >
      {children}
    </button>
  )
}
