/**
 * Live-ticker row actions: a write a cron tick or flow made opens that run. Each resolves on
 * click (never per row on render) and starts a new investigation at that level.
 *
 * There is no "Push" action: no tap stamps a partner API on a ticker event, so nothing could
 * ever apply. Pushes are reached from the partner node's footer and from the job / flow panels.
 */
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { inspectErrorOf } from '../../inspect/api'
import { openInspect } from '../../inspect/stack'
import type { TrafficEventWire } from '../../types'
import { fetchRunFor } from './data'
import { runKindOf } from './logic'

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50'

/**
 * One in-flight resolve at a time. The guard is a ref, not the rendered state: two clicks in
 * the same tick both see the stale `busy` of the render they came from, so state alone would
 * let both through and open the level twice.
 */
function useBusy(): [boolean, (fn: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  return [
    busy,
    (fn) => {
      if (inFlight.current) return
      inFlight.current = true
      setBusy(true)
      void fn().finally(() => {
        inFlight.current = false
        setBusy(false)
      })
    }
  ]
}

function RunAction({ ev }: { ev: TrafficEventWire }) {
  const [busy, run] = useBusy()
  const kind = runKindOf(ev.run)
  if (!kind || !ev.run) return null
  const name = ev.run.slice(ev.run.indexOf(':') + 1)
  const source = ev.run
  return (
    <button
      type='button'
      className={ROW_LINK}
      disabled={busy}
      data-tm-open-run={source}
      title={
        kind === 'cron' ? `Inspect the ${name} run behind this` : 'Inspect the flow run behind this'
      }
      onClick={(e) => {
        e.stopPropagation()
        run(async () => {
          try {
            const pick = await fetchRunFor(source, ev.t)
            if (!pick) {
              toast.message(
                kind === 'cron'
                  ? `No recorded run of ${name} covers this moment (quiet jobs keep only failed ticks).`
                  : 'No recorded run of this flow covers this moment.'
              )
              return
            }
            openInspect(
              {
                kind: pick.kind,
                id: pick.id,
                at: ev.t,
                label: kind === 'cron' ? `${name} run` : undefined
              },
              { root: true }
            )
          } catch (err) {
            toast.error(`Could not find the run: ${inspectErrorOf(err).message}`)
          }
        })
      }}
    >
      {kind === 'cron' ? 'Run' : 'Flow'}
    </button>
  )
}

export function JobRunAction({ ev }: { ev: TrafficEventWire }) {
  return <RunAction ev={ev} />
}

export function FlowRunAction({ ev }: { ev: TrafficEventWire }) {
  return <RunAction ev={ev} />
}
