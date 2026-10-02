/**
 * #1190 — one API call: what it was, who made it, how it went, its trace, body and neighbours.
 */
import { createNivaro } from '@nivaro/sdk'
import { type ApiLogRow, NivaroProvider, ReplayBlock } from '@nivaro/shared'
import { inspectErrorOf } from '../../inspect/api'
import { fmtClock, shortId } from '../../inspect/format'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { type RequestDetail, type RequestRow, useRequestDetail } from './api'
import {
  callerKeyOf,
  curlFor,
  fmtMs,
  graphqlParts,
  offsetText,
  prettyBody,
  queryPairs
} from './logic'
import { TraceNextControl } from './TraceNextControl'
import { Code, CopyButton, Facts, Note, PanelSkeleton, Section, StatusPill, Tag } from './ui'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const MATCHED: Record<string, string> = {
  chain_time:
    'Matched by chain and time — the root /graphql alias writes its log row without a request id, so this is the /graphql call of the same chain within 2 seconds.',
  time: 'Matched by time only — the only /graphql call logged without a request id within 2 seconds of this event.',
  chain:
    'Matched by chain — this id is a chain id, and this is the newest root /graphql call logged in that chain (such calls carry no request id).'
}

function replayRow(r: RequestRow): ApiLogRow {
  return {
    id: r.id,
    method: r.method,
    path: r.path,
    status: r.status,
    latency_ms: r.latency_ms,
    user: r.user,
    user_name: r.caller.kind === 'user' ? r.caller.label : null,
    user_email: null,
    collection: null,
    api_key_id: r.api_key_id,
    api_key_name: r.caller.kind === 'api_key' ? r.caller.label : null,
    auth: (r.auth as ApiLogRow['auth']) ?? null,
    ip: r.ip,
    user_agent: r.user_agent,
    error: r.error,
    request_body: r.request_body,
    query: r.query,
    created_at: r.created_at ?? ''
  }
}

function Body({ row }: { row: RequestRow }) {
  const gql = graphqlParts(row.request_body)
  if (row.request_body) {
    const pretty = prettyBody(row.request_body)
    return (
      <Section
        title='Body'
        hook='body'
        aside={
          row.body_source === 'capture' ? (
            <Tag tip='Held in memory by a running capture — never written to the API log'>
              from a capture
            </Tag>
          ) : (
            <Tag tip='Stored by the API log (token and API-key writes are kept, 64 KB at most)'>
              from the log
            </Tag>
          )
        }
      >
        {gql ? (
          <>
            {gql.query && <Code text={gql.query} hook='graphql-query' />}
            {gql.variables && (
              <>
                <span className='text-[11.5px] text-[var(--tm-muted)]'>Variables</span>
                <Code text={gql.variables} hook='graphql-variables' max='max-h-40' />
              </>
            )}
          </>
        ) : (
          <Code text={pretty.text} hook='body' />
        )}
        <p className='text-[11px] text-[var(--tm-muted)]'>
          Values under credential-looking names are shown as ••••••.
        </p>
      </Section>
    )
  }
  if (!WRITES.has(row.method)) return null
  return (
    <Section title='Body' hook='body'>
      <Note hook='body-missing'>
        {row.body_note ??
          (row.auth === 'token' || row.auth === 'api_key'
            ? 'No JSON body was stored for this call (multipart uploads and non-JSON bodies are not kept).'
            : 'Body not captured — the API log keeps bodies only for token and API-key callers, never for a person’s browser session. Use “Capture next…” to hold the next ones in memory.')}
      </Note>
    </Section>
  )
}

