/**
 * Live-ticker row actions: a write a cron tick or flow made opens that run; an event that names
 * a partner call opens the matching push. Each resolves on click (never per row on render) and
 * starts a new investigation at that level.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { inspectErrorOf } from '../../inspect/api'
import { openInspect } from '../../inspect/stack'
import type { TrafficEventWire } from '../../types'
import { fetchRunFor, fetchSubmissionsFor } from './data'
import { outboundApiOf, runKindOf } from './logic'

const ROW_LINK =
  'rounded-sm px-1 text-[11px] font-medium text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-50'

function useBusy(): [boolean, (fn: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false)
  return [
    busy,
    (fn) => {
      if (busy) return
      setBusy(true)
      void fn().finally(() => setBusy(false))
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

function PartnerPushAction({ ev }: { ev: TrafficEventWire }) {
  const [busy, run] = useBusy()
  const apiId = outboundApiOf(ev)
  if (apiId == null) return null
  return (
    <button
      type='button'
      className={ROW_LINK}
      disabled={busy}
      data-tm-open-submission={apiId}
      title='Inspect the partner push behind this'
      onClick={(e) => {
        e.stopPropagation()
        run(async () => {
          try {
            const found = await fetchSubmissionsFor({
              api: apiId,
              chain: ev.chain ?? null,
              at: ev.t,
              window: 60
            })
            const first = found.rows[0]
            if (!first) {
              toast.message('No stored push to that partner matches this moment.')
              return
            }
            openInspect(
              {
                kind: 'submission',
                id: String(first.id),
                at: ev.t,
                label: `Push #${first.id}${first.api_name ? ` → ${first.api_name}` : ''}`
              },
              { root: true }
            )
          } catch (err) {
            toast.error(`Could not find the push: ${inspectErrorOf(err).message}`)
          }
        })
      }}
    >
      Push
    </button>
  )
}

export function JobRunAction({ ev }: { ev: TrafficEventWire }) {
  return <RunAction ev={ev} />
}

export function FlowRunAction({ ev }: { ev: TrafficEventWire }) {
  return <RunAction ev={ev} />
}

export { PartnerPushAction }
