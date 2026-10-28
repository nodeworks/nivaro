import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useAfterIdle } from '../../lib/defer'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { InboundRequestPopover } from '../integrations/InboundRequest'

/**
 * An info icon on a header chip ("Changed by … · when" on hover) — the newest
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
  fields,
  className
}: {
  collection: string
  itemId: string
  field: string
  /** Every header field — the shared query key. */
  fields: string[]
  /** Placement on the tile (the band puts it top-right, beside Copy). */
  className?: string
}) {
  const { data } = useFieldTouches(collection, itemId, fields)
  const t = data?.[field]
  if (!t) return null
  const machine = t.via !== 'user'
  const iconCls = cn(
    'h-3 w-3',
    machine ? 'text-amber-600/80 dark:text-amber-300/80' : 'text-slate-400 dark:text-slate-500'
  )
  const boxCls = cn(
    'flex h-3 w-3 items-center justify-center rounded-sm opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
    className
  )
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
          aria-label={`Changed by ${t.caller.name} ${formatRelative(t.at)} — open the request`}
          className={boxCls}
          data-tip={`${t.caller.name} · ${formatDateTime(t.at)} — click for the request`}
          onClick={(e) => e.stopPropagation()}
        >
          <Info className={iconCls} />
        </button>
      </InboundRequestPopover>
    )
  }
  const who = machine && t.via !== 'import' ? `${t.who} (${t.via})` : t.who
  const tip = `Changed by ${who} · ${formatDateTime(t.at)} (${formatRelative(t.at)})`
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the tip
    <span data-copy-skip tabIndex={0} role='img' aria-label={tip} data-tip={tip} className={boxCls}>
      <Info className={iconCls} />
    </span>
  )
}
