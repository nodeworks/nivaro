import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useAfterIdle } from '../../lib/defer'
import { formatDateTime, formatRelative } from '../../lib/utils'

/**
 * "updated 2h ago · import (Bid Import)" under a header chip — the newest
 * revision that touched THAT field. One request per record covers every
 * header field (react-query dedupes on the shared key). A field nobody has
 * changed since creation shows nothing: the stamp marks edits, not birth.
 */
type Touch = { at: string; who: string; via: 'import' | 'integration' | 'system' | 'user' }

export function useFieldTouches(collection: string, itemId: string, fields: string[]) {
  const client = useNivaroClient()
  const key = [...fields].sort().join(',')
  // Decoration, not content: wait for the form's own reads to land first.
  const settled = useAfterIdle(1500)
  return useQuery<Record<string, Touch>>({
    queryKey: ['field-touch', collection, itemId, key],
    queryFn: () =>
      client
        .request<{ data: Record<string, Touch> }>(
          get('/revisions/field-touch', { collection, item: itemId, fields: key })
        )
        .then((r) => r.data ?? {}),
    enabled: settled && !!itemId && itemId !== 'new' && fields.length > 0,
    staleTime: 60_000
  })
}

export function HeaderFreshness({
  collection,
  itemId,
  field,
  fields
}: {
  collection: string
  itemId: string
  field: string
  /** Every header field — the shared query key. */
  fields: string[]
}) {
  const { data } = useFieldTouches(collection, itemId, fields)
  const t = data?.[field]
  if (!t) return null
  const machine = t.via !== 'user'
  return (
    <span
      data-copy-skip
      className={
        machine
          ? 'mt-0.5 block truncate text-[10px] leading-none text-amber-700/80 dark:text-amber-300/80 [[data-header-dense]_&]:hidden'
          : 'mt-0.5 block truncate text-[10px] leading-none text-slate-400 dark:text-slate-500 [[data-header-dense]_&]:hidden'
      }
      data-tip={`${t.who} · ${formatDateTime(t.at)}`}
    >
      {formatRelative(t.at)}
      {machine ? ` · ${t.via === 'import' ? t.who : t.via}` : ''}
    </span>
  )
}
