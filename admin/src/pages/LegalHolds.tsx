import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Scale } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Legal Holds — exemptions from retention, trash purge and archival, with a
 * full audit trail. A hold names either a record (collection + id) or a user.
 */

interface Hold {
  id: number
  collection: string | null
  item_id: string | null
  user: string | null
  user_name: string | null
  reason: string
  placed_by_name: string | null
  created_at: string
  released_at: string | null
}

export default function LegalHolds() {
  const qc = useQueryClient()
  const [showReleased, setShowReleased] = useState(false)
  const [kind, setKind] = useState<'record' | 'user'>('record')
  const [collection, setCollection] = useState('')
  const [itemId, setItemId] = useState('')
  const [userSearch, setUserSearch] = useState('')
  const [userId, setUserId] = useState('')
  const [reason, setReason] = useState('')

  const { data: holds = [] } = useQuery<Hold[]>({
    queryKey: ['legal-holds', showReleased],
    queryFn: () =>
      api
        .get('/legal-holds', { params: { include_released: showReleased || undefined } })
        .then((r) => r.data.data)
  })
  const { data: users = [] } = useQuery<Array<{ id: string; first_name: string; last_name: string; email: string }>>({
    queryKey: ['legal-hold-users', userSearch],
    queryFn: () =>
      api.get('/users', { params: { search: userSearch, limit: 10 } }).then((r) => r.data.data),
    enabled: kind === 'user' && userSearch.length > 1
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['legal-holds'] })
  const place = useMutation({
    mutationFn: () =>
      api.post('/legal-holds', {
        reason,
        ...(kind === 'record' ? { collection: collection.trim(), item_id: itemId.trim() } : { user: userId })
      }),
    onSuccess: () => {
      toast.success('Hold placed')
      setCollection('')
      setItemId('')
      setUserId('')
      setReason('')
      invalidate()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Failed to place hold')
  })
  const release = useMutation({
    mutationFn: (id: number) => api.post(`/legal-holds/${id}/release`),
    onSuccess: () => {
      toast.success('Hold released')
      invalidate()
    }
  })

  const canPlace =
    reason.trim().length > 0 &&
    (kind === 'record' ? collection.trim().length > 0 && itemId.trim().length > 0 : userId.length > 0)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Scale className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>Legal Holds</h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              A held record survives trash purges; a held user is exempt from every retention
              policy. Holds are audited — reason, placer, release.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 space-y-4 overflow-y-auto p-6'>
        <div className='max-w-[720px] rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Place a hold</p>
          <div className='mt-2 flex flex-wrap items-center gap-2'>
            <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
              {(['record', 'user'] as const).map((k) => (
                <button
                  key={k}
                  type='button'
                  onClick={() => setKind(k)}
                  className={cn(
                    'rounded px-2.5 py-1 text-[12px] font-medium capitalize',
                    kind === k ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground' : 'text-slate-400'
                  )}
                >
                  {k}
                </button>
              ))}
            </span>
            {kind === 'record' ? (
              <>
                <input
                  value={collection}
                  onChange={(e) => setCollection(e.target.value)}
                  placeholder='collection (e.g. workflows)'
                  className='h-8 w-[200px] rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12px] dark:border-border'
                />
                <input
                  value={itemId}
                  onChange={(e) => setItemId(e.target.value)}
                  placeholder='record id'
                  className='h-8 w-[140px] rounded-md border border-slate-200 bg-background px-2.5 font-mono text-[12px] dark:border-border'
                />
              </>
            ) : (
              <div className='relative'>
                <input
                  value={userSearch}
                  onChange={(e) => {
                    setUserSearch(e.target.value)
                    setUserId('')
                  }}
                  placeholder='Search a user…'
                  className='h-8 w-[260px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
                />
                {userSearch.length > 1 && !userId && users.length > 0 && (
                  <div className='absolute z-10 mt-1 w-[260px] rounded-md border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'>
                    {users.map((u) => (
                      <button
                        key={u.id}
                        type='button'
                        onClick={() => {
                          setUserId(u.id)
                          setUserSearch(`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email)
                        }}
                        className='block w-full px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                      >
                        {`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email}
                        <span className='ml-1.5 text-[11px] text-slate-400'>{u.email}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder='Reason (required — audited)'
            className='mt-2 h-8 w-full rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
          />
          <button
            type='button'
            disabled={!canPlace || place.isPending}
            onClick={() => place.mutate()}
            className='mt-2.5 h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-medium text-white disabled:opacity-50'
          >
            {place.isPending ? 'Placing…' : 'Place hold'}
          </button>
        </div>

        <div className='max-w-[860px] space-y-2'>
          <div className='flex items-center justify-between'>
            <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-muted-foreground'>
              Holds
            </p>
            <label className='flex cursor-pointer items-center gap-1.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
              <input
                type='checkbox'
                checked={showReleased}
                onChange={(e) => setShowReleased(e.target.checked)}
                className='h-3.5 w-3.5'
              />
              Show released
            </label>
          </div>
          {holds.length === 0 && <p className='text-[12px] text-slate-400'>No holds.</p>}
          {holds.map((h) => (
            <div
              key={h.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border bg-white px-4 py-2.5 dark:bg-card',
                h.released_at ? 'border-slate-200 opacity-60 dark:border-border' : 'border-amber-200 dark:border-amber-500/30'
              )}
            >
              <div className='min-w-0 flex-1'>
                <p className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                  {h.collection ? (
                    <span className='font-mono'>{h.collection} / {h.item_id}</span>
                  ) : (
                    <>User: {h.user_name || h.user}</>
                  )}
                  {h.released_at && (
                    <span className='ml-2 rounded bg-slate-500/10 px-1.5 py-px text-[10.5px] uppercase text-slate-500'>
                      released
                    </span>
                  )}
                </p>
                <p className='mt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>{h.reason}</p>
                <p className='mt-0.5 text-[11px] text-slate-400'>
                  placed by {h.placed_by_name || 'unknown'} · {new Date(h.created_at).toLocaleString()}
                  {h.released_at && ` · released ${new Date(h.released_at).toLocaleString()}`}
                </p>
              </div>
              {!h.released_at && (
                <button
                  type='button'
                  onClick={() => {
                    if (window.confirm('Release this hold? The record/user re-enters normal retention.')) {
                      release.mutate(h.id)
                    }
                  }}
                  className='shrink-0 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:border-slate-300 dark:border-border dark:text-muted-foreground'
                >
                  Release
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
