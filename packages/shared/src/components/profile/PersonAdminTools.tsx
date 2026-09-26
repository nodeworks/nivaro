import { useMutation, useQuery } from '@tanstack/react-query'
import { GitMerge, RefreshCw, UserMinus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { EmptyLine, SectionCard } from './primitives'
import { errorText, type PersonProfile, useInvalidatePerson } from './types'

/**
 * The tools that change someone's standing rather than describe it — pushing
 * a reload to their tabs, handing their work to a successor, folding a
 * duplicate account into a survivor. Each one is its own card, each one
 * framed amber, each destructive step behind a second confirmation.
 */

// ─── Force a reload ──────────────────────────────────────────────────────────

export function ForceReloadCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const [seconds, setSeconds] = useState('15')
  const [message, setMessage] = useState('')
  const push = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { sockets: number; users: number } }>(
          post('/realtime/force-refresh', {
            user_ids: [p.id],
            seconds: Number(seconds) || 15,
            message
          })
        )
        .then((r) => r.data),
    onSuccess: ({ sockets }) =>
      toast.success(
        sockets > 0
          ? `Reload pushed to ${sockets} open tab${sockets === 1 ? '' : 's'}`
          : 'Reload sent — they have no tab connected to this node right now'
      ),
    onError: (e) => toast.error(errorText(e, 'Failed to push the reload'))
  })
  return (
    <SectionCard
      icon={<RefreshCw className='h-4 w-4' />}
      title='Force a reload'
      hint='Every tab they have open shows a countdown, then reloads onto the current build'
      tone='danger'
      testId='force-reload'
    >
      <div className='flex flex-wrap items-center gap-2' data-user-force-reload>
        <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
          Countdown
          <input
            value={seconds}
            onChange={(e) => setSeconds(e.target.value)}
            inputMode='numeric'
            className='h-7 w-14 rounded-md border border-slate-200 bg-white px-2 text-right text-[12px] dark:border-border dark:bg-background'
          />
          s
        </label>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder='Optional message in their banner'
          className='h-7 min-w-[200px] flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] dark:border-border dark:bg-background'
        />
        <button
          type='button'
          disabled={push.isPending}
          onClick={() => push.mutate()}
          className='inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 px-2.5 text-[11.5px] font-medium text-amber-800 transition-colors hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10'
        >
          <RefreshCw className={cn('h-3 w-3', push.isPending && 'animate-spin')} />
          {push.isPending ? 'Sending…' : 'Reload their tabs'}
        </button>
      </div>
      <p className='mt-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
        Unsaved form drafts survive — the record form mirrors them within seconds of typing and
        offers a restore on the next open.
      </p>
    </SectionCard>
  )
}

