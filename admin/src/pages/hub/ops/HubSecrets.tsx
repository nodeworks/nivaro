import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { KeyRound, RotateCw, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatDateTime } from '@/lib/utils'
import { hubToast } from '../hub-api'
import { CopyButton, NO_RECORD_ATTRS, NO_RECORD_CLASS, SectionCard } from '../hub-parts'
import {
  checkSecretNow,
  type DueState,
  type KindInfo,
  markRotated,
  opsKeys,
  rotateHere,
  rotateThroughRoute,
  type SecretItem,
  type SecretPolicy,
  savePolicy,
  useSecrets
} from './ops-api'

const DUE_COPY: Record<DueState, { label: string; tone: string }> = {
  overdue: {
    label: 'Overdue',
    tone: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300'
  },
  due_soon: {
    label: 'Due soon',
    tone: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300'
  },
  ok: {
    label: 'On schedule',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300'
  },
  no_schedule: {
    label: 'No schedule',
    tone: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
  },
  never: {
    label: 'Never rotated',
    tone: 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'
  }
}

const CHECK_COPY: Record<string, string> = {
  pending: 'Check waiting',
  ok: 'Check passed',
  failed: 'Check failed',
  skipped: 'No automatic check'
}

/**
 * Secrets (Apps hub tab, administrators): every secret the Hub holds or delivers, by fingerprint
 * and age — never a value. Schedules per kind, reminders before the due date, rotation through
 * the Hub's own paths and a readiness check after each one.
 */
export default function HubSecrets() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center bg-slate-50 p-8 text-center dark:bg-background'>
        <p className='m-0 max-w-[48ch] text-[13px] text-slate-600 dark:text-muted-foreground'>
          Only administrators see the Hub’s secrets.
        </p>
      </div>
    )
  return <SecretsAdmin />
}

function SecretsAdmin() {
  const q = useSecrets()
  const [kind, setKind] = useState('')
  const [shown, setShown] = useState<{ label: string; value: string } | null>(null)
  if (q.isPending)
    return (
      <div className='flex-1 space-y-3 bg-slate-50 p-6 dark:bg-background'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-64 w-full' />
      </div>
    )
  if (q.isError)
    return (
      <div className='flex-1 bg-slate-50 p-6 dark:bg-background'>
        <QueryErrorState error={q.error} what='the secrets' onRetry={() => void q.refetch()} />
      </div>
    )
  const { items, policies, kinds } = q.data
  const due = items.filter((i) => i.due === 'overdue' || i.due === 'due_soon').length
  const visible = kind ? items.filter((i) => i.kind === kind) : items
  return (
    <div className='relative flex-1 space-y-5 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
      {shown && (
        <section
          aria-label='New secret'
          {...NO_RECORD_ATTRS}
          className={`${NO_RECORD_CLASS} space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30`}
        >
          <p
            role='status'
            className='m-0 text-[13px] font-semibold text-amber-900 dark:text-amber-200'
          >
            Copy the new {shown.label} now — it is shown only this once
          </p>
          <div className='flex min-w-0 flex-wrap items-center gap-2'>
            <code className='min-w-0 flex-1 break-all rounded border border-amber-200 bg-white px-2 py-1.5 font-mono text-[12px] text-slate-900 dark:border-amber-900/60 dark:bg-background dark:text-foreground'>
              {shown.value}
            </code>
            <CopyButton value={shown.value} label='Copy the secret' />
            <Button size='sm' variant='outline' className='h-8' onClick={() => setShown(null)}>
              Done
            </Button>
          </div>
        </section>
      )}

      <SectionCard
        title='Secrets the Hub holds'
        description={
          due > 0
            ? `${due} due for rotation. Values are never shown: a fingerprint of the stored secret tells you when it changed.`
            : 'Values are never shown: a fingerprint of the stored secret tells you when it changed.'
        }
        actions={
          <SimpleSelect
            value={kind}
            onChange={setKind}
            ariaLabel='Kind of secret'
            className='h-8 w-48'
            options={[
              { value: '', label: 'Every kind' },
              ...Object.entries(kinds).map(([k, v]) => ({ value: k, label: v.label }))
            ]}
          />
        }
      >
        {visible.length === 0 ? (
          <p className='m-0 p-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No secrets of this kind.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {visible.map((i) => (
              <SecretRow key={i.ref} item={i} info={kinds[i.kind]} onShow={setShown} />
            ))}
          </ul>
        )}
      </SectionCard>

      <PoliciesCard policies={policies} kinds={kinds} />
    </div>
  )
}

