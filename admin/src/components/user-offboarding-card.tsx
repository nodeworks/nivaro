import { useMutation, useQuery } from '@tanstack/react-query'
import { GitMerge, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Offboarding wizard (#1) + account merge (#38) — everything a departing or
 * duplicate account holds, handed to a successor / survivor in one pass.
 */

const HOLDING_LABELS: Record<string, string> = {
  queue_claims: 'Queue claims',
  instance_ownerships: 'Record ownerships (open pipelines)',
  open_tasks: 'Open tasks',
  owner_group_memberships: 'Owner-group memberships',
  delegates_pointing_here: 'People delegating to them',
  direct_reports: 'Direct reports',
  notification_subscriptions: 'Notification subscriptions',
  field_watches: 'Field watches'
}

/** Which offboard action each summary line maps to. Informational rows
 *  (nothing to transfer) carry null. */
const HOLDING_ACTION: Record<string, string | null> = {
  queue_claims: 'queue_claims',
  instance_ownerships: 'instance_ownerships',
  open_tasks: 'open_tasks',
  owner_group_memberships: 'owner_group_memberships',
  delegates_pointing_here: 'delegates',
  direct_reports: 'delegates',
  notification_subscriptions: 'notification_subscriptions',
  field_watches: 'notification_subscriptions'
}

function UserPicker({
  excludeId,
  value,
  label,
  onPick
}: {
  excludeId: string
  value: { id: string; name: string } | null
  label: string
  onPick: (u: { id: string; name: string } | null) => void
}) {
  const [search, setSearch] = useState('')
  const { data: users = [] } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['offboard-user-search', search],
    queryFn: () => api.get('/users', { params: { search, limit: 8 } }).then((r) => r.data.data),
    enabled: search.length > 1
  })
  if (value) {
    return (
      <span className='inline-flex items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'>
        {value.name}
        <button type='button' onClick={() => onPick(null)} aria-label='Clear' className='text-[11px]'>
          ✕
        </button>
      </span>
    )
  }
  return (
    <div className='relative'>
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={label}
        className='h-8 w-[260px] rounded-md border border-slate-200 bg-background px-2.5 text-[12.5px] dark:border-border'
      />
      {search.length > 1 && users.length > 0 && (
        <div className='absolute z-10 mt-1 w-[260px] rounded-md border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-card'>
          {users
            .filter((u) => u.id.toUpperCase() !== excludeId.toUpperCase())
            .map((u) => {
              const name = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => {
                    onPick({ id: u.id, name })
                    setSearch('')
                  }}
                  className='block w-full px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-foreground'
                >
                  {name}
                  <span className='ml-1.5 text-[11px] text-slate-400'>{u.email}</span>
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}

export function UserOffboardingCard({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)
  const [successor, setSuccessor] = useState<{ id: string; name: string } | null>(null)
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [suspend, setSuspend] = useState(true)
  const [result, setResult] = useState<Record<string, number> | null>(null)

  const { data: summary, refetch } = useQuery<{
    user: { name: string; status: string }
    holdings: Record<string, number>
  }>({
    queryKey: ['offboarding', userId],
    queryFn: () => api.get(`/offboarding/${userId}`).then((r) => r.data.data),
    enabled: open
  })

  const run = useMutation({
    mutationFn: () =>
      api
        .post(`/offboarding/${userId}/run`, { successor: successor?.id, include, suspend })
        .then((r) => r.data.data as Record<string, number>),
    onSuccess: (d) => {
      setResult(d)
      toast.success('Offboarding complete')
      void refetch()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Offboarding failed')
  })

  const totalHoldings = Object.values(summary?.holdings ?? {}).reduce((a, b) => a + b, 0)

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2.5 px-4 py-3 text-left'
      >
        <UserMinus className='h-4 w-4 text-slate-400' />
        <div className='flex-1'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Offboarding</p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Hand everything this user holds to a successor in one pass.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Close' : 'Open'}</span>
      </button>
      {open && (
        <div className='space-y-3 border-t border-slate-100 px-4 py-3 dark:border-border/60'>
          {!summary ? (
            <p className='text-[12px] text-slate-400'>Loading holdings…</p>
          ) : (
            <>
              <div className='grid grid-cols-2 gap-x-6 gap-y-1'>
                {Object.entries(summary.holdings).map(([k, v]) => {
                  const action = HOLDING_ACTION[k]
                  return (
                    <label
                      key={k}
                      className={cn(
                        'flex items-center gap-2 text-[12.5px]',
                        v === 0 ? 'text-slate-300 dark:text-slate-600' : 'text-slate-700 dark:text-slate-200'
                      )}
                    >
                      {action ? (
                        <input
                          type='checkbox'
                          checked={include[action] !== false}
                          disabled={v === 0}
                          onChange={(e) =>
                            setInclude((prev) => ({ ...prev, [action]: e.target.checked }))
                          }
                          className='h-3.5 w-3.5'
                        />
                      ) : (
                        <span className='w-3.5' />
                      )}
                      <span className='flex-1'>{HOLDING_LABELS[k] ?? k}</span>
                      <span className='font-semibold tabular-nums'>{v}</span>
                    </label>
                  )
                })}
              </div>
              <div className='flex flex-wrap items-center gap-2.5'>
                <UserPicker
                  excludeId={userId}
                  value={successor}
                  label='Successor (who takes it over)…'
                  onPick={setSuccessor}
                />
                <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                  <input
                    type='checkbox'
                    checked={suspend}
                    onChange={(e) => setSuspend(e.target.checked)}
                    className='h-3.5 w-3.5'
                  />
                  Suspend the account after
                </label>
                <span className='flex-1' />
                <button
                  type='button'
                  disabled={!successor || run.isPending || totalHoldings === 0}
                  onClick={() => run.mutate()}
                  className='h-8 rounded-md bg-nvr-cyan px-4 text-[12.5px] font-semibold text-white disabled:opacity-50'
                >
                  {run.isPending ? 'Reassigning…' : 'Run offboarding'}
                </button>
              </div>
              {result && (
                <p className='rounded-md bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'>
                  Done:{' '}
                  {Object.entries(result)
                    .map(([k, v]) => `${(HOLDING_LABELS[k] ?? k).toLowerCase()} ${v}`)
                    .join(' · ')}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function UserMergeCard({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false)
  const [survivor, setSurvivor] = useState<{ id: string; name: string } | null>(null)
  const [preview, setPreview] = useState<Record<string, number> | null>(null)
  const [confirmPhrase, setConfirmPhrase] = useState('')

  const dryRun = useMutation({
    mutationFn: () =>
      api
        .post(`/offboarding/${userId}/merge`, { into: survivor?.id, dry_run: true })
        .then((r) => r.data.data as { references: Record<string, number> }),
    onSuccess: (d) => setPreview(d.references),
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Preview failed')
  })
  const merge = useMutation({
    mutationFn: () =>
      api.post(`/offboarding/${userId}/merge`, { into: survivor?.id }).then((r) => r.data.data),
    onSuccess: () => {
      toast.success('Accounts merged — the duplicate is suspended')
      setPreview(null)
      setConfirmPhrase('')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Merge failed')
  })

  return (
    <div className='rounded-lg border border-amber-200 bg-white dark:border-amber-500/30 dark:bg-card'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2.5 px-4 py-3 text-left'
      >
        <GitMerge className='h-4 w-4 text-amber-500' />
        <div className='flex-1'>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Merge into another account
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            For duplicate/legacy twins: repoint every reference to the survivor, then suspend
            this account. Audited; membership duplicates are dropped.
          </p>
        </div>
        <span className='text-[11px] text-slate-400'>{open ? 'Close' : 'Open'}</span>
      </button>
      {open && (
        <div className='space-y-3 border-t border-slate-100 px-4 py-3 dark:border-border/60'>
          <div className='flex flex-wrap items-center gap-2.5'>
            <UserPicker
              excludeId={userId}
              value={survivor}
              label='Survivor account (keeps everything)…'
              onPick={(u) => {
                setSurvivor(u)
                setPreview(null)
              }}
            />
            <button
              type='button'
              disabled={!survivor || dryRun.isPending}
              onClick={() => dryRun.mutate()}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
            >
              {dryRun.isPending ? 'Scanning…' : 'Preview references'}
            </button>
          </div>
          {preview && (
            <>
              <div className='max-h-[220px] overflow-y-auto rounded-md border border-slate-100 dark:border-border/60'>
                {Object.keys(preview).length === 0 ? (
                  <p className='px-3 py-2 text-[12px] text-slate-400'>
                    Nothing references this account.
                  </p>
                ) : (
                  Object.entries(preview).map(([k, v]) => (
                    <div
                      key={k}
                      className='flex items-center justify-between border-b border-slate-50 px-3 py-1 text-[12px] last:border-0 dark:border-border/40'
                    >
                      <span className='font-mono text-slate-600 dark:text-slate-300'>{k}</span>
                      <span className='font-semibold tabular-nums text-slate-700 dark:text-slate-200'>
                        {v}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <input
                  value={confirmPhrase}
                  onChange={(e) => setConfirmPhrase(e.target.value)}
                  placeholder='Type MERGE to confirm'
                  className='h-8 w-[180px] rounded-md border border-amber-300 bg-background px-2.5 text-[12.5px] dark:border-amber-500/40'
                />
                <button
                  type='button'
                  disabled={confirmPhrase !== 'MERGE' || merge.isPending}
                  onClick={() => merge.mutate()}
                  className='h-8 rounded-md bg-amber-500 px-4 text-[12.5px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
                >
                  {merge.isPending ? 'Merging…' : `Merge into ${survivor?.name ?? ''}`}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
