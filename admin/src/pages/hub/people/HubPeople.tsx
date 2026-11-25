import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Search, ShieldOff, Users, UserX } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { dangerArmed, Field, ghostButton, listPaneClass, SectionCard } from '../hub-parts'
import {
  codeWords,
  type DirectoryPerson,
  type EnvAccess,
  type EnvOutcome,
  fetchPeople,
  fetchPersonAccess,
  liftOffboard,
  type OffboardRun,
  OUTCOME_COPY,
  type PersonDetail,
  peopleKeys,
  peopleToast,
  retryOffboard,
  startOffboard,
  usePerson
} from './people-api'

/**
 * People (Apps hub tab, Hub administrators): everyone the Hub has seen sign in to its apps, where,
 * and — asked live over each app's link — which account and role they hold there. "Offboard
 * everywhere" suspends them in every app at once (never deletes) and stops the Hub signing them
 * in. Master-detail: the list left, the person (`?person=<key>`) right; one at a time below md.
 */
export default function HubPeople() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const selected = params.get('person')
  const [q, setQ] = useState('')
  const people = useQuery({
    queryKey: peopleKeys.list(q.trim()),
    queryFn: () => fetchPeople(q.trim()),
    enabled: isAdmin
  })
  const pick = (key: string | null) =>
    setParams((p) => {
      const out = new URLSearchParams(p)
      if (key) out.set('person', key)
      else out.delete('person')
      return out
    })

  if (!isAdmin)
    return (
      <div className='flex flex-1 items-center justify-center p-8 text-center'>
        <p className='m-0 text-[13px] text-slate-500 dark:text-muted-foreground'>
          People are for Hub administrators.
        </p>
      </div>
    )

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className={cn(listPaneClass, selected ? 'hidden' : 'flex')}>
          <div className='border-b border-slate-200 p-2 dark:border-border'>
            <div className='relative'>
              <Search
                className='pointer-events-none absolute top-2 left-2 h-4 w-4 text-slate-400'
                aria-hidden
              />
              <Input
                aria-label='Find a person'
                placeholder='Name, email or app'
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className='h-8 pl-8 text-[13px]'
              />
            </div>
            {people.data && (
              <p className='m-0 mt-1.5 px-1 text-[11px] text-slate-500 tabular-nums dark:text-muted-foreground'>
                {people.data.total} {people.data.total === 1 ? 'person' : 'people'}
              </p>
            )}
          </div>
          {people.isPending ? (
            <div className='space-y-2 p-3'>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className='h-12 w-full' />
              ))}
            </div>
          ) : people.isError ? (
            <QueryErrorState
              error={people.error}
              what='the people'
              onRetry={() => void people.refetch()}
              className='m-3'
            />
          ) : people.data.data.length === 0 ? (
            <p className='m-0 px-4 py-8 text-center text-[12px] text-slate-500 dark:text-muted-foreground'>
              {q.trim() ? 'Nobody matches.' : 'Nobody has signed in to an app the Hub knows yet.'}
            </p>
          ) : (
            <ul className='m-0 list-none space-y-0.5 p-2'>
              {people.data.data.map((p) => (
                <li key={p.key}>
                  <PersonItem person={p} active={p.key === selected} onSelect={() => pick(p.key)} />
                </li>
              ))}
            </ul>
          )}
        </aside>
        <div
          className={cn(
            'min-w-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background',
            selected ? 'block' : 'hidden md:block'
          )}
        >
          {selected ? (
            <>
              <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
                <button type='button' className={ghostButton} onClick={() => pick(null)}>
                  <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All people
                </button>
              </div>
              <PersonView key={selected} personKey={selected} />
            </>
          ) : (
            <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
              <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
                <Users className='h-5 w-5 text-slate-400 dark:text-muted-foreground' aria-hidden />
              </div>
              <p className='mt-3 text-[13px] font-medium text-slate-700 dark:text-foreground'>
                Pick a person
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function PersonItem({
  person,
  active,
  onSelect
}: {
  person: DirectoryPerson
  active: boolean
  onSelect: () => void
}) {
  const apps = new Set(person.environments.map((e) => e.app_id)).size
  return (
    <button
      type='button'
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'w-full rounded-md px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
        active ? 'bg-accent' : 'hover:bg-muted'
      )}
    >
      <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
        {person.name ?? person.email ?? 'Unknown person'}
      </span>
      <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
        {[person.name ? person.email : null, `${apps} ${apps === 1 ? 'app' : 'apps'}`]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </button>
  )
}

const OUTCOME_TONE: Record<EnvOutcome, string> = {
  pending: 'text-slate-500 dark:text-muted-foreground',
  suspended: 'text-emerald-700 dark:text-emerald-400',
  already: 'text-emerald-700 dark:text-emerald-400',
  none: 'text-slate-600 dark:text-slate-300',
  refused: 'text-amber-700 dark:text-amber-400',
  no_link: 'text-amber-700 dark:text-amber-400',
  failed: 'text-red-600 dark:text-red-400'
}

const cell = 'px-3 py-2 align-top text-[12px] text-slate-700 dark:text-slate-200'

/** App and environment in one cell, so a phone keeps three columns. "Production" only when the
 *  key does not already say so (the Hub's rule: the last environment of the chain). */
function Where({ app, env, production }: { app: string; env: string; production?: boolean }) {
  const tag = production && !/^(production|prod|prd|live)$/i.test(env)
  return (
    <td className={cell}>
      <span className='block font-medium text-slate-800 dark:text-foreground'>{app}</span>
      <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
        {env}
        {tag ? ' · production' : ''}
      </span>
    </td>
  )
}
const head = 'px-3 py-2 text-left text-[11px] font-medium text-slate-500 dark:text-muted-foreground'

function PersonView({ personKey }: { personKey: string }) {
  const person = usePerson(personKey)
  if (person.isPending)
    return (
      <div className='space-y-3 p-4'>
        <Skeleton className='h-16 w-full' />
        <Skeleton className='h-40 w-full' />
      </div>
    )
  if (person.isError)
    return (
      <QueryErrorState
        error={person.error}
        what='this person'
        onRetry={() => void person.refetch()}
        className='m-4'
      />
    )
  const p = person.data
  const running = p.offboards.some((o) => o.status === 'running')
  return (
    <div className='space-y-4 p-4'>
      <header>
        <h2 className='m-0 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
          {p.name ?? p.email ?? 'Unknown person'}
        </h2>
        <p className='m-0 mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {[
            p.name ? p.email : null,
            p.hub_user_id ? 'Has a Hub account' : 'No Hub account',
            p.last_seen ? `last seen ${formatRelative(p.last_seen)}` : null
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      <SeenCard person={p} />
      <AccessCard personKey={personKey} />
      <OffboardCard person={p} running={running} />
      {p.offboards.map((o) => (
        <RunCard key={o.id} run={o} personKey={personKey} />
      ))}
    </div>
  )
}

function SeenCard({ person }: { person: PersonDetail }) {
  return (
    <SectionCard
      title='Where the Hub has seen them'
      description='Sign-ins through the Hub, and sign-ins the apps report. Kept 180 days.'
    >
      {person.environments.length === 0 ? (
        <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No sign-ins recorded.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr>
                <th className={head}>Where</th>
                <th className={head}>How</th>
                <th className={head}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {person.environments.map((e) => (
                <tr key={e.environment_id} className='border-t border-slate-100 dark:border-border'>
                  <Where app={e.app_name} env={e.environment_key} />
                  <td className={cell}>{e.via === 'hub' ? 'Through the Hub' : 'Directly'}</td>
                  <td className={cell}>{e.last_seen ? formatRelative(e.last_seen) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

function accessWords(a: EnvAccess): string {
  if (a.state === 'none') return 'No account'
  if (a.state === 'no_link') return 'No link — check in the app'
  if (a.state === 'error') return codeWords(a.code) ?? 'Did not answer'
  return a.accounts
    .map(
      (x) =>
        `${x.role ?? 'No role'}${x.admin ? ' (admin)' : ''}${x.status === 'active' ? '' : ` · ${x.status}`}`
    )
    .join(', ')
}

function AccessCard({ personKey }: { personKey: string }) {
  const [asked, setAsked] = useState(false)
  const access = useQuery({
    queryKey: peopleKeys.access(personKey),
    queryFn: () => fetchPersonAccess(personKey),
    enabled: asked,
    staleTime: 30_000
  })
  return (
    <SectionCard
      title='Access in every app'
      description='Asks every app now which account they hold and with which role. Matched by email and Microsoft id only.'
      actions={
        <button
          type='button'
          className={ghostButton}
          disabled={access.isFetching}
          onClick={() => (asked ? void access.refetch() : setAsked(true))}
        >
          {access.isFetching ? 'Asking the apps…' : asked ? 'Ask again' : 'Check now'}
        </button>
      }
    >
      {!asked ? null : access.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-24 w-full' />
        </div>
      ) : access.isError ? (
        <QueryErrorState
          error={access.error}
          what='their access'
          onRetry={() => void access.refetch()}
          className='m-3'
        />
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr>
                <th className={head}>Where</th>
                <th className={head}>Account and role</th>
              </tr>
            </thead>
            <tbody>
              {access.data.map((a) => (
                <tr key={a.environment_id} className='border-t border-slate-100 dark:border-border'>
                  <Where app={a.app_name} env={a.environment_key} production={a.production} />
                  <td
                    className={cn(
                      cell,
                      a.state === 'error' || a.state === 'no_link'
                        ? 'text-amber-700 dark:text-amber-400'
                        : a.state === 'none'
                          ? 'text-slate-500 dark:text-muted-foreground'
                          : ''
                    )}
                  >
                    {accessWords(a)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  )
}

function OffboardCard({ person, running }: { person: PersonDetail; running: boolean }) {
  const blocked = person.offboards.some((o) => o.blocked)
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState('')
  const ident = person.identity
  const nothing = ident.emails.length === 0 && ident.entra.length === 0
  const expected = ident.emails[0] ?? person.key
  const start = useMutation({
    mutationFn: () => startOffboard(person.key, confirm.trim(), person.identity_hash),
    onSuccess: () => {
      setConfirm('')
      toast.success('Offboarding started', {
        description: 'The Hub no longer signs them in. Each app is being asked now.'
      })
      void qc.invalidateQueries({ queryKey: peopleKeys.person(person.key) })
    },
    onError: (err) => {
      peopleToast(err, 'Could not start offboarding')
      // IDENTITY_CHANGED: show the list as it is now before anyone confirms again.
      void qc.invalidateQueries({ queryKey: peopleKeys.person(person.key) })
    }
  })
  const ready = confirm.trim().toLowerCase() === expected.toLowerCase()
  const id = `offboard-confirm-${person.key}`
  return (
    <SectionCard
      title='Offboard everywhere'
      description='Suspends their account in every app and ends their sessions and phone sign-ins there. Nothing is deleted. The Hub stops signing them in at once. An app’s last administrator is never suspended.'
    >
      <div className='space-y-3 px-4 py-3'>
        {blocked && !running && (
          <p
            role='status'
            className='m-0 text-[12px] font-medium text-slate-700 dark:text-slate-200'
          >
            Offboarded — the Hub refuses their sign-in. Run it again to reach apps added since.
          </p>
        )}
        {nothing ? (
          <p className='m-0 text-[12px] text-amber-700 dark:text-amber-400'>
            The Hub has nothing proven to match this person by (no Hub account, or no email or
            Microsoft id the Hub recorded itself). Suspend them in each app by hand.
          </p>
        ) : (
          <div className='space-y-1'>
            <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
              Every app suspends the accounts that match:
            </p>
            <ul className='m-0 list-none space-y-0.5 p-0 text-[12px]'>
              {ident.emails.map((e) => (
                <li key={e} className='text-slate-800 dark:text-slate-200'>
                  {e}
                </li>
              ))}
              {ident.entra.map((x) => (
                <li key={x.oid} className='text-slate-800 dark:text-slate-200'>
                  Microsoft id <span className='font-mono text-[11px]'>{x.oid}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <Field id={id} label={`Type ${expected} to confirm`}>
          <Input
            id={id}
            value={confirm}
            autoComplete='off'
            spellCheck={false}
            onChange={(e) => setConfirm(e.target.value)}
            className='h-8 max-w-sm text-[13px]'
            disabled={nothing || running || start.isPending}
          />
        </Field>
        <button
          type='button'
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium disabled:opacity-50',
            dangerArmed
          )}
          disabled={nothing || !ready || running || start.isPending}
          onClick={() => start.mutate()}
        >
          <UserX className='h-3.5 w-3.5' aria-hidden />
          {running ? 'Offboarding…' : blocked ? 'Offboard again' : 'Offboard everywhere'}
        </button>
      </div>
    </SectionCard>
  )
}

/** Codes the outcome word already says ("Did not answer", "No link"): no second line. */
const SAID_BY_OUTCOME = new Set(['TIMEOUT', 'LINK_UNREACHABLE', 'NO_LINK'])

const RUN_WORDS: Record<OffboardRun['status'], string> = {
  running: 'Running',
  done: 'Done in every app',
  partial: 'Not finished everywhere',
  interrupted: 'Stopped (the Hub restarted)'
}

function RunCard({ run, personKey }: { run: OffboardRun; personKey: string }) {
  const qc = useQueryClient()
  const refresh = () => void qc.invalidateQueries({ queryKey: peopleKeys.person(personKey) })
  const retry = useMutation({
    mutationFn: () => retryOffboard(run.id),
    onSuccess: refresh,
    onError: (err) => peopleToast(err, 'Could not retry')
  })
  const [lifting, setLifting] = useState(false)
  const [liftText, setLiftText] = useState('')
  const liftExpected = run.identity?.emails[0] ?? run.person_key ?? String(run.id)
  const lift = useMutation({
    mutationFn: () => liftOffboard(run.id, liftText.trim()),
    onSuccess: (res) => {
      toast.success(res.hub_account_reactivated ? 'The Hub signs them in again' : 'Block lifted', {
        description: res.hub_account_reactivated
          ? 'Their Hub account is active again. Their accounts in the apps stay suspended; restore them in each app.'
          : `${res.hub_account_note ?? 'Their Hub account was left as it is.'} Their accounts in the apps stay suspended.`
      })
      setLifting(false)
      setLiftText('')
      refresh()
    },
    onError: (err) => peopleToast(err, 'Could not lift the block')
  })
  const open = run.results.filter(
    (r) => r.state !== 'suspended' && r.state !== 'already' && r.state !== 'none'
  ).length
  return (
    <SectionCard
      title={`Offboard · ${RUN_WORDS[run.status]}`}
      description={[
        run.started_at ? `Started ${formatDateTime(run.started_at)}` : null,
        run.hub_account === 'suspended'
          ? 'Hub account suspended'
          : run.hub_account === 'already'
            ? 'Hub account was suspended'
            : 'No Hub account',
        run.blocked ? 'Hub sign-in refused' : 'Hub sign-in block lifted'
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={
        run.status === 'running' ? null : (
          <>
            {open > 0 && (
              <button
                type='button'
                className={ghostButton}
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
              >
                Retry {open} {open === 1 ? 'environment' : 'environments'}
              </button>
            )}
            {run.blocked && (
              <button
                type='button'
                className={cn(ghostButton, lifting && 'bg-accent')}
                aria-expanded={lifting}
                onClick={() => setLifting((v) => !v)}
              >
                <ShieldOff className='h-3.5 w-3.5' aria-hidden /> Lift Hub sign-in block…
              </button>
            )}
          </>
        )
      }
    >
      {lifting && run.blocked && run.status !== 'running' && (
        <div className='space-y-2 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <p className='m-0 text-[12px] text-slate-600 dark:text-slate-300'>
            Lifts this offboard’s sign-in block. Their Hub account is made active again only if this
            offboard suspended it and nobody suspended or changed it since. Their accounts in the
            apps stay suspended.
          </p>
          <Field id={`lift-${run.id}`} label={`Type ${liftExpected} to lift the block`}>
            <Input
              id={`lift-${run.id}`}
              value={liftText}
              autoComplete='off'
              spellCheck={false}
              onChange={(e) => setLiftText(e.target.value)}
              className='h-8 max-w-sm text-[13px]'
            />
          </Field>
          <button
            type='button'
            className={cn(ghostButton, 'border border-slate-200 dark:border-border')}
            disabled={
              lift.isPending || liftText.trim().toLowerCase() !== liftExpected.toLowerCase()
            }
            onClick={() => lift.mutate()}
          >
            Lift the block
          </button>
        </div>
      )}
      <div className='overflow-x-auto'>
        <table className='w-full'>
          <thead>
            <tr>
              <th className={head}>Where</th>
              <th className={head}>Result</th>
              <th className={cn(head, 'text-right')}>Tries</th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((r) => (
              <tr key={r.environment_id} className='border-t border-slate-100 dark:border-border'>
                <Where app={r.app_name} env={r.environment_key} />
                <td className={cn(cell, OUTCOME_TONE[r.state])}>
                  {OUTCOME_COPY[r.state]}
                  {r.code && !SAID_BY_OUTCOME.has(r.code) && (
                    <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                      {codeWords(r.code)}
                    </span>
                  )}
                </td>
                <td className={cn(cell, 'text-right tabular-nums')}>{r.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  )
}
