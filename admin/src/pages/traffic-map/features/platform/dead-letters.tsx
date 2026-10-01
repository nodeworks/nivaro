/**
 * #1184 — dead letters as a sink. Failed flow runs (the dead letter queue) and webhook deliveries
 * that failed in the last day with no success since flow into one "Dead letters" node, with an
 * edge from each flow that left something there. Retry and Discard sit on the node: per item in
 * the inspector, and for everything listed in the inspector's action row. Both go through the
 * existing admin routes (POST /dead-letters/:id/retry|discard, POST /webhooks/deliveries/:id/retry)
 * and every one is a two-click confirm.
 */
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { Empty, t as hhmmss, Section } from '../../Inspector'
import { setDownLabel } from '../../nodeKinds'
import { canvasLayers, nodeProviders, sideBadges } from '../../registry/canvasLayers'
import { inspectorActions } from '../../registry/inspectorActions'
import { inspectorPanels } from '../../registry/inspectorPanels'
import { register } from '../../registry/registry'
import { toolbarItems } from '../../registry/toolbarItems'
import type { Selection } from '../../types'
import { ConfirmButton, errorOf, LINK, Note, SafeLink } from '../shared'
import {
  DEAD_LETTER_NODE,
  type DeadLetterData,
  deadLettersNow,
  setDeadLetters,
  useDeadLetters
} from './store'

setDownLabel(DEAD_LETTER_NODE, 'Dead letters')

/** Everything waiting in the sink. */
export function deadLetterCount(d: DeadLetterData | null): number {
  return (d?.flow_runs.count ?? 0) + (d?.deliveries.count ?? 0)
}

function DeadLetterPoller() {
  const q = useDeadLetters()
  useEffect(() => {
    if (q.data) setDeadLetters(q.data)
  }, [q.data])
  useEffect(() => () => setDeadLetters(null), [])
  return null
}
register(toolbarItems, { id: 'dead-letter-poller', order: 997, Component: DeadLetterPoller })

register(nodeProviders, {
  id: 'dead-letters',
  downs: () => (deadLetterCount(deadLettersNow()) > 0 ? [DEAD_LETTER_NODE] : [])
})

register(sideBadges, {
  id: 'dead-letters',
  badge(kind, id) {
    if (kind !== 'down' || id !== DEAD_LETTER_NODE) return null
    const n = deadLetterCount(deadLettersNow())
    return n > 0 ? { text: `${n.toLocaleString()} waiting`, tone: 'error' } : null
  }
})

/** flow source → dead letter node, for each flow with failed runs waiting. */
register(canvasLayers, {
  id: 'dead-letter-edges',
  order: 14,
  draw(ctx, { layout, tokens, active }) {
    const to = layout.downs[DEAD_LETTER_NODE]
    const byFlow = deadLettersNow()?.flow_runs.by_flow
    if (!to || !byFlow) return
    for (const [flowId, n] of Object.entries(byFlow)) {
      const from = layout.callers[flowId]
      if (!from || n <= 0) continue
      const on =
        (active?.kind === 'caller' && active.id === flowId) ||
        (active?.kind === 'down' && active.id === DEAD_LETTER_NODE)
      const a = { x: from.x + from.w, y: from.y + from.h / 2 + 8 }
      const b = { x: to.x, y: to.y + to.h / 2 + 8 }
      const mx = (a.x + b.x) / 2
      ctx.strokeStyle = tokens.error
      ctx.globalAlpha = on ? 0.9 : 0.35
      ctx.lineWidth = Math.min(3, 1 + Math.log10(1 + n))
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.bezierCurveTo(mx, a.y, mx, b.y, b.x, b.y)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }
  }
})

function useAct() {
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  async function run(key: string, fn: () => Promise<string>) {
    setBusy(key)
    setNote(null)
    try {
      setNote({ tone: 'ok', text: await fn() })
    } catch (err) {
      setNote({ tone: 'error', text: errorOf(err) })
    } finally {
      setBusy(null)
      void qc.invalidateQueries({ queryKey: ['traffic-map', 'dead-letters'] })
    }
  }
  return { busy, note, run }
}

const retryRun = (id: string) => api.post(`/dead-letters/${encodeURIComponent(id)}/retry`)
const discardRun = (id: string) => api.post(`/dead-letters/${encodeURIComponent(id)}/discard`)
const retryDelivery = (id: number) => api.post(`/webhooks/deliveries/${id}/retry`, {})

