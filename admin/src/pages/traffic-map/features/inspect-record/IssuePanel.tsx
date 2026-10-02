/**
 * #1201 — one issue from the issue log: what failed, how often, the stack, the screenshot, and
 * the replay of the moment (opens the recording). Opened by issue id, or as `rid:<request>` —
 * the open server issue that request raised, matched by route and time.
 */
import { Link } from 'react-router'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { LINK } from '../shared'
import { fmtStamp } from './logic'
import { Block, Facts, LoadFailed, Mono, Note, Skeleton } from './ui'
import { WatchWhatTheySaw } from './WatchFooter'

interface IssueRecording {
  id: string
  user_name: string | null
  clip: boolean
  offset_ms: number | null
  at: number | null
}

type IssueDetail =
  | { none: true; reason: string | null; request_id: string }
  | {
      none?: false
      id: number
      title: string | null
      severity: string | null
      status: string | null
      source: string | null
      occurrence_count: number
      created_at: string | null
      last_seen_at: string | null
      collection: string | null
      item: string | null
      raised_by: string | null
      raised_by_name: string | null
      assigned_to_name: string | null
      resolution_notes: string | null
      route: string | null
      request_context: string | null
      stack: string | null
      details_other: string | null
      recording: IssueRecording | null
      recording_note: string | null
      screenshot: string | null
      screenshot_note: string | null
      matched_request: string | null
    }

function prettyContext(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export default function IssuePanel(props: InspectPanelProps) {
  const { inspectRef, anchor, windowSec } = props
  const q = useInspectDetail<IssueDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <Skeleton rows={[75, 60, 90, 80, 50]} />
  if (q.isError || !q.data) return <LoadFailed error={q.error} what='issue' />
  const d = q.data
  if (d.none) {
    return (
      <div className='grid gap-2' data-tm-inspect-issue='none'>
        <p className='text-[13px] font-medium text-[var(--tm-fg)]'>
          No open issue for this request
        </p>
        <Note hook='issue-none'>{d.reason ?? 'Nothing matched.'}</Note>
        <InspectLink inspectRef={{ kind: 'request', id: d.request_id, label: 'Request' }}>
          Open the request
        </InspectLink>
      </div>
    )
  }
  const lastAt = d.last_seen_at ? Date.parse(d.last_seen_at) : null
  return (
    <div className='grid min-w-0 gap-3' data-tm-inspect-issue={d.id}>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <p className='min-w-0 text-[13px] font-medium leading-snug text-[var(--tm-fg)] [overflow-wrap:anywhere]'>
          {d.title ?? `Issue #${d.id}`}
        </p>
        <Link
          to={`/issues/${d.id}`}
          className={`${LINK} text-[12px]`}
          data-tm-inspect-issue-page=''
        >
          Open full page
        </Link>
      </div>
      {d.matched_request && (
        <Note hook='issue-matched'>
          Matched to this request by route and time — the issue log groups repeats, so other
          requests share it.
        </Note>
      )}
      <Facts
        rows={[
          ['Status', `${d.status ?? '—'}${d.severity ? ` · ${d.severity}` : ''}`],
          [
            'Source',
            d.source === 'client' ? 'Browser (client)' : d.source === 'server' ? 'Server' : d.source
          ],
          [
            'Seen',
            `${d.occurrence_count.toLocaleString()} time${d.occurrence_count === 1 ? '' : 's'} · first ${fmtStamp(d.created_at)} · last ${fmtStamp(d.last_seen_at)}`
          ],
          d.route
            ? [
                'Route',
                <span key='r' className='font-mono text-[11.5px]'>
                  {d.route}
                </span>
              ]
            : null,
          [
            'Raised by',
            d.raised_by ? (
              <InspectLink
                key='who'
                inspectRef={{
                  kind: 'caller',
                  id: `u${d.raised_by.toUpperCase()}`,
                  at: lastAt ?? undefined,
                  label: d.raised_by_name ?? undefined
                }}
              >
                {d.raised_by_name ?? d.raised_by}
              </InspectLink>
            ) : (
              'Nobody signed in'
            )
          ],
          d.assigned_to_name ? ['Assigned to', d.assigned_to_name] : null,
          d.collection && d.item
            ? [
                'Record',
                <InspectLink
                  key='rec'
                  inspectRef={{ kind: 'record', id: `${d.collection}:${d.item}` }}
                >
                  {d.collection} {d.item}
                </InspectLink>
              ]
            : null,
          d.resolution_notes ? ['Resolution', d.resolution_notes] : null
        ]}
      />

      <Block title='Replay' hook='issue-replay'>
        {d.recording ? (
          <InspectLink
            inspectRef={{
              kind: 'recording',
              id: d.recording.id,
              at: d.recording.at ?? undefined,
              label: `${d.recording.clip ? 'Error clip' : 'Recording'} · ${d.recording.user_name ?? 'someone'}`
            }}
          >
            Watch the moment it failed{d.recording.clip ? ' (error clip)' : ''}
          </InspectLink>
        ) : (
          <>
            {d.recording_note && <Note hook='issue-replay'>{d.recording_note}</Note>}
            {d.raised_by && lastAt ? (
              <WatchWhatTheySaw user={d.raised_by} at={lastAt} name={d.raised_by_name} />
            ) : null}
          </>
        )}
      </Block>

      {d.screenshot ? (
        <Block title='Screenshot' hook='issue-screenshot'>
          <div
            className='w-fit max-w-full rounded-md border border-[var(--tm-line)]'
            data-tm-inspect-issue-screenshot=''
          >
            <img
              src={d.screenshot}
              alt='What the person saw when they reported it'
              className='max-h-48 max-w-full rounded-md object-contain'
            />
          </div>
        </Block>
      ) : d.screenshot_note ? (
        <Note hook='issue-screenshot'>{d.screenshot_note}</Note>
      ) : null}

      {d.stack && (
        <Block title='Stack' hook='issue-stack'>
          <Mono>{d.stack}</Mono>
        </Block>
      )}
      {d.request_context && (
        <Block title='Request (shape only — values are never kept)' hook='issue-context'>
          <Mono max='max-h-40'>{prettyContext(d.request_context)}</Mono>
        </Block>
      )}
      {d.details_other && (
        <Block title='Details' hook='issue-details'>
          <Mono max='max-h-40'>{d.details_other}</Mono>
        </Block>
      )}
    </div>
  )
}
