import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Collection access requests (#55): "Request access" on a denied collection
 * lands here — grant adds a READ policy to the requester's role in one click
 * (the smallest change that satisfies the request), or deny with a
 * notification either way.
 */

interface AccessRequest {
  id: number
  user: string
  user_name: string | null
  user_email: string | null
  collection: string
  note: string | null
  status: string
  created_at: string
  resolved_at: string | null
}

export default function AccessRequests() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<'pending' | 'granted' | 'denied'>('pending')

  const { data: rows = [] } = useQuery<AccessRequest[]>({
    queryKey: ['access-requests', tab],
    queryFn: () => api.get('/access-requests', { params: { status: tab } }).then((r) => r.data.data)
  })

  const resolve = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: 'grant' | 'deny' }) =>
      api.post(`/access-requests/${id}/resolve`, { decision }).then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(
        d.status === 'granted'
          ? d.policy_added
            ? 'Granted — a read policy was added to their role'
            : 'Granted — their role already had read access'
          : 'Request denied'
      )
      void qc.invalidateQueries({ queryKey: ['access-requests'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to resolve')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <KeyRound className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Access Requests
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Collection-level requests from people who hit an access wall. Granting adds a read
              policy to the requester's role — wider grants live on the Roles page.
            </p>
          </div>
        </div>
        <div className='mt-3 flex gap-1'>
          {(['pending', 'granted', 'denied'] as const).map((t) => (
            <button
              key={t}
              type='button'
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md px-3 py-1.5 text-[12.5px] font-medium capitalize',
                tab === t
                  ? 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
                  : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-muted/50'
              )}
            >
              {t}
            </button>
          ))}
        </div>
      </header>

      <div className='flex-1 space-y-2 overflow-y-auto p-6'>
        {rows.length === 0 && (
          <p className='text-[13px] text-slate-400'>
            {tab === 'pending' ? 'No pending requests — all clear.' : `No ${tab} requests.`}
          </p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className='flex max-w-[820px] items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'
          >
            <div className='min-w-0 flex-1'>
              <p className='text-[13px] text-slate-800 dark:text-foreground'>
                <Link to={`/users/${r.user}`} className='font-semibold hover:underline'>
                  {r.user_name || r.user_email || r.user}
                </Link>{' '}
                wants access to <span className='font-mono font-medium'>{r.collection}</span>
              </p>
              {r.note && (
                <p className='mt-0.5 text-[12.5px] italic text-slate-500 dark:text-muted-foreground'>
                  “{r.note}”
                </p>
              )}
              <p className='mt-0.5 text-[11px] text-slate-400'>
                {new Date(r.created_at).toLocaleString()}
                {r.resolved_at && ` · resolved ${new Date(r.resolved_at).toLocaleString()}`}
              </p>
            </div>
            {tab === 'pending' && (
              <div className='flex shrink-0 gap-1.5'>
                <button
                  type='button'
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: r.id, decision: 'grant' })}
                  className='h-8 rounded-md bg-emerald-500 px-3 text-[12.5px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-50'
                >
                  Grant read
                </button>
                <button
                  type='button'
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: r.id, decision: 'deny' })}
                  className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
                >
                  Deny
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