function Header({ d, row }: { d: RequestDetail; row: RequestRow }) {
  return (
    <div className='grid gap-1' data-tm-inspect-request-head=''>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusPill status={row.status} />
        <span className='min-w-0 truncate font-mono text-[12.5px] font-semibold text-[var(--tm-fg)]'>
          {row.method} {row.path}
        </span>
      </div>
      <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-[var(--tm-fg-2)]'>
        <span className='tabular-nums'>{fmtMs(row.latency_ms)}</span>
        <span>{row.created_at ? fmtClock(Date.parse(row.created_at)) : '—'}</span>
        <span>
          by{' '}
          {row.caller.kind === 'anonymous' ? (
            'an anonymous caller'
          ) : (
            <InspectLink
              inspectRef={{ kind: 'caller', id: row.caller.key, label: row.caller.label }}
            >
              {row.caller.label}
            </InspectLink>
          )}
        </span>
      </div>
      {d.matched_by && d.matched_by !== 'request_id' && (
        <Note tone='warn' hook='matched-by'>
          {MATCHED[d.matched_by]}
        </Note>
      )}
    </div>
  )
}

export function RequestPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const q = useRequestDetail(inspectRef, anchor, windowSec)
  if (q.isLoading) return <PanelSkeleton />
  if (q.error) {
    const e = inspectErrorOf(q.error)
    return (
      <Note tone='error' hook='request-error'>
        {e.status === 400 ? 'That is not a request id.' : e.message}
      </Note>
    )
  }
  const d = q.data
  if (!d) return <PanelSkeleton />
  const row = d.row

  if (!row) {
    return (
      <div className='grid gap-3' data-tm-inspect-request={d.rid}>
        {d.pending && !q.gaveUp ? (
          <Note hook='request-pending'>
            Waiting for the API log — rows are written in batches every few seconds. Checking again…
          </Note>
        ) : (
          <Note hook='request-not-logged'>
            {q.gaveUp
              ? 'Not logged (internal dispatch, skipped path, or not flushed yet).'
              : (d.missing ?? 'Not in the API log.')}
          </Note>
        )}
        {d.trace.kept ? (
          <Section title='Trace' hook='trace'>
            <p className='text-[12px] text-[var(--tm-fg-2)]'>
              This API process kept its trace: {fmtMs(d.trace.total_ms)}, {d.trace.queries} queries.{' '}
              <InspectLink
                inspectRef={{ kind: 'trace', id: d.rid, label: `Trace ${shortId(d.rid)}` }}
              >
                Open the trace
              </InspectLink>
            </p>
          </Section>
        ) : null}
      </div>
    )
  }

  const pairs = queryPairs(row.query)
  const curl = curlFor({
    origin: window.location.origin,
    method: row.method,
    path: row.path,
    query: row.query,
    body: row.request_body
  })

  return (
    <div className='grid gap-4' data-tm-inspect-request={d.rid}>
      <Header d={d} row={row} />

      <Facts
        items={[
          [
            'Route',
            row.entity ? (
              <InspectLink key='route' inspectRef={{ kind: 'entity', id: row.entity }}>
                {row.route}
              </InspectLink>
            ) : (
              <span key='route' className='font-mono'>
                {row.route}
              </span>
            )
          ],
          ['Signed in with', row.auth ?? '—'],
          row.record && [
            'Record',
            <InspectLink key='rec' inspectRef={{ kind: 'record', id: row.record }}>
              {row.record.replace(':', ' ')}
            </InspectLink>
          ],
          row.chain_id && [
            'Chain',
            <InspectLink key='chain' inspectRef={{ kind: 'chain', id: row.chain_id }}>
              {shortId(row.chain_id)}
              {row.chain_parent ? ' (inside another call)' : ''}
            </InspectLink>
          ],
          [
            'Served by',
            row.instance
              ? `instance ${row.instance}${row.instance === d.instance ? ' (this one)' : ''}`
              : 'not recorded'
          ],
          ['From', row.ip ?? '—'],
          row.user_agent && [
            'Client',
            <span key='ua' data-tip={row.user_agent}>
              {row.user_agent}
            </span>
          ],
          [
            'Request id',
            <span key='rid' className='font-mono'>
              {d.rid}
            </span>
          ]
        ]}
      />

      <Section title='Trace' hook='trace'>
        {d.trace.kept ? (
          <p className='text-[12px] text-[var(--tm-fg-2)]' data-tm-inspect-trace-summary=''>
            {fmtMs(d.trace.total_ms)} · {d.trace.queries} queries · {fmtMs(d.trace.sql_ms)} in SQL
            {d.trace.slowest_phase
              ? ` · slowest phase ${d.trace.slowest_phase.phase} (${fmtMs(d.trace.slowest_phase.ms)})`
              : ''}
            .{' '}
            <InspectLink
              inspectRef={{ kind: 'trace', id: d.rid, label: `Trace ${shortId(d.rid)}` }}
            >
              Open the waterfall
            </InspectLink>
          </p>
        ) : (
          <>
            <Note hook={`trace-${d.trace.code}`}>{d.trace.reason}</Note>
            <TraceNextControl route={row.route} caller={callerKeyOf(row)} />
          </>
        )}
      </Section>

      {pairs.length > 0 && (
        <Section title='Query' hook='query'>
          <dl className='grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11.5px]'>
            {pairs.map(([k, v], i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a name may repeat
              <div key={`${k}-${i}`} className='contents'>
                <dt className='text-[var(--tm-muted)]'>{k}</dt>
                <dd className='min-w-0 break-all text-[var(--tm-fg)]'>{v || '—'}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}

      {row.graphql && (
        <Section title='GraphQL' hook='graphql'>
          <Facts
            items={[
              ['Operation', row.graphql.operation ?? 'anonymous'],
              ['Kind', row.graphql.kind ?? '—'],
              row.graphql.depth != null && ['Depth', String(row.graphql.depth)],
              row.graphql.selections != null && ['Fields selected', String(row.graphql.selections)],
              ['Errors in the answer', String(row.graphql.errors ?? 0)],
              row.graphql.deprecated && ['Deprecated fields', row.graphql.deprecated]
            ]}
          />
        </Section>
      )}

      <Body row={row} />

      {row.error && (
        <Section title='Error' hook='error'>
          <Code text={row.error} hook='error' max='max-h-40' />
        </Section>
      )}

      <Section title='Run it again' hook='replay'>
        <div className='flex flex-wrap items-center gap-2'>
          <CopyButton text={curl} label='Copy as curl' hook='curl' />
        </div>
        {row.body_source === 'log' && WRITES.has(row.method) ? (
          <NivaroProvider client={sharedClient}>
            <ReplayBlock row={replayRow(row)} />
          </NivaroProvider>
        ) : (
          <p className='text-[11.5px] text-[var(--tm-muted)]'>
            {WRITES.has(row.method)
              ? 'Replay needs the body stored in the API log — this one is not there.'
              : 'Replay is for writes; a read can be run again with the curl above.'}
          </p>
        )}
      </Section>

      <Section
        title='Around it'
        hook='neighbours'
        aside={<span className='text-[11px] text-[var(--tm-muted)]'>same caller, ±5 s</span>}
      >
        {d.neighbours.length === 0 ? (
          <p className='text-[12px] text-[var(--tm-muted)]'>
            No other calls by this caller within 5 seconds.
          </p>
        ) : (
          <ul className='grid gap-0.5 text-[12px]' data-tm-inspect-neighbours=''>
            {d.neighbours.map((n, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: rows without a request id repeat
                key={`${n.request_id ?? 'x'}-${i}`}
                className='flex min-w-0 items-center gap-2'
              >
                <span className='w-16 shrink-0 text-right tabular-nums text-[var(--tm-muted)]'>
                  {offsetText(n.created_at, row.created_at)}
                </span>
                {n.request_id ? (
                  <InspectLink
                    inspectRef={{ kind: 'request', id: n.request_id, label: n.route }}
                    className='font-mono text-[11.5px]'
                  >
                    {n.method} {n.path}
                  </InspectLink>
                ) : (
                  <span
                    className='min-w-0 truncate font-mono text-[11.5px] text-[var(--tm-fg-2)]'
                    data-tip='Logged before request ids were recorded'
                  >
                    {n.method} {n.path}
                  </span>
                )}
                <span className='ml-auto shrink-0 tabular-nums text-[var(--tm-muted)]'>
                  {n.status} · {fmtMs(n.latency_ms)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
