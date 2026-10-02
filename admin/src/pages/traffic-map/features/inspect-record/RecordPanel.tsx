/**
 * #1194 — one record, read-only: its read view (the summary, detail or grouped layout — the
 * same read view the record page's Summary mode draws), then the writes recorded on it around the
 * moment, each opening the write. Read AS THE CALLER on the server, so RBAC applies.
 */
import { type ReadViewLayout, RecordReadView } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api } from '@/lib/api'
import { useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import type { InspectPanelProps } from '../../registry/inspectables'
import { LINK } from '../shared'
import { fmtStamp } from './logic'
import { SharedProviders } from './providers'
import { Block, Facts, LoadFailed, Note, Skeleton } from './ui'

interface Touch {
  id: number
  action: string
  at: string | null
  who: string | null
  origin: string | null
  comment: string | null
  chain_id: string | null
}

interface RecordDetail {
  collection: string
  item: string
  label: string | null
  exists: boolean
  reason: string | null
  values: Record<string, string | number | boolean | null> | null
  touches: Touch[]
  touches_in_window: number
  touches_total: number
  touches_note: string | null
  window_sec: number
}

/** The read layout to draw: the summary layout, else the detail layout, else the active one. */
async function fetchReadLayout(collection: string, item: string): Promise<ReadViewLayout | null> {
  const c = encodeURIComponent(collection)
  const tries = [
    `/collection-layouts/summary/${c}`,
    `/collection-layouts/detail/${c}`,
    `/collection-layouts/active?collection=${c}&item=${encodeURIComponent(item)}`
  ]
  for (const url of tries) {
    try {
      const res = await api.get(url)
      const d = (res?.data as { data?: ReadViewLayout | null })?.data
      if (d?.layout && Array.isArray(d.assignments) && d.assignments.length > 0) return d
    } catch {
      /* try the next layout kind */
    }
  }
  return null
}

const VERB: Record<string, string> = { create: 'created', update: 'updated', delete: 'deleted' }

function TouchList({ touches, label }: { touches: Touch[]; label: string }) {
  return (
    <ul className='grid gap-1' data-tm-inspect-record-touches=''>
      {touches.map((t) => (
        <li
          key={t.id}
          className='grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 text-[12px]'
          data-tm-inspect-record-touch={t.id}
        >
          <span className='font-mono text-[11px] tabular-nums text-[var(--tm-muted)]'>
            {fmtStamp(t.at).slice(11)}
          </span>
          <span className='min-w-0 truncate'>
            <InspectLink
              inspectRef={{
                kind: 'write',
                id: String(t.id),
                at: t.at ? Date.parse(t.at) : undefined,
                label: `${VERB[t.action] ?? t.action} ${label}`
              }}
            >
              {VERB[t.action] ?? t.action}
            </InspectLink>{' '}
            <span className='text-[var(--tm-fg-2)]'>by {t.who ?? 'no person'}</span>
            {t.origin && t.origin !== 'person' ? (
              <span className='text-[var(--tm-muted)]'> · {t.origin}</span>
            ) : null}
            {t.comment ? (
              <span className='text-[var(--tm-muted)]' data-tip={t.comment}>
                {' '}
                · {t.comment}
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

export default function RecordPanel(props: InspectPanelProps) {
  const { inspectRef, open, anchor, windowSec } = props
  const q = useInspectDetail<RecordDetail>(inspectRef, anchor, windowSec)
  const d = q.data
  const layoutQ = useQuery({
    queryKey: ['tm-inspect-record-layout', d?.collection, d?.item],
    queryFn: () => fetchReadLayout(d?.collection as string, d?.item as string),
    enabled: !!d?.exists,
    staleTime: 5 * 60_000
  })
  if (q.isLoading) return <Skeleton rows={[55, 90, 80, 85, 70]} />
  if (q.isError || !d) return <LoadFailed error={q.error} what='record' />
  const title = d.label ?? `${d.collection} ${d.item}`
  return (
    <div className='grid min-w-0 gap-3' data-tm-inspect-record={`${d.collection}:${d.item}`}>
      <div className='flex flex-wrap items-baseline justify-between gap-2'>
        <div className='min-w-0'>
          <p className='truncate text-[13px] font-medium text-[var(--tm-fg)]'>{title}</p>
          <p className='font-mono text-[11px] text-[var(--tm-muted)]'>
            {d.collection} · {d.item}
          </p>
        </div>
        {d.exists && (
          <Link
            to={`/collections/${encodeURIComponent(d.collection)}/${encodeURIComponent(d.item)}`}
            className={`${LINK} text-[12px]`}
            data-tm-inspect-record-page=''
          >
            Open full page
          </Link>
        )}
      </div>
      {d.reason && <Note hook='record-missing'>{d.reason}</Note>}

      <Block
        title={`Writes ${d.touches_in_window > 0 ? `near this moment (${d.touches_in_window})` : ''}`.trim()}
        hook='record-writes'
      >
        {d.touches_note && <Note hook='record-touches'>{d.touches_note}</Note>}
        {d.touches.length > 0 && <TouchList touches={d.touches} label={title} />}
        {d.touches_total > d.touches.length && (
          <Note>{d.touches_total.toLocaleString()} writes recorded on this record in all.</Note>
        )}
      </Block>

      {d.exists && (
        <Block title='The record now' hook='record-view'>
          {layoutQ.isLoading ? (
            <Skeleton rows={[80, 70, 90, 60]} />
          ) : layoutQ.data ? (
            <SharedProviders open={open}>
              <div className='min-w-0 overflow-hidden rounded-lg border border-[var(--tm-line)]'>
                <RecordReadView
                  key={`${d.collection}:${d.item}`}
                  collection={d.collection}
                  itemId={d.item}
                  layoutData={layoutQ.data}
                />
              </div>
            </SharedProviders>
          ) : d.values ? (
            <>
              <Note hook='record-no-layout'>
                This collection has no read layout, so its fields are listed as stored.
              </Note>
              <Facts
                rows={Object.entries(d.values).map(([k, v]) => [
                  k,
                  v == null ? '—' : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)
                ])}
              />
            </>
          ) : null}
        </Block>
      )}
    </div>
  )
}