function SecretRow({
  item,
  info,
  onShow
}: {
  item: SecretItem
  info: KindInfo | undefined
  onShow: (s: { label: string; value: string }) => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const refresh = () => void qc.invalidateQueries({ queryKey: opsKeys.secrets })
  const envKey = item.env_key ?? ''

  const helper = useMutation({
    mutationFn: () => rotateHere(item.ref, typed.trim()),
    onSuccess: () => {
      setConfirming(false)
      setTyped('')
      toast.success('Hub token rotated', {
        description: 'Apply now delivers it to the stack; the check runs in about 5 minutes.'
      })
      refresh()
    },
    onError: (e) => hubToast(e, 'The token could not be rotated')
  })
  const route = useMutation({
    mutationFn: async () => {
      const value = await rotateThroughRoute(item)
      await markRotated(item.ref).catch(() => undefined)
      return value
    },
    onSuccess: (value) => {
      setConfirming(false)
      if (value) onShow({ label: item.kind_label.toLowerCase(), value })
      else toast.success(`${item.kind_label} rotated`)
      refresh()
    },
    onError: (e) => hubToast(e, 'It could not be rotated')
  })
  const check = useMutation({
    mutationFn: () => checkSecretNow(item.ref),
    onSuccess: (r) => {
      if (r.state === 'failed') toast.error('Check failed', { description: r.detail })
      else toast.success(CHECK_COPY[r.state] ?? r.state, { description: r.detail })
      refresh()
    },
    onError: (e) => hubToast(e, 'The check could not run')
  })
  const due = DUE_COPY[item.due]

  return (
    <li className='space-y-2 px-4 py-3'>
      <div className='flex flex-wrap items-start gap-x-3 gap-y-1'>
        <KeyRound className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' aria-hidden />
        <div className='min-w-0 flex-[1_1_240px]'>
          <p className='m-0 break-words text-[13px] font-medium text-slate-900 dark:text-foreground'>
            {item.label}
          </p>
          <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
            {item.kind_label} ·{' '}
            {item.sealed ? (
              <>
                fingerprint <span className='font-mono'>{item.fingerprint}</span>
              </>
            ) : (
              <span className='text-amber-700 dark:text-amber-400'>stored unsealed</span>
            )}
            {item.age_days != null ? ` · ${item.age_days} days old` : ''}
            {item.rotated_at
              ? ` · rotated ${formatDate(item.rotated_at)}${item.rotated_via === 'detected' ? ' (seen)' : ''}`
              : ''}
            {item.due_at ? ` · due ${formatDate(item.due_at)}` : ''}
          </p>
          {item.check_state && (
            <p
              className={cn(
                'm-0 mt-0.5 text-[11px]',
                item.check_state === 'failed'
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-slate-500 dark:text-muted-foreground'
              )}
            >
              <ShieldCheck className='mr-1 inline h-3 w-3' aria-hidden />
              {CHECK_COPY[item.check_state] ?? item.check_state}
              {item.check_detail ? `: ${item.check_detail}` : ''}
              {item.check_state === 'pending' && item.check_due_at
                ? ` (at ${formatDateTime(item.check_due_at)})`
                : ''}
            </p>
          )}
        </div>
        <span
          className={cn(
            'whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium',
            due.tone
          )}
        >
          {due.label}
        </span>
      </div>
      <div className='flex flex-wrap items-center gap-2 pl-7'>
        {item.rotate === 'helper' && item.helper_ready && !confirming && (
          <Button size='sm' variant='outline' className='h-7' onClick={() => setConfirming(true)}>
            <RotateCw className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Rotate…
          </Button>
        )}
        {item.rotate === 'route' && !confirming && (
          <Button size='sm' variant='outline' className='h-7' onClick={() => setConfirming(true)}>
            <RotateCw className='mr-1.5 h-3.5 w-3.5' aria-hidden /> Rotate…
          </Button>
        )}
        {confirming && item.rotate === 'helper' && (
          <>
            <span aria-hidden className='text-[12px] text-slate-600 dark:text-slate-300'>
              Type <span className='font-mono'>{envKey}</span> to rotate:
            </span>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              aria-label='Environment key to confirm'
              autoComplete='off'
              spellCheck={false}
              className='h-7 w-40 font-mono text-[12px]'
            />
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-white'
              disabled={typed.trim() !== envKey || helper.isPending}
              onClick={() => helper.mutate()}
            >
              {helper.isPending ? 'Rotating…' : 'Rotate and apply'}
            </Button>
            <Button size='sm' variant='ghost' className='h-7' onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        )}
        {confirming && item.rotate === 'route' && (
          <>
            <span className='text-[12px] text-slate-600 dark:text-slate-300'>{info?.how}</span>
            <Button
              size='sm'
              className='h-7 bg-nvr-cyan text-white'
              disabled={route.isPending}
              onClick={() => route.mutate()}
            >
              {route.isPending ? 'Rotating…' : 'Rotate now'}
            </Button>
            <Button size='sm' variant='ghost' className='h-7' onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </>
        )}
        {!confirming &&
          (item.rotate === 'manual' || (item.rotate === 'helper' && !item.helper_ready)) && (
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {item.rotate === 'helper'
                ? 'Not deployed through a Docker driver: set a new HUB_TOKEN on the app, then type it on the environment.'
                : info?.how}{' '}
              <Link
                to={item.path}
                className='font-medium text-cyan-700 hover:underline dark:text-cyan-300'
              >
                Open where it lives
              </Link>
            </span>
          )}
        {!confirming && item.rotated_at && (
          <Button
            size='sm'
            variant='ghost'
            className='h-7'
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? 'Checking…' : 'Check now'}
          </Button>
        )}
      </div>
    </li>
  )
}

