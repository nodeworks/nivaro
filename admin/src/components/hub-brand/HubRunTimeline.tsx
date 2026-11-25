import { Check, Pause, X } from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { useHubProductFlag } from '@/lib/hub-product'
import { cn } from '@/lib/utils'

/**
 * The run timeline — the standalone Hub's visual signature for promotions, moves, upgrades and
 * creations: a horizontal track of steps (plan → run → check …), the current one lit and pulsing
 * while the run is live. A summary above the run's own step list, which stays the full,
 * accessible record; outside Hub mode this renders nothing.
 */

export type RunStepState =
  | 'done'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'stopped'
  | 'undone'
  | 'pending'

export interface RunStep {
  key: string
  label: string
  /** One or two words for the track itself; the full label stays in the caption and the tip. */
  short?: string
  state: RunStepState
}

const STATE_WORDS: Record<RunStepState, string> = {
  done: 'done',
  running: 'running',
  waiting: 'waiting',
  failed: 'failed',
  stopped: 'stopped',
  undone: 'undone',
  pending: 'not started'
}

/** The step to name in the summary: the live one, else a failed one, else the last done. */
export function focusStep(steps: RunStep[]): number {
  const live = steps.findIndex((s) => s.state === 'running' || s.state === 'waiting')
  if (live >= 0) return live
  const failed = steps.findIndex((s) => s.state === 'failed' || s.state === 'stopped')
  if (failed >= 0) return failed
  let last = -1
  steps.forEach((s, i) => {
    if (s.state === 'done') last = i
  })
  return last
}

export function HubRunTimeline({
  steps,
  live = false,
  what = 'Run'
}: {
  steps: RunStep[]
  /** The run is still going: the current step pulses. */
  live?: boolean
  what?: string
}) {
  const on = useHubProductFlag()
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const [moreLeft, setMoreLeft] = useState(false)
  const at = focusStep(steps)
  // A track wider than its box (a phone): keep the current step in view, and fade the edge
  // that has more steps behind it.
  useEffect(() => {
    const el = box.current
    if (!el) return
    const node = el.querySelectorAll<HTMLElement>('[data-track-step]')[Math.max(0, at)]
    if (node && el.scrollWidth > el.clientWidth)
      el.scrollLeft = Math.max(0, node.offsetLeft - el.clientWidth / 2 + node.offsetWidth / 2)
    const update = () => {
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 4)
      setMoreLeft(el.scrollLeft > 4)
    }
    update()
    el.addEventListener('scroll', update, { passive: true })
    return () => el.removeEventListener('scroll', update)
  }, [at])
  if (!on || steps.length === 0) return null
  const summary =
    at >= 0
      ? `${what}: step ${at + 1} of ${steps.length}, ${steps[at].label} — ${STATE_WORDS[steps[at].state]}`
      : `${what}: ${steps.length} steps, not started`
  const focus = at >= 0 ? steps[at] : null
  return (
    <div data-hub-run='' className='min-w-0 space-y-1.5'>
      <div
        ref={box}
        data-hub-run-timeline=''
        data-more={more ? '' : undefined}
        data-more-left={moreLeft ? '' : undefined}
        role='img'
        aria-label={summary}
        className='hub-track-scroll w-full min-w-0 max-w-full overflow-x-auto pb-1'
      >
        <ol aria-hidden className='m-0 flex min-w-max list-none items-start p-0'>
          {steps.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && (
                <li
                  className='hub-track-seg mt-[11px] h-[2px] w-6 shrink-0 rounded-full sm:w-10'
                  data-done={steps[i - 1].state === 'done' ? '' : undefined}
                />
              )}
              <li
                data-track-step=''
                data-tip={s.short && s.short !== s.label ? s.label : undefined}
                className='flex w-[76px] shrink-0 flex-col items-center gap-1.5 text-center'
              >
                <span
                  data-state={s.state}
                  data-hub-live={live && s.state === 'running' ? '' : undefined}
                  className='hub-track-node relative flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold'
                >
                  <NodeGlyph state={s.state} index={i} />
                </span>
                <span
                  className={cn(
                    'line-clamp-2 text-[11px] leading-tight',
                    s.state === 'pending' || s.state === 'undone'
                      ? 'text-muted-foreground'
                      : 'font-medium text-foreground'
                  )}
                >
                  {s.short ?? s.label}
                </span>
              </li>
            </Fragment>
          ))}
        </ol>
      </div>
      {focus && (
        <p
          aria-hidden
          className='m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-[12px] text-muted-foreground'
        >
          <span className='hub-fact shrink-0'>
            {at + 1}/{steps.length}
          </span>
          <span
            className={cn(
              'min-w-0 break-words font-medium',
              focus.state === 'failed' || focus.state === 'stopped'
                ? 'text-red-700 dark:text-red-300'
                : 'text-foreground'
            )}
          >
            {focus.label}
          </span>
          <span>— {STATE_WORDS[focus.state]}</span>
        </p>
      )}
    </div>
  )
}

function NodeGlyph({ state, index }: { state: RunStepState; index: number }) {
  if (state === 'done') return <Check className='h-3.5 w-3.5' strokeWidth={3} />
  if (state === 'failed') return <X className='h-3.5 w-3.5' strokeWidth={3} />
  if (state === 'stopped' || state === 'waiting')
    return <Pause className='h-3 w-3' strokeWidth={3} />
  return <span className='hub-fact relative'>{index + 1}</span>
}
