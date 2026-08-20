import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * Data-integrity findings for THIS record, from the latest completed
 * conformance run — editors fix issues where they live instead of admins
 * chasing a list. Per-collection toggle (nivaro_collections.integrity_badge,
 * default on) is enforced server-side; nothing renders when the record is
 * clean, the collection has never been swept, or the badge is off.
 */
export function RecordIntegrityBanner({
  collection,
  itemId,
  onJumpToField
}: {
  collection: string
  itemId: string
  onJumpToField?: (field: string) => void
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  const { data } = useQuery<{
    enabled: boolean
    checked_at?: string | null
    findings: Array<{ field: string; rule: string; message: string | null }>
  }>({
    queryKey: ['record-integrity', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: never }>(
          get(`/config-conformance/record/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data)
        .catch(() => ({ enabled: false, findings: [] }) as never),
    staleTime: 5 * 60_000
  })

  if (!data?.enabled || data.findings.length === 0) return null
  const n = data.findings.length
  return (
    <div
      data-record-integrity
      className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 dark:border-amber-500/30 dark:bg-amber-400/10'
    >
      <div className='flex items-center gap-2'>
        <span className='text-[12.5px] font-medium text-amber-800 dark:text-amber-300'>
          {n} data integrity issue{n === 1 ? '' : 's'} on this record
        </span>
        {data.checked_at && (
          <span className='text-[11px] text-amber-600/80 dark:text-amber-400/70'>
            checked {new Date(data.checked_at).toLocaleDateString()}
          </span>
        )}
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          className='ml-auto text-[11.5px] font-medium text-amber-700 underline decoration-dotted underline-offset-2 dark:text-amber-300'
        >
          {expanded ? 'Hide' : 'View'}
        </button>
      </div>
      {expanded && (
        <div className='mt-1.5 space-y-1'>
          {data.findings.map((f, i) => (
            <div key={i} className='flex items-baseline gap-2 text-[12px]'>
              <button
                type='button'
                onClick={() => onJumpToField?.(f.field)}
                className='shrink-0 font-mono text-[11px] text-amber-700 underline decoration-dotted underline-offset-2 dark:text-amber-300'
              >
                {f.field}
              </button>
              <span className='min-w-0 text-amber-800 dark:text-amber-200/90'>{f.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
