import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowUpRight } from 'lucide-react'
import type { MouseEvent } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'

/**
 * Request id cards (#2762). A request id (uuid) or trace id (the same id
 * without dashes) pasted into a message unfurls into a card. The server
 * builds it for the reader: administrators get the route, status, duration,
 * person and a link to the request on the Traffic Map; everyone else only
 * learns that the id names a logged request. Ids that name nothing render
 * nothing, so an ordinary uuid stays plain text.
 */

export interface RequestCardDetails {
  method: string
  route: string
  path: string
  status: number
  duration_ms: number
  at: string | null
  person: string | null
  caller_kind: 'user' | 'api_key' | 'anonymous'
  trace_kept: boolean
  trace_note: string | null
  trace_url: string
}

export interface RequestCardData {
  kind: 'request'
  id: string
  details: RequestCardDetails | null
}

const ID_RE = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})\b/gi
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+/gi

/** Request / trace ids written in a message (never ones inside a link), at most `max`. */
export function extractRequestIds(text: string, max = 2): string[] {
  const out: string[] = []
  const stripped = text.replace(/```[\s\S]*?```/g, ' ').replace(URL_RE, ' ')
  for (const m of stripped.matchAll(ID_RE)) {
    const id = m[0].toLowerCase()
    // A trace id and its request id are the same request.
    const key = id.replace(/-/g, '')
    if (!out.some((o) => o.replace(/-/g, '') === key)) out.push(id)
    if (out.length >= max) break
  }
  return out
}

export function shortRequestId(id: string): string {
  const h = id.replace(/-/g, '')
  return `${h.slice(0, 8)}…${h.slice(-4)}`
}

function statusTone(status: number): string {
  if (status >= 500) return 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  if (status >= 400) return 'bg-amber-50 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
  if (status >= 200 && status < 300)
    return 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  return 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
}

function formatMs(ms: number): string {
  if (ms >= 10_000) return `${(ms / 1000).toFixed(1)} s`
  return `${ms.toLocaleString()} ms`
}

function formatAt(at: string | null): string | null {
  if (!at) return null
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return null
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
}

/** Same-origin links navigate inside the app; another app's link opens in a new tab. */
function inAppPath(url: string): string | null {
  if (url.startsWith('/')) return url
  try {
    if (typeof window === 'undefined') return null
    const u = new URL(url)
    return u.origin === window.location.origin ? `${u.pathname}${u.search}` : null
  } catch {
    return null
  }
}

const shell =
  'block w-full max-w-[340px] rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'

export function RequestCardView({
  card,
  navigate
}: {
  card: RequestCardData
  navigate?: (url: string) => void
}) {
  const d = card.details
  if (!d) {
    return (
      <div className={shell} data-chat-request-card='summary' data-chat-request-id={card.id}>
        <span className='flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
          <Activity className='h-3.5 w-3.5 shrink-0' />
          Request <span className='font-mono'>{shortRequestId(card.id)}</span>
        </span>
        <span className='mt-0.5 block text-[11.5px] text-slate-600 dark:text-slate-300'>
          This request was logged. Its details are for administrators.
        </span>
      </div>
    )
  }
  const at = formatAt(d.at)
  const meta = [formatMs(d.duration_ms), d.person, at].filter(Boolean) as string[]
  const local = inAppPath(d.trace_url)
  const onClick = (e: MouseEvent) => {
    if (local && navigate) {
      e.preventDefault()
      navigate(local)
    }
  }
  return (
    <a
      href={d.trace_url}
      target={local ? undefined : '_blank'}
      rel={local ? undefined : 'noopener noreferrer'}
      onClick={onClick}
      className={cn(shell, 'hover:border-slate-300 dark:hover:border-slate-600')}
      data-chat-request-card='details'
      data-chat-request-id={card.id}
    >
      <span className='flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400'>
        <Activity className='h-3.5 w-3.5 shrink-0' />
        <span>
          Request <span className='font-mono'>{shortRequestId(card.id)}</span>
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 rounded px-1.5 py-px font-mono text-[10.5px] font-medium',
            statusTone(d.status)
          )}
          data-chat-request-status={d.status}
        >
          {d.status}
        </span>
      </span>
      <span
        className='mt-0.5 block truncate font-mono text-[11.5px] font-medium text-slate-800 dark:text-slate-100'
        data-tip={d.path}
      >
        {d.route}
      </span>
      {meta.length > 0 && (
        <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
          {meta.join(' · ')}
        </span>
      )}
      <span className='mt-1 flex items-center gap-1 text-[11px]'>
        <span className='inline-flex items-center gap-0.5 font-medium text-nvr-navy dark:text-nvr-cyan'>
          {d.trace_kept ? 'Open trace' : 'Open request'}
          <ArrowUpRight className='h-3 w-3' />
        </span>
        {!d.trace_kept && d.trace_note && (
          <span
            className='truncate text-slate-500 dark:text-slate-400'
            data-tip={d.trace_note}
            data-chat-request-no-trace
          >
            · no trace kept
          </span>
        )}
      </span>
    </a>
  )
}

export function RequestIdCard({ id, navigate }: { id: string; navigate?: (url: string) => void }) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-request-card', id],
    queryFn: () =>
      client
        .request<{ data: RequestCardData | null }>(get('/chat/request-card', { id }))
        .then((r) => r.data ?? null),
    staleTime: 60_000,
    retry: false
  })
  if (!data) return null
  return <RequestCardView card={data} navigate={navigate} />
}
