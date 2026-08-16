import {
  type ManagedUser,
  type UserScopesInfo,
  deleteNotificationSubscription,
  listNotificationSubscriptions,
  readItems,
  readMyScopes,
  readUser,
  readUserCard,
  saveMyScopeDefaults,
  setMyDelegate,
  updateNotificationSubscription,
  updateUser
} from '@nivaro/sdk'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BellRing,
  Building2,
  Filter as FilterIcon,
  Camera,
  Check,
  Clock,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  Phone,
  ShieldCheck,
  Trash2,
  Undo2,
  UserRound
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useItemEditAuth, useNivaroClient } from '../context'
import { get, patch } from '../lib/commands'
import { cn } from '../lib/utils'
import { RelationCombobox } from './item-edit/RelationCombobox'

/**
 * ProfileView — user profile for headless hosts (and reusable by admin).
 *
 * Own profile (userId omitted or equal to the authenticated user) is editable:
 * identity fields, avatar upload, out-of-office delegation, notification
 * subscriptions, two-factor and API-token security. Other users render the
 * public card (same fields as UserChip, laid out as a full page).
 *
 * Server enforcement: nivaro's /users/:id PATCH allow-list — everything here
 * is curation over already-permitted API calls.
 */

interface UserCard {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  title: string | null
  phone: string | null
  department: string | null
  company: string | null
  avatar: string | null
  status: string
  last_access: string | null
  is_out_of_office: boolean
  role_name: string | null
  manager_name: string | null
  manager_id: string | null
}

interface SubscriptionRow {
  id: number
  label: string | null
  collection: string | null
  event_type: string
  digest_frequency: string | null
  is_active: boolean
  filter_field?: string | null
  filter_value?: string | null
}

const fullName = (u: { first_name?: string | null; last_name?: string | null; email?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.email ?? 'Unknown')

const initials = (u: { first_name?: string | null; last_name?: string | null; email?: string }) =>
  (
    `${u.first_name?.[0] ?? ''}${u.last_name?.[0] ?? ''}` ||
    (u.email ?? '?').slice(0, 2)
  ).toUpperCase()

function SectionCard({
  icon,
  title,
  hint,
  children,
  actions
}: {
  icon: React.ReactNode
  title: string
  hint?: string
  children: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <header className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
        <span className='text-nvr-navy dark:text-nvr-cyan'>{icon}</span>
        <h3 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>{title}</h3>
        {hint && <p className='hidden text-[11px] text-slate-500 dark:text-slate-400 sm:block'>{hint}</p>}
        <span className='ml-auto'>{actions}</span>
      </header>
      <div className='p-4'>{children}</div>
    </section>
  )
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  hint,
  inputClassName
}: {
  label: string
  value: string
  onChange?: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  hint?: string
  inputClassName?: string
}) {
  return (
    <label className='block'>
      <span className='mb-1 flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
        {label}
        {hint && <span className='normal-case tracking-normal text-slate-400 dark:text-slate-500'>{hint}</span>}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 outline-none transition-colors focus:border-nvr-cyan focus-visible:ring-2 focus-visible:ring-nvr-cyan/25 dark:border-border dark:bg-background dark:text-slate-200',
          disabled && 'cursor-not-allowed bg-slate-50 text-slate-400 dark:bg-muted/40 dark:text-slate-500',
          inputClassName
        )}
      />
    </label>
  )
}

/** One switch vocabulary for the whole page. */
function Toggle({
  on,
  onChange,
  label,
  tone = 'cyan'
}: {
  on: boolean
  onChange: () => void
  label: string
  tone?: 'cyan' | 'amber'
}) {
  return (
    <button
      type='button'
      role='switch'
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
      className={cn(
        'relative h-[18px] w-8 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/40',
        on ? (tone === 'amber' ? 'bg-amber-400' : 'bg-nvr-cyan') : 'bg-slate-200 dark:bg-muted'
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-150',
          on ? 'left-[15px]' : 'left-0.5'
        )}
      />
    </button>
  )
}

/** Two-step destructive button: first click arms, second confirms; disarms after 3s. */
function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Confirm?',
  className,
  armedClassName,
  title
}: {
  onConfirm: () => void
  children: React.ReactNode
  confirmLabel?: React.ReactNode
  className?: string
  armedClassName?: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 3000)
    return () => window.clearTimeout(t)
  }, [armed])
  return (
    <button
      type='button'
      title={title}
      aria-label={title}
      onClick={() => {
        if (armed) {
          setArmed(false)
          onConfirm()
        } else {
          setArmed(true)
        }
      }}
      className={cn(className, armed && armedClassName)}
    >
      {armed ? confirmLabel : children}
    </button>
  )
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>{label}</p>
      <div className='mt-0.5 text-[12.5px] text-slate-700 dark:text-slate-200'>{children}</div>
    </div>
  )
}