// ─── Successor / survivor picker ─────────────────────────────────────────────

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
  const client = useNivaroClient()
  const [search, setSearch] = useState('')
  const { data: users = [] } = useQuery<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>
  >({
    queryKey: ['nvr-offboard-user-search', search],
    queryFn: () =>
      client
        .request<{ data: never }>(get('/users', { search, limit: 8 }))
        .then((r) => r.data as never),
    enabled: search.length > 1
  })
  if (value) {
    return (
      <span className='inline-flex items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'>
        {value.name}
        <button
          type='button'
          onClick={() => onPick(null)}
          aria-label='Clear'
          className='text-[11px]'
        >
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
        className='h-8 w-[260px] rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] dark:border-border dark:bg-background'
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

// ─── Offboarding ─────────────────────────────────────────────────────────────

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

export function OffboardingCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const invalidate = useInvalidatePerson(p.id)
  const [successor, setSuccessor] = useState<{ id: string; name: string } | null>(null)
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [suspend, setSuspend] = useState(true)
  const [result, setResult] = useState<Record<string, number> | null>(null)
  const { data: summary, refetch } = useQuery<{
    user: { name: string; status: string }
    holdings: Record<string, number>
  }>({
    queryKey: ['nvr-offboarding', p.id],
    queryFn: () =>
      client.request<{ data: never }>(get(`/offboarding/${p.id}`)).then((r) => r.data as never)
  })
  const run = useMutation({
    mutationFn: () =>
      client
        .request<{ data: Record<string, number> }>(
          post(`/offboarding/${p.id}/run`, { successor: successor?.id, include, suspend })
        )
        .then((r) => r.data),
    onSuccess: (d) => {
      setResult(d)
      toast.success('Offboarding complete')
      void refetch()
      invalidate()
    },
    onError: (e) => toast.error(errorText(e, 'Offboarding failed'))
  })
  const total = Object.values(summary?.holdings ?? {}).reduce((a, b) => a + b, 0)
  const [confirm, setConfirm] = useState('')

  return (
    <SectionCard
      icon={<UserMinus className='h-4 w-4' />}
      title='Offboarding'
      hint='Hand everything they hold to a successor in one pass'
      tone='danger'
      testId='offboarding'
    >
      {!summary ? (
        <EmptyLine>Loading what they hold…</EmptyLine>
      ) : (
        <div className='space-y-3'>
          <div className='grid gap-x-6 gap-y-1 sm:grid-cols-2'>
            {Object.entries(summary.holdings).map(([k, v]) => {
              const action = HOLDING_ACTION[k]
              const cls = cn(
                'flex items-center gap-2 text-[12.5px]',
                v === 0
                  ? 'text-slate-300 dark:text-slate-600'
                  : 'text-slate-700 dark:text-slate-200'
              )
              const body = (
                <>
                  <span className='flex-1'>{HOLDING_LABELS[k] ?? k}</span>
                  <span className='font-semibold tabular-nums'>{v}</span>
                </>
              )
              return action ? (
                <label key={k} className={cls}>
                  <input
                    type='checkbox'
                    checked={include[action] !== false}
                    disabled={v === 0}
                    onChange={(e) =>
                      setInclude((prev) => ({ ...prev, [action]: e.target.checked }))
                    }
                    className='h-3.5 w-3.5'
                  />
                  {body}
                </label>
              ) : (
                <div key={k} className={cls}>
                  <span className='w-3.5' />
                  {body}
                </div>
              )
            })}
          </div>
          {total === 0 ? (
            <EmptyLine>Nothing to hand over — this account holds no work.</EmptyLine>
          ) : (
            <div className='flex flex-wrap items-center gap-2.5'>
              <UserPicker
                excludeId={p.id}
                value={successor}
                label='Successor (who takes it over)…'
                onPick={setSuccessor}
              />
              <label className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
                <input
                  type='checkbox'
                  checked={suspend}
                  onChange={(e) => setSuspend(e.target.checked)}
                  className='h-3.5 w-3.5'
                />
                Suspend the account after
              </label>
              <span className='flex-1' />
              {successor && (
                <input
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder='Type OFFBOARD'
                  aria-label='Type OFFBOARD to confirm'
                  className='h-8 w-[150px] rounded-md border border-amber-300 bg-white px-2.5 text-[12.5px] dark:border-amber-500/40 dark:bg-background'
                />
              )}
              <button
                type='button'
                disabled={!successor || confirm !== 'OFFBOARD' || run.isPending}
                onClick={() => run.mutate()}
                className='h-8 rounded-md bg-amber-500 px-4 text-[12.5px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
              >
                {run.isPending ? 'Reassigning…' : 'Run offboarding'}
              </button>
            </div>
          )}
          {result && (
            <p className='rounded-md bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400'>
              Done:{' '}
              {Object.entries(result)
                .map(([k, v]) => `${(HOLDING_LABELS[k] ?? k).toLowerCase()} ${v}`)
                .join(' · ')}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// ─── Merge into another account ──────────────────────────────────────────────

export function MergeCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const invalidate = useInvalidatePerson(p.id)
  const [survivor, setSurvivor] = useState<{ id: string; name: string } | null>(null)
  const [preview, setPreview] = useState<Record<string, number> | null>(null)
  const [phrase, setPhrase] = useState('')
  const dryRun = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { references: Record<string, number> } }>(
          post(`/offboarding/${p.id}/merge`, { into: survivor?.id, dry_run: true })
        )
        .then((r) => r.data),
    onSuccess: (d) => setPreview(d.references),
    onError: (e) => toast.error(errorText(e, 'Preview failed'))
  })
  const merge = useMutation({
    mutationFn: () => client.request(post(`/offboarding/${p.id}/merge`, { into: survivor?.id })),
    onSuccess: () => {
      toast.success('Accounts merged — the duplicate is suspended')
      setPreview(null)
      setPhrase('')
      invalidate()
    },
    onError: (e) => toast.error(errorText(e, 'Merge failed'))
  })
  return (
    <SectionCard
      icon={<GitMerge className='h-4 w-4' />}
      title='Merge into another account'
      hint='For duplicate or legacy twins: every reference moves to the survivor, then this account is suspended'
      tone='danger'
      testId='merge'
    >
      <div className='space-y-3'>
        <div className='flex flex-wrap items-center gap-2.5'>
          <UserPicker
            excludeId={p.id}
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
            className='h-8 rounded-md border border-slate-200 px-3 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
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
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                placeholder='Type MERGE to confirm'
                aria-label='Type MERGE to confirm'
                className='h-8 w-[180px] rounded-md border border-amber-300 bg-white px-2.5 text-[12.5px] dark:border-amber-500/40 dark:bg-background'
              />
              <button
                type='button'
                disabled={phrase !== 'MERGE' || merge.isPending}
                onClick={() => merge.mutate()}
                className='h-8 rounded-md bg-amber-500 px-4 text-[12.5px] font-semibold text-white hover:bg-amber-600 disabled:opacity-50'
              >
                {merge.isPending ? 'Merging…' : `Merge into ${survivor?.name ?? ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </SectionCard>
  )
}
