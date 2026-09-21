import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, RotateCw, Search, UserX } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useItemNavigation, useNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

/**
 * Data Integrity → People. Accounts that can no longer act (suspended,
 * redacted, anonymised, import placeholders) and the live work that still
 * names them: contacts and owners on records, owner-group seats, team
 * memberships, open tasks. Reads GET /inactive-user-links (admin); a record
 * link is handed on through POST /inactive-user-links/:user/reassign, which
 * writes through the items service as the person clicking.
 *
 * Opens on the narrowest useful question — assignments on records that sit in
 * an open pipeline — and widens by switch. Needs `<NivaroProvider>`;
 * `NavigationContext` supplies record and user links.
 */

type LinkRole = 'assignment' | 'audit' | 'seat' | 'own'
type Reason = 'suspended' | 'redacted' | 'anonymised' | 'placeholder'

interface LinkSource {
  key: string
  collection: string
  collection_label: string
  field: string
  label: string
  role: LinkRole
  scope: 'open' | 'all'
  kind: 'column' | 'junction' | 'm2a' | 'builtin'
  reassignable: boolean
}

interface PersonLinks {
  user: {
    id: string
    name: string
    email: string | null
    status: string | null
    reason: Reason
    last_access: string | null
  }
  total: number
  links: Array<{ source: string; count: number }>
}

interface Scan {
  sources: LinkSource[]
  users: PersonLinks[]
  failed: string[]
}

const REASON_LABEL: Record<Reason, string> = {
  suspended: 'Suspended',
  redacted: 'Redacted',
  anonymised: 'Anonymised',
  placeholder: 'Placeholder'
}
const REASON_TIP: Record<Reason, string> = {
  suspended: 'The account is suspended — the person cannot sign in or act.',
  redacted: 'Personal details were removed by a retention policy.',
  anonymised: 'Details were overwritten by the nightly anonymisation of departed people.',
  placeholder: 'Stands in for a legacy account that no longer exists.'
}
const REASON_CLS: Record<Reason, string> = {
  suspended: 'bg-[#fef3c7] text-[#92400e] dark:bg-[#3a2a12] dark:text-[#f5c97a]',
  redacted: 'bg-[#ffe4e6] text-[#9f1239] dark:bg-[#3d1a20] dark:text-[#f4a3ad]',
  anonymised: 'bg-[#ffe4e6] text-[#9f1239] dark:bg-[#3d1a20] dark:text-[#f4a3ad]',
  placeholder: 'bg-[#e2e8f0] text-[#334155] dark:bg-[#2c3038] dark:text-[#cbd5e1]'
}

const n = (v: number) => v.toLocaleString()

