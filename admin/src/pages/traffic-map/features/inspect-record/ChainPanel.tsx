/**
 * #1192 — an integration event chain as its path (the shared event-path tree the Integrations
 * console draws), embedded in the investigation panel. Every step that names something opens
 * it as a deeper level: the request, a write, a flow run, a partner push, the moved record.
 */
import {
  EventPathBody,
  EventPathFacts,
  eventPathSummary,
  type IntegrationEventPath,
  type IntegrationPathNode
} from '@nivaro/shared'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { stepRefFor, stepRefLabel } from './logic'
import { SharedProviders } from './providers'
import { LoadFailed, Note, Skeleton } from './ui'

interface ChainDetail {
  chain_id: string
  path: IntegrationEventPath
  request: { log_id: string; request_id: string | null; at: string | null } | null
  request_note: string | null
}

export default function ChainPanel(props: InspectPanelProps) {
  const { inspectRef, open, anchor, windowSec } = props
  const q = useInspectDetail<ChainDetail>(inspectRef, anchor, windowSec)
  if (q.isLoading) return <Skeleton rows={[70, 90, 80, 85, 60, 75]} />
  if (q.isError || !q.data) return <LoadFailed error={q.error} what='event path' />
  const d = q.data
  const requestId = d.request?.request_id ?? null
  return (
    <SharedProviders open={open}>
      <div className='grid min-w-0 gap-2.5' data-tm-inspect-chain={d.chain_id}>
        <p className='text-[13px] font-medium leading-snug text-[var(--tm-fg)]'>
          {eventPathSummary(d.path, inspectRef.label ? { label: inspectRef.label } : undefined)}
        </p>
        <div className='flex flex-wrap items-center gap-2 text-[12px] text-[var(--tm-muted)]'>
          <EventPathFacts
            path={d.path}
            onOpenEvent={(t) => open({ kind: 'chain', id: t.chainId })}
          />
          {requestId ? (
            <InspectLink
              inspectRef={{ kind: 'request', id: requestId, label: 'Request' }}
              className='text-[12px]'
            >
              Started by request {requestId.slice(0, 8)}
            </InspectLink>
          ) : null}
        </div>
        {d.request_note && <Note hook='chain-request'>{d.request_note}</Note>}
        <EventPathBody
          path={d.path}
          targetKey={`chain:${d.chain_id}`}
          className='min-w-0 rounded-lg border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2'
          onOpenRecord={(collection, id) =>
            open({ kind: 'record', id: `${collection}:${id}`, label: `${collection} ${id}` })
          }
          stepAction={(node: IntegrationPathNode) => {
            const ref = stepRefFor(node, requestId)
            if (!ref) return null
            return (
              <InspectLink inspectRef={ref} className='text-[11px] font-medium'>
                {stepRefLabel(ref)}
              </InspectLink>
            )
          }}
        />
      </div>
    </SharedProviders>
  )
}
