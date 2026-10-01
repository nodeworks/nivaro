import { useQuery } from '@tanstack/react-query'
import { Copy, Repeat } from 'lucide-react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { fmtCount } from '../EventTicker'
import { inspectorActions } from '../registry/inspectorActions'
import { register } from '../registry/registry'
import type { Selection } from '../types'

/**
 * #1159 — load replay, development only: on a caller (an API key or a person), what the
 * `traffic:replay` script would send over the last hour and the command to run it against a
 * throwaway API. The preview route answers 404 outside development, so nothing shows there.
 */
interface Preview {
  caller: string
  hours: number
  gets: number
  capped: boolean
  dropped_queries: number
  top_paths: Array<{ path: string; n: number }>
  command: string
}

export function replayable(sel: Selection): boolean {
  return sel.kind === 'caller' && /^(k\d+|u[0-9A-Fa-f-]{36})$/.test(sel.id)
}

function ReplayAction({ sel }: { sel: Selection }) {
  const q = useQuery({
    queryKey: ['traffic-map', 'replay-preview', sel.id],
    queryFn: async () =>
      (await api.get(`/traffic-map/replay/preview?caller=${encodeURIComponent(sel.id)}&hours=1`))
        .data.data as Preview,
    retry: false,
    staleTime: 60_000
  })
  if (!q.data) return null
  const p = q.data
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          id='tm-replay'
          className='inline-flex items-center gap-1 rounded border border-[var(--tm-line)] bg-[var(--tm-card)] px-2 py-[2px] text-[11.5px] font-medium text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
        >
          <Repeat className='h-3 w-3' aria-hidden='true' />
          Replay load (dev)
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='traffic-map w-[380px] border-[var(--tm-line)] bg-[var(--tm-card)] p-3.5 text-[12px] text-[var(--tm-fg)]'
        data-tm-replay=''
      >
        <h3 className='text-[13px] font-semibold'>Replay this caller's reads</h3>
        <p className='mt-1 text-[var(--tm-fg-2)]'>
          {fmtCount(p.gets)} GET requests in the last hour{p.capped ? ' (newest only)' : ''}. The
          script replays a sample against a throwaway API — never a shared one — as the token you
          give it.
          {p.dropped_queries > 0
            ? ` ${fmtCount(p.dropped_queries)} masked query strings are sent without them.`
            : ''}
        </p>
        {p.top_paths.length > 0 && (
          <ul className='mt-2 space-y-0.5 font-mono text-[11px] text-[var(--tm-fg-2)]'>
            {p.top_paths.map((t) => (
              <li key={t.path} className='truncate'>
                {fmtCount(t.n)} × {t.path}
              </li>
            ))}
          </ul>
        )}
        <div className='mt-2.5 flex items-start gap-1.5'>
          <code className='block min-w-0 flex-1 break-all rounded border border-[var(--tm-line)] bg-[var(--tm-card-2)] p-2 font-mono text-[11px]'>
            {p.command}
          </code>
          <button
            type='button'
            aria-label='Copy the command'
            className='rounded border border-[var(--tm-line)] p-1.5 text-[var(--tm-fg-2)] hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onClick={() =>
              void navigator.clipboard
                .writeText(p.command)
                .then(() => toast.success('Command copied'))
                .catch(() => toast.error('Copy failed'))
            }
          >
            <Copy className='h-3.5 w-3.5' aria-hidden='true' />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

register(inspectorActions, {
  id: 'replay',
  order: 90,
  applies: (sel) => replayable(sel),
  Component: ReplayAction
})