export function InactiveUserLinksView({ className }: { className?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [openOnly, setOpenOnly] = useState(true)
  const [withAudit, setWithAudit] = useState(false)
  const [withOwn, setWithOwn] = useState(false)
  const [withSeats, setWithSeats] = useState(true)
  const [reason, setReason] = useState<Reason | null>(null)
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fresh, setFresh] = useState(0)

  const scan = useQuery({
    queryKey: ['inactive-user-links', fresh],
    queryFn: () =>
      client
        .request<{ data: Scan }>(get(`/inactive-user-links${fresh ? '?fresh=1' : ''}`))
        .then((r) => r.data),
    staleTime: 60_000
  })

  const sources = useMemo(
    () => new Map((scan.data?.sources ?? []).map((s) => [s.key, s])),
    [scan.data]
  )

  const visible = useCallback(
    (s: LinkSource | undefined) => {
      if (!s) return false
      if (s.role === 'audit' && !withAudit) return false
      if (s.role === 'own' && !withOwn) return false
      if (s.role === 'seat' && !withSeats) return false
      // Seats have no record behind them; they always count.
      if (openOnly && s.scope !== 'open' && s.role !== 'seat') return false
      return true
    },
    [openOnly, withAudit, withOwn, withSeats]
  )

  const people = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (scan.data?.users ?? [])
      .map((p) => {
        // Record links lead; seats move from the account page, so they trail.
        const links = p.links
          .filter((l) => visible(sources.get(l.source)))
          .sort(
            (a, b) =>
              Number(sources.get(a.source)?.role === 'seat') -
                Number(sources.get(b.source)?.role === 'seat') || b.count - a.count
          )
        return { ...p, links, total: links.reduce((a, l) => a + l.count, 0) }
      })
      .filter((p) => p.total > 0)
      .filter(
        (p) => !needle || `${p.user.name} ${p.user.email ?? ''}`.toLowerCase().includes(needle)
      )
      .sort((a, b) => b.total - a.total)
  }, [scan.data, sources, q, visible])

  const byReason = useMemo(() => {
    const out: Record<Reason, number> = { suspended: 0, redacted: 0, anonymised: 0, placeholder: 0 }
    for (const p of people) out[p.user.reason]++
    return out
  }, [people])

  const shown = reason ? people.filter((p) => p.user.reason === reason) : people
  const totals = useMemo(() => {
    let records = 0
    let seats = 0
    for (const p of shown)
      for (const l of p.links) {
        if (sources.get(l.source)?.role === 'seat') seats += l.count
        else records += l.count
      }
    return { records, seats }
  }, [shown, sources])

  const rescan = () => {
    setFresh((v) => v + 1)
    setExpanded(null)
  }
  const afterChange = () => {
    qc.invalidateQueries({ queryKey: ['inactive-user-links'] })
    qc.invalidateQueries({ queryKey: ['inactive-user-records'] })
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-4 p-6', className)} data-inactive-links>
      <div className='flex flex-wrap items-center gap-x-5 gap-y-3'>
        <dl className='flex items-baseline gap-5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          <div className='flex items-baseline gap-1.5'>
            <dd
              className='text-[20px] font-semibold tabular-nums text-slate-900 dark:text-foreground'
              data-inactive-people
            >
              {scan.isLoading ? '—' : n(shown.length)}
            </dd>
            <dt>{shown.length === 1 ? 'person' : 'people'}</dt>
          </div>
          <div className='flex items-baseline gap-1.5'>
            <dd className='text-[20px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
              {scan.isLoading ? '—' : n(totals.records)}
            </dd>
            <dt>{openOnly ? 'links on open records' : 'record links'}</dt>
          </div>
          <div className='flex items-baseline gap-1.5'>
            <dd className='text-[20px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
              {scan.isLoading ? '—' : n(totals.seats)}
            </dd>
            <dt>owner seats and team places</dt>
          </div>
        </dl>
        <button
          type='button'
          onClick={rescan}
          disabled={scan.isFetching}
          className='ml-auto inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[12px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900 disabled:opacity-60 dark:border-border dark:text-muted-foreground dark:hover:text-foreground'
          data-inactive-rescan
        >
          <RotateCw className={cn('h-3.5 w-3.5', scan.isFetching && 'animate-spin')} />
          Scan again
        </button>
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <label className='relative'>
          <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder='Find a person'
            className='h-8 w-56 rounded-md border border-slate-200 bg-background pl-7 pr-2 text-[12.5px] text-slate-800 placeholder:text-slate-500 focus:border-slate-400 focus:outline-none dark:border-border dark:text-foreground dark:placeholder:text-muted-foreground'
            data-inactive-search
          />
        </label>
        <span className='flex flex-wrap items-center gap-1'>
          {(Object.keys(REASON_LABEL) as Reason[]).map((r) =>
            byReason[r] || reason === r ? (
              <button
                key={r}
                type='button'
                aria-pressed={reason === r}
                onClick={() => setReason(reason === r ? null : r)}
                data-tip={REASON_TIP[r]}
                data-inactive-reason={r}
                className={cn(
                  'h-7 rounded-md border px-2 text-[11.5px] font-medium transition-colors',
                  reason === r
                    ? 'border-slate-400 bg-slate-100 text-slate-900 dark:border-border dark:bg-muted dark:text-foreground'
                    : 'border-slate-200 text-slate-600 hover:border-slate-300 dark:border-border dark:text-muted-foreground'
                )}
              >
                {REASON_LABEL[r]}{' '}
                <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>
                  {n(byReason[r])}
                </span>
              </button>
            ) : null
          )}
        </span>
        <span className='ml-auto flex flex-wrap items-center gap-x-4 gap-y-1'>
          <Check
            label='Only records in an open workflow'
            checked={openOnly}
            onChange={setOpenOnly}
            hook='open'
          />
          <Check
            label='Owner seats and team places'
            checked={withSeats}
            onChange={setWithSeats}
            hook='seats'
          />
          <Check
            label='Created by / updated by'
            checked={withAudit}
            onChange={setWithAudit}
            hook='audit'
          />
          <Check
            label="The person's own saved sets"
            checked={withOwn}
            onChange={setWithOwn}
            hook='own'
          />
        </span>
      </div>

      {scan.data?.failed.length ? (
        <p className='text-[11.5px] text-amber-700 dark:text-amber-300'>
          {scan.data.failed.length} link {scan.data.failed.length === 1 ? 'type' : 'types'} could
          not be read and are left out: {scan.data.failed.join(', ')}
        </p>
      ) : null}

      <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        {scan.isLoading ? (
          <div className='space-y-2 p-4'>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className='h-9 animate-pulse rounded'
                style={{ background: 'hsl(var(--nvr-skeleton))' }}
              />
            ))}
          </div>
        ) : scan.isError ? (
          <p className='p-6 text-[12.5px] text-rose-700 dark:text-rose-300'>
            The scan failed. {(scan.error as Error)?.message}
          </p>
        ) : shown.length === 0 ? (
          <div className='flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center'>
            <UserX className='h-6 w-6 text-slate-400' />
            <p className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
              {openOnly ? 'Nobody inactive is named on open work' : 'Nothing matches'}
            </p>
            <p className='max-w-[52ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
              {openOnly
                ? 'Every contact, owner and task on a record in an open workflow belongs to someone who can still act. Clear the first switch to look at closed records too.'
                : 'Change the switches above to widen what counts as a link.'}
            </p>
          </div>
        ) : (
          <ul className='min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
            {shown.map((p) => (
              <PersonRow
                key={p.user.id}
                person={p}
                sources={sources}
                open={expanded === p.user.id}
                onToggle={() => setExpanded(expanded === p.user.id ? null : p.user.id)}
                onChanged={afterChange}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Check({
  label,
  checked,
  onChange,
  hook
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  hook: string
}) {
  return (
    <label className='flex cursor-pointer items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
      <input
        type='checkbox'
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className='h-3.5 w-3.5 accent-slate-700'
        data-inactive-switch={hook}
      />
      {label}
    </label>
  )
}

function sourceText(s: LinkSource) {
  return s.kind === 'builtin' ? s.label : `${s.collection_label} · ${s.label}`
}

function PersonRow({
  person,
  sources,
  open,
  onToggle,
  onChanged
}: {
  person: PersonLinks
  sources: Map<string, LinkSource>
  open: boolean
  onToggle: () => void
  onChanged: () => void
}) {
  const nav = useNavigation()
  const u = person.user
  const profile = nav.userUrl ? nav.userUrl(u.id) : `/users/${u.id}`
  const initials = u.name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
  return (
    <li data-inactive-person={u.id}>
      <button
        type='button'
        onClick={onToggle}
        aria-expanded={open}
        className='flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted'
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        )}
        <UserAvatar
          userId={u.id}
          className='h-6 w-6 shrink-0 rounded-full object-cover'
          fallback={
            <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[9px] font-semibold text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              {initials}
            </span>
          }
        />
        <span className='min-w-0 flex-[0_1_260px]'>
          <span className='block truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
            {u.name}
          </span>
          <span className='block truncate text-[11px] text-slate-500 dark:text-muted-foreground'>
            {u.email ?? '—'}
          </span>
        </span>
        <span
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium',
            REASON_CLS[u.reason]
          )}
          data-tip={REASON_TIP[u.reason]}
        >
          {REASON_LABEL[u.reason]}
        </span>
        <span className='hidden min-w-0 flex-1 truncate text-[11.5px] text-slate-500 md:block dark:text-muted-foreground'>
          {person.links
            .slice(0, 3)
            .map((l) => {
              const s = sources.get(l.source)
              return s ? `${sourceText(s)} ${n(l.count)}` : ''
            })
            .filter(Boolean)
            .join('  ·  ')}
          {person.links.length > 3 ? `  ·  +${person.links.length - 3} more` : ''}
        </span>
        <span className='ml-auto shrink-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          {u.last_access ? `last active ${formatRelative(u.last_access)}` : 'never signed in'}
        </span>
        <span className='w-14 shrink-0 text-right text-[12.5px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
          {n(person.total)}
        </span>
      </button>
      {open && (
        <div className='border-t border-slate-100 bg-slate-50/60 px-4 py-3 pl-11 dark:border-border dark:bg-white/[0.02]'>
          <ul className='space-y-1'>
            {person.links.map((l) => {
              const s = sources.get(l.source)
              return s ? (
                <SourceRow
                  key={l.source}
                  userId={u.id}
                  source={s}
                  count={l.count}
                  onChanged={onChanged}
                />
              ) : null
            })}
          </ul>
          {profile && (
            <p className='mt-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Everything this person holds can also move in one pass from{' '}
              <button
                type='button'
                onClick={() => nav.navigate(profile)}
                className='font-medium text-slate-700 underline decoration-dotted underline-offset-2 hover:text-slate-900 dark:text-foreground'
              >
                their account page
              </button>{' '}
              (Offboarding).
            </p>
          )}
        </div>
      )}
    </li>
  )
}

