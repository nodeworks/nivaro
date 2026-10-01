/**
 * #1096 — "Explain with AI": the selected node's own window (rate, latency, errors, kinds, top
 * routes and callers, recent errors, writes and live events) goes to /ai/brief; the answer is two
 * sentences plus where to look next. One call per click, admin only (the page is admin only).
 */
import { useMutation } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { useTrafficMap } from '../context'
import { callerLabel, fmtMs, fmtPct, fmtRate } from '../EventTicker'
import type { InspectorData } from '../Inspector'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection, TrafficCatalog, TrafficEventWire } from '../types'
import { KIND_ORDER } from '../types'
import { BTN, errorOf, Note } from './shared'

export const EXPLAIN_INSTRUCTIONS =
  'You are reading one node of a live API traffic map for an administrator. Using only the figures given, write exactly two plain sentences explaining what is happening (name the busiest route, caller or error code and the numbers that matter). Then, on its own line, write "Look next:" followed by one concrete place to look (a route, a caller, an error code, or a page such as API Analytics, Integrations, DB Health or Background jobs). No markdown, no lists.'

const WINDOW_TEXT: Record<number, string> = {
  60: '60 seconds',
  300: '5 minutes',
  900: '15 minutes'
}

/** The plain-text context sent to /ai/brief (pure; capped so one call stays small). */
export function explainContext(
  sel: Selection,
  d: InspectorData,
  events: TrafficEventWire[],
  catalog: TrafficCatalog | null,
  win: number
): string {
  const lines: string[] = []
  lines.push(`Node: ${d.name} (${d.type}). Window: last ${WINDOW_TEXT[win] ?? `${win} s`}.`)
  lines.push(
    `Requests per second ${fmtRate(d.rps)}; p95 latency ${fmtMs(d.p95)}; error rate ${fmtPct(d.errPct)}.`
  )
  lines.push(
    `Counts in window: ${KIND_ORDER.map((k, i) => `${k} ${Math.round(d.kinds[i] ?? 0)}`).join(', ')}.`
  )
  if (d.series.length) {
    lines.push(
      `Requests over the window (oldest first): ${d.series.map((v) => Math.round(v)).join(' ')}.`
    )
  }
  if (d.routes.length)
    lines.push(`Top routes: ${d.routes.map((r) => `${r.route} ×${Math.round(r.n)}`).join('; ')}.`)
  if (d.callers.length)
    lines.push(
      `Top callers: ${d.callers.map((c) => `${callerLabel(catalog, c.key)} ×${Math.round(c.n)}`).join('; ')}.`
    )
  if (d.errors.length) {
    lines.push('Recent errors:')
    for (const e of d.errors.slice(0, 8))
      lines.push(
        `- ${e.at} ${e.status} ${e.code ?? ''} ${e.route} by ${callerLabel(catalog, e.caller)}`.trim()
      )
  }
  if (d.writes.length) {
    lines.push('Recent writes:')
    for (const w of d.writes.slice(0, 6))
      lines.push(
        `- ${w.at} ${w.action} ${w.record} (${w.fields.slice(0, 5).join(', ')}) via ${w.via}`
      )
  }
  const mine = events
    .filter((ev) =>
      sel.kind === 'entity'
        ? `${ev.lane}/${ev.entity}` === sel.id
        : sel.kind === 'lane'
          ? ev.lane === sel.id
          : sel.kind === 'caller'
            ? ev.caller === sel.id
            : false
    )
    .slice(0, 12)
  if (mine.length) {
    lines.push('Latest live events:')
    for (const ev of mine)
      lines.push(
        `- ${new Date(ev.t).toISOString()} ${ev.kind} ${ev.route}${ev.status ? ` ${ev.status}` : ''}${ev.code ? ` ${ev.code}` : ''}${ev.ms != null ? ` ${ev.ms}ms` : ''}`
      )
  }
  return lines.join('\n').slice(0, 6000)
}

/** The answer split into the explanation and the "Look next:" line. */
export function splitBrief(text: string): { body: string; next: string | null } {
  const m = text.match(/^([\s\S]*?)\n?\s*Look next:\s*([\s\S]+)$/i)
  if (!m) return { body: text.trim(), next: null }
  return { body: m[1].trim(), next: m[2].trim() }
}

function ExplainSpike({ sel, d }: { sel: Selection; d: InspectorData }) {
  const { model, catalog, win } = useTrafficMap()
  const [answer, setAnswer] = useState<{ body: string; next: string | null } | null>(null)
  const m = useMutation({
    mutationFn: async () => {
      const res = await api.post('/ai/brief', {
        context: explainContext(sel, d, model.events, catalog, win),
        instructions: EXPLAIN_INSTRUCTIONS
      })
      return String((res?.data as { data?: { brief?: string } })?.data?.brief ?? '')
    },
    onSuccess: (text) => setAnswer(splitBrief(text))
  })
  const selKey = `${sel.kind}:${sel.id}`
  // A new selection starts clean; an answer belongs to the node it explained.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the selection only
  useEffect(() => {
    setAnswer(null)
    m.reset()
  }, [selKey])
  return (
    <>
      <button
        type='button'
        className={BTN}
        id='tm-explain'
        disabled={m.isPending}
        onClick={() => {
          setAnswer(null)
          m.mutate()
        }}
      >
        {m.isPending ? 'Explaining…' : 'Explain'}
      </button>
      {m.isError && <Note tone='error'>The explanation failed: {errorOf(m.error)}</Note>}
      {answer && (
        <div
          className='basis-full rounded-md border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-2.5 py-2 text-[12.5px] leading-relaxed text-[var(--tm-fg)]'
          data-tm-explain=''
          role='status'
        >
          <p>{answer.body || 'No explanation came back.'}</p>
          {answer.next && (
            <p className='mt-1 text-[12px] text-[var(--tm-fg-2)]'>
              <span className='font-medium text-[var(--tm-fg)]'>Look next:</span> {answer.next}
            </p>
          )}
        </div>
      )}
    </>
  )
}

register(inspectorActions, {
  id: 'explain-spike',
  order: 40,
  applies: () => true,
  Component: ExplainSpike
})
