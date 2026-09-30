import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { formatDateTime, formatRelative } from '../../lib/utils'
import { InboundRequestPopover } from '../integrations/InboundRequest'

/**
 * Every record change one inbound caller made (#609): "Order sync changed
 * Vendor, Amount on PO-1024 · 2h ago". Attribution comes from the credential
 * stamped on each write (the API key, or the account behind a static token);
 * writes from before that stamping existed are read off machine identities.
 */
interface CallerChange {
  activity_id: number
  at: string
  action: string
  collection: string
  collection_label: string
  item: string | null
  record_label: string | null
  fields: Array<{ field: string; label: string }>
  sentence: string
  caller: { name: string; kind: string; key: string }
}

export function CallerChangesSection({
  caller,
  hours
}: {
  /** `k<api key id>` or `u<user id>`. */
  caller: { key: string; label: string }
  hours: number
}) {
  const client = useNivaroClient()
  const nav = useItemNavigation()
  const [page, setPage] = useState(1)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['inbound-caller-changes', caller.key, hours, page],
    queryFn: () =>
      client.request<{ data: CallerChange[]; has_more: boolean; stamped: boolean }>(
        get('/inbound-attribution/changes', { caller: caller.key, hours, page, limit: 50 })
      ),
    placeholderData: (prev) => prev
  })
  const rows = data?.data ?? []
  return (
    <section
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-caller-changes={caller.key}
    >
      <header className='flex flex-wrap items-baseline gap-x-2 border-b border-slate-100 px-3 py-2 dark:border-border'>
        <h3 className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          Changes written by {caller.label}
        </h3>
        <span className='text-[11px] text-slate-400'>
          record by record, newest first — the last{' '}
          {hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours}h`}
        </span>
      </header>
      {isLoading ? (
        <div className='space-y-1.5 p-3'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-5 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : isError ? (
        <p className='px-3 py-4 text-[12px] text-red-700 dark:text-red-400'>
          Could not load this caller’s changes.
        </p>
      ) : rows.length === 0 ? (
        <p className='px-3 py-4 text-[12px] text-slate-500 dark:text-slate-400'>
          No record changes from {caller.label} in this window.
          {data && !data.stamped && caller.key.startsWith('k')
            ? ' Writes are attributed to API keys once this database has run the inbound-attribution migration.'
            : ''}
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {rows.map((r) => (
            <li
              key={r.activity_id}
              className='flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 text-[12px]'
              data-caller-change={r.activity_id}
            >
              <span className='text-slate-700 dark:text-slate-200'>
                <span className='font-medium'>{r.caller.name}</span> {r.sentence}{' '}
                {r.item ? (
                  <>
                    {r.action === 'create' || r.action === 'delete' ? '— ' : 'on '}
                    <button
                      type='button'
                      onClick={() =>
                        nav.open({ collection: r.collection, itemId: r.item as string })
                      }
                      className='font-medium text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
                    >
                      {r.record_label ?? `${r.collection_label} #${r.item}`}
                    </button>
                    <span className='ml-1 text-[11px] text-slate-400'>{r.collection_label}</span>
                  </>
                ) : null}
              </span>
              <span className='ml-auto text-[11px] text-slate-400' data-tip={formatDateTime(r.at)}>
                {formatRelative(r.at)}
              </span>
              {r.item && (
                <InboundRequestPopover
                  activityId={r.activity_id}
                  callerName={r.caller.name}
                  collection={r.collection}
                  itemId={r.item}
                  align='end'
                >
                  <button
                    type='button'
                    data-caller-change-request={r.activity_id}
                    className='rounded px-1.5 py-px text-[10.5px] font-medium text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-900/20'
                  >
                    Request
                  </button>
                </InboundRequestPopover>
              )}
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || data?.has_more) && (
        <footer className='flex items-center justify-end gap-2 border-t border-slate-100 px-3 py-1.5 text-[11px] dark:border-border'>
          <button
            type='button'
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className='rounded border border-slate-200 px-2 py-0.5 text-slate-600 disabled:opacity-40 dark:border-border dark:text-slate-300'
          >
            Newer
          </button>
          <span className='text-slate-400'>Page {page}</span>
          <button
            type='button'
            disabled={!data?.has_more}
            onClick={() => setPage((p) => p + 1)}
            className='rounded border border-slate-200 px-2 py-0.5 text-slate-600 disabled:opacity-40 dark:border-border dark:text-slate-300'
          >
            Older
          </button>
        </footer>
      )}
    </section>
  )
}
