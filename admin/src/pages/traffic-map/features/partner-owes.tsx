/**
 * #1094 — a partner node shows what it is owed: its missing, overdue and failed obligations and
 * its newest failed pushes, with Retry (re-send the stored payload) and Send now (remediation).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { fmtTime } from '../EventTicker'
import { Empty, type InspectorData, Section } from '../Inspector'
import { inspectorPanels } from '../registry/inspectorPanels'
import { register } from '../registry/registry'
import type { Selection } from '../types'
import { ConfirmButton, errorOf, LINK, Note } from './shared'

export interface PartnerOwes {
  api: { id: number; name: string }
  totals: Record<string, number>
  send_now: boolean
  obligations: Array<{
    id: number
    kind: string
    collection: string | null
    item: string | null
    outcome: string
    reason: string | null
    due_at: string
    submission_id: number | null
  }>
  submissions: Array<{
    id: number
    collection: string
    item: string
    attempts: number
    last_error: string | null
    updated_at: string
  }>
}

const OUTCOME_TEXT: Record<string, string> = {
  failed: 'Failed',
  missing: 'Never told',
  overdue: 'Overdue'
}

function recordLink(collection: string | null, item: string | null) {
  if (!collection || !item) return <span className='text-[var(--tm-muted)]'>no record</span>
  return (
    <Link to={`/collections/${collection}/${item}`} className={`${LINK} font-mono text-[11px]`}>
      {collection} {item}
    </Link>
  )
}

function PartnerOwesPanel({ sel }: { sel: Selection; d: InspectorData }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['traffic-map', 'partner-owes', sel.id],
    queryFn: async () =>
      (
        (await api.get('/traffic-map/partner-owes', { params: { id: sel.id } }))?.data as {
          data?: PartnerOwes
        }
      )?.data ?? null,
    staleTime: 15_000
  })
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const done = (text: string) => {
    setNote({ tone: 'ok', text })
    void qc.invalidateQueries({ queryKey: ['traffic-map', 'partner-owes', sel.id] })
  }
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/erp-submissions/${id}/retry`),
    onSuccess: (r, id) => {
      const status = (r?.data as { data?: { status?: string } })?.data?.status
      done(`Push #${id} re-sent${status ? ` — ${status}` : ''}.`)
    },
    onError: (e) => setNote({ tone: 'error', text: errorOf(e) })
  })
  const send = useMutation({
    mutationFn: (id: number) => api.post(`/integration-obligations/${id}/send`),
    onSuccess: (r, id) => {
      const detail = (r?.data as { data?: { detail?: string } })?.data?.detail
      done(`Obligation #${id}: ${detail ?? 'sent'}.`)
    },
    onError: (e) => setNote({ tone: 'error', text: errorOf(e) })
  })
  const data = q.data
  return (
    <Section title='What this partner is owed'>
      {q.isLoading ? (
        <Empty>Reading obligations…</Empty>
      ) : q.isError ? (
        <Empty>Obligations could not be read: {errorOf(q.error)}</Empty>
      ) : !data ? (
        <Empty>No obligations for this partner.</Empty>
      ) : (
        <div className='grid gap-2.5 text-[12px]' data-tm-partner-owes={data.api.name}>
          <div className='flex flex-wrap gap-1.5'>
            {(['missing', 'overdue', 'failed'] as const).map((k) => (
              <span
                key={k}
                className='inline-flex items-baseline gap-1 rounded-md border border-[var(--tm-line)] px-1.5 py-0.5 text-[11.5px]'
              >
                <span className='text-[var(--tm-fg-2)]'>{OUTCOME_TEXT[k]}</span>
                <span
                  className={`font-semibold tabular-nums ${data.totals[k] ? 'text-[var(--tm-error-ink)]' : ''}`}
                  data-tm-owes-total={k}
                >
                  {data.totals[k] ?? 0}
                </span>
              </span>
            ))}
            <Link to='/integration-health?tab=partners' className={`${LINK} ml-auto text-[11.5px]`}>
              Integrations
            </Link>
          </div>
          {data.obligations.length === 0 ? (
            <Empty>Nothing missing, overdue or failed.</Empty>
          ) : (
            <ul className='grid gap-1.5'>
              {data.obligations.map((o) => (
                <li
                  key={o.id}
                  className='grid gap-0.5 border-t border-[var(--tm-line-2)] pt-1.5 first:border-t-0 first:pt-0'
                  data-tm-obligation={o.id}
                >
                  <div className='flex flex-wrap items-baseline gap-x-2'>
                    <span className='font-medium text-[var(--tm-error-ink)]'>
                      {OUTCOME_TEXT[o.outcome] ?? o.outcome}
                    </span>
                    <span className='font-mono text-[11px] text-[var(--tm-fg-2)]'>{o.kind}</span>
                    {recordLink(o.collection, o.item)}
                    <span className='ml-auto font-mono text-[10.5px] tabular-nums text-[var(--tm-muted)]'>
                      due {fmtTime(o.due_at)}
                    </span>
                  </div>
                  {o.reason && <p className='text-[11.5px] text-[var(--tm-fg-2)]'>{o.reason}</p>}
                  {data.send_now && (
                    <div>
                      <ConfirmButton
                        label='Send now'
                        confirmLabel='Send it?'
                        busy={send.isPending && send.variables === o.id}
                        onConfirm={() => send.mutate(o.id)}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!data.send_now && data.obligations.length > 0 && (
            <Note>Send now is off for this deployment (Settings · Integrations).</Note>
          )}
          <h4 className='mt-1 text-[12px] font-medium text-[var(--tm-muted)]'>
            Newest failed pushes
          </h4>
          {data.submissions.length === 0 ? (
            <Empty>No failed pushes.</Empty>
          ) : (
            <ul className='grid gap-1.5'>
              {data.submissions.map((s) => (
                <li key={s.id} className='grid gap-0.5' data-tm-failed-push={s.id}>
                  <div className='flex flex-wrap items-baseline gap-x-2'>
                    <span className='font-mono text-[11px] tabular-nums'>#{s.id}</span>
                    {recordLink(s.collection, s.item)}
                    <span className='text-[11px] text-[var(--tm-muted)]'>
                      {s.attempts} attempt{s.attempts === 1 ? '' : 's'}
                    </span>
                    <span className='ml-auto'>
                      <ConfirmButton
                        label='Retry'
                        confirmLabel='Re-send?'
                        busy={retry.isPending && retry.variables === s.id}
                        onConfirm={() => retry.mutate(s.id)}
                      />
                    </span>
                  </div>
                  {s.last_error && (
                    <p
                      className='truncate font-mono text-[11px] text-[var(--tm-fg-2)]'
                      title={s.last_error}
                    >
                      {s.last_error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
          {note && <Note tone={note.tone}>{note.text}</Note>}
        </div>
      )}
    </Section>
  )
}

register(inspectorPanels, {
  id: 'partner-owes',
  order: 20,
  applies: (sel) => sel.kind === 'down' && /^ext:\d+$/.test(sel.id),
  Component: PartnerOwesPanel
})
