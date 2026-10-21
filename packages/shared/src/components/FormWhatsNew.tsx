import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sparkles, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useNivaroClient } from '../context'
import { get, post } from '../lib/commands'

/**
 * "What's new on this form" (#2657): the first time someone opens a form after it changed,
 * a short note of what moved, was added or removed, from the version diff. Dismissed per
 * person (the server keeps what they last saw); the person who saved never sees it.
 */

interface WhatsNewAnswer {
  rev: string | null
  lines: string[] | null
  mark: boolean
  changed_at?: string | null
  changed_by?: string | null
}

export function FormWhatsNew({ layoutId }: { layoutId: number }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const key = ['form-whats-new', layoutId] as const
  const { data } = useQuery<WhatsNewAnswer | null>({
    queryKey: key,
    queryFn: async () => {
      const r = await client.request<{ data?: WhatsNewAnswer }>(
        get(`/layout-collab/${layoutId}/whats-new`)
      )
      return r?.data ?? null
    },
    staleTime: 5 * 60_000,
    retry: false
  })
  // Nothing to show but a state to remember (first open, a settings-only change): record it once.
  const marked = useRef<string | null>(null)
  useEffect(() => {
    if (!data?.mark || !data.rev || marked.current === data.rev) return
    marked.current = data.rev
    void client
      .request(post(`/layout-collab/${layoutId}/whats-new/seen`, { rev: data.rev }))
      .catch(() => undefined)
  }, [client, data, layoutId])

  if (!data?.lines?.length || !data.rev) return null
  const rev = data.rev
  const dismiss = () => {
    qc.setQueryData(key, { ...data, lines: null, mark: false })
    void client
      .request(post(`/layout-collab/${layoutId}/whats-new/seen`, { rev }))
      .catch(() => undefined)
  }
  const when = data.changed_at
    ? new Date(data.changed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null
  return (
    <div
      data-form-whats-new=''
      role='status'
      className='mb-2 flex items-start gap-2 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/5 px-3 py-2 text-[12px] text-slate-700 dark:text-foreground'
    >
      <Sparkles className='mt-[1px] h-3.5 w-3.5 shrink-0 text-[#007a99] dark:text-nvr-cyan' />
      <div className='min-w-0 flex-1'>
        <div className='font-semibold text-[#007a99] dark:text-nvr-cyan'>
          What’s new on this form
          {(data.changed_by || when) && (
            <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>
              {[data.changed_by, when].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        <ul className='mt-0.5 space-y-0.5'>
          {data.lines.map((l) => (
            <li key={l} className='break-words'>
              {l}
            </li>
          ))}
        </ul>
      </div>
      <button
        type='button'
        aria-label='Dismiss what’s new'
        data-tip='Got it'
        onClick={dismiss}
        className='inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-nvr-cyan/10 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
