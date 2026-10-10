/**
 * Skip inactivity (#1358) — the player half: the per-frame speed / jump
 * driver, the "skipped 2m 10s" bands on the scrubber, the toggle and the
 * "skipping" badge over the frame. The decisions are in ./inactivity.
 */
import { FastForward } from 'lucide-react'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { fmtSkip, type InactiveGap, SKIP_GAP_MS, SKIP_SPEED, skipDecision } from './inactivity'

const PREF_KEY = 'nvr.replay.skipInactive'

function readPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) !== '0'
  } catch {
    return true
  }
}

interface ReplayerLike {
  play: (t?: number) => void
  setConfig: (c: { speed?: number }) => void
}

/**
 * Drives the replayer across inactive gaps. `onTick(time)` runs from the
 * player's animation frame while playing; it switches to 8× inside a gap,
 * jumps over a long one, and puts the chosen speed back after.
 */
export function useSkipInactivity(
  replayerRef: { current: ReplayerLike | null },
  gaps: InactiveGap[],
  userSpeed: number,
  active: boolean
) {
  const [enabled, setEnabledState] = useState(readPref)
  const [current, setCurrent] = useState<InactiveGap | null>(null)
  const appliedSpeed = useRef<number | null>(null)
  const state = useRef({ gaps, userSpeed, enabled, active })
  state.current = { gaps, userSpeed, enabled, active }

  // The user picked a speed (or switched skipping off): the next frame re-decides.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on these inputs on purpose
  useEffect(() => {
    appliedSpeed.current = null
  }, [userSpeed, enabled, active, gaps])

  const setEnabled = useCallback(
    (on: boolean) => {
      setEnabledState(on)
      try {
        window.localStorage.setItem(PREF_KEY, on ? '1' : '0')
      } catch {
        /* private window — this visit only */
      }
      if (!on) {
        setCurrent(null)
        const rep = replayerRef.current
        if (rep) rep.setConfig({ speed: state.current.userSpeed })
      }
    },
    [replayerRef]
  )

  const onTick = useCallback(
    (time: number) => {
      const rep = replayerRef.current
      const s = state.current
      if (!rep || !s.active) return
      const d = skipDecision(s.gaps, time, s.userSpeed, s.enabled)
      if (d.seekTo != null && time < d.seekTo - 100) {
        rep.play(d.seekTo)
        return
      }
      if (appliedSpeed.current !== d.speed) {
        appliedSpeed.current = d.speed
        rep.setConfig({ speed: d.speed })
      }
      setCurrent((prev) => (prev === d.gap ? prev : d.gap))
    },
    [replayerRef]
  )

  return { enabled, setEnabled, current: active ? current : null, onTick }
}

/** Hatched bands over the scrubber where the player skips, labelled when there is room. */
export const SkipBands = memo(function SkipBands({
  gaps,
  total,
  enabled
}: {
  gaps: InactiveGap[]
  total: number
  enabled: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth || 600)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 600))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  if (!(total > 0) || gaps.length === 0) return <div ref={ref} className='hidden' />
  return (
    <div
      ref={ref}
      // The range input is 16 px tall with a 2 px margin: the band sits on its track.
      className='pointer-events-none absolute inset-x-0 top-1 z-[1] h-3'
      data-replay-skip-bands=''
    >
      {gaps.map((g) => {
        const left = Math.max(0, g.start / total)
        const w = Math.max(0, Math.min(1, g.end / total) - left)
        const label = `${enabled ? 'skipped' : 'idle'} ${fmtSkip(g.end - g.start)}`
        return (
          <div
            key={`${g.start}:${g.end}`}
            className='absolute top-0 flex h-full items-center justify-center overflow-hidden rounded-sm border border-slate-300/70 dark:border-slate-600/70'
            style={{
              left: `${left * 100}%`,
              width: `${w * 100}%`,
              background: enabled
                ? 'repeating-linear-gradient(135deg, rgba(148,163,184,.35) 0 3px, rgba(148,163,184,.08) 3px 6px)'
                : 'rgba(148,163,184,.15)'
            }}
            title={label}
            data-replay-skip=''
          >
            {w * width >= 76 && (
              <span className='whitespace-nowrap px-1 text-[9.5px] font-medium leading-none text-slate-500 dark:text-slate-300'>
                {label}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
})

/** "Skip idle" on/off beside the speed buttons. */
export function SkipToggle({
  enabled,
  onChange,
  count
}: {
  enabled: boolean
  onChange: (on: boolean) => void
  count: number
}) {
  return (
    <button
      type='button'
      aria-pressed={enabled}
      onClick={() => onChange(!enabled)}
      className={
        enabled
          ? 'flex items-center gap-1 rounded-md border border-slate-200 bg-accent px-1.5 py-1 text-[10.5px] font-medium text-nvr-navy dark:border-border dark:text-nvr-cyan'
          : 'flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-1 text-[10.5px] text-slate-400 dark:border-border'
      }
      data-tip={
        enabled
          ? `Skipping ${count} idle stretch${count === 1 ? '' : 'es'} (over ${SKIP_GAP_MS / 1000} s with no input or page change) at ${SKIP_SPEED}× — click to play in real time`
          : 'Real time — click to skip stretches with no input or page change'
      }
      data-replay-skip-toggle=''
    >
      <FastForward className='h-3 w-3' />
      {enabled ? 'Skip idle' : 'Real time'}
    </button>
  )
}

/** Over the frame while a gap is being crossed. */
export function SkippingBadge({ gap }: { gap: InactiveGap | null }) {
  if (!gap) return null
  return (
    <span
      className='pointer-events-none absolute right-2 top-2 z-10 flex items-center gap-1 rounded-full bg-slate-900/75 px-2.5 py-1 text-[11px] font-medium text-white shadow'
      data-replay-skipping=''
    >
      <FastForward className='h-3 w-3' />
      Skipping {fmtSkip(gap.end - gap.start)} of inactivity
    </span>
  )
}
