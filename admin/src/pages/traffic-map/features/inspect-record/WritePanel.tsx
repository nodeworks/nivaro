/**
 * One write (a nivaro_activity row): who made it, how they were signed in, which record, every
 * field it changed (old → new, labelled), the chain it rode and the request that made it.
 */

import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { fmtStamp } from './logic'
import { Block, Facts, LoadFailed, Note, Skeleton } from './ui'

interface WriteDetail {
  id: number
  action: string
  at: string | null
  collection: string | null
  item: string | null
  record_label: string | null
  user: string | null
  who: string | null
  origin: string | null
  auth_method: string | null
  api_key: { id: number; name: string | null } | null
  ip: string | null
  user_agent: string | null
  comment: string | null
  chain_id: string | null
  revision_id: number | null
  changes: Array<{ field: string; label: string; old: string; new: string }>
  changes_note: string | null
  request: { log_id: string; request_id: string | null; at: string | null } | null
  request_note: string | null
}

const AUTH: Record<string, string> = {
  session: 'Signed-in session',
  token: 'Static token',
  api_key: 'API key',
  masquerade: 'Viewing as someone (masquerade)',
  key_sim: 'Run as an API key (simulated)'
}

export default function WritePanel(props: InspectPanelProps) {
  const { inspectRef, anchor, windowSec } = props
  const q = useInspectDetail<WriteDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <Skeleton rows={[60, 80, 90, 70, 85]} />
  if (q.isError || !q.data) return <LoadFailed error={q.error} what='write' />
  const d = q.data
  const at = d.at ? Date.parse(d.at) : undefined
  const recordName = d.record_label ?? (d.collection ? `${d.collection} ${d.item ?? ''}` : null)
  return (
    <div className='grid min-w-0 gap-3' data-tm-inspect-write={d.id}>
      <p className='text-[13px] font-medium text-[var(--tm-fg)]'>
        {d.who ?? 'No person'}{' '}
        {d.action === 'create' ? 'created' : d.action === 'delete' ? 'deleted' : 'updated'}{' '}
        {recordName ?? 'a record'}
      </p>
      <Facts
        rows={[
          ['When', fmtStamp(d.at)],
          d.collection && d.item
            ? [
                'Record',
                <InspectLink
                  key='rec'
                  inspectRef={{
                    kind: 'record',
                    id: `${d.collection}:${d.item}`,
                    at,
                    label: recordName ?? undefined
                  }}
                >
                  {recordName}
                </InspectLink>
              ]
            : null,
          [
            'Who',
            d.user ? (
              <InspectLink
                key='who'
                inspectRef={{
                  kind: 'caller',
                  id: `u${d.user.toUpperCase()}`,
                  at,
                  label: d.who ?? undefined
                }}
              >
                {d.who ?? d.user}
              </InspectLink>
            ) : (
              'No person (a background job or a public form)'
            )
          ],
          d.origin ? ['Origin', d.origin] : null,
          d.auth_method ? ['Signed in by', AUTH[d.auth_method] ?? d.auth_method] : null,
          d.api_key
            ? [
                'API key',
                <InspectLink
                  key='key'
                  inspectRef={{
                    kind: 'caller',
                    id: `k${d.api_key.id}`,
                    at,
                    label: d.api_key.name ?? undefined
                  }}
                >
                  {d.api_key.name ?? `Key ${d.api_key.id}`}
                </InspectLink>
              ]
            : null,
          d.ip ? ['From', d.ip] : null,
          d.comment ? ['Reason', d.comment] : null
        ]}
      />

      <Block
        title={`What changed${d.changes.length ? ` (${d.changes.length})` : ''}`}
        hook='write-changes'
      >
        {d.changes_note && <Note hook='write-changes'>{d.changes_note}</Note>}
        {d.changes.length > 0 && (
          <table className='w-full table-fixed text-[12px]' data-tm-inspect-write-changes=''>
            <tbody>
              {d.changes.map((c) => (
                <tr key={c.field} className='align-top' data-tm-inspect-write-change={c.field}>
                  <td className='w-[34%] py-0.5 pr-3 text-[var(--tm-muted)] [overflow-wrap:anywhere]'>
                    {c.label || c.field}
                  </td>
                  <td className='py-0.5 text-[var(--tm-fg)] [overflow-wrap:anywhere]'>
                    <span className='text-[var(--tm-muted)] line-through decoration-[var(--tm-line)]'>
                      {c.old || '—'}
                    </span>{' '}
                    <span className='text-[var(--tm-muted)]'>→ </span>
                    {c.new || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block title='Where it came from' hook='write-origin'>
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]'>
          {d.request?.request_id ? (
            <InspectLink
              inspectRef={{ kind: 'request', id: d.request.request_id, label: 'Request' }}
            >
              The request that made it
            </InspectLink>
          ) : null}
          {d.chain_id ? (
            <InspectLink inspectRef={{ kind: 'chain', id: d.chain_id, at, label: 'Event path' }}>
              Its event path
            </InspectLink>
          ) : null}
        </div>
        {d.request_note && <Note hook='write-request'>{d.request_note}</Note>}
      </Block>
    </div>
  )
}
