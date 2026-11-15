import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  KeyRound,
  LogIn,
  Smartphone
} from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { ErrorNotice } from '../ErrorNotice'
import { Skeleton } from '../ui/skeleton'
import { EmptyLine, SectionCard } from './primitives'
import type { PersonProfile } from './types'

/**
 * Admin tools → Sign-in troubleshooter (idea 32). Reads GET /users/:id/sign-in-troubleshooter:
 * the account's standing now, the failure to act on (newest one since their last sign-in) with
 * what to do and who can fix it, then 30 days of attempts — failed, signed in, phone ended — each
 * with a plain reason. "Refused requests" asks the request log on demand (slower).
 */

type Owner = 'person' | 'admin' | 'it' | 'wait'

interface Attempt {
  id: string
  at: string
  outcome: 'failed' | 'signed_in' | 'ended'
  reason: string | null
  label: string
  explain: string | null
  todo: string | null
  owner: Owner | null
  method: string | null
  app: string | null
  code: string | null
  match: 'named' | 'browser'
  browser: string | null
  ip: string | null
  new_ip?: boolean
}

interface Troubleshooter {
  window_days: number
  checks: Array<{ key: string; ok: boolean | null; label: string; detail: string }>
  last_success: {
    at: string
    method: string
    browser: string | null
    ip: string | null
    app: string | null
  } | null
  apps: Array<{ app: string; at: string }>
  phones: Array<{ name: string; platform: string | null; last_used_at: string | null }>
  attempts: Attempt[]
  by_reason: Array<{ reason: string; label: string; n: number; last_at: string }>
  current: (Attempt & { since_success: boolean }) | null
}

interface Refusal {
  code: string
  status: number
  message: string | null
  n: number
  last_at: string
}

const OWNER_TEXT: Record<Owner, string> = {
  person: 'They can fix this',
  admin: 'An administrator here fixes this',
  it: 'Their IT team fixes this',
  wait: 'Usually clears by itself'
}

const METHOD_TEXT: Record<string, string> = {
  oidc: 'Single sign-on',
  saml: 'SAML',
  password: 'Password',
  totp: 'Two-factor code',
  token: 'Token',
  static_token: 'Token',
  phone: 'Phone app'
}

const appLabel = (app: string | null) =>
  !app ? null : app === 'admin' ? 'Admin' : app === 'phone' ? 'Phone app' : app

const SHOWN = 8

export function SignInTroubleshooterCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const q = useQuery({
    queryKey: ['nvr-sign-in-troubleshooter', p.id],
    queryFn: () =>
      client
        .request<{ data: Troubleshooter }>(get(`/users/${p.id}/sign-in-troubleshooter`))
        .then((r) => r.data),
    staleTime: 30_000
  })
  const [all, setAll] = useState(false)
  const first = p.first_name?.trim() || p.name || 'They'

  return (
    <SectionCard
      icon={<KeyRound className='h-4 w-4' />}
      title='Sign-in troubleshooter'
      hint='Why their sign-ins failed in the last 30 days, and what to do'
      testId='sign-in-troubleshooter'
    >
      {q.isLoading ? (
        <div className='space-y-3' aria-hidden>
          <Skeleton className='h-16 w-full' />
          <Skeleton className='h-9 w-full' />
          <Skeleton className='h-9 w-2/3' />
        </div>
      ) : q.isError || !q.data ? (
        <ErrorNotice error={q.error} what='sign-in history' onRetry={() => q.refetch()} />
      ) : (
        <Body
          t={q.data}
          first={first}
          sessions={p.admin?.sessions ?? null}
          userId={p.id}
          all={all}
          onAll={() => setAll(true)}
        />
      )}
    </SectionCard>
  )
}

