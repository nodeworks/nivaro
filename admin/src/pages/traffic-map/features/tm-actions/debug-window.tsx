/**
 * #2215 Debug a node for a while — from an endpoint, an API key or a person: for 15 minutes (or a
 * chosen time) its requests log at debug level and every trace touching it is kept, then it all
 * switches back on its own. Start and end land on the Ops Console incident timeline. Two clicks.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { fmtMs } from '../../EventTicker'
import { Empty, type InspectorData, Section } from '../../Inspector'
import { InspectLink } from '../../inspect/InspectLink'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import type { Selection } from '../../types'
import { inPage } from '../b1-shared'
import { untilPhrase } from '../breaker'
import { apiError, TwoClickButton } from '../ops-common'
import { LINK, ReadEmpty, SafeLink } from '../shared'
import { type DebugWindow, debugTargetOf, Segmented, useDebugWindows } from './shared'

const MINUTES: Array<[number, string]> = [
  [5, '5 min'],
  [15, '15 min'],
  [30, '30 min'],
  [60, '1 h']
]

interface KeptTrace {
  id: string
  method: string
  route: string
  status: number
  total_ms: number
  queries: number
  ts: string
}

function OpenWindow({ w }: { w: DebugWindow }) {
  const qc = useQueryClient()
  const traces = useQuery({
    queryKey: ['traffic-map', 'debug-window-traces', w.id],
    queryFn: async () =>
      ((await api.get(`/traffic-map/debug-windows/${w.id}/traces`)).data.data.traces ??
        []) as KeptTrace[],
    refetchInterval: 5000
  })
  const stop = async () => {
    try {
      await api.delete(`/traffic-map/debug-windows/${w.id}`)
      toast.success('Debug window closed; logging is back to normal')
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'debug-windows'] })
    } catch (e) {
      toast.error(apiError(e))
    }
  }
  const list = traces.data ?? []
  return (
    <div
      className='grid gap-1.5 rounded-md border border-[var(--tm-accent)] bg-[var(--tm-accent-soft)] px-2.5 py-2 text-[12px]'
      data-tm-debug-open={w.target}
    >
      <div className='font-medium text-[var(--tm-accent-ink)]'>
        Debugging {untilPhrase(w.until)}
      </div>
      <div className='text-[var(--tm-fg-2)]'>
        {w.matched.toLocaleString()} {w.matched === 1 ? 'request' : 'requests'} matched on this
        server, {w.kept.toLocaleString()} {w.kept === 1 ? 'trace' : 'traces'} kept
        {w.by_name ? ` — started by ${w.by_name}` : ''}
      </div>
      {list.length ? (
        <ul className='grid gap-0.5'>
          {list.slice(0, 8).map((t) => (
            <li key={t.id} className='flex min-w-0 items-baseline justify-between gap-2'>
              <InspectLink
                inspectRef={{ kind: 'trace', id: t.id, label: `${t.method} ${t.route}` }}
                className='font-mono text-[11.5px]'
              >
                {t.method} {t.route}
              </InspectLink>
              <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-fg-2)]'>
                {t.status} · {fmtMs(t.total_ms)} · {t.queries} trips
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className='text-[11.5px] text-[var(--tm-fg-2)]'>
        Debug lines go to the{' '}
        <SafeLink to='/ops-console' className={LINK}>
          Ops Console log
        </SafeLink>{' '}
        (filter on debug).
      </p>
      <div>
        <TwoClickButton
          id='tm-debug-stop'
          label='Stop now'
          armedLabel='Click again to stop debugging'
          onConfirm={() => void stop()}
        />
      </div>
    </div>
  )
}

function DebugWindowPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const target = debugTargetOf(sel)
  const qc = useQueryClient()
  const q = useDebugWindows()
  const [minutes, setMinutes] = useState(15)
  const [busy, setBusy] = useState(false)
  if (!target) return null
  const open = q.data?.windows.find((w) => w.target === target)
  const start = async () => {
    setBusy(true)
    try {
      await api.post('/traffic-map/debug-windows', { target, minutes })
      toast.success(`Debugging for ${minutes} min`)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'debug-windows'] })
    } catch (e) {
      toast.error(apiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section title='Debug window'>
      {q.isLoading || q.isError ? (
        <ReadEmpty loading={q.isLoading} error={q.isError} />
      ) : open ? (
        <OpenWindow w={open} />
      ) : q.data && !q.data.available ? (
        <Empty>Debug windows need Redis, which is not connected.</Empty>
      ) : (
        <div className='grid gap-2 text-[12px]' data-tm-debug-form={target}>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            For a while, every request touching{' '}
            {sel.kind === 'caller' ? 'this caller' : 'this endpoint'} logs at debug level and keeps
            its full trace, on every server. It switches back on its own and is noted on the
            incident timeline.
          </p>
          <div className='flex flex-wrap items-center gap-2'>
            <Segmented label='How long' value={minutes} options={MINUTES} onChange={setMinutes} />
            <TwoClickButton
              id='tm-debug-start'
              label={`Debug for ${MINUTES.find((m) => m[0] === minutes)?.[1] ?? `${minutes} min`}`}
              armedLabel='Click again to start'
              busy={busy}
              onConfirm={() => void start()}
            />
          </div>
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'debug-window',
  order: 27,
  applies: (sel) => debugTargetOf(sel) !== null,
  Component: inPage(DebugWindowPanel)
})
