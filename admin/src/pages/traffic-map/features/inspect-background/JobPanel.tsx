/** #1196 — one background job run: what the job is, how the run went, and what it wrote. */
import { Link } from 'react-router'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { SubmissionList } from './lists'
import {
  fmtDuration,
  fmtWhen,
  isoMs,
  type JobDetail,
  jobStatusNote,
  triggerWords,
  writeLabel
} from './logic'
import {
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

function writesEmpty(d: JobDetail): string {
  if (d.writes.via === 'chain') return 'This run wrote nothing.'
  if (d.writes.via === 'window')
    return 'No writes found in this run’s window. The run predates chain tracking, so only writes stamped with this job inside its start–finish window are matched.'
  return 'This run recorded no chain id, so the writes it made cannot be attributed to it.'
}

export function JobPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useInspectDetail<JobDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton hook='job' />
  if (q.isError || !q.data)
    return <PanelError kind='job' id={inspectRef.id} error={q.error ?? new Error('Empty answer')} />
  const d = q.data
  const note = jobStatusNote(d)
  const node = d.instance_id
    ? `${d.instance ?? 'unknown instance'} · ${d.instance_id}${d.this_node ? ' (this node)' : ''}`
    : 'Not recorded (run predates node tracking)'
  return (
    <div className='grid gap-4' data-tm-inspect-job={d.id}>
      <div className='grid gap-1'>
        <p
          className='font-mono text-[12.5px] text-[var(--tm-fg)]'
          data-tm-inspect-job-id={d.job_id}
        >
          {d.job_id}
          {d.label ? <span className='ml-2 font-sans text-[var(--tm-fg-2)]'>{d.label}</span> : null}
        </p>
        {d.description ? (
          <p className='text-[12.5px] leading-snug text-[var(--tm-fg-2)]'>{d.description}</p>
        ) : (
          <Note hook='job-no-description'>
            {d.kind === 'cron' && d.registered === false
              ? 'No description: this process has not registered the job (renamed, removed, or registered only on another node).'
              : 'No description registered for this job.'}
          </Note>
        )}
      </div>
      <Facts
        items={[
          ['Status', <StatusPill key='s' status={d.status} hook='job-status' />],
          ['Kind', d.kind],
          ['Trigger', triggerWords(d.trigger_kind)],
          [
            'Started by',
            d.triggered_by ? (
              <InspectLink
                key='link-74'
                inspectRef={{
                  kind: 'caller',
                  id: `u${d.triggered_by.id}`,
                  label: d.triggered_by.name
                }}
              >
                {d.triggered_by.name}
              </InspectLink>
            ) : (
              'Nobody (the scheduler or code)'
            )
          ],
          ['Node', node],
          ['Scheduler lease', d.lease_holder ?? '—'],
          ['Started', fmtWhen(d.started_at)],
          ['Finished', fmtWhen(d.finished_at)],
          ['Duration', fmtDuration(d.duration_ms)],
          d.extension_id ? ['Extension', d.extension_id] : null,
          d.registry?.expression ? ['Schedule', d.registry.expression] : null,
          d.registry?.next_run ? ['Next run', fmtWhen(d.registry.next_run)] : null,
          d.ticks_enabled === false ? ['Ticks', 'Off on the process that ran it'] : null
        ]}
      />
      {note ? <Note hook='job-status-note'>{note}</Note> : null}
      {d.registry?.paused ? <Note hook='job-paused'>This job is paused now.</Note> : null}
      {d.error ? (
        <Section title='Error' hook='job-error'>
          <ErrorText text={d.error} hook='job' />
        </Section>
      ) : null}
      {d.outcome || d.progress != null ? (
        <Section title='Output' hook='job-output'>
          {d.outcome ? (
            <p className='whitespace-pre-wrap break-words text-[12.5px] text-[var(--tm-fg)]'>
              {d.outcome}
            </p>
          ) : null}
          {d.progress != null ? (
            <BodyBlock label='Last progress report' value={d.progress} hook='job-progress' />
          ) : null}
        </Section>
      ) : (
        <Note hook='job-no-output'>The job reported no outcome or progress.</Note>
      )}
      <Section
        title={`Writes (${d.writes.total.toLocaleString()})`}
        hook='job-writes'
        aside={
          d.chain_id ? (
            <InspectLink
              inspectRef={{ kind: 'chain', id: d.chain_id, label: `${d.job_id} chain` }}
              className='text-[12px]'
            >
              Event path
            </InspectLink>
          ) : null
        }
      >
        {d.writes.rows.length ? (
          <ul className={LIST}>
            {d.writes.rows.map((w) => (
              <Row key={w.id} aside={fmtWhen(w.at)}>
                <InspectLink
                  inspectRef={{
                    kind: 'write',
                    id: String(w.id),
                    at: isoMs(w.at),
                    label: writeLabel(w)
                  }}
                >
                  {writeLabel(w) || `Write ${w.id}`}
                </InspectLink>
              </Row>
            ))}
          </ul>
        ) : (
          <Note hook='job-writes-empty'>{writesEmpty(d)}</Note>
        )}
        {d.writes.total > d.writes.rows.length ? (
          <Note hook='job-writes-more'>
            Showing the newest {d.writes.rows.length} of {d.writes.total.toLocaleString()}.
          </Note>
        ) : null}
      </Section>
      {d.flows.length ? (
        <Section title={`Flows it ran (${d.flows.length})`} hook='job-flows'>
          <ul className={LIST}>
            {d.flows.map((f) => (
              <Row key={f.id} aside={f.status ?? ''}>
                <InspectLink
                  inspectRef={{
                    kind: 'flow',
                    id: f.id,
                    at: isoMs(f.started_at),
                    label: f.flow_name ?? undefined
                  }}
                >
                  {f.flow_name ?? 'Deleted flow'}
                </InspectLink>
              </Row>
            ))}
          </ul>
        </Section>
      ) : null}
      {d.submissions.length ? (
        <Section title={`Partner pushes (${d.submissions.length})`} hook='job-submissions'>
          <SubmissionList rows={d.submissions} />
        </Section>
      ) : null}
      <Note hook='job-full'>
        <Link
          to='/background-jobs'
          className='text-[var(--tm-accent-ink)] hover:underline'
          data-tm-inspect-job-full=''
        >
          Open Background Jobs
        </Link>
      </Note>
    </div>
  )
}
