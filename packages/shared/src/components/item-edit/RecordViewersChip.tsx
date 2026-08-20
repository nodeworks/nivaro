import { useQuery } from '@tanstack/react-query'
import { Eye } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'

interface Viewer {
  user_id: string
  name: string
  last_viewed_at: string
}

/**
 * "Viewed by N" — who has opened this record, from the same per-user view
 * watermarks the recap strip writes. Admin-only (the route 403s everyone
 * else, and the host should only mount this for admins): whether the
 * approver actually looked is an audit question, not a social feature.
 */
export function RecordViewersChip({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data: viewers } = useQuery<Viewer[]>({
    queryKey: ['record-viewers', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: Viewer[] }>(
          get(`/record-views/${collection}/${encodeURIComponent(itemId)}/viewers`)
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 60_000
  })

  if (!viewers || viewers.length === 0) return null

  return (
    <span className='relative inline-flex'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        data-record-viewers
        className='inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10.5px] text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:text-slate-500 dark:hover:bg-muted dark:hover:text-slate-300'
        title='Who has opened this record'
      >
        <Eye className='h-3 w-3' />
        {viewers.length}
      </button>
      {open && (
        <>
          <button
            type='button'
            aria-label='Close'
            className='fixed inset-0 z-[100] cursor-default'
            onClick={() => setOpen(false)}
          />
          <div className='absolute left-0 top-full z-[110] mt-1 w-60 rounded-lg border border-slate-200 bg-white p-2 shadow-lg dark:border-border dark:bg-card'>
            <p className='mb-1 px-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              Viewed by
            </p>
            <div className='max-h-56 space-y-0.5 overflow-y-auto'>
              {viewers.map((v) => (
                <div
                  key={v.user_id}
                  className='flex items-baseline justify-between gap-2 rounded px-1 py-0.5 text-[11.5px] hover:bg-slate-50 dark:hover:bg-muted'
                >
                  <span className='truncate text-slate-700 dark:text-slate-200'>{v.name}</span>
                  <span className='shrink-0 text-[10.5px] text-slate-400'>
                    {formatRelative(v.last_viewed_at)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  )
}
