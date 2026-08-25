import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * Record insights (Record & Form UX sprint): one header popover answering
 * three questions about a saved record —
 * #123 audience: who hears about a change, and via which channel
 * #241 integrations: every ERP push / webhook delivery about this record
 * #144 owner history: who held the record when (approximation — owners are
 *      resolved with TODAY's matrix config, labeled as such)
 * Plus #399 deep record search: find-in-record across fields.
 */

type Tab = 'audience' | 'integrations' | 'owners' | 'mail' | 'chat'

export function RecordInsightsButton({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<Tab>('audience')
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        data-tip='Record insights — audience, integrations, owner history'
        aria-label='Record insights'
        className='inline-flex h-9 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground'
      >
        <Info className='h-3.5 w-3.5' />
      </button>
      {open && (
        <div className='absolute right-0 top-full z-[60] mt-1 w-[380px] rounded-lg border border-slate-200 bg-white p-3 shadow-xl dark:border-border dark:bg-card'>
          <div className='mb-2 flex gap-1'>
            {(
              [
                ['audience', 'Audience'],
                ['integrations', 'Integrations'],
                ['owners', 'Owner history'],
                ['mail', 'Mail'],
                ['chat', 'Chat']
              ] as Array<[Tab, string]>
            ).map(([key, label]) => (
              <button
                key={key}
                type='button'
                onClick={() => setTab(key)}
                className={
                  tab === key
                    ? 'rounded-md bg-nvr-cyan/10 px-2 py-1 text-[11.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:bg-muted'
                }
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'audience' && <AudienceTab collection={collection} itemId={itemId} />}
          {tab === 'integrations' && <IntegrationsTab collection={collection} itemId={itemId} />}
          {tab === 'owners' && <OwnerHistoryTab collection={collection} itemId={itemId} />}
          {tab === 'mail' && <MailTab collection={collection} itemId={itemId} />}
          {tab === 'chat' && <ChatMentionsTab collection={collection} itemId={itemId} />}
        </div>
      )}
    </div>
  )
}

const EVENT_LABEL: Record<string, string> = {
  all: 'all changes',
  create: 'new records',
  update: 'updates',
  delete: 'deletions',
  workflow_transition: 'state changes'
}

function AudienceTab({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  // One deduped row per person (server drops redacted/suspended users and
  // merges owner + watcher + subscriber roles) — the old three-list shape
  // repeated the same names and surfaced redacted accounts.
  const { data, isLoading } = useQuery<{
    people: Array<{
      id: string
      name: string
      owner: boolean
      watch_fields: string[]
      subscriptions: Array<{ event_type: string; cadence: string; reason: string | null }>
    }>
  }>({
    queryKey: ['record-audience', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/audience/${collection}/${itemId}`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  if (isLoading) return <p className='text-[12px] text-slate-400'>Loading…</p>
  const people = data?.people ?? []
  if (people.length === 0)
    return (
      <p className='text-[12px] text-slate-400'>
        Nobody hears about changes here automatically — no owners, watchers, or subscribers.
      </p>
    )
  return (
    <div className='max-h-72 overflow-y-auto'>
      <p className='pb-1.5 text-[10.5px] text-slate-400'>
        {people.length} {people.length === 1 ? 'person hears' : 'people hear'} about changes to
        this record
      </p>
      {people.map((p) => (
        <div
          key={p.id}
          className='border-t border-slate-100 py-1.5 first:border-t-0 dark:border-border/50'
        >
          <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>{p.name}</p>
          <div className='mt-0.5 flex flex-wrap gap-1'>
            {p.owner && (
              <span className='rounded-full bg-nvr-cyan/10 px-1.5 py-px text-[10.5px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                Owner — notified on transitions
              </span>
            )}
            {p.watch_fields.length > 0 && (
              <span
                className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'
                data-tip={p.watch_fields.join(', ')}
              >
                Chose to watch {p.watch_fields.length}{' '}
                {p.watch_fields.length === 1 ? 'field' : 'fields'}
              </span>
            )}
            {p.subscriptions.map((s) => (
              <span
                key={`${s.event_type}:${s.cadence}:${s.reason ?? ''}`}
                className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'
              >
                {s.reason ?? `Subscribed to ${EVENT_LABEL[s.event_type] ?? s.event_type}`} ·{' '}
                {s.cadence}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function IntegrationsTab({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  // ERP rows come from the SAME route + query key the External-requests chip
  // and failure banner use, so this tab can never disagree with them.
  const { data: erpRows = [], isLoading: erpLoading } = useQuery<
    Array<{
      id: number
      external_api_name: string | null
      target: string | null
      endpoint_path: string | null
      status: string
      created_at: string
      attempts: number
    }>
  >({
    queryKey: ['erp-submissions', collection, String(itemId)],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/erp-submissions/${collection}/${encodeURIComponent(itemId)}`))
        .then((r) => r.data ?? [])
        .catch(() => [] as never),
    staleTime: 30_000
  })
  const { data, isLoading } = useQuery<{
    webhooks: Array<{ id: number; webhook: string; response_status: number; created_at: string }>
  }>({
    queryKey: ['record-integrations', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/record-integrations/${collection}/${itemId}`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  // External ID registry (#351): the record's stored external-system
  // identifiers — heuristic column-name scan, labeled as such.
  const { data: extIds = [] } = useQuery<Array<{ field: string; value: string }>>({
    queryKey: ['record-external-ids', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(get(`/items/${collection}/${itemId}`))
        .then((r) => {
          const row = r.data ?? {}
          const PATTERN = /(external|nuvolo|mwf|oracle|sap|erp|legacy|fusion|mdsi).*(id|number|ref)|^(order_number|requisition_id|sales_order_id)$/i
          return Object.entries(row)
            .filter(([k, v]) => k !== 'id' && v != null && v !== '' && PATTERN.test(k))
            .map(([field, v]) => ({ field, value: String(v).slice(0, 60) }))
            .slice(0, 12)
        })
        .catch(() => []),
    staleTime: 60_000
  })
  if (isLoading || erpLoading) return <p className='text-[12px] text-slate-400'>Loading…</p>
  if (erpRows.length + (data?.webhooks.length ?? 0) === 0)
    return <p className='text-[12px] text-slate-400'>No integration activity for this record.</p>
  return (
    <>
      {extIds.length > 0 && (
        <div className='border-b border-slate-100 px-3 py-2 dark:border-border/50'>
          <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
            External identifiers
          </p>
          <div className='mt-1 flex flex-wrap gap-1.5'>
            {extIds.map((e) => (
              <span
                key={e.field}
                className='inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] dark:border-border dark:bg-muted/40'
              >
                <span className='text-slate-400'>{e.field}:</span>
                <span className='font-mono text-slate-700 dark:text-slate-200'>{e.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {(() => { return (
    <div className='max-h-72 space-y-1 overflow-y-auto text-[12px]'>
      {erpRows.map((e) => (
        <p key={`e${e.id}`} className='flex items-baseline justify-between gap-2'>
          <span className='min-w-0 truncate text-slate-700 dark:text-slate-200'>
            {e.external_api_name ?? e.target ?? e.endpoint_path ?? 'ERP push'}
          </span>
          <span
            className={
              e.status === 'failed'
                ? 'shrink-0 text-red-500'
                : e.status === 'accepted'
                  ? 'shrink-0 text-emerald-600'
                  : 'shrink-0 text-slate-400'
            }
          >
            {e.status} · {new Date(e.created_at).toLocaleDateString()}
          </span>
        </p>
      ))}
      {data?.webhooks.map((w) => (
        <p key={`w${w.id}`} className='flex items-baseline justify-between gap-2'>
          <span className='min-w-0 truncate text-slate-700 dark:text-slate-200'>
            webhook: {w.webhook}
          </span>
          <span className='shrink-0 text-slate-400'>
            {w.response_status} · {new Date(w.created_at).toLocaleDateString()}
          </span>
        </p>
      ))}
    </div>
  ) })()}
    </>
  )
}

function OwnerHistoryTab({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const { data = [], isLoading } = useQuery<
    Array<{
      state_label: string | null
      entered_at: string
      left_at: string | null
      moved_by: string | null
      owners: Array<{ id: string; name: string }>
    }>
  >({
    queryKey: ['record-owner-history', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/owner-history/${collection}/${itemId}`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  if (isLoading) return <p className='text-[12px] text-slate-400'>Loading…</p>
  if (data.length === 0)
    return <p className='text-[12px] text-slate-400'>No workflow history on this record.</p>
  return (
    <div className='max-h-72 space-y-2 overflow-y-auto text-[12px]'>
      <p className='text-[10.5px] text-amber-600 dark:text-amber-400'>
        Owners shown are resolved with TODAY's matrix config — membership changes since then
        aren't snapshotted.
      </p>
      {data.map((h, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ordered stays
        <div key={i}>
          <p className='font-medium text-slate-700 dark:text-slate-200'>
            {h.state_label ?? '—'}{' '}
            <span className='font-normal text-[10.5px] text-slate-400'>
              {new Date(h.entered_at).toLocaleDateString()} →{' '}
              {h.left_at ? new Date(h.left_at).toLocaleDateString() : 'now'}
              {h.moved_by ? ` · moved by ${h.moved_by}` : ''}
            </span>
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {h.owners.length > 0 ? h.owners.map((o) => o.name).join(', ') : 'no resolved owners'}
          </p>
        </div>
      ))}
    </div>
  )
}


// ─── Mail tab (#261): mail sent about this record — headers only ─────────────
function MailTab({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['record-mail-log', collection, itemId],
    queryFn: () =>
      client
        .request<{
          data: Array<{ id: number; to: string; subject: string; template: string | null; status: string; created_at: string }>
        }>(get(`/mail-log/record/${collection}/${itemId}`))
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 30_000
  })
  if (isLoading) return <p className='p-3 text-[12px] text-slate-400'>Loading…</p>
  if (rows.length === 0)
    return (
      <p className='p-3 text-[12px] text-slate-400'>
        No emails recorded about this record. (Mail logging captures record context from
        subscription and workflow sends.)
      </p>
    )
  return (
    <div className='max-h-72 overflow-y-auto'>
      {rows.map((m) => (
        <div key={m.id} className='border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-border/50'>
          <div className='flex items-center gap-2'>
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                m.status === 'sent' ? 'bg-emerald-500' : m.status === 'failed' ? 'bg-red-500' : 'bg-slate-300'
              }`}
            />
            <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700 dark:text-slate-200'>
              {m.subject}
            </span>
          </div>
          <p className='ml-3.5 truncate text-[10.5px] text-slate-400'>
            to {m.to} · {m.status} · {new Date(m.created_at).toLocaleString()}
          </p>
        </div>
      ))}
    </div>
  )
}


// ─── Chat mentions (#132): messages naming this record beyond its own room ──
function ChatMentionsTab({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['record-chat-mentions', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: number; room: string; message: string; sender_name: string | null; date_created: string }> }>(
          get(`/chat/record-mentions/${collection}/${itemId}`)
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000
  })
  if (isLoading) return <p className='p-3 text-[12px] text-slate-400'>Loading…</p>
  if (rows.length === 0)
    return (
      <p className='p-3 text-[12px] text-slate-400'>
        No chat messages mention this record outside its own room.
      </p>
    )
  const roomLabel = (r: string) =>
    r === 'global' ? '#global' : r.startsWith('ch:') ? `#${r.slice(3)}` : r.startsWith('dm:') ? 'a direct message' : r
  return (
    <div className='max-h-72 overflow-y-auto'>
      {rows.map((m) => (
        <div key={m.id} className='border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-border/50'>
          <p className='text-[12px] text-slate-700 dark:text-slate-200'>
            <span className='font-medium'>{m.sender_name ?? 'Someone'}</span>{' '}
            <span className='text-slate-400'>in {roomLabel(m.room)}</span>
          </p>
          <p className='truncate text-[11.5px] text-slate-500'>{m.message.slice(0, 160)}</p>
          <p className='text-[10px] text-slate-400'>{new Date(m.date_created).toLocaleString()}</p>
        </div>
      ))}
    </div>
  )
}
