import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { ScrollTabStrip } from '@/components/tab-strip'
import { api } from '@/lib/api'

/**
 * Collection access requests (#55): "Request access" on a denied collection
 * lands here — grant adds a READ policy to the requester's role in one click
 * (the smallest change that satisfies the request), or deny with a
 * notification either way.
 */

interface AccessReason {
  type: string
  message: string
  dimension_label?: string
}
interface GrantAction {
  type: 'scope' | 'policy' | 'manual'
  label: string
}
interface AccessRequest {
  id: number
  user: string
  user_name: string | null
  user_email: string | null
  collection: string
  item: string | null
  item_label: string | null
  note: string | null
  reasons: AccessReason[] | null
  plan: GrantAction[]
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
    onSuccess: (d: {
      status: string
      applied?: string[]
      policy_added?: boolean
      remaining?: AccessReason[]
    }) => {
      if (d.status === 'pending') {
        toast.warning(
          `Applied: ${d.applied?.length ? d.applied.join('; ') : 'nothing'} — still blocked: ${(
            d.remaining ?? []
          )
            .map((r) => r.message)
            .join(' ')}`,
          { duration: 12000 }
        )
      } else if (d.status === 'granted') {
        toast.success(
          d.applied?.length
            ? `Granted — ${d.applied.join('; ')}`
            : 'Granted — nothing needed changing, they already had access'
        )
      } else toast.success('Request denied')
      void qc.invalidateQueries({ queryKey: ['access-requests'] })
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to resolve')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Requests from people who hit an access wall on a collection or one record. Each names why it was denied and what granting changes; wider grants live on Roles and user pages.' />
      <ScrollTabStrip
        variant='sub'
        className='shrink-0 border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-background'
        tabs={(['pending', 'granted', 'denied'] as const).map((t) => ({
          id: t,
          label: t[0].toUpperCase() + t.slice(1)
        }))}
        active={tab}
        onSelect={(t) => setTab(t as typeof tab)}
        ariaLabel='Access requests by status'
        tabDomId={(t) => `access-requests-tab-${t}`}
        panelId='access-requests-panel'
      />

      <div
        id='access-requests-panel'
        role='tabpanel'
        aria-labelledby={`access-requests-tab-${tab}`}
        className='flex-1 space-y-2 overflow-y-auto p-4 sm:p-6'
      >
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
                wants access to{' '}
                {r.item ? (
                  <Link
                    to={`/collections/${r.collection}/${r.item}`}
                    className='font-medium text-nvr-navy underline decoration-dotted underline-offset-2 hover:decoration-solid dark:text-nvr-cyan'
                  >
                    {r.collection.replace(/_/g, ' ')} {r.item_label ?? r.item}
                  </Link>
                ) : (
                  <span className='font-mono font-medium'>{r.collection}</span>
                )}
              </p>
              {r.reasons && r.reasons.length > 0 && (
                <ul className='mt-1.5 space-y-1'>
                  {r.reasons.map((why, i) => (
                    <li
                      key={i}
                      className='flex items-start gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'
                    >
                      <span className='mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400' />
                      {/* Reasons were written to the requester ("Your Zone filter…");
                          read them as the admin. */}
                      <span>
                        {why.message
                          .replace(/^Your /, 'Their ')
                          .replace(/\byou are limited/g, 'they are limited')
                          .replace(/\byour role\b/gi, 'their role')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {tab === 'pending' && r.plan.length > 0 && (
                <p className='mt-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
                  <span className='font-medium text-slate-700 dark:text-slate-200'>
                    Granting will:
                  </span>{' '}
                  {r.plan.map((a) => a.label).join('; ')}
                  {r.plan.every((a) => a.type === 'manual') &&
                    ' — nothing here can do that automatically.'}
                </p>
              )}
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
                  disabled={resolve.isPending || r.plan.every((a) => a.type === 'manual')}
                  onClick={() => resolve.mutate({ id: r.id, decision: 'grant' })}
                  className='h-8 rounded-md bg-emerald-500 px-3 text-[12.5px] font-semibold text-white hover:bg-emerald-600 disabled:opacity-50'
                  title={r.plan.map((a) => a.label).join('; ') || undefined}
                >
                  {r.plan.some((a) => a.type === 'scope')
                    ? 'Grant — widen their filter'
                    : 'Grant read'}
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
