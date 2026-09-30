import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useAfterIdle } from '../../lib/defer'
import { formatDateTime, formatRelative } from '../../lib/utils'
import { InboundRequestPopover } from '../integrations/InboundRequest'

/**
 * "updated 2h ago · import (Bid Import)" under a header chip — the newest
 * revision that touched THAT field. One request per record covers every
 * header field (react-query dedupes on the shared key). A field nobody has
 * changed since creation shows nothing: the stamp marks edits, not birth.
 */
export type FieldTouch = {
  at: string
  who: string
  via: 'import' | 'integration' | 'system' | 'user'
  /** The activity row that wrote it — opens the inbound request (#617). */
  activity_id?: number
  /** An inbound token / API-key write: the caller's name (key name, else
   *  the account's), never just "integration". */
  caller?: { name: string; kind: 'api_key' | 'token' | 'account'; key: string } | null
}
type Touch = FieldTouch

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
  // #617 — an inbound write names its caller and opens the request.
  if (t.caller && t.activity_id) {
    return (
      <InboundRequestPopover
        activityId={t.activity_id}
        callerName={t.caller.name}
        collection={collection}
        itemId={itemId}
      >
        <button
          type='button'
          data-copy-skip
          data-field-touch-caller={t.caller.key}
          className='mt-0.5 block max-w-full truncate text-left text-[10px] leading-none text-amber-700/80 underline decoration-dotted underline-offset-2 hover:text-amber-800 dark:text-amber-300/80 dark:hover:text-amber-200 [[data-header-dense]_&]:hidden'
          data-tip={`${t.caller.name} · ${formatDateTime(t.at)} — click for the request`}
        >
          {t.caller.name} · {formatRelative(t.at)}
        </button>
      </InboundRequestPopover>
    )
  }
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
