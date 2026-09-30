import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { formatApiPayload } from '../../lib/api-payload'
import { get } from '../../lib/commands'
import { formatDateTime, formatRelative } from '../../lib/utils'
import { HighlightedCode } from '../item-edit/HighlightedCode'
import { type ApiLogRow, ReplayBlock } from '../monitoring/ApiRequestLog'
import { RecordEventPathSheet } from '../panels/IntegrationActivitySection'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * The inbound request behind one write (#617 / #609): which caller (the API
 * key's name, else the account's), the call itself, the body it sent
 * (administrators), a replay of it (administrators) and the path everything
 * it set off took. Opened from a field's "changed by <caller>" stamp and from
 * the caller's entries in the Notes thread.
 */
export interface InboundRequestInfo {
  log_id: number
  method: string
  path: string
  status: number | null
  auth: string
  api_key_name: string | null
  user_name: string | null
  at: string
  chain_id: string | null
  body: unknown
  body_withheld?: boolean
  request_body?: string | null
  query?: string | null
  can_replay?: boolean
  matched_by: 'chain' | 'window'
}

export function useInboundRequest(activityId: number | null | undefined, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['inbound-request', activityId],
    queryFn: () =>
      client
        .request<{ data: InboundRequestInfo | null }>(
          get(`/inbound-attribution/activity/${activityId}/request`)
        )
        .then((r) => r.data ?? null),
    enabled: enabled && activityId != null && activityId > 0,
    staleTime: 5 * 60_000
  })
}

export function InboundRequestDetail({
  activityId,
  callerName,
  collection,
  itemId,
  onShowPath
}: {
  activityId: number
  callerName: string
  collection: string
  itemId: string
  onShowPath: (logId: number, label: string) => void
}) {
  const { isAdmin } = useItemEditAuth()
  const { data, isLoading, isError } = useInboundRequest(activityId, true)
  const payload = useMemo(() => (data ? formatApiPayload(data.body) : null), [data])
  if (isLoading) {
    return (
      <div className='space-y-2' data-inbound-request='loading'>
        <div className='h-3 w-40 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        <div className='h-16 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  }
  if (isError) {
    return (
      <p className='text-[12px] text-red-700 dark:text-red-400' data-inbound-request='error'>
        Could not load the request behind this change.
      </p>
    )
  }
  if (!data) {
    return (
      <p className='text-[12px] text-slate-500 dark:text-slate-400' data-inbound-request='none'>
        {callerName} wrote this, but the request itself is no longer in the request log (it keeps 14
        days) or was not recorded.
      </p>
    )
  }
  const replayRow: ApiLogRow = {
    id: data.log_id,
    method: data.method,
    path: data.path,
    status: data.status ?? 0,
    latency_ms: 0,
    user: null,
    user_name: data.user_name,
    user_email: null,
    collection,
    api_key_id: null,
    api_key_name: data.api_key_name,
    auth: data.auth as ApiLogRow['auth'],
    ip: null,
    user_agent: null,
    error: null,
    request_body: data.request_body ?? null,
    query: data.query ?? null,
    created_at: data.at
  }
  return (
    <div className='text-[12px]' data-inbound-request={data.log_id}>
      <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1'>
        <dt className='text-slate-500 dark:text-slate-400'>Caller</dt>
        <dd className='text-slate-700 dark:text-slate-200'>
          {data.api_key_name
            ? `API key “${data.api_key_name}”`
            : data.user_name
              ? `${data.user_name} (access token)`
              : callerName}
        </dd>
        <dt className='text-slate-500 dark:text-slate-400'>Request</dt>
        <dd className='break-all font-mono text-[11px] text-slate-700 dark:text-slate-200'>
          {data.method} {data.path}
          {data.status != null && (
            <span
              className={
                data.status >= 400
                  ? 'ml-2 text-red-700 dark:text-red-400'
                  : 'ml-2 text-emerald-700 dark:text-emerald-400'
              }
            >
              → {data.status}
            </span>
          )}
        </dd>
        <dt className='text-slate-500 dark:text-slate-400'>When</dt>
        <dd className='text-slate-700 dark:text-slate-200' data-tip={formatDateTime(data.at)}>
          {formatRelative(data.at)}
          {data.matched_by === 'window' && (
            <span className='ml-1 text-[11px] text-slate-400'>
              · matched by time — the nearest call from this caller
            </span>
          )}
        </dd>
      </dl>
      {isAdmin && data.request_body ? (
        <ReplayBlock row={replayRow} />
      ) : payload ? (
        <div className='mt-2 space-y-1.5'>
          {payload.sections.map((sec) => (
            <pre
              key={sec.title}
              data-inbound-payload={sec.kind}
              className='max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-slate-50 p-2 font-mono text-[10.5px] leading-snug text-slate-700 dark:border-border dark:bg-[#0f172a] dark:text-slate-200'
            >
              <HighlightedCode kind={sec.kind} text={sec.text} />
            </pre>
          ))}
          <div className='flex justify-end'>
            <button
              type='button'
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(payload.sections.map((x) => x.text).join('\n\n'))
                  .then(() => toast.success('Payload copied'))
              }}
              className='text-[11px] text-slate-500 hover:underline dark:text-slate-400'
            >
              Copy payload
            </button>
          </div>
        </div>
      ) : (
        <p className='mt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
          {data.body_withheld
            ? 'Only administrators can see the request body.'
            : 'The request body was not recorded.'}
        </p>
      )}
      <div className='mt-2 flex justify-end'>
        <button
          type='button'
          data-inbound-request-path
          onClick={() => onShowPath(data.log_id, `${data.method} ${data.path}`)}
          className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] font-medium text-slate-700 hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted'
          data-tip={`Everything this request set off on ${collection} / ${itemId}, step by step`}
        >
          Show the path it took
        </button>
      </div>
    </div>
  )
}

/**
 * A trigger (any inline element) that opens the request behind an inbound
 * write. The event-path sheet opens AFTER the popover closes, so a sheet
 * never mounts inside a popover.
 */
export function InboundRequestPopover({
  activityId,
  callerName,
  collection,
  itemId,
  children,
  align = 'start'
}: {
  activityId: number
  callerName: string
  collection: string
  itemId: string
  children: ReactNode
  align?: 'start' | 'center' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [path, setPath] = useState<{ logId: number; label: string } | null>(null)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent
          align={align}
          className='w-[520px] max-w-[94vw] p-3'
          data-inbound-request-popover={activityId}
        >
          <p className='mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            <KeyRound className='h-3.5 w-3.5 text-nvr-cyan' />
            Written by {callerName} through the API
          </p>
          {open && (
            <InboundRequestDetail
              activityId={activityId}
              callerName={callerName}
              collection={collection}
              itemId={itemId}
              onShowPath={(logId, label) => {
                setOpen(false)
                setPath({ logId, label })
              }}
            />
          )}
        </PopoverContent>
      </Popover>
      <RecordEventPathSheet
        target={
          path
            ? {
                source: 'core:inbound',
                id: String(path.logId),
                record: { collection, item: String(itemId) }
              }
            : null
        }
        event={path ? { label: path.label } : null}
        onClose={() => setPath(null)}
      />
    </>
  )
}