function DeadLetterList({ flow }: { flow?: string }) {
  const q = useDeadLetters()
  const { busy, note, run } = useAct()
  const d = q.data
  if (q.isLoading || !d) return <Empty>Reading the dead letter queue…</Empty>
  const runs = flow ? d.flow_runs.items.filter((r) => `flow:${r.flow}` === flow) : d.flow_runs.items
  const deliveries = flow ? [] : d.deliveries.items
  if (!runs.length && !deliveries.length)
    return <Empty>Nothing waiting — every failed run has been retried or discarded.</Empty>
  return (
    <div className='grid gap-2' data-tm-dead-letters=''>
      {runs.length > 0 && (
        <ul className='grid gap-2 text-[12px]'>
          {runs.slice(0, 12).map((r) => (
            <li key={r.id} className='grid gap-1' data-tm-dead-letter={r.id}>
              <span className='flex min-w-0 items-baseline justify-between gap-2'>
                <span className='min-w-0 truncate font-medium' title={r.flow_name ?? r.flow}>
                  {r.flow_name ?? 'Deleted flow'}
                </span>
                <span className='shrink-0 tabular-nums text-[11.5px] text-[var(--tm-muted)]'>
                  {r.failed_at ? hhmmss(r.failed_at) : ''}
                  {r.trigger ? ` · ${r.trigger}` : ''}
                </span>
              </span>
              {r.error && (
                <span
                  className='line-clamp-2 text-[11.5px] text-[var(--tm-error-ink)]'
                  title={r.error}
                >
                  {r.error}
                </span>
              )}
              <span className='flex flex-wrap gap-1.5'>
                <ConfirmButton
                  label='Retry'
                  confirmLabel='Run it again?'
                  busy={busy === `r:${r.id}`}
                  onConfirm={() =>
                    void run(`r:${r.id}`, async () => {
                      await retryRun(r.id)
                      return `Retried ${r.flow_name ?? 'the run'} — it runs in the background.`
                    })
                  }
                />
                <ConfirmButton
                  label='Discard'
                  confirmLabel='Drop it from the queue?'
                  danger
                  busy={busy === `d:${r.id}`}
                  onConfirm={() =>
                    void run(`d:${r.id}`, async () => {
                      await discardRun(r.id)
                      return 'Discarded. The run stays in the flow history.'
                    })
                  }
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {deliveries.length > 0 && (
        <>
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            Webhook deliveries that failed in the last {d.deliveries.hours} h with no success since:
          </p>
          <ul className='grid gap-1.5 text-[12px]'>
            {deliveries.slice(0, 8).map((x) => (
              <li
                key={x.id}
                className='flex min-w-0 flex-wrap items-baseline justify-between gap-2'
                data-tm-dead-delivery={x.id}
              >
                <span className='min-w-0 truncate'>
                  {x.webhook_name ?? `Webhook ${x.webhook}`}{' '}
                  <span className='font-mono text-[11px] text-[var(--tm-muted)]'>{x.event}</span>
                  {x.status_code != null && (
                    <span className='text-[var(--tm-error-ink)]'> · {x.status_code}</span>
                  )}
                </span>
                <ConfirmButton
                  label='Retry'
                  confirmLabel='Send it again?'
                  busy={busy === `w:${x.id}`}
                  onConfirm={() =>
                    void run(`w:${x.id}`, async () => {
                      const res = await retryDelivery(x.id)
                      const ok = (res?.data as { data?: { ok?: boolean } })?.data?.ok
                      return ok === false
                        ? 'Sent again — it failed again.'
                        : 'Sent again — it went through.'
                    })
                  }
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </div>
  )
}

function DeadLetterNodePanel() {
  const d = useDeadLetters().data
  return (
    <Section
      title={`Waiting${d ? ` · ${d.flow_runs.count.toLocaleString()} run${d.flow_runs.count === 1 ? '' : 's'}${d.deliveries.count ? `, ${d.deliveries.count} deliver${d.deliveries.count === 1 ? 'y' : 'ies'}` : ''}` : ''}`}
    >
      <DeadLetterList />
    </Section>
  )
}

function FlowDeadLetterPanel({ sel }: { sel: Selection }) {
  const d = useDeadLetters().data
  const n = d?.flow_runs.by_flow[sel.id] ?? 0
  if (!n) return null
  return (
    <Section title={`Dead letters from this flow · ${n}`}>
      <DeadLetterList flow={sel.id} />
    </Section>
  )
}

/** Node action row: retry or discard every run listed, and the full queue page. */
function DeadLetterActions() {
  const d = useDeadLetters().data
  const { busy, note, run } = useAct()
  const ids = d?.flow_runs.items.map((r) => r.id) ?? []
  async function each(fn: (id: string) => Promise<unknown>): Promise<{ ok: number; bad: number }> {
    let ok = 0
    let bad = 0
    for (const id of ids) {
      try {
        await fn(id)
        ok++
      } catch {
        bad++
      }
    }
    return { ok, bad }
  }
  return (
    <>
      {ids.length > 0 && (
        <ConfirmButton
          id='tm-dead-letters-retry-all'
          label={`Retry ${ids.length}`}
          confirmLabel={`Run ${ids.length} again?`}
          busy={busy === 'all-retry'}
          onConfirm={() =>
            void run('all-retry', async () => {
              const r = await each(retryRun)
              return `Retried ${r.ok}${r.bad ? `, ${r.bad} could not be` : ''}.`
            })
          }
        />
      )}
      {ids.length > 0 && (
        <ConfirmButton
          id='tm-dead-letters-discard-all'
          label={`Discard ${ids.length}`}
          confirmLabel={`Drop ${ids.length} from the queue?`}
          danger
          busy={busy === 'all-discard'}
          onConfirm={() =>
            void run('all-discard', async () => {
              const r = await each(discardRun)
              return `Discarded ${r.ok}${r.bad ? `, ${r.bad} could not be` : ''}.`
            })
          }
        />
      )}
      <SafeLink to='/dead-letters' className={LINK}>
        Open the queue
      </SafeLink>
      {note && <Note tone={note.tone}>{note.text}</Note>}
    </>
  )
}

register(inspectorActions, {
  id: 'dead-letters',
  applies: (sel) => sel.kind === 'down' && sel.id === DEAD_LETTER_NODE,
  Component: DeadLetterActions
})
register(inspectorPanels, {
  id: 'dead-letters-node',
  order: 20,
  applies: (sel) => sel.kind === 'down' && sel.id === DEAD_LETTER_NODE,
  Component: DeadLetterNodePanel
})
register(inspectorPanels, {
  id: 'dead-letters-flow',
  order: 40,
  applies: (sel) => sel.kind === 'caller' && sel.id.startsWith('flow:'),
  Component: FlowDeadLetterPanel
})
