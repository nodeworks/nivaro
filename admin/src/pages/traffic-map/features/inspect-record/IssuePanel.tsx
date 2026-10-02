/**
 * #1201 — one issue from the issue log: what failed, how often, the stack, the screenshot, and
 * the replay of the moment (opens the recording). Opened by issue id, or as `rid:<request>` —
 * the open server issue that request raised, matched by its error fingerprint (route + message),
 * or by the route alone when the message matched no open issue (the panel says which).
 */
import { useEffect } from 'react'
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

/** The request a `rid:` lookup resolved — the anchor for "what they saw". */
interface MatchedRequest {
  id: string
  user: string | null
  at: number | null
  matched_by: 'fingerprint' | 'route'
}

type IssueDetail =
  | { none: true; reason: string | null; request_id: string; pending?: boolean }
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
      matched_request: MatchedRequest | null
    }

/** How long to wait before asking again for a request whose log row is not flushed yet. */
const PENDING_RETRY_MS = 5_000

function prettyContext(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/**
 * Whose recording shows the failure, and when: for a `rid:` match the request's own person and
 * time; otherwise the first raiser at the moment the issue was raised (`raised_by` is set on
 * insert only, so pairing it with `last_seen_at` would name the wrong moment).
 */
function watchAnchor(
  d: Extract<IssueDetail, { id: number }>
): { user: string; at: number; name: string | null } | null {
  const m = d.matched_request
  if (m?.user && m.at) return { user: m.user, at: m.at, name: null }
  const createdAt = d.created_at ? Date.parse(d.created_at) : Number.NaN
  if (d.raised_by && Number.isFinite(createdAt))
    return { user: d.raised_by, at: createdAt, name: d.raised_by_name }
  return null
}

export default function IssuePanel(props: InspectPanelProps) {
  const { inspectRef, anchor, windowSec } = props
  const q = useInspectDetail<IssueDetail>(inspectRef, anchor, windowSec)
  const pending = !!q.data?.none && !!q.data.pending
  // The log is written in batches: a request that just failed has no row for a few seconds,
  // and the detail cache would otherwise keep that answer for 30 s.
  const refetch = q.refetch
  useEffect(() => {
    if (!pending) return
    const t = setTimeout(() => void refetch(), PENDING_RETRY_MS)
    return () => clearTimeout(t)
  }, [pending, refetch, q.dataUpdatedAt])
  if (q.isLoading) return <Skeleton rows={[75, 60, 90, 80, 50]} />
  if (q.isError || !q.data) return <LoadFailed error={q.error} what='issue' />
  const d = q.data
  if (d.none) {
    return (
      <div className='grid gap-2' data-tm-inspect-issue={d.pending ? 'pending' : 'none'}>
        <p className='text-[13px] font-medium text-[var(--tm-fg)]'>
          {d.pending ? 'Waiting for the API log' : 'No open issue for this request'}
        </p>
        <Note hook='issue-none'>{d.reason ?? 'Nothing matched.'}</Note>
        <InspectLink inspectRef={{ kind: 'request', id: d.request_id, label: 'Request' }}>
          Open the request
        </InspectLink>
      </div>
    )
  }
  const watch = watchAnchor(d)
  const createdAt = d.created_at ? Date.parse(d.created_at) : null
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
        <Note hook={`issue-matched-${d.matched_request.matched_by}`}>
          {d.matched_request.matched_by === 'fingerprint'
            ? 'This request raised this issue — its error message and route are the issue’s fingerprint; the issue log groups repeats, so other requests share it.'
            : 'Matched by route only — the request’s error message did not match any open issue on this route, so this is the newest open issue there and may not be the one this request raised.'}
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
                  at: createdAt ?? undefined,
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
            {watch ? <WatchWhatTheySaw user={watch.user} at={watch.at} name={watch.name} /> : null}
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
