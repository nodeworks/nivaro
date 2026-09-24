import { useEffect, useState } from 'react'
import { useItemEditAuth, useItemNavigation } from '../../context'
import { cn, formatDateTime } from '../../lib/utils'
import {
  type EventPathTarget,
  eventPathTargetKey,
  useRecordIntegrationActivity
} from '../integrations/console/api'
import { EventPathSheet } from '../integrations/console/event-path'
import type { IntegrationEvent } from '../integrations/console/types'

/**
 * The integration path sheet as a record page opens it. The target is always
 * read through the record (`target.record`), so the server checks the viewer
 * can read the record and withholds bodies from non-admins. Replay links
 * swap to the chain view — admins only, because a chain is not tied to a
 * record the viewer is known to be able to read. A chip naming another
 * record opens it through the host's navigation.
 */
export function RecordEventPathSheet({
  target,
  event,
  onClose,
  onOpenRecord
}: {
  target: EventPathTarget | null
  event?: { label?: string | null; item_label?: string | null } | null
  onClose: () => void
  onOpenRecord?: (collection: string, id: string) => void
}) {
  const { isAdmin } = useItemEditAuth()
  const nav = useItemNavigation()
  const [chain, setChain] = useState<{ chainId: string } | null>(null)
  const targetKey = target ? eventPathTargetKey(target) : null
  // A new event starts on its own path, never on a chain left open before.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the target identity
  useEffect(() => {
    setChain(null)
  }, [targetKey])
  const close = () => {
    setChain(null)
    onClose()
  }
  return (
    <EventPathSheet
      target={target ? (chain ?? target) : null}
      event={chain ? null : event}
      onClose={close}
      onOpenRecord={(collection, id) => {
        close()
        if (onOpenRecord) onOpenRecord(collection, id)
        else nav.open({ collection, itemId: id })
      }}
      onOpenEvent={isAdmin ? setChain : undefined}
    />
  )
}

/**
 * History sheet section: every integration chain that touched this record —
 * partner pushes, inbound writes, flows — newest first. Each row opens the
 * full path. Renders nothing when the record has none.
 */
export function IntegrationActivitySection({
  collection,
  item,
  onOpenRecord
}: {
  collection: string
  item: string
  onOpenRecord?: (c: string, id: string) => void
}) {
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<IntegrationEvent | null>(null)
  const q = useRecordIntegrationActivity(collection, item, page)
  const rows = q.data?.entries ?? []
  if (!q.isLoading && rows.length === 0 && page === 1) return null
  return (
    <section
      className='mt-4 rounded-lg border border-slate-200 p-3 dark:border-border'
      data-record-integration-activity
    >
      <div className='mb-1.5 flex items-baseline justify-between gap-2'>
        <h3 className='text-[11px] font-semibold uppercase tracking-wide text-muted-foreground'>
          Integration activity
        </h3>
        {page > 1 && (
          <button
            type='button'
            className='text-[11.5px] text-muted-foreground underline-offset-2 hover:underline'
            onClick={() => setPage(1)}
          >
            Newest
          </button>
        )}
      </div>
      {q.isLoading && rows.length === 0 ? (
        <p className='px-2 py-1.5 text-[12px] text-muted-foreground'>Loading…</p>
      ) : (
        <ul className={cn('space-y-0.5', q.isFetching && 'opacity-60')}>
          {rows.map((e) => {
            const key = `${e.source ?? e.provider}:${e.id}`
            return (
              <li key={key}>
                <button
                  type='button'
                  className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-muted'
                  onClick={() => setSelected(e)}
                  data-record-integration-event={key}
                >
                  <span className='w-[136px] shrink-0 whitespace-nowrap tabular-nums text-[11.5px] text-muted-foreground'>
                    {formatDateTime(e.created_at)}
                  </span>
                  <span className='shrink-0 font-medium text-foreground'>{e.label}</span>
                  <span className='min-w-0 truncate text-muted-foreground' data-tip={e.text}>
                    {e.text}
                  </span>
                  {e.status === 'error' && (
                    <span className='ml-auto shrink-0 rounded-full bg-[#fee2e2] px-2 text-[11px] text-[#991b1b] dark:bg-[#450a0a] dark:text-[#fecaca]'>
                      Problem
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {q.data?.has_more && (
        <button
          type='button'
          className='mt-2 text-[12px] text-muted-foreground underline underline-offset-2 hover:text-foreground'
          onClick={() => setPage((p) => p + 1)}
        >
          Older
        </button>
      )}
      <RecordEventPathSheet
        target={
          selected
            ? {
                source: String(selected.source ?? selected.provider),
                id: String(selected.id),
                record: { collection, item }
              }
            : null
        }
        event={selected}
        onClose={() => setSelected(null)}
        onOpenRecord={onOpenRecord}
      />
    </section>
  )
}
