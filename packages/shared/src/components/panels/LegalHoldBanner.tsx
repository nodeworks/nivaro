import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useAfterIdle } from '../../lib/defer'
import { formatRelative } from '../../lib/utils'

/**
 * "On legal hold" strip for the record form's banner stack (#17). Renders nothing unless the
 * record has an active hold. The check (GET /legal-holds/check/:collection/:id) answers at once
 * for a collection with no holds, and waits until the record's own reads have landed.
 */
interface Hold {
  id: number
  reason: string
  created_at: string
}

export function LegalHoldBanner({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const settled = useAfterIdle(1500)
  const { data } = useQuery<Hold | null>({
    queryKey: ['legal-hold', collection, itemId],
    enabled: settled && !!collection && !!itemId,
    queryFn: () =>
      client
        .request<{ data: Hold | null }>(
          get(`/legal-holds/check/${encodeURIComponent(collection)}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false
  })
  if (!data) return null
  return (
    <div
      data-legal-hold-banner
      role='status'
      className='nvr-expand-in flex flex-wrap items-center gap-2 rounded-md border border-violet-200 bg-violet-50 px-3 py-2 dark:border-violet-500/30 dark:bg-violet-500/10'
    >
      <p className='min-w-0 flex-1 text-[12.5px] text-violet-900 dark:text-violet-200'>
        <span className='font-semibold'>On legal hold</span>
        {data.created_at && ` · since ${formatRelative(data.created_at)}`} · its history, trash copy
        and linked files are kept through every purge
        {data.reason && (
          <span className='block truncate text-[11.5px] text-violet-800/80 dark:text-violet-300/80'>
            “{data.reason}”
          </span>
        )}
      </p>
    </div>
  )
}
