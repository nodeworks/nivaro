// #1100 — rewind the last 15 minutes. While paused (or on a frozen snapshot) the window becomes a
// timeline: drag back to any second the client ring holds and the map, strip, ticker and hot
// table show that second; Live returns to the present.
import { History } from 'lucide-react'
import type { TrafficModel } from './model'

const fmtClock = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
export function agoText(s: number): string {
  if (s <= 0) return 'now'
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} min ${r} s ago` : `${m} min ago`
}

export function RewindBar({
  model: m,
  win,
  viewSec,
  frozen,
  onRewind,
  onLive
}: {
  model: TrafficModel
  win: number
  viewSec: number | null
  frozen: boolean
  onRewind: (sec: number | null) => void
  onLive: () => void
}) {
  const { min, max } = m.rewindRange(win)
  const at = viewSec == null ? max : Math.min(max, Math.max(min, viewSec))
  const fineFrom = m.fineFrom
  const none = max - min < 5
  return (
    <section
      aria-label='Rewind'
      id='tm-rewind'
      className='mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[var(--tm-update)] bg-[var(--tm-card)] px-3.5 py-2 text-[12px]'
    >
      <span className='inline-flex items-center gap-1.5 font-semibold text-[var(--tm-fg)]'>
        <History className='h-3.5 w-3.5 text-[var(--tm-update)]' aria-hidden='true' />
        {frozen ? 'Scrub the snapshot' : 'Rewind'}
      </span>
      {none ? (
        <span className='text-[var(--tm-fg-2)]' id='tm-rewind-none'>
          {win === 900
            ? 'The 15-minute window already covers everything the map holds. Pick 1 or 5 minutes to rewind.'
            : 'Nothing earlier to rewind to yet.'}
        </span>
      ) : (
        <>
          <input
            type='range'
            id='tm-rewind-slider'
            min={min}
            max={max}
            step={1}
            value={at}
            onChange={(e) => {
              const v = Number(e.target.value)
              onRewind(v >= max ? null : v)
            }}
            aria-valuetext={`${fmtClock(at)}, ${agoText(max - at)}`}
            aria-label='Second to view'
            className='h-1.5 min-w-[180px] flex-1 cursor-pointer accent-[var(--tm-update)]'
          />
          <span className='tabular-nums text-[var(--tm-fg)]' data-tm-rewind-at={at}>
            {fmtClock(at)}
          </span>
          <span className='tabular-nums text-[var(--tm-fg-2)]'>{agoText(max - at)}</span>
        </>
      )}
      {!frozen ? (
        <button
          type='button'
          id='tm-live'
          onClick={onLive}
          className='ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--tm-update)] bg-[var(--tm-update)] px-2.5 py-[3px] text-[12px] font-medium leading-tight text-[var(--tm-on-update)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--tm-card)]'
        >
          Live
        </button>
      ) : null}
      {fineFrom != null && !none && at < fineFrom ? (
        <p className='basis-full text-[11.5px] text-[var(--tm-muted)]' id='tm-rewind-coarse'>
          Before {fmtClock(fineFrom)} the figures come from a 15-minute snapshot and move in steps
          of a few seconds; from then on they are per second.
        </p>
      ) : null}
    </section>
  )
}
