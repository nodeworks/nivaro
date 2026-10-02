/** #1198 — one partner push: what was sent, what came back, who caused it, and Resend. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { fmtDuration, fmtWhen, hasMask, type Requester, type SubmissionDetail } from './logic'
import {
  ACTION_BTN,
  BodyBlock,
  ErrorText,
  Facts,
  LIST,
  Note,
  PanelError,
  PanelSkeleton,
  Row,
  Section,
  StatusPill
} from './ui'

function RequesterText({ r }: { r: Requester }) {
  const body = r.user ? (
    <InspectLink inspectRef={{ kind: 'caller', id: `u${r.user.id}`, label: r.user.name }}>
      {r.user.name}
    </InspectLink>
  ) : (
    r.label
  )
  return (
    <span data-tip={r.how ?? undefined} data-tm-inspect-submission-requester={r.basis}>
      {body}
      {r.basis === 'inferred' ? (
        <span className='ml-1 text-[11.5px] text-[var(--tm-muted)]'>(inferred)</span>
      ) : null}
    </span>
  )
}

/** Two clicks: the first arms (and says what will happen), the second sends. */
function Resend({ d }: { d: SubmissionDetail }) {
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 6000)
    return () => window.clearTimeout(t)
  }, [armed])
  const m = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/erp-submissions/${encodeURIComponent(d.id)}/retry`)
      return (res?.data as { data?: { status?: string; last_error?: string | null } })?.data
    },
    onSuccess: (row) => {
      setArmed(false)
      const status = row?.status ?? 'sent'
      if (status === 'failed' || status === 'rejected')
        toast.error(`Resent — the partner refused again: ${row?.last_error ?? status}`)
      else toast.success(`Resent — now ${status}`)
      void qc.invalidateQueries({ queryKey: ['tm-inspect', 'submission', d.id] })
      void qc.invalidateQueries({ queryKey: ['tm-inspect-peek', 'submission', d.id] })
    },
    onError: (err) => {
      setArmed(false)
      toast.error(`Resend failed: ${inspectErrorOf(err).message}`)
    }
  })
  const blocked = !d.retry.eligible
  return (
    <div className='grid gap-1.5' data-tm-inspect-submission-resend-box=''>
      <div className='flex flex-wrap items-center gap-2'>
        <button
          type='button'
          className={ACTION_BTN}
          disabled={blocked || m.isPending}
          data-tip={blocked ? (d.retry.reason ?? 'This push cannot be resent') : undefined}
          aria-label={armed ? 'Confirm resend' : 'Resend this push'}
          onClick={() => {
            if (!armed) setArmed(true)
            else m.mutate()
          }}
          data-tm-inspect-submission-resend={armed ? 'armed' : 'idle'}
        >
          <RotateCw className='h-3.5 w-3.5' aria-hidden='true' />
          {m.isPending ? 'Sending…' : armed ? 'Click again to send it' : 'Resend'}
        </button>
        {armed ? (
          <button
            type='button'
            className='text-[12px] text-[var(--tm-fg-2)] hover:underline'
            onClick={() => setArmed(false)}
            data-tm-inspect-submission-resend-cancel=''
          >
            Cancel
          </button>
        ) : null}
      </div>
      {armed ? (
        <Note hook='submission-resend-what'>
          Sends the stored payload to {d.partner.name ?? 'the partner'} again, unmasked, as it was
          first sent — a real call.
        </Note>
      ) : null}
      {blocked && d.retry.reason ? (
        <Note hook='submission-resend-blocked'>{d.retry.reason}</Note>
      ) : null}
      {d.retry.warning ? <Note hook='submission-resend-warning'>{d.retry.warning}</Note> : null}
    </div>
  )
}

export function SubmissionPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<SubmissionDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton hook='submission' />
  if (q.isError || !q.data)
    return (
      <PanelError
        kind='submission'
        id={inspectRef.id}
        error={q.error ?? new Error('Empty answer')}
      />
    )
  const d = q.data
  const recordId = d.collection && d.item ? `${d.collection}:${d.item}` : null
  const attempts = d.attempts
  return (
    <div className='grid gap-4' data-tm-inspect-submission={d.id}>
      <Facts
        items={[
          [
            'Partner',
            d.partner.id != null ? (
              <InspectLink
                key='link-137'
                inspectRef={{
                  kind: 'down',
                  id: `ext:${d.partner.id}`,
                  label: d.partner.name ?? undefined
                }}
              >
                {d.partner.name ?? `API ${d.partner.id}`}
              </InspectLink>
            ) : (
              'Unknown partner (the external API was deleted)'
            )
          ],
          ['Status', <StatusPill key='s' status={d.status} hook='submission-status' />],
          ['Endpoint', `${d.endpoint.method} ${d.endpoint.path ?? d.endpoint_path ?? '—'}`],
          ['Error class', d.error_class ?? '—'],
          [
            'Record',
            recordId ? (
              <InspectLink
                key='link-156'
                inspectRef={{ kind: 'record', id: recordId, label: d.record_label ?? undefined }}
              >
                {d.record_label ?? recordId}
              </InspectLink>
            ) : (
              '—'
            )
          ],
          ['Attempts', d.attempts_count == null ? '—' : String(d.attempts_count)],
          ['Requested by', <RequesterText key='r' r={d.triggered_by} />],
          ['Via', d.requested_via ?? d.triggered_by.via ?? '—'],
          ['Cause', d.trigger.label],
          ['Partner reference', d.external_ref ?? '—'],
          ['First sent', fmtWhen(d.created_at)],
          ['Last change', fmtWhen(d.updated_at)]
        ]}
      />
      {d.last_error ? (
        <Section title='Last error' hook='submission-error'>
          <ErrorText text={d.last_error} hook='submission' />
        </Section>
      ) : null}
      <Resend d={d} />
      <Section title='Obligation' hook='submission-obligation'>
        {d.obligation ? (
          <Facts
            items={[
              ['Kind', d.obligation.kind],
              ['Outcome', <StatusPill key='o' status={d.obligation.outcome} />],
              ['Due', fmtWhen(d.obligation.due_at)],
              [
                'Resolved',
                d.obligation.resolved_at ? fmtWhen(d.obligation.resolved_at) : 'Still open'
              ],
              d.obligation.reason ? ['Reason', d.obligation.reason] : null
            ]}
          />
        ) : (
          <Note hook='submission-no-obligation'>
            No obligation is linked: this push was not tracked as something the partner was owed (or
            it predates obligation tracking).
          </Note>
        )}
      </Section>
      <Section title='What was sent' hook='submission-bodies'>
        {hasMask(d.payload) || hasMask(d.response) ? (
          <Note hook='submission-masked'>
            Values under credential-like keys are masked here; Resend sends the stored payload as it
            was.
          </Note>
        ) : null}
        <BodyBlock
          label='Payload'
          value={d.payload}
          hook='submission-payload'
          empty='No payload stored — it was blanked after the retention window, or never kept.'
        />
        <BodyBlock
          label='Response'
          value={d.response}
          hook='submission-response'
          empty='No response stored — the call got none, or it was blanked after retention.'
        />
      </Section>
      <Section
        title={attempts ? `Attempts (${attempts.total})` : 'Attempts'}
        hook='submission-attempts'
      >
        {attempts ? (
          <>
            <ul className='grid gap-2'>
              {attempts.attempts.map((a) => (
                <li
                  key={a.attempt}
                  className='grid gap-1 rounded-md border border-[var(--tm-line)] p-2'
                  data-tm-inspect-attempt={a.attempt}
                >
                  <div className='flex flex-wrap items-baseline gap-2 text-[12.5px]'>
                    <span className='font-medium'>Attempt {a.attempt}</span>
                    <StatusPill status={a.status} />
                    {a.http_status != null ? (
                      <span className='text-[var(--tm-fg-2)]'>HTTP {a.http_status}</span>
                    ) : null}
                    <span className='text-[11.5px] text-[var(--tm-muted)]'>
                      {fmtWhen(a.at)} · from the{' '}
                      {a.source === 'call-log'
                        ? 'partner call log'
                        : a.source === 'current'
                          ? 'push itself'
                          : 'attempt history'}
                    </span>
                  </div>
                  {a.error ? <ErrorText text={a.error} /> : null}
                  <BodyBlock label='Sent' value={a.payload} hook={`attempt-${a.attempt}-payload`} />
                  <BodyBlock
                    label='Answer'
                    value={a.response}
                    hook={`attempt-${a.attempt}-response`}
                  />
                </li>
              ))}
            </ul>
            {attempts.unrecorded > 0 ? (
              <Note hook='submission-attempts-unrecorded'>
                {attempts.unrecorded} earlier attempt{attempts.unrecorded === 1 ? '' : 's'} left no
                record (made before attempt history was kept, and not in the partner call log).
              </Note>
            ) : null}
          </>
        ) : (
          <Note hook='submission-attempts-missing'>
            {d.attempts_reason ?? 'The attempts list could not be read.'}
          </Note>
        )}
      </Section>
      <Section title={`Partner calls (${d.call_logs.length})`} hook='submission-calls'>
        {d.call_logs.length ? (
          <ul className={LIST}>
            {d.call_logs.map((c) => (
              <Row key={c.id} aside={`${fmtWhen(c.created_at)} · ${fmtDuration(c.duration_ms)}`}>
                <span className='font-mono text-[11.5px]'>
                  {c.method ?? '?'} {c.status ?? (c.error ? 'no response' : '—')}
                </span>
                <span className='ml-1.5 text-[var(--tm-muted)]'>
                  {c.triggered_by ?? ''}
                  {c.user ? ` · ${c.user.name}` : ''}
                </span>
              </Row>
            ))}
          </ul>
        ) : (
          <Note hook='submission-no-calls'>
            No partner call-log rows matched this push (the call log keeps 30 days, and only calls
            whose body matches the stored payload are counted).
          </Note>
        )}
      </Section>
      <Note hook='submission-full'>
        {d.chain_id ? (
          <>
            <InspectLink inspectRef={{ kind: 'chain', id: d.chain_id }}>Event path</InspectLink>
            {' · '}
          </>
        ) : null}
        <Link
          to='/erp-submissions'
          className='text-[var(--tm-accent-ink)] hover:underline'
          data-tm-inspect-submission-full=''
        >
          Open ERP submissions
        </Link>
      </Note>
    </div>
  )
}
