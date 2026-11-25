import { ConfirmButton, QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronLeft,
  ClipboardCheck,
  Download,
  KeyRound,
  ShieldAlert,
  UserCheck,
  UserMinus
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag, ProductionGuard } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Checkbox } from '@/components/ui/checkbox'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import {
  dangerArmed,
  dangerGhost,
  Field,
  ghostButton,
  SectionCard,
  smallButton
} from '../hub-parts'
import {
  BG_STATUS_WORDS,
  type BreakGlass,
  type BreakGlassPage,
  blobError,
  decide,
  decideBreakGlass,
  download,
  fetchAppSecurity,
  fetchBreakGlass,
  fetchReview,
  fetchReviews,
  REMOVAL_WORDS,
  REVIEW_STATUS_WORDS,
  type Review,
  type ReviewDetail,
  type ReviewItem,
  requestBreakGlass,
  reviewAction,
  saveAppSecurity,
  securityKeys,
  securityToast,
  startReview
} from './security-api'
import { Chip, codeWords, type Tone, untilWords } from './security-parts'

/**
 * Access (Apps hub tab): who may administer the apps. Break-glass — temporary administrator
 * access to one environment for a few hours, approved by a Hub administrator, ended by the Hub and
 * by the app itself on time — and access reviews, where an app's owners keep or remove every
 * administrator and role holder and the Hub suspends the removed ones through the app.
 * `?request=<id>` highlights a request, `?review=<id>` opens a review.
 */
export default function HubAccess() {
  const [params, setParams] = useSearchParams()
  const reviewId = Number(params.get('review')) || null
  const open = (id: number | null) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      if (id) out.set('review', String(id))
      else out.delete('review')
      return out
    })
  return (
    <section aria-labelledby='hub-access-title' className='flex flex-1 min-h-0 flex-col'>
      <h2 id='hub-access-title' className='sr-only'>
        Access
      </h2>
      <HubToolbar description='Temporary admin access (break-glass) that ends by itself, and the access reviews every app is due for. Removed people are suspended in the app, never deleted.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {reviewId ? (
          <ReviewView id={reviewId} onBack={() => open(null)} />
        ) : (
          <div className='space-y-4'>
            <BreakGlassCard highlight={Number(params.get('request')) || null} />
            <ReviewsCard onOpen={open} />
            <ScheduleCard />
          </div>
        )}
      </div>
    </section>
  )
}

const primary = cn(smallButton, 'bg-nvr-cyan text-white hover:bg-nvr-cyan/90 disabled:opacity-50')

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className='m-0 px-4 py-4 text-[12px] text-slate-500 dark:text-muted-foreground'>{children}</p>
)

const BG_TONE: Record<BreakGlass['status'], Tone> = {
  pending: 'warn',
  granting: 'live',
  active: 'bad',
  revoking: 'live',
  revoked: 'neutral',
  expired: 'neutral',
  denied: 'neutral',
  cancelled: 'neutral',
  failed: 'bad',
  not_needed: 'neutral'
}

// ─── Break-glass ─────────────────────────────────────────────────────────────────────────