interface PlatformEntry {
  id: string
  title: string
  subtitle: string | null
  facts: string[]
  sole: boolean
  others: string[]
  record: { collection: string; id: string; label: string } | null
  console_path: string | null
}

interface LinkedRecord {
  id: string
  collection: string
  label: string
}

function SourceRow({
  userId,
  source,
  count,
  onChanged
}: {
  userId: string
  source: LinkSource
  count: number
  onChanged: () => void
}) {
  const client = useNivaroClient()
  const { open: openItem } = useItemNavigation()
  const [show, setShow] = useState(false)
  const listable = true
  const platform = source.kind === 'builtin'
  const records = useQuery({
    queryKey: ['inactive-user-records', userId, source.key],
    queryFn: () =>
      client
        .request<{ data: { records: LinkedRecord[]; entries: PlatformEntry[] | null } }>(
          get(
            `/inactive-user-links/${userId}/records?source=${encodeURIComponent(source.key)}&limit=100`
          )
        )
        .then((r) => r.data),
    enabled: show && listable
  })
  return (
    <li data-inactive-source={source.key}>
      <div className='flex items-center gap-2 text-[12px]'>
        <button
          type='button'
          disabled={!listable}
          onClick={() => setShow((v) => !v)}
          aria-expanded={show}
          className='flex min-w-0 items-center gap-1.5 text-left text-slate-700 enabled:hover:text-slate-900 dark:text-foreground'
        >
          {listable ? (
            show ? (
              <ChevronDown className='h-3 w-3 shrink-0 text-slate-400' />
            ) : (
              <ChevronRight className='h-3 w-3 shrink-0 text-slate-400' />
            )
          ) : (
            <span className='w-3' />
          )}
          <span className='truncate'>{sourceText(source)}</span>
        </button>
        <span className='tabular-nums text-slate-500 dark:text-muted-foreground'>{n(count)}</span>
        {source.scope === 'open' && (
          <span className='rounded bg-[#e0f2fe] px-1.5 py-0.5 text-[10px] font-medium text-[#075985] dark:bg-[#15303f] dark:text-[#8fcdf0]'>
            open workflow
          </span>
        )}
        {source.reassignable && !platform && (
          <span className='ml-auto'>
            <Reassign userId={userId} source={source} count={count} onDone={onChanged} />
          </span>
        )}
      </div>
      {show && listable && (
        <div className='ml-[18px] mt-1 mb-2'>
          {records.isLoading ? (
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>Loading…</p>
          ) : platform ? (
            <PlatformEntries
              userId={userId}
              source={source}
              entries={records.data?.entries ?? []}
              onChanged={onChanged}
            />
          ) : records.data?.records.length ? (
            <ul className='flex flex-wrap gap-1' data-inactive-records>
              {records.data.records.map((r) => (
                <li key={`${r.collection}:${r.id}`}>
                  <button
                    type='button'
                    onClick={() => openItem({ collection: r.collection, itemId: r.id })}
                    className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-700 hover:border-slate-400 dark:border-border dark:bg-card dark:text-foreground'
                  >
                    {r.label?.trim() || `#${r.id}`}
                  </button>
                </li>
              ))}
              {count > records.data.records.length && (
                <li className='px-1 py-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                  +{n(count - records.data.records.length)} more
                </li>
              )}
            </ul>
          ) : (
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Nothing to list.
            </p>
          )}
        </div>
      )}
    </li>
  )
}

