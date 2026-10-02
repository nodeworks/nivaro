/** #1197 — one flow run: how far it got, where it stopped, and a dry run of the same payload. */
import { useMutation } from '@tanstack/react-query'
import { Play } from 'lucide-react'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { type FlowDryRunAnswer, postFlowDryRun } from './data'
import { SubmissionList } from './lists'
import { type FlowDetail, fmtDuration, fmtWhen, hasMask } from './logic'
import {
  ACTION_BTN,
  BodyBlock,
  ErrorText,
  Facts,
  LIST,
  Note,
  PanelError,
  PanelSkeleton,
  Section,
  StatusPill
} from './ui'

/**
 * The dry run happens server-side from the run id alone: the server reads the run's stored
 * payload (the real values) and runs the flow as it is today in dry-run mode. The masked view
 * this panel shows is never what goes in.
 */
function DryRun({ runId }: { runId: string }) {
  const m = useMutation<FlowDryRunAnswer, unknown>({
    mutationFn: () => postFlowDryRun(runId)
  })
  return (
    <Section title='Dry run' hook='flow-dry-run'>
      <Note hook='flow-dry-run-what'>
        Runs the flow as it is today with this run’s stored payload — the real values, not the
        masked view above. Mail, notifications, webhooks and partner calls render without sending;
        the tester records its own run.
      </Note>
      <div>
        <button
          type='button'
          className={ACTION_BTN}
          disabled={m.isPending}
          onClick={() => m.mutate()}
          data-tm-inspect-flow-dry-run=''
        >
          <Play className='h-3.5 w-3.5' aria-hidden='true' />
          {m.isPending ? 'Running…' : 'Dry run with this payload'}
        </button>
      </div>
      {m.isError ? (
        <ErrorText text={`The dry run could not start: ${inspectErrorOf(m.error).message}`} />
      ) : null}
      {m.data ? (
        <div className='grid gap-1.5' data-tm-inspect-flow-dry-run-result={m.data.steps.length}>
          {m.data.payload_used === 'empty' ? (
            <Note hook='flow-dry-run-empty-payload'>
              The stored payload is not an object (text or a list), so the flow ran on an empty one.
            </Note>
          ) : null}
          {m.data.steps.length ? (
            <ol className={LIST}>
              {m.data.steps.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a step key can repeat in a loop
                <li key={`${s.key}-${i}`} className='grid gap-0.5 text-[12.5px]'>
                  <span className='flex items-baseline gap-2'>
                    <span className='tabular-nums text-[var(--tm-muted)]'>{i + 1}.</span>
                    <span className='min-w-0 truncate font-medium'>{s.name || s.key}</span>
                    <span className='text-[11.5px] text-[var(--tm-muted)]'>{s.type}</span>
                    <StatusPill status={s.status} />
                  </span>
                  {s.preview != null ? (
                    <BodyBlock label='Would send' value={s.preview} hook={`flow-step-${i}`} />
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <Note>No operation ran — the trigger’s conditions turned this payload away.</Note>
          )}
          {m.data.error ? <ErrorText text={m.data.error} /> : null}
        </div>
      ) : null}
    </Section>
  )
}

export function FlowPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<FlowDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton hook='flow' />
  if (q.isError || !q.data)
    return (
      <PanelError kind='flow' id={inspectRef.id} error={q.error ?? new Error('Empty answer')} />
    )
  const d = q.data
  const fromCron = d.chain_parent?.startsWith('cron:') ? d.chain_parent.slice(5) : null
  return (
    <div className='grid gap-4' data-tm-inspect-flow={d.id}>
      <div className='grid gap-1'>
        <p className='text-[13px] font-semibold text-[var(--tm-fg)]'>
          {d.flow?.name ?? 'Deleted flow'}
          {d.flow && !d.flow.active ? (
            <span className='ml-2 text-[11.5px] font-normal text-[var(--tm-muted)]'>
              inactive now
            </span>
          ) : null}
        </p>
        {d.flow?.description ? (
          <p className='text-[12.5px] leading-snug text-[var(--tm-fg-2)]'>{d.flow.description}</p>
        ) : null}
      </div>
      <Facts
        items={[
          ['Status', <StatusPill key='s' status={d.status} hook='flow-status' />],
          ['Trigger', d.trigger ?? '—'],
          ['Operations run', d.ops_run == null ? 'Not recorded' : String(d.ops_run)],
          [
            'Acted',
            d.matched == null
              ? 'Not recorded'
              : d.matched
                ? 'Yes — beyond its conditions'
                : 'No — stopped at a condition'
          ],
          ['Halted at', d.halted_at ?? '—'],
          ['Duration', fmtDuration(d.duration_ms)],
          ['Started', fmtWhen(d.started_at)],
          [
            'Run as',
            d.user ? (
              <InspectLink
                key='link-137'
                inspectRef={{ kind: 'caller', id: `u${d.user.id}`, label: d.user.name }}
              >
                {d.user.name}
              </InspectLink>
            ) : (
              'No person (an event or schedule)'
            )
          ],
          d.job
            ? [
                'Started by job',
                <InspectLink
                  key='j'
                  inspectRef={{ kind: 'job', id: d.job.id, label: `${d.job.job_id} run` }}
                >
                  {d.job.job_id}
                </InspectLink>
              ]
            : fromCron
              ? ['Started by job', fromCron]
              : null
        ]}
      />
      {d.error ? (
        <Section title='Error' hook='flow-error'>
          <ErrorText text={d.error} hook='flow' />
        </Section>
      ) : null}
      <Section title='Operations' hook='flow-operations'>
        <Note hook='flow-no-trace'>
          Live runs keep no step-by-step trace. This is the flow’s operation list as it is now (it
          may have changed since the run); the halted and failed marks come from the run.
        </Note>
        {d.operations.length ? (
          <ol className={LIST}>
            {d.operations.map((o) => (
              <li
                key={o.key}
                className='flex min-w-0 items-baseline gap-2 text-[12.5px]'
                data-tm-inspect-flow-op={o.key}
              >
                <span
                  className={cn(
                    'min-w-0 truncate',
                    (o.halted || o.failed) && 'font-semibold',
                    o.failed && 'text-[var(--tm-error-ink)]'
                  )}
                >
                  {o.name ?? o.key}
                </span>
                <span className='shrink-0 text-[11.5px] text-[var(--tm-muted)]'>{o.type}</span>
                {o.failed ? <StatusPill status='failed' /> : null}
                {o.halted && !o.failed ? <StatusPill status='halted here' /> : null}
                {o.next ? (
                  <span className='ml-auto shrink-0 text-[11.5px] text-[var(--tm-muted)]'>
                    then {o.next}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <Note>The flow has no operations now.</Note>
        )}
      </Section>
      <Section title='Payload' hook='flow-payload'>
        {hasMask(d.input) ? (
          <Note hook='flow-masked'>Values under credential-like keys are masked.</Note>
        ) : null}
        <BodyBlock label='What it was given' value={d.input} hook='flow-input' />
        <BodyBlock label='What it ended with' value={d.output} hook='flow-output' />
      </Section>
      {d.flow ? <DryRun runId={d.id} /> : null}
      {d.submissions.length ? (
        <Section
          title={`Partner pushes in its chain (${d.submissions.length})`}
          hook='flow-submissions'
        >
          <SubmissionList rows={d.submissions} />
        </Section>
      ) : null}
      <Note hook='flow-full'>
        {d.chain_id ? (
          <>
            <InspectLink inspectRef={{ kind: 'chain', id: d.chain_id }}>Event path</InspectLink>
            {' · '}
          </>
        ) : null}
        {d.flow ? (
          <Link
            to={`/flows/${d.flow.id}`}
            className='text-[var(--tm-accent-ink)] hover:underline'
            data-tm-inspect-flow-full=''
          >
            Open the flow
          </Link>
        ) : (
          'The flow was deleted.'
        )}
      </Note>
    </div>
  )
}