function BreakGlassCard({ highlight }: { highlight: number | null }) {
  const { user } = useAuth()
  const me = String((user as { id?: string } | null)?.id ?? '').toUpperCase()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: securityKeys.breakGlass(),
    queryFn: fetchBreakGlass,
    refetchInterval: (query) =>
      query.state.data?.requests.some((r) => r.status === 'granting' || r.status === 'revoking')
        ? 3000
        : 30_000
  })
  const [asking, setAsking] = useState(false)
  const act = useMutation({
    mutationFn: (v: { id: number; action: 'approve' | 'deny' | 'cancel' | 'revoke' }) =>
      decideBreakGlass(v.id, v.action),
    onSuccess: (_r, v) => {
      toast.success(
        v.action === 'approve'
          ? 'Approved — granting now'
          : v.action === 'deny'
            ? 'Request denied'
            : v.action === 'cancel'
              ? 'Request withdrawn'
              : 'Ending the access now'
      )
      void qc.invalidateQueries({ queryKey: securityKeys.breakGlass() })
    },
    onError: (err) => securityToast(err, 'The request could not be changed')
  })
  const active = q.data?.requests.filter((r) => r.status === 'active').length ?? 0
  return (
    <SectionCard
      title='Break-glass access'
      description={
        active
          ? `${active} temporary admin grant${active === 1 ? '' : 's'} holding now. Each ends by itself when its time runs out.`
          : 'Temporary administrator access to one environment, for a few hours, with a reason. A Hub administrator approves it.'
      }
      actions={
        q.data && q.data.requestable.length > 0 && !asking ? (
          <button type='button' className={ghostButton} onClick={() => setAsking(true)}>
            <KeyRound className='h-3.5 w-3.5' aria-hidden /> Ask for access
          </button>
        ) : null
      }
    >
      {asking && q.data && <AskForm page={q.data} onDone={() => setAsking(false)} />}
      {q.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-16 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the break-glass requests'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      ) : q.data.requests.length === 0 ? (
        <Empty>No break-glass request yet.</Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {q.data.requests.map((r) => (
            <BreakGlassRow
              key={r.id}
              row={r}
              page={q.data}
              mine={r.requester_id.toUpperCase() === me}
              isAdmin={isAdmin}
              highlight={r.id === highlight}
              busy={act.isPending}
              onAct={(action) => act.mutate({ id: r.id, action })}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  )
}

function BreakGlassRow({
  row,
  page,
  mine,
  isAdmin,
  highlight,
  busy,
  onAct
}: {
  row: BreakGlass
  page: BreakGlassPage
  mine: boolean
  isAdmin: boolean
  highlight: boolean
  busy: boolean
  onAct: (a: 'approve' | 'deny' | 'cancel' | 'revoke') => void
}) {
  const env = page.environments.find((e) => e.environment_id === row.environment_id)
  const who = page.people[row.requester_id.toUpperCase()] ?? 'Someone'
  const approver = row.decided_by ? page.people[row.decided_by.toUpperCase()] : null
  const when =
    row.status === 'active' && row.expires_at
      ? `ends ${untilWords(row.expires_at)}${row.approval_kind === 'incident' ? ' or when the incident resolves' : ''}`
      : row.created_at
        ? `asked ${formatRelative(row.created_at)}`
        : ''
  return (
    <li
      id={`bg-${row.id}`}
      className={cn(
        'flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3',
        highlight && 'bg-sky-50/70 dark:bg-sky-950/30'
      )}
    >
      <div className='min-w-0 flex-[1_1_320px]'>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {mine ? 'You' : who}
          </span>
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {env ? `${env.app_name} · ${env.env_key}` : `Environment ${row.environment_id}`}
          </span>
          <HubEnvTag envKey={env?.env_key} />
          <Chip tone={BG_TONE[row.status]}>{BG_STATUS_WORDS[row.status]}</Chip>
        </div>
        <p className='m-0 mt-1 text-[12px] text-slate-700 dark:text-slate-300'>{row.reason}</p>
        <p className='m-0 mt-1 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
          {row.hours} h{when ? ` · ${when}` : ''}
          {approver
            ? ` · ${row.status === 'denied' ? 'denied' : 'approved'} by ${approver}${row.approval_kind === 'incident' ? ' (on call, incident)' : ''}`
            : ''}
          {row.status === 'revoking' && row.last_error
            ? ' · the app did not answer yet; the Hub keeps trying, and the app ends it on time by itself'
            : ''}
          {row.status === 'failed' && row.last_error ? ` · ${row.last_error}` : ''}
        </p>
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        {row.status === 'pending' && isAdmin && !mine && (
          <>
            <button
              type='button'
              className={primary}
              disabled={busy}
              onClick={() => onAct('approve')}
            >
              <UserCheck className='h-3.5 w-3.5' aria-hidden /> Approve
            </button>
            <button
              type='button'
              className={ghostButton}
              disabled={busy}
              onClick={() => onAct('deny')}
            >
              Deny
            </button>
          </>
        )}
        {row.status === 'pending' && mine && (
          <button
            type='button'
            className={ghostButton}
            disabled={busy}
            onClick={() => onAct('cancel')}
          >
            Withdraw
          </button>
        )}
        {(row.status === 'active' || row.status === 'granting') && (isAdmin || mine) && (
          <ConfirmButton
            onConfirm={() => onAct('revoke')}
            className={dangerGhost}
            armedClassName={cn(smallButton, dangerArmed)}
            confirmLabel='End it now?'
            disabled={busy}
          >
            End now
          </ConfirmButton>
        )}
      </div>
    </li>
  )
}

function AskForm({ page, onDone }: { page: BreakGlassPage; onDone: () => void }) {
  const qc = useQueryClient()
  const envs = page.environments.filter((e) => page.requestable.includes(e.environment_id))
  const [envId, setEnvId] = useState(envs[0] ? String(envs[0].environment_id) : '')
  const [hours, setHours] = useState('2')
  const [reason, setReason] = useState('')
  const env = envs.find((e) => String(e.environment_id) === envId)
  const send = useMutation({
    mutationFn: () => requestBreakGlass(Number(envId), Number(hours), reason.trim()),
    onSuccess: () => {
      toast.success('Request sent', {
        description: 'Hub administrators were told. You get a notice once it is decided.'
      })
      void qc.invalidateQueries({ queryKey: securityKeys.breakGlass() })
      onDone()
    },
    onError: (err) => securityToast(err, 'The request could not be sent')
  })
  const short = reason.trim().length < 10
  return (
    <div className='border-b border-slate-200 bg-slate-50/60 px-4 py-4 dark:border-border dark:bg-muted/30'>
      <ProductionGuard envKey={env?.env_key} what='access'>
        <form
          className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]'
          onSubmit={(e) => {
            e.preventDefault()
            if (!short && envId) send.mutate()
          }}
        >
          <Field id='bg-env' label='Environment'>
            <SimpleSelect
              value={envId}
              onChange={setEnvId}
              ariaLabel='Environment'
              options={envs.map((e) => ({
                value: String(e.environment_id),
                label: `${e.app_name} · ${e.env_key}`
              }))}
              className='h-8 text-[13px]'
            />
          </Field>
          <Field id='bg-hours' label='For'>
            <SimpleSelect
              value={hours}
              onChange={setHours}
              ariaLabel='Hours'
              options={Array.from({ length: page.max_hours }, (_, i) => ({
                value: String(i + 1),
                label: `${i + 1} hour${i ? 's' : ''}`
              }))}
              className='h-8 text-[13px]'
            />
          </Field>
          <div className='sm:col-span-2'>
            <Field
              id='bg-reason'
              label='Why you need it'
              hint='The approver, the app’s owners and the audit trail see this.'
            >
              <Textarea
                id='bg-reason'
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className='text-[13px]'
                placeholder='The import job is stuck on production and needs an admin to release it.'
              />
            </Field>
          </div>
          <div className='flex flex-wrap items-center gap-2 sm:col-span-2'>
            <button type='submit' className={primary} disabled={short || !envId || send.isPending}>
              {send.isPending ? 'Sending…' : 'Send request'}
            </button>
            <button type='button' className={ghostButton} onClick={onDone}>
              Cancel
            </button>
            <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
              Your existing account there is raised to administrator; it is never created.
            </span>
          </div>
        </form>
      </ProductionGuard>
    </div>
  )
}

// ─── Access reviews ──────────────────────────────────────────────────────────────────────

const REVIEW_TONE: Record<Review['status'], Tone> = {
  reading: 'live',
  open: 'warn',
  completing: 'live',
  completed: 'good',
  cancelled: 'neutral',
  failed: 'bad'
}

function ReviewsCard({ onOpen }: { onOpen: (id: number) => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: securityKeys.reviews(),
    queryFn: fetchReviews,
    refetchInterval: (query) =>
      query.state.data?.data.some((r) => r.status === 'reading' || r.status === 'completing')
        ? 3000
        : 60_000
  })
  const [appId, setAppId] = useState('')
  useEffect(() => {
    if (!appId && q.data?.apps[0]) setAppId(String(q.data.apps[0].id))
  }, [appId, q.data])
  const start = useMutation({
    mutationFn: () => startReview(Number(appId)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: securityKeys.reviews() })
      onOpen(r.id)
    },
    onError: (err) => securityToast(err, 'The review could not be started')
  })
  const appName = (id: number) => q.data?.apps.find((a) => a.id === id)?.name ?? `App ${id}`
  return (
    <SectionCard
      title='Access reviews'
      description='The app’s owners confirm or remove every administrator and role holder. Removed people are suspended in the app, never deleted.'
      actions={
        q.data && q.data.apps.length > 0 ? (
          <div className='flex items-center gap-2'>
            <SimpleSelect
              value={appId}
              onChange={setAppId}
              ariaLabel='App to review'
              options={q.data.apps.map((a) => ({ value: String(a.id), label: a.name }))}
              className='h-8 w-[160px] text-[12px]'
            />
            <button
              type='button'
              className={primary}
              disabled={!appId || start.isPending}
              onClick={() => start.mutate()}
            >
              <ClipboardCheck className='h-3.5 w-3.5' aria-hidden />
              {start.isPending ? 'Starting…' : 'Start review'}
            </button>
          </div>
        ) : null
      }
    >
      {q.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-16 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the access reviews'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      ) : q.data.data.length === 0 ? (
        <Empty>No access review yet. Start one for an app, or set a schedule below.</Empty>
      ) : (
        <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
          {q.data.data.map((r) => {
            const overdue = r.status === 'open' && r.due_at && Date.parse(r.due_at) < Date.now()
            const c = r.counts
            return (
              <li key={r.id}>
                <button
                  type='button'
                  onClick={() => onOpen(r.id)}
                  className='flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan/50'
                >
                  <span className='min-w-0 flex-[1_1_220px]'>
                    <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                      {appName(r.app_id)}
                    </span>
                    <span className='block text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                      {r.started_at ? `Started ${formatDateTime(r.started_at)}` : ''}
                      {r.started_via === 'schedule' ? ' · on schedule' : ''}
                    </span>
                  </span>
                  {c && (
                    <span className='text-[12px] text-slate-600 tabular-nums dark:text-slate-300'>
                      {c.total} accounts · {c.admins} admins
                      {r.status === 'open' && c.pending ? ` · ${c.pending} undecided` : ''}
                      {c.removed ? ` · ${c.removed} removed` : ''}
                    </span>
                  )}
                  {overdue ? (
                    <Chip tone='bad'>Overdue</Chip>
                  ) : (
                    <Chip tone={REVIEW_TONE[r.status]}>{REVIEW_STATUS_WORDS[r.status]}</Chip>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </SectionCard>
  )
}

function ScheduleCard() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const list = useQuery({ queryKey: securityKeys.reviews(), queryFn: fetchReviews })
  const [appId, setAppId] = useState('')
  useEffect(() => {
    if (!appId && list.data?.apps[0]) setAppId(String(list.data.apps[0].id))
  }, [appId, list.data])
  const id = Number(appId)
  const q = useQuery({
    queryKey: securityKeys.appSecurity(id),
    queryFn: () => fetchAppSecurity(id),
    enabled: id > 0
  })
  const [every, setEvery] = useState<string | null>(null)
  const [due, setDue] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      saveAppSecurity(
        id,
        Number(every ?? q.data?.review_every_months ?? 0),
        Number(due ?? q.data?.review_due_days ?? 14)
      ),
    onSuccess: () => {
      toast.success('Schedule saved')
      setEvery(null)
      setDue(null)
      void qc.invalidateQueries({ queryKey: securityKeys.appSecurity(id) })
    },
    onError: (err) => securityToast(err, 'The schedule could not be saved')
  })
  if (!list.data?.apps.length) return null
  const months = every ?? String(q.data?.review_every_months ?? 0)
  const days = due ?? String(q.data?.review_due_days ?? 14)
  const dirty = every !== null || due !== null
  return (
    <SectionCard
      title='Review schedule'
      description={
        isAdmin
          ? 'Reviews start by themselves on the first of the month, and the owners are told.'
          : 'Set by Hub administrators.'
      }
    >
      <div className='flex flex-wrap items-end gap-3 px-4 py-4'>
        <Field id='rs-app' label='App'>
          <SimpleSelect
            value={appId}
            onChange={(v) => {
              setAppId(v)
              setEvery(null)
              setDue(null)
            }}
            ariaLabel='App'
            options={list.data.apps.map((a) => ({ value: String(a.id), label: a.name }))}
            className='h-8 w-[180px] text-[13px]'
          />
        </Field>
        <Field id='rs-every' label='Every'>
          <SimpleSelect
            value={months}
            onChange={setEvery}
            ariaLabel='How often'
            disabled={!isAdmin}
            options={[
              { value: '0', label: 'Never (start by hand)' },
              { value: '1', label: 'Month' },
              { value: '3', label: '3 months (quarterly)' },
              { value: '6', label: '6 months' },
              { value: '12', label: 'Year' }
            ]}
            className='h-8 w-[200px] text-[13px]'
          />
        </Field>
        <Field id='rs-due' label='Owners have'>
          <SimpleSelect
            value={days}
            onChange={setDue}
            ariaLabel='Days to finish'
            disabled={!isAdmin}
            options={['7', '14', '30', '60'].map((d) => ({ value: d, label: `${d} days` }))}
            className='h-8 w-[120px] text-[13px]'
          />
        </Field>
        {isAdmin && (
          <button
            type='button'
            className={primary}
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </button>
        )}
        {q.data?.next_review_at && (
          <span className='pb-2 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
            Next: {formatDateTime(q.data.next_review_at)}
          </span>
        )}
      </div>
    </SectionCard>
  )
}

// ─── One review ──────────────────────────────────────────────────────────────────────────

function ReviewView({ id, onBack }: { id: number; onBack: () => void }) {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: securityKeys.review(id),
    queryFn: () => fetchReview(id),
    refetchInterval: (query) =>
      query.state.data?.status === 'reading' || query.state.data?.status === 'completing'
        ? 2000
        : false
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: securityKeys.review(id) })
    void qc.invalidateQueries({ queryKey: securityKeys.reviews() })
  }
  const set = useMutation({
    mutationFn: (items: Array<{ id: number; decision: 'keep' | 'remove' | 'pending' }>) =>
      decide(id, items),
    onSuccess: refresh,
    onError: (err) => securityToast(err, 'The decision could not be saved')
  })
  const act = useMutation({
    mutationFn: (a: 'complete' | 'retry' | 'cancel') => reviewAction(id, a),
    onSuccess: (_r, a) => {
      toast.success(
        a === 'complete'
          ? 'Review completed — removing access now'
          : a === 'retry'
            ? 'Trying the removals again'
            : 'Review cancelled'
      )
      refresh()
    },
    onError: (err) => securityToast(err, 'The review could not be changed')
  })
  const [onlyOpen, setOnlyOpen] = useState(false)
  const grouped = useMemo(() => {
    const out = new Map<number, ReviewItem[]>()
    for (const i of q.data?.items ?? []) {
      if (onlyOpen && i.decision !== 'pending') continue
      out.set(i.environment_id, [...(out.get(i.environment_id) ?? []), i])
    }
    return out
  }, [q.data, onlyOpen])

  const back = (
    <button type='button' className={cn(ghostButton, '-ml-2 mb-2')} onClick={onBack}>
      <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All reviews
    </button>
  )
  if (q.isPending)
    return (
      <div>
        {back}
        <Skeleton className='h-48 w-full' />
      </div>
    )
  if (q.isError)
    return (
      <div>
        {back}
        <QueryErrorState error={q.error} what='the review' onRetry={() => void q.refetch()} />
      </div>
    )
  const r: ReviewDetail = q.data
  const envs = r.environments
  const c = r.counts
  const isOpen = r.status === 'open'
  const failedRemovals = r.items.some(
    (i) => i.decision === 'remove' && i.removal_state === 'failed'
  )
  const people = r.people
  const evidence = async (kind: 'csv' | 'pdf') => {
    try {
      await download(`/hub/access-reviews/${id}/evidence.${kind}`, `access-review-${id}.${kind}`)
    } catch (err) {
      securityToast(await blobError(err), 'The evidence could not be downloaded')
    }
  }
  const pendingIds = r.items.filter((i) => i.decision === 'pending').map((i) => i.id)
  return (
    <div className='space-y-4'>
      <div>
        {back}
        <div className='flex flex-wrap items-center gap-2'>
          <h3 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {r.app_name ? `${r.app_name} — access review ${r.id}` : `Access review ${r.id}`}
          </h3>
          <Chip tone={REVIEW_TONE[r.status]}>{REVIEW_STATUS_WORDS[r.status]}</Chip>
        </div>
        <p className='m-0 mt-1 text-[12px] text-slate-500 tabular-nums dark:text-muted-foreground'>
          {r.started_at ? `Started ${formatDateTime(r.started_at)}` : ''}
          {r.started_by
            ? ` by ${people[r.started_by.toUpperCase()] ?? 'an owner'}`
            : ' on schedule'}
          {r.due_at && isOpen ? ` · due ${formatDateTime(r.due_at)}` : ''}
          {r.completed_at
            ? ` · completed ${formatDateTime(r.completed_at)}${r.completed_by ? ` by ${people[r.completed_by.toUpperCase()] ?? 'an owner'}` : ''}`
            : ''}
        </p>
      </div>

      <dl className='m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-5 dark:border-border dark:bg-border'>
        {[
          ['Accounts', c.total],
          ['Administrators', c.admins],
          ['Undecided', c.pending],
          ['To remove', c.remove],
          ['Removed', c.removed]
        ].map(([k, v]) => (
          <div
            key={k}
            className='bg-white px-3 py-2 last:col-span-2 sm:last:col-span-1 dark:bg-card'
          >
            <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{k}</dt>
            <dd className='m-0 text-[15px] font-semibold text-slate-900 tabular-nums dark:text-foreground'>
              {v}
            </dd>
          </div>
        ))}
      </dl>

      {r.status === 'reading' && (
        <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
          Reading who holds a role in each environment…
        </p>
      )}

      {envs
        .filter((e) => e.state !== 'read')
        .map((e) => (
          <p
            key={e.environment_id}
            className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
          >
            <ShieldAlert className='mr-1.5 inline h-3.5 w-3.5 align-[-2px]' aria-hidden />
            {e.environment_key}:{' '}
            {e.state === 'no_link'
              ? 'the Hub has no link to it — review its people in the app itself.'
              : `${codeWords(e.code, 'it did not answer')}. Its accounts are not in this review.`}
          </p>
        ))}

      <div className='sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2 sm:-mx-6 sm:px-6 dark:border-border dark:bg-background'>
        {isOpen && pendingIds.length > 0 && (
          <button
            type='button'
            className={ghostButton}
            disabled={set.isPending}
            onClick={() => set.mutate(pendingIds.map((i) => ({ id: i, decision: 'keep' })))}
          >
            <UserCheck className='h-3.5 w-3.5' aria-hidden /> Keep all undecided
          </button>
        )}
        {isOpen && (
          <span className='inline-flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            <Checkbox
              id='ar-only-open'
              checked={onlyOpen}
              onCheckedChange={(v) => setOnlyOpen(v === true)}
            />
            <label htmlFor='ar-only-open'>Only undecided</label>
          </span>
        )}
        <span className='flex-1' />
        <button type='button' className={ghostButton} onClick={() => void evidence('csv')}>
          <Download className='h-3.5 w-3.5' aria-hidden /> Evidence CSV
        </button>
        <button type='button' className={ghostButton} onClick={() => void evidence('pdf')}>
          <Download className='h-3.5 w-3.5' aria-hidden /> PDF
        </button>
        {isOpen && (
          <ConfirmButton
            onConfirm={() => act.mutate('cancel')}
            className={ghostButton}
            armedClassName={cn(smallButton, dangerArmed)}
            confirmLabel='Cancel review?'
            disabled={act.isPending}
          >
            Cancel review
          </ConfirmButton>
        )}
        {r.status === 'completed' && failedRemovals && (
          <button
            type='button'
            className={ghostButton}
            disabled={act.isPending}
            onClick={() => act.mutate('retry')}
          >
            Retry removals
          </button>
        )}
        {isOpen && (
          <ConfirmButton
            onConfirm={() => act.mutate('complete')}
            className={primary}
            armedClassName={cn(smallButton, dangerArmed)}
            confirmLabel={c.remove ? `Suspend ${c.remove}?` : 'Complete?'}
            disabled={act.isPending || c.pending > 0}
            title={c.pending ? 'Decide every account first' : undefined}
          >
            Complete review
          </ConfirmButton>
        )}
      </div>

      {[...grouped.entries()].map(([envId, items]) => {
        const env = envs.find((e) => e.environment_id === envId)
        return (
          <SectionCard
            key={envId}
            title={env?.environment_key ?? `Environment ${envId}`}
            description={`${items.length} account${items.length === 1 ? '' : 's'}${env?.production ? ' · production' : ''}${env?.truncated ? ' · only the first 5 000 are listed' : ''}`}
            actions={<HubEnvTag envKey={env?.environment_key} />}
          >
            <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
              {items.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  open={isOpen}
                  busy={set.isPending}
                  people={people}
                  onDecide={(d) => set.mutate([{ id: i.id, decision: d }])}
                />
              ))}
            </ul>
          </SectionCard>
        )
      })}
      {r.items.length > 0 && grouped.size === 0 && (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Every account has a decision.
        </p>
      )}
    </div>
  )
}

