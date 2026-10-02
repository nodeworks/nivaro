/** #1195 — one AI call: what it cost, what it asked, what it answered. */
import { Link } from 'react-router'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { type AiDetail, fmtCost, fmtDuration, fmtInt, fmtWhen } from './logic'
import {
  BodyBlock,
  ErrorText,
  Facts,
  Note,
  PanelError,
  PanelSkeleton,
  Section,
  StatusPill
} from './ui'

export function AiPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<AiDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton hook='ai' />
  if (q.isError || !q.data)
    return <PanelError kind='ai' id={inspectRef.id} error={q.error ?? new Error('Empty answer')} />
  const d = q.data
  const t = d.tokens
  const lastMessage = (d.request?.messages.length ?? 0) - 1
  return (
    <div className='grid gap-4' data-tm-inspect-ai={d.id}>
      <Facts
        items={[
          ['Feature', d.feature ?? '—'],
          ['Status', <StatusPill key='s' status={d.status} hook='ai-status' />],
          ['Model', d.model ?? '—'],
          ['Provider', d.provider ?? '—'],
          ['Latency', fmtDuration(d.latency_ms)],
          ['Cost', fmtCost(d.cost_usd)],
          ['Tokens in / out', `${fmtInt(t.input)} / ${fmtInt(t.output)}`],
          ['Cache read / write', `${fmtInt(t.cache_read)} / ${fmtInt(t.cache_write)}`],
          ['Rounds', fmtInt(d.rounds)],
          ['Tool calls', fmtInt(d.tool_calls)],
          ['Stop reason', d.stop_reason ?? '—'],
          ['When', fmtWhen(d.created_at)],
          [
            'Who',
            d.user ? (
              <InspectLink
                key='link-44'
                inspectRef={{ kind: 'caller', id: `u${d.user.id}`, label: d.user.name }}
              >
                {d.user.name}
              </InspectLink>
            ) : (
              'No signed-in person (a job or the system)'
            )
          ],
          [
            'Request',
            d.request_id ? (
              <InspectLink
                key='link-54'
                inspectRef={{ kind: 'request', id: d.request_id, label: d.route ?? undefined }}
              >
                {d.route ?? d.request_id.slice(0, 8)}
              </InspectLink>
            ) : (
              'Not recorded'
            )
          ]
        ]}
      />
      {d.calls_in_request > 1 ? (
        <Note hook='ai-siblings'>
          This request made {d.calls_in_request} AI calls; the request level lists them all.
        </Note>
      ) : null}
      {d.error ? (
        <Section title='Error' hook='ai-error'>
          <ErrorText text={d.error} hook='ai' />
        </Section>
      ) : null}
      <Section title='What it asked' hook='ai-request'>
        {d.request ? (
          <div className='grid gap-1.5'>
            {d.request.tools.length ? (
              <Note hook='ai-tools'>Tools offered: {d.request.tools.join(', ')}</Note>
            ) : null}
            <BodyBlock label='System prompt' value={d.request.system} hook='ai-system' />
            {d.request.messages.map((m, i) => (
              <BodyBlock
                // biome-ignore lint/suspicious/noArrayIndexKey: messages have no id; order is the identity
                key={i}
                label={`${i + 1}. ${m.role}`}
                value={m.text}
                hook={`ai-message-${i}`}
                defaultOpen={i === lastMessage}
              />
            ))}
          </div>
        ) : d.request_raw ? (
          <>
            <Note hook='ai-request-cut'>
              The stored prompt was cut at the log's 48 KB cap, so it is shown as text.
            </Note>
            <BodyBlock label='Prompt (cut)' value={d.request_raw} hook='ai-request-raw' />
          </>
        ) : (
          <Note hook='ai-request-none'>The prompt was not stored for this call.</Note>
        )}
      </Section>
      <Section title='What it answered' hook='ai-response'>
        {d.response_text ? (
          <BodyBlock label='Answer' value={d.response_text} hook='ai-answer' defaultOpen />
        ) : (
          <Note hook='ai-response-none'>
            {d.status === 'error'
              ? 'No answer — the call failed (see the error above).'
              : 'The answer was not stored for this call.'}
          </Note>
        )}
      </Section>
      <Note hook='ai-retention'>
        AI calls are kept {d.kept_days} days.{' '}
        <Link
          to='/ai-analytics'
          className='text-[var(--tm-accent-ink)] hover:underline'
          data-tm-inspect-ai-full=''
        >
          Open AI analytics
        </Link>
      </Note>
    </div>
  )
}