// ── Email delivery (instant vs daily action digest) ─────────────────────────

function EmailDeliveryCard() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: prefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>)
  })
  const mode = prefs?.email_digest === 'daily' ? 'daily' : 'instant'
  const save = useMutation({
    mutationFn: (email_digest: 'instant' | 'daily') =>
      client.request(patch('/users/me/preferences', { email_digest })),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
  })
  const Option = ({
    value,
    label,
    hint
  }: {
    value: 'instant' | 'daily'
    label: string
    hint: string
  }) => (
    <button
      type='button'
      onClick={() => save.mutate(value)}
      disabled={save.isPending}
      className={cn(
        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors',
        mode === value
          ? 'border-[#00ceff] bg-[#f0fbfe] dark:border-[#00ceff66] dark:bg-[#0b2530]'
          : 'border-slate-200 hover:border-slate-300 dark:border-border dark:hover:border-slate-600'
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border',
          mode === value ? 'border-[#00ceff]' : 'border-slate-300 dark:border-slate-600'
        )}
      >
        {mode === value && <span className='h-2 w-2 rounded-full bg-[#00ceff]' />}
      </span>
      <span>
        <span className='block text-[12.5px] font-semibold text-slate-700 dark:text-slate-200'>
          {label}
        </span>
        <span className='block text-[11.5px] text-slate-500 dark:text-slate-400'>{hint}</span>
      </span>
    </button>
  )
  return (
    <SectionCard
      icon={<Mail className='h-4 w-4' />}
      title='Email delivery'
      hint='How workflow and assignment emails reach you'
    >
      <div className='space-y-2'>
        <Option
          value='instant'
          label='Individual emails'
          hint='An email for every state change, assignment and review the moment it happens'
        />
        <Option
          value='daily'
          label='Daily action summary'
          hint='One morning email — all updates, items assigned to you, and invoices awaiting review'
        />
      </div>
    </SectionCard>
  )
}

// ── Default filters (user scopes — self-serve defaults) ─────────────────────

function ScopeDefaultsCard() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: scopes } = useQuery({
    queryKey: ['nvr-profile-scopes'],
    queryFn: () =>
      client.request(readMyScopes()).then((r) => (r as { data: UserScopesInfo }).data)
  })
  const save = useMutation({
    mutationFn: ({ dimension, values }: { dimension: string; values: Array<string | number> }) =>
      client.request(saveMyScopeDefaults(dimension, values)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['nvr-profile-scopes'] })
  })
  if (!scopes || scopes.dimensions.length === 0) return null
  return (
    <SectionCard
      icon={<FilterIcon className='h-4 w-4' />}
      title='Default filters'
      hint='Pre-selected in browsers and reports — clear anytime'
    >
      <div className='space-y-3'>
        {scopes.dimensions.map((d) => (
          <ScopeDimensionRow
            key={d.name}
            dimension={d}
            selected={scopes.defaults[d.name] ?? []}
            restricted={scopes.restricted[d.name]}
            onSave={(values) => save.mutate({ dimension: d.name, values })}
          />
        ))}
      </div>
    </SectionCard>
  )
}