function Body({
  t,
  first,
  sessions,
  userId,
  all,
  onAll
}: {
  t: Troubleshooter
  first: string
  sessions: number | null
  userId: string
  all: boolean
  onAll: () => void
}) {
  const failures = t.attempts.filter((a) => a.outcome === 'failed').length
  const rows = all ? t.attempts : t.attempts.slice(0, SHOWN)
  return (
    <div className='space-y-4' data-sign-in-troubleshooter>
      <Verdict t={t} first={first} />

      <ul className='grid gap-x-4 gap-y-2 sm:grid-cols-2' data-sign-in-checks>
        {t.checks.map((c) => (
          <li key={c.key} className='flex min-w-0 items-start gap-2' data-sign-in-check={c.key}>
            {c.ok === true ? (
              <CircleCheck className='mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            ) : c.ok === false ? (
              <CircleX className='mt-px h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' />
            ) : (
              <CircleHelp className='mt-px h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
            )}
            <div className='min-w-0'>
              <p className='text-[12px] font-medium text-slate-800 dark:text-slate-100'>
                {c.label}
              </p>
              <p className='text-[11.5px] leading-snug text-slate-500 dark:text-slate-400'>
                {c.detail}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
        <Stat
          label='Last sign-in'
          value={t.last_success ? formatRelative(t.last_success.at) : 'None in 30 days'}
          tip={t.last_success ? formatDateTime(t.last_success.at) : undefined}
          sub={
            t.last_success
              ? [appLabel(t.last_success.app), METHOD_TEXT[t.last_success.method]]
                  .filter(Boolean)
                  .join(' · ') || null
              : null
          }
        />
        <Stat
          label='Live sessions'
          value={sessions == null ? '—' : String(sessions)}
          sub='Browser tabs signed in'
        />
        <Stat
          label='Phones'
          value={String(t.phones.length)}
          sub={t.phones[0]?.name ?? 'None signed in'}
        />
        <Stat
          label={`Failed · ${t.window_days} days`}
          value={String(failures)}
          sub={t.by_reason[0] ? `Mostly: ${t.by_reason[0].label}` : 'No failures'}
          warn={failures > 0}
        />
      </dl>

      {t.apps.length > 0 && (
        <p className='text-[11.5px] text-slate-500 dark:text-slate-400' data-sign-in-apps>
          Signed in to{' '}
          {t.apps.map((a, i) => (
            <span key={a.app}>
              {i > 0 && ', '}
              <span className='font-medium text-slate-700 dark:text-slate-200'>
                {appLabel(a.app) ?? a.app}
              </span>{' '}
              <span data-tip={formatDateTime(a.at)}>{formatRelative(a.at)}</span>
            </span>
          ))}
          .
        </p>
      )}

      <div>
        <h4 className='mb-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          Attempts
        </h4>
        {t.attempts.length === 0 ? (
          <EmptyLine>
            No sign-ins or failed attempts in the last {t.window_days} days. Failures from before
            this was turned on are not recorded.
          </EmptyLine>
        ) : (
          <ol className='divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-border/60 dark:border-border'>
            {rows.map((a) => (
              <AttemptRow key={a.id} a={a} />
            ))}
          </ol>
        )}
        {!all && t.attempts.length > SHOWN && (
          <button
            type='button'
            onClick={onAll}
            className='mt-2 text-[11.5px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
          >
            Show all {t.attempts.length}
          </button>
        )}
      </div>

      <Refusals userId={userId} />
    </div>
  )
}

function Verdict({ t, first }: { t: Troubleshooter; first: string }) {
  const c = t.current
  if (c) {
    return (
      <div
        className='rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 dark:border-amber-500/30 dark:bg-amber-500/10'
        data-sign-in-current={c.reason ?? ''}
      >
        <div className='flex items-start gap-2.5'>
          <CircleAlert className='mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400' />
          <div className='min-w-0 space-y-1'>
            <p className='text-[13px] font-semibold text-amber-950 dark:text-amber-100'>
              {c.label}
              <span className='ml-2 text-[11.5px] font-normal text-amber-800 dark:text-amber-300'>
                <span data-tip={formatDateTime(c.at)}>{formatRelative(c.at)}</span>
                {c.match === 'browser' && ' · probably them'}
              </span>
            </p>
            {c.explain && (
              <p className='text-[12px] leading-snug text-amber-900 dark:text-amber-200'>
                {c.explain}
              </p>
            )}
            {c.todo && (
              <p className='text-[12px] leading-snug text-amber-950 dark:text-amber-50'>
                <span className='font-semibold'>What to do: </span>
                {c.todo}
              </p>
            )}
            {c.owner && (
              <p className='text-[11.5px] text-amber-800 dark:text-amber-300'>
                {OWNER_TEXT[c.owner]}
                {c.code && <> · code {c.code}</>}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }
  const s = t.last_success
  return (
    <div
      className='flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-3 dark:border-border dark:bg-muted/40'
      data-sign-in-current='none'
    >
      <CircleCheck className='mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400' />
      <p className='text-[12.5px] leading-snug text-slate-700 dark:text-slate-200'>
        {s ? (
          <>
            <span className='font-semibold'>No sign-in problem since their last sign-in</span>{' '}
            <span data-tip={formatDateTime(s.at)}>{formatRelative(s.at)}</span>
            {s.browser && <> on {s.browser}</>}.
          </>
        ) : (
          <>
            <span className='font-semibold'>{first} has not signed in for 30 days</span>, and no
            failed attempt was recorded. If they say sign-in fails, ask them to try once now, then
            refresh this card.
          </>
        )}
      </p>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tip,
  warn
}: {
  label: string
  value: string
  sub?: string | null
  tip?: string
  warn?: boolean
}) {
  return (
    <div className='min-w-0 bg-white px-3 py-2 dark:bg-card'>
      <dt className='text-[10.5px] font-medium text-slate-500 dark:text-slate-400'>{label}</dt>
      <dd
        className={cn(
          'truncate text-[13px] font-semibold tabular-nums',
          warn ? 'text-amber-700 dark:text-amber-300' : 'text-slate-800 dark:text-slate-100'
        )}
        data-tip={tip}
      >
        {value}
      </dd>
      {sub && (
        <dd className='truncate text-[11px] text-slate-500 dark:text-slate-400' title={sub}>
          {sub}
        </dd>
      )}
    </div>
  )
}

function AttemptRow({ a }: { a: Attempt }) {
  const [open, setOpen] = useState(false)
  const failed = a.outcome === 'failed'
  const canOpen = !!(a.explain || a.todo)
  const chips = [
    appLabel(a.app),
    a.method ? (METHOD_TEXT[a.method] ?? a.method) : null,
    a.code
  ].filter(Boolean) as string[]
  const Icon = a.outcome === 'signed_in' ? LogIn : a.outcome === 'ended' ? Smartphone : CircleX
  const main = (
    <>
      <Icon
        className={cn(
          'mt-0.5 h-3.5 w-3.5 shrink-0',
          failed
            ? 'text-red-600 dark:text-red-400'
            : a.outcome === 'signed_in'
              ? 'text-emerald-600 dark:text-emerald-400'
              : 'text-slate-400 dark:text-slate-500'
        )}
      />
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
          <span
            className={cn(
              'text-[12px] font-medium',
              failed ? 'text-slate-900 dark:text-slate-50' : 'text-slate-700 dark:text-slate-200'
            )}
          >
            {a.label}
          </span>
          {chips.map((c) => (
            <span
              key={c}
              className='rounded bg-slate-100 px-1.5 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-slate-300'
            >
              {c}
            </span>
          ))}
          {a.match === 'browser' && (
            <span
              className='rounded bg-amber-100 px-1.5 py-px text-[10.5px] text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'
              data-tip='Nobody was named on this attempt; it came from the same address and browser as one of their sign-ins'
            >
              Probably them
            </span>
          )}
          {a.new_ip && (
            <span className='rounded bg-sky-100 px-1.5 py-px text-[10.5px] text-sky-800 dark:bg-sky-500/15 dark:text-sky-300'>
              New address
            </span>
          )}
        </div>
        <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
          {[a.browser, a.ip].filter(Boolean).join(' · ') || ' '}
        </p>
        {open && canOpen && (
          <div className='mt-1.5 space-y-1 text-[11.5px] leading-snug' data-sign-in-detail>
            {a.explain && <p className='text-slate-600 dark:text-slate-300'>{a.explain}</p>}
            {a.todo && (
              <p className='text-slate-800 dark:text-slate-100'>
                <span className='font-semibold'>What to do: </span>
                {a.todo}
              </p>
            )}
            {a.owner && <p className='text-slate-500 dark:text-slate-400'>{OWNER_TEXT[a.owner]}</p>}
          </div>
        )}
      </div>
      <span
        className='shrink-0 text-[11px] tabular-nums text-slate-500 dark:text-slate-400'
        data-tip={formatDateTime(a.at)}
      >
        {formatRelative(a.at)}
      </span>
      {canOpen && (
        <ChevronDown
          className={cn(
            'mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-180'
          )}
        />
      )}
    </>
  )
  return (
    <li data-sign-in-attempt={a.outcome}>
      {canOpen ? (
        <button
          type='button'
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className='flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted/40'
        >
          {main}
        </button>
      ) : (
        <div className='flex items-start gap-2 px-3 py-2'>{main}</div>
      )}
    </li>
  )
}

function Refusals({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const [asked, setAsked] = useState(false)
  const q = useQuery({
    queryKey: ['nvr-sign-in-refusals', userId],
    queryFn: () =>
      client
        .request<{ data: Refusal[]; days: number }>(
          get(`/users/${userId}/sign-in-troubleshooter/refusals`)
        )
        .then((r) => r),
    enabled: asked,
    staleTime: 60_000
  })
  if (!asked) {
    return (
      <div className='flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-border/60'>
        <button
          type='button'
          onClick={() => setAsked(true)}
          className='inline-flex h-7 items-center rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-border dark:text-slate-200 dark:hover:bg-muted/40'
          data-sign-in-refusals-ask
        >
          Check refused requests
        </button>
        <span className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          Requests made as them that were refused in the last 7 days. Reads the request log, so it
          takes a moment.
        </span>
      </div>
    )
  }
  return (
    <div className='border-t border-slate-100 pt-3 dark:border-border/60' data-sign-in-refusals>
      <h4 className='mb-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
        Refused requests · 7 days
      </h4>
      {q.isLoading ? (
        <Skeleton className='h-8 w-full' />
      ) : q.isError ? (
        <ErrorNotice error={q.error} what='refused requests' onRetry={() => q.refetch()} />
      ) : !q.data?.data.length ? (
        <EmptyLine>None — every request made as them was let through.</EmptyLine>
      ) : (
        <ul className='space-y-1'>
          {q.data.data.map((r) => (
            <li key={r.code} className='flex items-baseline gap-2 text-[12px]'>
              <span className='font-medium tabular-nums text-slate-800 dark:text-slate-100'>
                {r.n}×
              </span>
              <span className='text-slate-700 dark:text-slate-200'>{r.code}</span>
              <span className='min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400'>
                {r.message ?? ''}
              </span>
              <span
                className='shrink-0 text-[11px] text-slate-500 dark:text-slate-400'
                data-tip={formatDateTime(r.last_at)}
              >
                {formatRelative(r.last_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
