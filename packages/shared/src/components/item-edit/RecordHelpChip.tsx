import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LifeBuoy } from 'lucide-react'
import { useNavigation, useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { LIVE_ASPECTS, useLiveRecordQueries } from '../../lib/live'

/**
 * "Help requested by Beth" in a record's header (realtime round 9, item 19): a support request
 * raised from this record is still open. Everyone who can read the record sees that help was
 * asked for; who asked, its status and the link to the request follow the support rules (the
 * requester, the assignee, the request's team and administrators — GET /support/record/:c/:id).
 * Live: opening, picking up, reassigning or closing a request sends the record's `$support`
 * aspect; the chip re-reads and appears or goes quietly.
 */

export interface RecordHelpTicket {
  id: number
  title: string
  status: string
  requested_by: string | null
  requested_by_id: string
  assignee: string | null
  created_at: string | null
}

export interface RecordHelp {
  open: number
  tickets: RecordHelpTicket[]
}

export const recordHelpKey = (collection: string, itemId: string) => [
  'record-help',
  collection,
  itemId
]

/** The chip's words (pure). */
export function helpChipText(help: RecordHelp | null | undefined): string | null {
  if (!help || help.open <= 0) return null
  const first = help.tickets[0]
  const more = help.open - 1
  const who = first?.requested_by
  const base = who ? `Help requested by ${who}` : 'Help requested'
  return more > 0 ? `${base} +${more}` : base
}

/** The tip: what the viewer may know about the request(s) (pure). */
export function helpChipTip(help: RecordHelp): string {
  const first = help.tickets[0]
  if (!first) {
    return help.open === 1
      ? 'Someone asked the support team for help with this record.'
      : `${help.open} open requests for help with this record.`
  }
  const state =
    first.status === 'in_progress'
      ? first.assignee
        ? `${first.assignee} is on it`
        : 'In progress'
      : 'Waiting for the support team'
  return `“${first.title}” · ${state}`
}

export function RecordHelpChip({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const nav = useNavigation()
  const id = itemId && itemId !== 'new' ? String(itemId) : null
  const { data } = useQuery<RecordHelp | null>({
    queryKey: recordHelpKey(collection, id ?? ''),
    queryFn: () =>
      client
        .request<{ data: RecordHelp }>(
          get(`/support/record/${encodeURIComponent(collection)}/${encodeURIComponent(id ?? '')}`)
        )
        .then((r) => r.data ?? null)
        .catch(() => null),
    enabled: !!id && !/^(nivaro_|directus_)/.test(collection),
    staleTime: 60_000,
    retry: false
  })
  useLiveRecordQueries(collection, id, [recordHelpKey(collection, id ?? '')], {
    aspects: [LIVE_ASPECTS.support],
    includeOwn: true,
    client: qc
  })
  const text = helpChipText(data)
  if (!data || !text) return null
  const first = data.tickets[0]
  const path = first
    ? (nav.consoleUrl?.(`/support?ticket=${first.id}`) ??
      (nav.consoleUrl ? null : `/support?ticket=${first.id}`))
    : null
  const cls =
    'nvr-fade-in inline-flex max-w-[16rem] shrink-0 items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-px text-[10.5px] font-medium text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
  const body = (
    <>
      <LifeBuoy className='h-3 w-3 shrink-0 text-amber-600 dark:text-amber-300' aria-hidden />
      <span className='truncate'>{text}</span>
    </>
  )
  if (!path)
    return (
      <span data-record-help={data.open} data-tip={helpChipTip(data)} className={cls}>
        {body}
      </span>
    )
  return (
    <a
      href={path}
      data-record-help={data.open}
      data-tip={helpChipTip(data)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || /^https?:/.test(path)) return
        e.preventDefault()
        nav.navigate(path)
      }}
      className={`${cls} hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 dark:hover:bg-amber-500/20`}
    >
      {body}
    </a>
  )
}