function ScopeDimensionRow({
  dimension,
  selected,
  restricted,
  onSave
}: {
  dimension: UserScopesInfo['dimensions'][number]
  selected: Array<string | number>
  restricted?: Array<string | number>
  onSave: (values: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  const lf = dimension.display_field ?? 'name'
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const { data: options = [] } = useQuery({
    queryKey: ['nvr-scope-options', dimension.name],
    queryFn: async () => {
      const res = (await client.request(
        readItems(dimension.target_collection, {
          fields: ['id', lf],
          sort: dimension.options_sort ? [dimension.options_sort] : undefined,
          limit: 200
        })
      )) as { data: Array<Record<string, unknown>> }
      return (res.data ?? []).map((r) => ({ id: r.id as string | number, label: String(r[lf] ?? r.id) }))
    }
  })
  const restrictedSet = restricted?.length ? new Set(restricted.map(String)) : null
  const allowed = restrictedSet ? options.filter((o) => restrictedSet.has(String(o.id))) : options
  const sel = new Set(selected.map(String))

  // Big value spaces (projects, …) get a search-to-add picker instead of a
  // wall of pills; the search hits the server, so nothing is capped at the
  // first 200 options.
  const pickerMode = allowed.length > 24 || (options.length >= 200 && !restrictedSet)

  const { data: matches = [], isFetching: searching } = useQuery({
    queryKey: ['nvr-scope-search', dimension.name, q],
    queryFn: async () => {
      const res = (await client.request(
        readItems(dimension.target_collection, {
          fields: ['id', lf],
          filter: { [lf]: { _contains: q } } as never,
          sort: dimension.options_sort ? [dimension.options_sort] : undefined,
          limit: 30
        })
      )) as { data: Array<Record<string, unknown>> }
      const rows = (res.data ?? []).map((r) => ({
        id: r.id as string | number,
        label: String(r[lf] ?? r.id)
      }))
      return restrictedSet ? rows.filter((r) => restrictedSet.has(String(r.id))) : rows
    },
    enabled: pickerMode && q.trim().length > 0,
    placeholderData: (prev) => prev
  })

  // labels for selected values outside the loaded option page
  const known = new Map(options.map((o) => [String(o.id), o.label]))
  for (const m of matches) known.set(String(m.id), m.label)
  const missing = selected.filter((v) => !known.has(String(v)))
  const { data: extraLabels = [] } = useQuery({
    queryKey: ['nvr-scope-selected-labels', dimension.name, missing.map(String).sort().join(',')],
    queryFn: async () => {
      const res = (await client.request(
        readItems(dimension.target_collection, {
          fields: ['id', lf],
          filter: { id: { _in: missing } } as never,
          limit: 100
        })
      )) as { data: Array<Record<string, unknown>> }
      return (res.data ?? []).map((r) => ({ id: r.id as string | number, label: String(r[lf] ?? r.id) }))
    },
    enabled: missing.length > 0
  })
  for (const e of extraLabels) known.set(String(e.id), e.label)

  const toggle = (id: string | number) => {
    const on = sel.has(String(id))
    onSave(on ? selected.filter((v) => String(v) !== String(id)) : [...selected, id])
  }

  // Dropdown rows: initial page of options before any typing; while a server
  // search is in flight, narrow the loaded page client-side so the list never
  // flashes empty between keystrokes.
  const qNorm = q.trim().toLowerCase()
  const clientNarrowed = qNorm
    ? allowed.filter((o) => o.label.toLowerCase().includes(qNorm))
    : allowed
  const shown =
    qNorm.length === 0
      ? allowed.slice(0, 30)
      : searching && matches.length === 0
        ? clientNarrowed.slice(0, 30)
        : matches
  const listOpen = pickerMode && (focused || qNorm.length > 0)

  return (
    <div>
      <p className='mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
        {dimension.label}
        {restricted?.length ? (
          <span className='ml-1.5 normal-case tracking-normal text-amber-500'>
            (limited by your access)
          </span>
        ) : null}
        {selected.length > 0 && (
          <button
            type='button'
            onClick={() => onSave([])}
            className='ml-2 normal-case tracking-normal text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline'
          >
            clear {selected.length}
          </button>
        )}
      </p>

      {!pickerMode ? (
        <div className='flex flex-wrap gap-1'>
          {allowed.map((o) => {
            const on = sel.has(String(o.id))
            return (
              <button
                key={String(o.id)}
                type='button'
                onClick={() => toggle(o.id)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                  on
                    ? 'border-nvr-cyan bg-[#00ceff1a] font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border'
                )}
              >
                {o.label}
              </button>
            )
          })}
          {allowed.length === 0 && <span className='text-[11.5px] text-slate-400'>No options.</span>}
        </div>
      ) : (
        <div className='max-w-xl'>
          {selected.length > 0 && (
            <div className='mb-1.5 flex flex-wrap gap-1'>
              {selected.map((v) => (
                <span
                  key={String(v)}
                  className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan bg-[#00ceff1a] py-0.5 pl-2.5 pr-1 text-[11.5px] font-medium text-nvr-navy dark:text-nvr-cyan'
                >
                  {known.get(String(v)) ?? String(v)}
                  <button
                    type='button'
                    onClick={() => toggle(v)}
                    aria-label={`Remove ${known.get(String(v)) ?? v}`}
                    className='rounded-full px-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={`Search ${dimension.label.toLowerCase()} to add…`}
            className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
          />
          {listOpen && (
            <div
              onMouseDown={(e) => e.preventDefault()}
              className='mt-1 max-h-44 overflow-y-auto rounded-md border border-slate-200 dark:border-border'
            >
              {shown.map((m) => {
                const on = sel.has(String(m.id))
                return (
                  <button
                    key={String(m.id)}
                    type='button'
                    onClick={() => toggle(m.id)}
                    className={cn(
                      'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted',
                      on ? 'font-medium text-nvr-navy dark:text-nvr-cyan' : 'text-slate-600 dark:text-slate-300'
                    )}
                  >
                    <span className='truncate'>{m.label}</span>
                    <span className='pl-2 text-[11px] text-slate-400'>{on ? 'Remove' : 'Add'}</span>
                  </button>
                )
              })}
              {shown.length === 0 && (
                <p className='px-2.5 py-2 text-[11.5px] text-slate-400'>
                  {searching ? 'Searching…' : qNorm ? 'No matches.' : 'No options.'}
                </p>
              )}
              {qNorm.length === 0 && allowed.length > 30 && (
                <p className='border-t border-slate-100 px-2.5 py-1.5 text-[11px] text-slate-400 dark:border-border'>
                  Showing first 30 — type to narrow.
                </p>
              )}
            </div>
          )}
          {!listOpen && selected.length === 0 && (
            <p className='mt-1 text-[11px] text-slate-400'>
              No defaults set — click to browse or type to search.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Security: two-factor + API token ─────────────────────────────────────────

function SecurityCard() {
  // Two-factor is only offered where the instance actually enforces it.
  // Showing the setup flow on a deployment that never asks for a code invites
  // people to enrol in nothing and leaves them holding a dead authenticator
  // entry. Undefined while loading counts as ON so an enrolled user's panel
  // does not flicker away and back.
  const { data: instanceSettings } = useQuery({
    queryKey: ['nvr-settings-2fa'],
    queryFn: () =>
      client
        .request({ _method: 'GET', _path: '/settings/' } as never)
        .then((r) => (r as { data?: { two_factor_enabled?: boolean } })?.data ?? null)
        .catch(() => null),
    staleTime: 10 * 60_000
  })
  const twoFactorOffered = instanceSettings?.two_factor_enabled !== false
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [qr, setQr] = useState<{ qr: string; secret: string } | null>(null)
  const [token, setToken] = useState('')
  const [newApiToken, setNewApiToken] = useState<string | null>(null)

  const { data: totp } = useQuery({
    queryKey: ['nvr-profile-totp'],
    queryFn: () =>
      client
        .request({ _method: 'GET', _path: '/two-factor/status' } as never)
        .then((r) => (r as { data: { enabled: boolean } }).data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nvr-profile-totp'] })

  const setup = useMutation({
    mutationFn: () =>
      client
        .request({ _method: 'POST', _path: '/two-factor/setup' } as never)
        .then((r) => (r as { data: { qr: string; secret: string } }).data),
    onSuccess: (d) => setQr(d)
  })
  const verify = useMutation({
    mutationFn: (t: string) =>
      client.request({ _method: 'POST', _path: '/two-factor/verify', _body: { token: t } } as never),
    onSuccess: () => {
      setQr(null)
      setToken('')
      invalidate()
    }
  })
  const disable = useMutation({
    mutationFn: (t: string) =>
      client.request({
        _method: 'POST',
        _path: '/two-factor/disable',
        _body: { token: t }
      } as never),
    onSuccess: () => {
      setToken('')
      invalidate()
    }
  })
  const createToken = useMutation({
    mutationFn: () =>
      client
        .request({ _method: 'POST', _path: '/users/me/token' } as never)
        .then((r) => (r as { data: { token: string } }).data),
    onSuccess: (d) => setNewApiToken(d.token)
  })
  const revokeToken = useMutation({
    mutationFn: () => client.request({ _method: 'DELETE', _path: '/users/me/token' } as never),
    onSuccess: () => setNewApiToken(null)
  })
  const logoutAll = useMutation({
    mutationFn: () => client.request({ _method: 'POST', _path: '/auth/logout-all' } as never),
    onSuccess: () => window.location.assign('/login')
  })

  return (
    <SectionCard
      icon={<ShieldCheck className='h-4 w-4' />}
      title='Security'
      hint={twoFactorOffered ? 'Two-factor sign-in and API access' : 'API access'}
    >
      <div className='space-y-4'>
        {/* Hidden entirely when the instance does not use two-factor —
            an inert setup flow is worse than no panel. */}
        {twoFactorOffered && (
        <div>
          <div className='flex items-center gap-2'>
            <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
              Two-factor authentication
            </p>
            <span
              className={cn(
                'rounded-full px-1.5 py-px text-[10px] font-semibold',
                totp?.enabled
                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                  : 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400'
              )}
            >
              {totp?.enabled ? 'Enabled' : 'Off'}
            </span>
          </div>
          {!totp?.enabled && !qr && (
            <button
              type='button'
              onClick={() => setup.mutate()}
              className='mt-2 h-8 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-slate-300 dark:hover:text-nvr-cyan'
            >
              {setup.isPending ? 'Preparing…' : 'Set up 2FA'}
            </button>
          )}
          {qr && (
            <div className='mt-3 flex flex-wrap items-start gap-4'>
              <img
                src={qr.qr}
                alt='Scan with your authenticator app'
                className='h-32 w-32 rounded-md border border-slate-200 dark:border-border'
              />
              <div className='min-w-[200px] flex-1 space-y-2'>
                <p className='text-[12px] text-slate-500'>
                  Scan with your authenticator app, then enter the 6-digit code to confirm.
                </p>
                <div className='flex gap-1.5'>
                  <input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder='123456'
                    inputMode='numeric'
                    className='h-8 w-[110px] rounded-md border border-slate-200 px-2.5 text-center text-[13px] tabular-nums tracking-widest dark:border-border dark:bg-background'
                  />
                  <button
                    type='button'
                    disabled={token.trim().length < 6 || verify.isPending}
                    onClick={() => verify.mutate(token.trim())}
                    className='h-8 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
                  >
                    Confirm
                  </button>
                </div>
              </div>
            </div>
          )}
          {totp?.enabled && (
            <div className='mt-2 flex gap-1.5'>
              <input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder='Code to disable'
                inputMode='numeric'
                className='h-8 w-[130px] rounded-md border border-slate-200 px-2.5 text-[12px] dark:border-border dark:bg-background'
              />
              <button
                type='button'
                disabled={token.trim().length < 6 || disable.isPending}
                onClick={() => disable.mutate(token.trim())}
                className='h-8 rounded-md border border-red-200 px-3 text-[12px] font-medium text-red-500 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/30 dark:hover:bg-red-500/10'
              >
                {disable.isPending ? 'Disabling…' : 'Disable'}
              </button>
            </div>
          )}
        </div>
        )}

        {/* The rule separates this from two-factor above — with that hidden
            it would be a stray line across the top of the card. */}
        <div
          className={
            twoFactorOffered ? 'border-t border-slate-100 pt-3 dark:border-border/60' : undefined
          }
        >
          <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>API token</p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Personal Bearer token for scripts and integrations. Shown once — creating a new one
            replaces the old.
          </p>
          {newApiToken && (
            <code className='mt-2 block select-all break-all rounded-md bg-slate-50 px-2.5 py-2 font-mono text-[11.5px] text-nvr-navy dark:bg-muted dark:text-nvr-cyan'>
              {newApiToken}
            </code>
          )}
          <div className='mt-2 flex gap-1.5'>
            <button
              type='button'
              onClick={() => createToken.mutate()}
              className='h-8 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:text-slate-300 dark:hover:text-nvr-cyan'
            >
              {createToken.isPending ? 'Generating…' : 'Generate token'}
            </button>
            <ConfirmButton
              title='Revoke API token'
              onConfirm={() => revokeToken.mutate()}
              confirmLabel='Revoke token?'
              className='h-8 rounded-md px-3 text-[12px] font-medium text-slate-400 transition-colors hover:text-red-500'
              armedClassName='font-semibold text-red-500'
            >
              Revoke
            </ConfirmButton>
          </div>
        </div>

        <div className='border-t border-slate-100 pt-3 dark:border-border/60'>
          <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>Sessions</p>
          <p className='mt-0.5 text-[11.5px] text-slate-400'>
            Signs you out on every device and browser, including this one.
          </p>
          <ConfirmButton
            title='Sign out everywhere'
            onConfirm={() => logoutAll.mutate()}
            confirmLabel='Sign out everywhere?'
            className='mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 transition-colors hover:border-red-300 hover:text-red-500 dark:border-border dark:text-slate-300 dark:hover:border-red-500/40 dark:hover:text-red-400'
            armedClassName='border-red-300 font-semibold text-red-500 dark:border-red-500/40 dark:text-red-400'
          >
            <LogOut className='h-3.5 w-3.5' />
            {logoutAll.isPending ? 'Signing out…' : 'Sign out everywhere'}
          </ConfirmButton>
        </div>
      </div>
    </SectionCard>
  )
}

// ── Notification subscriptions ───────────────────────────────────────────────

function SubscriptionsCard() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: subs = [] } = useQuery({
    queryKey: ['nvr-profile-subs'],
    queryFn: () =>
      client
        .request(listNotificationSubscriptions())
        .then((r) => (r as { data: SubscriptionRow[] }).data)
  })
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['nvr-profile-subs'] })
  const toggle = useMutation({
    mutationFn: (s: SubscriptionRow) =>
      client.request(updateNotificationSubscription(s.id, { is_active: !s.is_active })),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: number) => client.request(deleteNotificationSubscription(id)),
    onSuccess: invalidate
  })

  return (
    <SectionCard
      icon={<BellRing className='h-4 w-4' />}
      title='Notification subscriptions'
      hint='What you get notified about'
    >
      {subs.length === 0 ? (
        <p className='text-[12px] text-slate-400'>
          No subscriptions yet — subscribe from a record, queue, or the notification settings page.
        </p>
      ) : (
        <div className='space-y-1'>
          {subs.map((s) => (
            <div
              key={s.id}
              className='flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-muted/40'
            >
              <Toggle
                on={s.is_active}
                onChange={() => toggle.mutate(s)}
                label={`${s.is_active ? 'Mute' : 'Unmute'} ${s.label ?? s.event_type}`}
              />
              <div className='min-w-0 flex-1'>
                <p
                  className={cn(
                    'truncate text-[12.5px]',
                    s.is_active
                      ? 'text-slate-700 dark:text-slate-200'
                      : 'text-slate-400 line-through'
                  )}
                >
                  {s.label || `${s.collection ?? 'Queue'} · ${s.event_type}`}
                </p>
                <p className='text-[10.5px] text-slate-400'>
                  {s.collection ?? 'queue'} · {s.event_type}
                  {s.filter_value ? ` · ${s.filter_value}` : ''} ·{' '}
                  {s.digest_frequency ?? 'instant'}
                </p>
              </div>
              <ConfirmButton
                title='Remove subscription'
                onConfirm={() => remove.mutate(s.id)}
                confirmLabel={<span className='text-[11px] font-semibold'>Remove?</span>}
                className='shrink-0 rounded p-1 text-slate-300 transition-colors hover:text-red-500 dark:text-slate-500'
                armedClassName='px-1.5 text-red-500'
              >
                <Trash2 className='h-3.5 w-3.5' />
              </ConfirmButton>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  )
}

// ── Out of office / delegation ───────────────────────────────────────────────

function DelegationCard({ user, onSaved }: { user: ManagedUser; onSaved: () => void }) {
  const client = useNivaroClient()
  const [ooo, setOoo] = useState(!!user.is_out_of_office)
  const [delegate, setDelegate] = useState<string | null>(user.delegate_id ?? null)
  const [expires, setExpires] = useState(
    user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : ''
  )
  const dirty =
    ooo !== !!user.is_out_of_office ||
    (delegate ?? null) !== (user.delegate_id ?? null) ||
    expires !== (user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : '')

  const save = useMutation({
    mutationFn: () =>
      client.request(
        setMyDelegate({
          is_out_of_office: ooo,
          delegate_id: delegate,
          delegate_expires_at: expires ? new Date(`${expires}T23:59:59`).toISOString() : null
        })
      ),
    onSuccess: onSaved
  })

  const reset = () => {
    setOoo(!!user.is_out_of_office)
    setDelegate(user.delegate_id ?? null)
    setExpires(user.delegate_expires_at ? String(user.delegate_expires_at).slice(0, 10) : '')
  }

  const untilLabel = expires
    ? new Date(`${expires}T12:00:00`).toLocaleDateString(undefined, {
        month: 'long',
        day: 'numeric'
      })
    : null

  return (
    <SectionCard
      icon={<UserRound className='h-4 w-4' />}
      title='Out of office'
      hint='Route your approvals to a delegate while you are away'
      actions={
        dirty && (
          <span className='flex items-center gap-1.5'>
            <button
              type='button'
              title='Discard changes'
              onClick={reset}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
            >
              <Undo2 className='h-3 w-3' /> Reset
            </button>
            <button
              type='button'
              disabled={save.isPending}
              onClick={() => save.mutate()}
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-50'
            >
              {save.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <Check className='h-3 w-3' />} Save
            </button>
          </span>
        )
      }
    >
      {/* State first: one clear switch line, config below it. */}
      <label className='flex cursor-pointer items-center justify-between gap-3'>
        <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
          I'm out of office
        </span>
        <Toggle on={ooo} onChange={() => setOoo((v) => !v)} label="I'm out of office" tone='amber' />
      </label>

      <div className='mt-3 grid gap-3 border-t border-slate-100 pt-3 dark:border-border/60 sm:grid-cols-2'>
        <div>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Delegate
          </span>
          <RelationCombobox
            collection='nivaro_users'
            value={delegate}
            onChange={(v) => setDelegate(v == null ? null : String(v))}
            placeholder='Pick a delegate…'
          />
        </div>
        {/* h-9 matches the RelationCombobox trigger beside it */}
        <Field
          label='Until'
          hint='optional'
          type='date'
          value={expires}
          onChange={setExpires}
          inputClassName='h-9'
        />
      </div>

      <p
        className={cn(
          'mt-3 text-[11.5px] leading-relaxed',
          ooo && !delegate
            ? 'rounded-md bg-amber-50 px-2.5 py-1.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
            : 'text-slate-400 dark:text-slate-500'
        )}
      >
        {ooo && !delegate
          ? 'No delegate picked — approvals will wait for you until you return.'
          : ooo
            ? `Workflow ownership and approvals route to your delegate${untilLabel ? ` through ${untilLabel}` : ' until you turn this off'}.`
            : 'When enabled, workflow ownership and approvals resolve to your delegate.'}
      </p>
    </SectionCard>
  )
}

// ── The page ─────────────────────────────────────────────────────────────────

export function ProfileView({ userId, className }: { userId?: string | null; className?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const auth = useItemEditAuth()
  const isOwn = !userId || (auth?.userId != null && String(auth.userId) === String(userId))
  const targetId = isOwn ? 'me' : (userId as string)

  const { data: me } = useQuery({
    queryKey: ['nvr-profile-user', targetId],
    queryFn: () =>
      client.request(readUser(targetId as never)).then((r) => (r as { data: ManagedUser }).data),
    enabled: isOwn
  })
  const cardId = isOwn ? (me?.id ?? null) : (userId as string)
  const { data: card } = useQuery({
    queryKey: ['nvr-profile-card', cardId],
    queryFn: () =>
      client.request(readUserCard(cardId as string)).then((r) => (r as unknown as { data: UserCard }).data),
    enabled: !!cardId
  })

  // editable identity draft
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  const base = useMemo(
    () => ({
      first_name: me?.first_name ?? '',
      last_name: me?.last_name ?? '',
      title: (me as { title?: string | null })?.title ?? '',
      department: (me as { department?: string | null })?.department ?? '',
      phone: (me as { phone?: string | null })?.phone ?? ''
    }),
    [me]
  )
  const d = draft ?? base
  const dirty = JSON.stringify(d) !== JSON.stringify(base)

  const saveIdentity = useMutation({
    mutationFn: () => client.request(updateUser((me as ManagedUser).id, d as never)),
    onSuccess: () => {
      setDraft(null)
      void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
      void qc.invalidateQueries({ queryKey: ['nvr-profile-card'] })
    }
  })

  const fileRef = useRef<HTMLInputElement | null>(null)
  const uploadAvatar = useMutation({
    mutationFn: async (file: File) => {
      const up = await client.upload(file, { title: `avatar-${me?.id}` })
      await client.request(updateUser((me as ManagedUser).id, { avatar: up.id } as never))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
      void qc.invalidateQueries({ queryKey: ['nvr-profile-card'] })
    }
  })

  const view: UserCard | null =
    card ?? (me ? ({ ...me, role_name: null, manager_name: null } as unknown as UserCard) : null)
  if (!view) {
    // Skeleton mirrors the real layout: header band + two card columns.
    return (
      <div className={cn('flex animate-pulse flex-col gap-4', className)} aria-busy='true'>
        <div className='flex items-center gap-5 rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
          <div className='h-[76px] w-[76px] rounded-full bg-slate-100 dark:bg-muted' />
          <div className='flex-1 space-y-2.5'>
            <div className='h-5 w-48 rounded bg-slate-100 dark:bg-muted' />
            <div className='h-3.5 w-72 max-w-full rounded bg-slate-100 dark:bg-muted' />
            <div className='h-3.5 w-56 max-w-full rounded bg-slate-100 dark:bg-muted' />
          </div>
        </div>
        <div className='grid gap-4 lg:grid-cols-2'>
          <div className='h-64 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card' />
          <div className='h-64 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card' />
        </div>
      </div>
    )
  }

  const avatarId = (isOwn ? (me as { avatar?: string | null })?.avatar : view.avatar) ?? null
  const active = view.status === 'active'

  return (
    <div className={cn('flex flex-col gap-4', className)} data-nvr-profile>
      {/* Header band */}
      <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-x-5 gap-y-4 p-5'>
          <div className='relative'>
            {avatarId ? (
              <img
                src={`/api/files/${avatarId}`}
                alt=''
                className='h-[76px] w-[76px] rounded-full border border-slate-200 object-cover dark:border-border'
              />
            ) : (
              <span className='flex h-[76px] w-[76px] items-center justify-center rounded-full bg-[#c7f0fb] text-[24px] font-semibold text-[#04516b] dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
                {initials(view)}
              </span>
            )}
            <span
              className={cn(
                'absolute bottom-0.5 right-0.5 h-3 w-3 rounded-full border-2 border-white dark:border-card',
                active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
              )}
              title={active ? 'Active' : view.status}
            />
            {isOwn && (
              <>
                <button
                  type='button'
                  title='Change photo'
                  aria-label='Change photo'
                  onClick={() => fileRef.current?.click()}
                  className='absolute -right-1 -top-1 flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm transition-colors hover:border-nvr-cyan hover:text-nvr-navy dark:border-border dark:bg-background dark:text-slate-300 dark:hover:text-nvr-cyan'
                >
                  {uploadAvatar.isPending ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Camera className='h-3.5 w-3.5' />
                  )}
                </button>
                <input
                  ref={fileRef}
                  type='file'
                  accept='image/*'
                  className='hidden'
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) uploadAvatar.mutate(f)
                    e.target.value = ''
                  }}
                />
              </>
            )}
          </div>

          <div className='min-w-0 flex-1'>
            <div className='flex flex-wrap items-center gap-2'>
              <h1 className='text-[21px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-white'>
                {fullName(view)}
              </h1>
              {view.role_name && (
                <span className='rounded-full bg-[#00ceff1a] px-2 py-px text-[10.5px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                  {view.role_name}
                </span>
              )}
              {view.is_out_of_office && (
                <span className='rounded-full bg-amber-50 px-2 py-px text-[10.5px] font-semibold text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'>
                  Out of office
                </span>
              )}
            </div>
            {(view.title || view.department) && (
              <p className='mt-0.5 truncate text-[13px] text-slate-500 dark:text-slate-400'>
                {[view.title, view.department].filter(Boolean).join(' · ')}
              </p>
            )}
            <div className='mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-slate-500 dark:text-slate-400'>
              {view.company && (
                <span className='inline-flex items-center gap-1.5'>
                  <Building2 className='h-3.5 w-3.5' /> {view.company}
                </span>
              )}
              <a
                href={`mailto:${view.email}`}
                className='inline-flex items-center gap-1.5 transition-colors hover:text-nvr-navy dark:hover:text-nvr-cyan'
              >
                <Mail className='h-3.5 w-3.5' /> {view.email}
              </a>
              {view.phone && (
                <a
                  href={`tel:${view.phone}`}
                  className='inline-flex items-center gap-1.5 transition-colors hover:text-nvr-navy dark:hover:text-nvr-cyan'
                >
                  <Phone className='h-3.5 w-3.5' /> {view.phone}
                </a>
              )}
              {view.last_access && (
                <span className='inline-flex items-center gap-1.5' title='Last active'>
                  <Clock className='h-3.5 w-3.5' />
                  {new Date(view.last_access).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric'
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {isOwn && me ? (
        <div className='grid gap-4 lg:grid-cols-2'>
          <div className='space-y-4'>
            <SectionCard
              icon={<UserRound className='h-4 w-4' />}
              title='About you'
              hint='Shown on your contact card across the app'
              actions={
                dirty && (
                  <span className='flex items-center gap-1.5'>
                    <button
                      type='button'
                      title='Discard changes'
                      onClick={() => setDraft(null)}
                      className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
                    >
                      <Undo2 className='h-3 w-3' /> Reset
                    </button>
                    <button
                      type='button'
                      disabled={saveIdentity.isPending}
                      onClick={() => saveIdentity.mutate()}
                      className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-50'
                    >
                      {saveIdentity.isPending ? (
                        <Loader2 className='h-3 w-3 animate-spin' />
                      ) : (
                        <Check className='h-3 w-3' />
                      )}{' '}
                      Save
                    </button>
                  </span>
                )
              }
            >
              <div className='grid gap-3 sm:grid-cols-2'>
                <Field
                  label='First name'
                  value={d.first_name}
                  onChange={(v) => setDraft({ ...d, first_name: v })}
                />
                <Field
                  label='Last name'
                  value={d.last_name}
                  onChange={(v) => setDraft({ ...d, last_name: v })}
                />
                <Field
                  label='Title'
                  value={d.title}
                  onChange={(v) => setDraft({ ...d, title: v })}
                  placeholder='e.g. Construction Manager'
                />
                <Field
                  label='Department'
                  value={d.department}
                  onChange={(v) => setDraft({ ...d, department: v })}
                />
                <Field
                  label='Phone'
                  value={d.phone}
                  onChange={(v) => setDraft({ ...d, phone: v })}
                  placeholder='+1 …'
                  type='tel'
                />
                <Field label='Email' value={me.email ?? ''} disabled hint='managed by admin' />
              </div>
            </SectionCard>
            <DelegationCard
              user={me}
              onSaved={() => {
                void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
                void qc.invalidateQueries({ queryKey: ['nvr-profile-card'] })
              }}
            />
            <ScopeDefaultsCard />
            <EmailDeliveryCard />
          </div>
          <div className='space-y-4'>
            <SubscriptionsCard />
            <SecurityCard />
          </div>
        </div>
      ) : (
        <div className='grid gap-4 lg:grid-cols-2'>
          <SectionCard icon={<UserRound className='h-4 w-4' />} title='Details'>
            <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-3'>
              <Meta label='Department'>{view.department ?? '—'}</Meta>
              <Meta label='Title'>{view.title ?? '—'}</Meta>
              <Meta label='Role'>{view.role_name ?? '—'}</Meta>
              <Meta label='Manager'>{view.manager_name ?? '—'}</Meta>
              <Meta label='Status'>{view.status}</Meta>
              <Meta label='Last active'>
                {view.last_access ? new Date(view.last_access).toLocaleString() : 'Never'}
              </Meta>
            </div>
          </SectionCard>
          <SectionCard icon={<KeyRound className='h-4 w-4' />} title='Reach out'>
            <div className='flex flex-wrap gap-2'>
              <a
                href={`mailto:${view.email}`}
                className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white'
              >
                <Mail className='h-3.5 w-3.5' /> Email {view.first_name ?? ''}
              </a>
              {view.phone && (
                <a
                  href={`tel:${view.phone}`}
                  className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 px-3 text-[12px] font-medium text-slate-600 dark:border-border dark:text-slate-300'
                >
                  <Phone className='h-3.5 w-3.5' /> Call
                </a>
              )}
            </div>
            {view.is_out_of_office && (
              <p className='mt-3 rounded-md bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'>
                {view.first_name ?? 'This user'} is currently out of office
                {view.manager_name ? ` — try ${view.manager_name}` : ''}.
              </p>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  )
}