interface Candidate {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

function Reassign({
  userId,
  source,
  count,
  ids,
  label = 'Hand to…',
  onDone
}: {
  userId: string
  source: LinkSource
  count: number
  ids?: string[]
  label?: string
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState<Candidate | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const users = useQuery({
    queryKey: ['inactive-reassign-users', q],
    queryFn: () =>
      client
        .request<{ data: Candidate[] }>(get(`/users?search=${encodeURIComponent(q)}&limit=8`))
        .then((r) => r.data),
    enabled: open && !pick && q.trim().length >= 2,
    staleTime: 30_000
  })
  const nameOf = (c: Candidate) => [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email
  const run = async () => {
    if (!pick) return
    setBusy(true)
    setError(null)
    try {
      const r = await client.request<{
        data: { moved: number; removed: number; failed: Array<{ id: string; error: string }> }
      }>(post(`/inactive-user-links/${userId}/reassign`, { source: source.key, to: pick.id, ids }))
      const d = r.data
      setResult(
        `${n(d.moved)} moved to ${nameOf(pick)}` +
          (d.removed ? ` · ${n(d.removed)} already theirs` : '') +
          (d.failed.length ? ` · ${n(d.failed.length)} refused (${d.failed[0].error})` : '')
      )
      setOpen(false)
      onDone()
    } catch (e) {
      const resp = (e as { response?: { error?: string } }).response
      setError(resp?.error ?? (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (result)
    return (
      <span className='text-[11px] text-emerald-700 dark:text-emerald-400' data-inactive-reassigned>
        {result}
      </span>
    )
  return (
    <span className='relative inline-block'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        data-inactive-reassign={source.key}
        className='rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-border dark:bg-card dark:text-muted-foreground dark:hover:text-foreground'
      >
        {label}
      </button>
      {open && (
        <div
          className='absolute right-0 top-7 z-30 w-72 rounded-md border border-slate-200 bg-white p-2 text-left shadow-md dark:border-border dark:bg-card'
          data-inactive-reassign-panel
        >
          {pick ? (
            <div className='space-y-2'>
              <p className='text-[12px] text-slate-700 dark:text-foreground'>
                Put <strong className='font-semibold'>{nameOf(pick)}</strong> on{' '}
                {n(Math.min(count, 500))}{' '}
                {source.kind === 'builtin'
                  ? count === 1
                    ? 'place'
                    : 'places'
                  : count === 1
                    ? 'record'
                    : 'records'}{' '}
                as {source.label.toLowerCase()}
                {count > 500 ? ' (500 at a time)' : ''}?{' '}
                {source.kind === 'builtin'
                  ? 'Places they already hold are not doubled.'
                  : "Each change is saved to the record's history."}
              </p>
              {error && <p className='text-[11.5px] text-rose-700 dark:text-rose-300'>{error}</p>}
              <div className='flex justify-end gap-1.5'>
                <button
                  type='button'
                  onClick={() => setPick(null)}
                  className='h-7 rounded-md px-2 text-[11.5px] text-slate-600 hover:text-slate-900 dark:text-muted-foreground'
                >
                  Back
                </button>
                <button
                  type='button'
                  onClick={run}
                  disabled={busy}
                  data-inactive-reassign-confirm
                  className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-medium text-white disabled:opacity-60'
                >
                  {busy ? 'Moving…' : 'Move them'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                // biome-ignore lint/a11y/noAutofocus: the panel opens on a click; the box is the only thing in it
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder='Search people'
                className='h-8 w-full rounded-md border border-slate-200 bg-background px-2 text-[12.5px] text-slate-800 placeholder:text-slate-500 focus:border-slate-400 focus:outline-none dark:border-border dark:text-foreground'
              />
              <ul className='mt-1 max-h-56 overflow-y-auto'>
                {(users.data ?? [])
                  .filter((c) => c.id.toLowerCase() !== userId.toLowerCase())
                  .map((c) => (
                    <li key={c.id}>
                      <button
                        type='button'
                        onClick={() => setPick(c)}
                        data-inactive-candidate={c.id}
                        className='flex w-full flex-col rounded px-2 py-1 text-left hover:bg-muted'
                      >
                        <span className='text-[12px] text-slate-800 dark:text-foreground'>
                          {nameOf(c)}
                        </span>
                        <span className='text-[10.5px] text-slate-500 dark:text-muted-foreground'>
                          {c.email}
                        </span>
                      </button>
                    </li>
                  ))}
                {q.trim().length >= 2 && !users.isLoading && !users.data?.length && (
                  <li className='px-2 py-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    No active person matches.
                  </li>
                )}
              </ul>
            </>
          )}
        </div>
      )}
    </span>
  )
}

/** Seats, team places, manual owner rows and tasks — one line each, with what it is and who else holds it. */
function PlatformEntries({
  userId,
  source,
  entries,
  onChanged
}: {
  userId: string
  source: LinkSource
  entries: PlatformEntry[]
  onChanged: () => void
}) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const { open: openItem } = useItemNavigation()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const removable = source.key !== 'builtin:tasks'
  const ids = [...picked]
  const allPicked = entries.length > 0 && picked.size === entries.length
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const remove = async () => {
    setBusy(true)
    try {
      const r = await client.request<{ data: { removed: number; failed: unknown[] } }>(
        post(`/inactive-user-links/${userId}/remove`, { source: source.key, ids })
      )
      setNote(
        `${n(r.data.removed)} removed${r.data.failed.length ? ` · ${n(r.data.failed.length)} refused` : ''}`
      )
      setPicked(new Set())
      setConfirmRemove(false)
      onChanged()
    } catch (e) {
      setNote((e as { response?: { error?: string } }).response?.error ?? (e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!entries.length)
    return (
      <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>Nothing to list.</p>
    )
  const soleCount = entries.filter((e) => e.sole).length
  return (
    <div data-inactive-entries={source.key}>
      <div className='mb-1 flex min-h-7 flex-wrap items-center gap-2 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
        <label className='flex cursor-pointer items-center gap-1.5'>
          <input
            type='checkbox'
            checked={allPicked}
            onChange={() => setPicked(allPicked ? new Set() : new Set(entries.map((e) => e.id)))}
            className='h-3.5 w-3.5 accent-slate-700'
            data-inactive-entries-all
          />
          {picked.size ? `${n(picked.size)} picked` : 'Pick all'}
        </label>
        {soleCount > 0 && (
          <span className='rounded bg-[#ffe4e6] px-1.5 py-0.5 text-[10.5px] font-medium text-[#9f1239] dark:bg-[#3d1a20] dark:text-[#f4a3ad]'>
            {n(soleCount)} with nobody else who can act
          </span>
        )}
        {note && <span className='text-emerald-700 dark:text-emerald-400'>{note}</span>}
        {picked.size > 0 && (
          <span className='ml-auto flex items-center gap-1.5'>
            <Reassign
              userId={userId}
              source={source}
              count={picked.size}
              ids={ids}
              label={`Hand ${n(picked.size)} to…`}
              onDone={() => {
                setPicked(new Set())
                onChanged()
              }}
            />
            {removable &&
              (confirmRemove ? (
                <>
                  <button
                    type='button'
                    onClick={remove}
                    disabled={busy}
                    data-inactive-remove-confirm
                    className='h-[22px] rounded-md bg-[#be123c] px-2 text-[11px] font-medium text-white disabled:opacity-60'
                  >
                    {busy ? 'Removing…' : `Remove ${n(picked.size)}, no successor`}
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirmRemove(false)}
                    className='text-[11px] text-slate-600 hover:text-slate-900 dark:text-muted-foreground'
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  onClick={() => setConfirmRemove(true)}
                  data-inactive-remove
                  className='rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:border-[#be123c] hover:text-[#be123c] dark:border-border dark:bg-card dark:text-muted-foreground'
                >
                  Remove…
                </button>
              ))}
          </span>
        )}
      </div>
      <ul className='divide-y divide-slate-100 rounded-md border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
        {entries.map((e) => {
          const consolePath = e.console_path
            ? nav.consoleUrl
              ? nav.consoleUrl(e.console_path)
              : e.console_path
            : null
          return (
            <li
              key={e.id}
              className='flex items-start gap-2 px-2.5 py-1.5'
              data-inactive-entry={e.id}
            >
              <input
                type='checkbox'
                checked={picked.has(e.id)}
                onChange={() => toggle(e.id)}
                aria-label={`Pick ${e.title}`}
                className='mt-0.5 h-3.5 w-3.5 shrink-0 accent-slate-700'
              />
              <div className='min-w-0 flex-1'>
                <div className='flex flex-wrap items-baseline gap-x-2'>
                  {e.record ? (
                    <button
                      type='button'
                      onClick={() =>
                        e.record &&
                        openItem({ collection: e.record.collection, itemId: e.record.id })
                      }
                      className='text-left text-[12px] font-medium text-slate-900 underline decoration-dotted underline-offset-2 dark:text-foreground'
                    >
                      {e.title}
                    </button>
                  ) : consolePath ? (
                    <button
                      type='button'
                      onClick={() =>
                        /^https?:/.test(consolePath)
                          ? window.open(consolePath, '_blank')
                          : nav.navigate(consolePath)
                      }
                      className='text-left text-[12px] font-medium text-slate-900 underline decoration-dotted underline-offset-2 dark:text-foreground'
                    >
                      {e.title}
                    </button>
                  ) : (
                    <span className='text-[12px] font-medium text-slate-900 dark:text-foreground'>
                      {e.title}
                    </span>
                  )}
                  <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {e.facts.join(' · ')}
                  </span>
                </div>
                {e.subtitle && (
                  <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                    {e.subtitle}
                  </p>
                )}
                {(source.key === 'builtin:owner_seats' || source.key === 'builtin:teams') && (
                  <p
                    className={cn(
                      'text-[11px]',
                      e.sole
                        ? 'font-medium text-[#9f1239] dark:text-[#f4a3ad]'
                        : 'text-slate-500 dark:text-muted-foreground'
                    )}
                  >
                    {e.sole
                      ? 'Nobody else who can act holds this — records here resolve no owner.'
                      : `Also held by ${e.others.slice(0, 4).join(', ')}${e.others.length > 4 ? ` +${e.others.length - 4}` : ''}${e.others.length ? '' : 'a linked team'}`}
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