function ItemRow({
  item,
  open,
  busy,
  people,
  onDecide
}: {
  item: ReviewItem
  open: boolean
  busy: boolean
  people: Record<string, string>
  onDecide: (d: 'keep' | 'remove' | 'pending') => void
}) {
  const segment = (d: 'keep' | 'remove', label: string, Icon: typeof UserCheck) => {
    const on = item.decision === d
    return (
      <button
        type='button'
        aria-pressed={on}
        disabled={!open || busy}
        onClick={() => onDecide(on ? 'pending' : d)}
        className={cn(
          'inline-flex h-7 items-center gap-1 px-2.5 text-[12px] font-medium focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-default',
          on
            ? d === 'keep'
              ? 'bg-emerald-600 text-white dark:bg-emerald-600'
              : 'bg-red-600 text-white dark:bg-red-600'
            : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-card dark:text-slate-300 dark:hover:bg-muted',
          !open && !on && 'opacity-50'
        )}
      >
        <Icon className='h-3.5 w-3.5' aria-hidden />
        {label}
      </button>
    )
  }
  const removal = item.removal_state ? REMOVAL_WORDS[item.removal_state] : null
  return (
    <li className='flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5'>
      <div className='min-w-0 flex-[1_1_260px]'>
        <div className='flex flex-wrap items-center gap-1.5'>
          <span className='truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {item.name ?? item.email ?? item.app_user_id}
          </span>
          {item.admin && <Chip tone='neutral'>Admin</Chip>}
          {item.account_kind && <Chip tone='neutral'>{item.account_kind}</Chip>}
          {item.break_glass && <Chip tone='bad'>Break-glass</Chip>}
          {item.account_status && item.account_status !== 'active' && (
            <Chip tone='neutral'>{item.account_status}</Chip>
          )}
        </div>
        <p className='m-0 mt-0.5 truncate text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
          {[
            item.name ? item.email : null,
            item.role,
            item.last_access ? `signed in ${formatRelative(item.last_access)}` : 'never signed in'
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>
      <div className='flex items-center gap-3'>
        {removal && (
          <span
            className={cn(
              'text-[11px] font-medium',
              item.removal_state === 'done' || item.removal_state === 'already'
                ? 'text-emerald-700 dark:text-emerald-400'
                : item.removal_state === 'failed'
                  ? 'text-red-600 dark:text-red-400'
                  : 'text-amber-700 dark:text-amber-400'
            )}
          >
            {removal}
          </span>
        )}
        {!open && item.decided_by && (
          <span className='hidden text-[11px] text-slate-500 sm:inline dark:text-muted-foreground'>
            {people[item.decided_by.toUpperCase()] ?? ''}
          </span>
        )}
        <fieldset
          aria-label={`Decision for ${item.name ?? item.email ?? item.app_user_id}`}
          className='m-0 inline-flex min-w-0 divide-x divide-slate-200 overflow-hidden rounded-md border border-slate-200 p-0 dark:divide-border dark:border-border'
        >
          {segment('keep', 'Keep', UserCheck)}
          {segment('remove', 'Remove', UserMinus)}
        </fieldset>
      </div>
    </li>
  )
}
