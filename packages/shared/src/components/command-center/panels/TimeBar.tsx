import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { useArmedFaults } from '../../chaos/DrillBanner'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { useCc } from '../state'
import { BUTTON, FAINT, FOCUS, MUTED } from '../theme'
import { clockLabel, localDayStart, usePortalVars, whenLabel } from '../time'
import type { BoardBrief } from '../types'

const STEP_MS = 5 * 60_000
const DAYS_BACK = 7
const POP = 'border-[var(--cc-border)] bg-[var(--cc-panel)] text-[var(--cc-text)]'

/**
 * Small "Live only" mark for a panel that cannot show the past (rewound board) — or any short
 * note of the same kind. Text, never colour alone.
 */
export function LiveOnlyBadge({ label = 'Live only' }: { label?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-[var(--cc-border)] px-1.5 py-px text-[10.5px] font-medium ${MUTED}`}
      data-tip='This shows what is happening now, even while the board is rewound.'
      data-cc-live-only=''
    >
      {label}
    </span>
  )
}

/** The days the picker offers: today and the seven before it (local midnights, newest first). Pure. */
export function rewindDays(now: number): number[] {
  const out: number[] = []
  let d = localDayStart(now)
  for (let i = 0; i <= DAYS_BACK; i++) {
    out.push(d)
    // Step back over a 23- or 25-hour day safely.
    d = localDayStart(d - 3600_000)
  }
  return out
}

/** Clamp a picked instant into [day start, min(day end, now)] on a 5-minute grid. Pure. */
export function clampRewind(ms: number, day: number, now: number): number {
  const end = Math.min(localDayStart(day + 26 * 3600_000) - 1, now - 60_000)
  const snapped = Math.floor(ms / STEP_MS) * STEP_MS
  return Math.max(day, Math.min(end, snapped))
}

function dayLabel(day: number, now: number): string {
  const today = localDayStart(now)
  if (day === today) return 'Today'
  if (day === localDayStart(today - 3600_000)) return 'Yesterday'
  return new Date(day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * Shared time cursor (CC-15): "Live" or "Rewound to 2:10 PM — Back to live". Rewind opens a
 * scrubber over a day (today, or up to seven days back) that sets the board's `at`; every panel
 * reads it through useCcQuery, and those that cannot rewind say "Live only".
 */
export function TimeBar() {
  const cc = useCc()
  const vars = usePortalVars()
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [open])
  const days = useMemo(() => rewindDays(now), [now])
  const [day, setDay] = useState(() => localDayStart(cc.at ?? Date.now()))
  const [draft, setDraftRaw] = useState<number>(() => cc.at ?? Date.now() - 30 * 60_000)
  // Only a value the person picked is committed — opening the picker never rewinds by itself.
  const [touched, setTouched] = useState(false)
  const setDraft = (ms: number) => {
    setTouched(true)
    setDraftRaw(ms)
  }
  const { at, setAt } = cc
  useEffect(() => {
    if (!open) setTouched(false)
  }, [open])

  // Commit the scrubber a moment after it stops moving (each commit refetches every panel).
  useEffect(() => {
    if (!open || !touched) return
    const t = setTimeout(() => {
      if (draft !== at) setAt(draft)
    }, 400)
    return () => clearTimeout(t)
  }, [draft, open, touched, at, setAt])

  const dayEnd = Math.min(localDayStart(day + 26 * 3600_000) - 1, now - 60_000)

  if (cc.at != null && !open) {
    return (
      <span
        className='inline-flex items-center gap-1 rounded-full bg-amber-500/15 py-0.5 pl-2.5 pr-1 text-[12px] text-[var(--cc-text)]'
        data-cc-rewound=''
      >
        <button
          type='button'
          className={`rounded-full font-medium ${FOCUS}`}
          onClick={() => {
            setDay(localDayStart(cc.at as number))
            setDraftRaw(cc.at as number)
            setOpen(true)
          }}
          aria-label={`Rewound to ${whenLabel(cc.at)} — change`}
        >
          Rewound to {whenLabel(cc.at)}
        </button>
        <button
          type='button'
          className={`rounded-full bg-[var(--cc-panel)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--cc-strong)] hover:bg-[var(--cc-chip-hover)] ${FOCUS}`}
          onClick={() => cc.setAt(null)}
        >
          Back to live
        </button>
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={`${BUTTON} ${FOCUS} inline-flex items-center gap-1.5`}
          aria-label={cc.at ? `Rewound to ${whenLabel(cc.at)}` : 'Live — rewind the board'}
        >
          {cc.at == null ? (
            <>
              <span className='h-1.5 w-1.5 rounded-full bg-[var(--cc-people)]' aria-hidden />
              Live
              <span className={FAINT}>· Rewind</span>
            </>
          ) : (
            <>Rewound to {whenLabel(cc.at)}</>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={`w-[340px] p-3 ${POP}`} style={vars}>
        <p className='text-[12.5px] font-semibold text-[var(--cc-strong)]'>Rewind the board</p>
        <p className={`mt-0.5 text-[11.5px] ${MUTED}`}>
          Panels show what they showed then; a few can only show now and say so.
        </p>
        <fieldset className='mt-2.5 flex flex-wrap gap-1' aria-label='Day'>
          {days.map((d) => (
            <button
              key={d}
              type='button'
              aria-pressed={day === d}
              onClick={() => {
                setDay(d)
                setDraft(clampRewind(d === days[0] ? now - 30 * 60_000 : d + 12 * 3600_000, d, now))
              }}
              className={`rounded-full px-2 py-0.5 text-[11.5px] ${FOCUS} ${
                day === d
                  ? 'bg-nvr-cyan/15 font-medium text-[var(--cc-strong)]'
                  : 'bg-[var(--cc-chip)] hover:bg-[var(--cc-chip-hover)]'
              }`}
            >
              {dayLabel(d, now)}
            </button>
          ))}
        </fieldset>
        <label className='mt-3 block text-[11.5px]' htmlFor='cc-rewind-scrubber'>
          <span className={MUTED}>Time</span>{' '}
          <b className='tabular-nums text-[var(--cc-strong)]'>{clockLabel(draft)}</b>
        </label>
        <input
          id='cc-rewind-scrubber'
          type='range'
          min={day}
          max={dayEnd}
          step={STEP_MS}
          value={Math.max(day, Math.min(dayEnd, draft))}
          onChange={(e) => setDraft(clampRewind(Number(e.target.value), day, now))}
          className={`mt-1 w-full accent-[#0891b2] ${FOCUS}`}
          aria-valuetext={whenLabel(draft, now)}
        />
        <div className={`flex justify-between text-[10.5px] tabular-nums ${FAINT}`}>
          <span>12 AM</span>
          <span>{day === days[0] ? 'Now' : '11:59 PM'}</span>
        </div>
        <div className='mt-3 flex items-center justify-between gap-2'>
          <button
            type='button'
            className={`${BUTTON} ${FOCUS}`}
            onClick={() => {
              cc.setAt(null)
              setOpen(false)
            }}
          >
            Back to live
          </button>
          <button
            type='button'
            className={`rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-medium text-white ${FOCUS}`}
            onClick={() => {
              cc.setAt(draft)
              setOpen(false)
            }}
          >
            Show {clockLabel(draft)}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * "What changed?" (CC-18): a short summary of the last hour from the figures the viewer's own
 * panels show (POST /command-center/brief, cached a few minutes per person). Not on a wallboard
 * link (it is a person's request).
 */
export function BriefButton() {
  const cc = useCc()
  const client = useNivaroClient()
  const vars = usePortalVars()
  const { armed } = useArmedFaults()
  const [open, setOpen] = useState(false)
  const m = useMutation({
    mutationFn: (fresh: boolean) =>
      client
        .request<{ data: BoardBrief }>(
          post('/command-center/brief', {
            ...(cc.region ? { region: cc.region } : {}),
            ...(cc.at ? { at: new Date(cc.at).toISOString() } : {}),
            drill: armed.length > 0,
            fresh
          })
        )
        .then((r) => r.data)
  })
  const { mutate, reset } = m
  // Ask on open, and again when the lenses change while open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lenses re-ask
  useEffect(() => {
    if (open) mutate(false)
    else reset()
  }, [open, cc.region, cc.at])
  if (cc.kiosk) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type='button' className={`${BUTTON} ${FOCUS}`}>
          What changed?
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={`w-[360px] p-3 ${POP}`} style={vars}>
        <div className='flex items-center justify-between gap-2'>
          <p className='text-[12.5px] font-semibold text-[var(--cc-strong)]'>
            {cc.at ? `The hour before ${clockLabel(cc.at)}` : 'The last hour'}
          </p>
          <button
            type='button'
            className={`${BUTTON} ${FOCUS}`}
            disabled={m.isPending}
            onClick={() => mutate(true)}
          >
            Refresh
          </button>
        </div>
        <div
          className='mt-2 text-[12.5px] leading-relaxed'
          aria-live='polite'
          aria-busy={m.isPending}
        >
          {m.isPending ? (
            <p className={MUTED}>Putting it together…</p>
          ) : m.isError ? (
            <p className='text-[var(--cc-bad-text)]'>
              Could not put the summary together. Try Refresh.
            </p>
          ) : m.data ? (
            <>
              <p className='whitespace-pre-line'>{m.data.text}</p>
              <p className={`mt-2 text-[11px] ${FAINT}`}>
                Written {clockLabel(new Date(m.data.generated_at).getTime())} from the figures on
                this board.
              </p>
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