function PoliciesCard({
  policies,
  kinds
}: {
  policies: Record<string, SecretPolicy>
  kinds: Record<string, KindInfo>
}) {
  return (
    <SectionCard
      title='Rotation schedules'
      description='Per kind of secret: rotate every N days (blank = no schedule) and remind administrators N days before.'
    >
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {Object.entries(kinds).map(([k, info]) => (
          <PolicyRow key={k} kind={k} info={info} policy={policies[k]} />
        ))}
      </ul>
    </SectionCard>
  )
}

function PolicyRow({
  kind,
  info,
  policy
}: {
  kind: string
  info: KindInfo
  policy: SecretPolicy | undefined
}) {
  const qc = useQueryClient()
  const [every, setEvery] = useState(policy?.every_days == null ? '' : String(policy.every_days))
  const [remind, setRemind] = useState(String(policy?.remind_days ?? info.remind_days))
  const save = useMutation({
    mutationFn: () =>
      savePolicy(kind, every.trim() === '' ? null : Number(every), Number(remind || 0)),
    onSuccess: () => {
      toast.success(`${info.label}: schedule saved`)
      void qc.invalidateQueries({ queryKey: opsKeys.secrets })
    },
    onError: (e) => hubToast(e, 'The schedule could not be saved')
  })
  const dirty =
    every !== (policy?.every_days == null ? '' : String(policy.every_days)) ||
    remind !== String(policy?.remind_days ?? info.remind_days)
  return (
    <li className='flex flex-wrap items-center gap-2 px-4 py-2.5'>
      <span className='min-w-0 flex-[1_1_200px] text-[12px] font-medium text-slate-800 dark:text-foreground'>
        {info.label}
        {!policy?.saved && (
          <span className='ml-1.5 font-normal text-slate-500 dark:text-muted-foreground'>
            (default)
          </span>
        )}
      </span>
      {info.rotate === 'never' ? (
        <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Never on a schedule
        </span>
      ) : (
        <>
          <span className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            Every
            <Input
              value={every}
              onChange={(e) => setEvery(e.target.value.replace(/[^\d]/g, ''))}
              inputMode='numeric'
              aria-label={`${info.label}: rotate every N days`}
              className='h-7 w-16 text-[12px]'
            />
            days
          </span>
          <span className='flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-slate-300'>
            remind
            <Input
              value={remind}
              onChange={(e) => setRemind(e.target.value.replace(/[^\d]/g, ''))}
              inputMode='numeric'
              aria-label={`${info.label}: remind N days before`}
              className='h-7 w-14 text-[12px]'
            />
            days before
          </span>
          <Button
            size='sm'
            variant='outline'
            className='h-7'
            disabled={!dirty || save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      )}
    </li>
  )
}
