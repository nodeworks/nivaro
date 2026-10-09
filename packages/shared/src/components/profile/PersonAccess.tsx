import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookUser,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, patch, post, put } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { SimpleSelect } from '../ui/SimpleSelect'
import { ConfirmButton, EmptyLine, SectionCard } from './primitives'
import { errorText, type PersonProfile, useInvalidatePerson } from './types'

// ─── Access: role · status · account kind ────────────────────────────────────

const ACCOUNT_KINDS = [
  { value: '', label: 'Person' },
  { value: 'integration', label: 'Integration — an external system writes as it' },
  { value: 'service', label: 'Service login' },
  { value: 'bot', label: 'Bot' },
  { value: 'placeholder', label: 'Placeholder — kept so old references resolve' }
]

export function AccessCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const invalidate = useInvalidatePerson(p.id)
  const { data: roles = [] } = useQuery<
    Array<{ id: string; name: string; admin_access?: boolean }>
  >({
    queryKey: ['nvr-roles'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string; admin_access?: boolean }> }>(
          get('/roles')
        )
        .then((r) => r.data),
    staleTime: 5 * 60_000
  })
  const base = useMemo(
    () => ({
      role: p.role_id ?? '',
      status: p.status,
      account_kind: p.admin?.account_kind ?? ''
    }),
    [p]
  )
  const [draft, setDraft] = useState<typeof base | null>(null)
  const d = draft ?? base
  const dirty = JSON.stringify(d) !== JSON.stringify(base)
  const save = useMutation({
    mutationFn: () =>
      client.request(
        patch(`/users/${p.id}`, {
          role: d.role || null,
          status: d.status,
          account_kind: d.account_kind || null
        })
      ),
    onSuccess: () => {
      setDraft(null)
      invalidate()
      toast.success('Access saved')
    },
    onError: (e) => toast.error(errorText(e, 'Could not save access'))
  })
  const roleOptions = [
    { value: '', label: 'No role' },
    ...roles.map((r) => ({ value: r.id, label: r.admin_access ? `${r.name} · admin` : r.name }))
  ]
  return (
    <SectionCard
      icon={<ShieldCheck className='h-4 w-4' />}
      title='Access'
      hint='Role decides what they can do; status decides whether they can sign in'
      testId='access'
      actions={
        dirty && (
          <span className='flex items-center gap-1.5'>
            <button
              type='button'
              onClick={() => setDraft(null)}
              className='inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11.5px] font-medium text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-200'
            >
              <Undo2 className='h-3 w-3' /> Reset
            </button>
            <button
              type='button'
              disabled={save.isPending}
              onClick={() => save.mutate()}
              data-person-access-save
              className='inline-flex h-7 items-center gap-1 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white transition-opacity disabled:opacity-50'
            >
              {save.isPending ? (
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
        <div className='block'>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Role
          </span>
          <SimpleSelect
            ariaLabel='Role'
            value={d.role}
            onChange={(v) => setDraft({ ...d, role: v })}
            options={roleOptions}
            className='h-8 text-[12.5px]'
          />
        </div>
        <div className='block'>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Status
          </span>
          <SimpleSelect
            ariaLabel='Status'
            value={d.status}
            onChange={(v) => setDraft({ ...d, status: v })}
            options={[
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'suspended', label: 'Suspended' }
            ]}
            className='h-8 text-[12.5px]'
          />
        </div>
        <div className='block sm:col-span-2'>
          <span className='mb-1 block text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400'>
            Account type
          </span>
          <SimpleSelect
            ariaLabel='Account type'
            value={d.account_kind}
            onChange={(v) => setDraft({ ...d, account_kind: v })}
            options={ACCOUNT_KINDS}
            className='h-8 text-[12.5px]'
          />
          <span className='mt-1 block text-[11px] text-slate-500 dark:text-slate-400'>
            Anything but Person is left out of people pickers, never checked against the company
            directory or retention, and its edits read as "integration" in field history.
          </span>
        </div>
      </div>
    </SectionCard>
  )
}

// ─── Suspension banner ───────────────────────────────────────────────────────

const SOURCE_LABEL: Record<string, string> = {
  directory: 'Directory sync',
  retention: 'Retention policy',
  offboarding: 'Offboarding',
  merge: 'Account merge',
  admin: 'Administrator',
  'legacy-redaction': 'Legacy redaction job',
  unknown: 'Unknown'
}

export function SuspensionBanner({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const suspended = p.status === 'suspended' || !!p.admin?.is_redacted
  const { data } = useQuery<{
    source: string
    text: string
    at: string | null
    by: { id: string; name: string } | null
  } | null>({
    queryKey: ['nvr-user-suspension', p.id],
    queryFn: () =>
      client
        .request<{ data: never }>(get(`/users/${p.id}/suspension`))
        .then((r) => r.data)
        .catch(() => null),
    enabled: suspended,
    staleTime: 60_000
  })
  if (!suspended || !data) return null
  return (
    <div
      className='rounded-lg border border-[#e9c46a] bg-[#fbefd9] px-4 py-3 text-[12.5px] text-[#6b4300] dark:border-[#7a5a14] dark:bg-[#3a2a0d] dark:text-[#f1b95c]'
      data-suspension-reason={data.source}
    >
      <p className='font-medium'>
        Cannot sign in — {SOURCE_LABEL[data.source] ?? data.source}
        {data.at ? ` · ${new Date(data.at).toLocaleString()}` : ''}
        {data.by ? ` · by ${data.by.name}` : ''}
      </p>
      <p className='mt-0.5'>{data.text}</p>
      <p className='mt-1 text-[11.5px] opacity-80'>
        Set Status back to Active to restore access; a redacted account also needs its details
        re-entered.
      </p>
    </div>
  )
}

// ─── Scopes (defaults + restrictions) ────────────────────────────────────────

interface ScopesInfo {
  dimensions: Array<{
    name: string
    label: string
    target_collection: string
    display_field: string | null
    options_sort: string | null
  }>
  defaults: Record<string, Array<string | number>>
  restricted: Record<string, Array<string | number>>
}

type Opt = { id: string | number; label: string }

function ValuePills({
  dimension,
  selected,
  accent,
  onToggle
}: {
  dimension: ScopesInfo['dimensions'][number]
  selected: Array<string | number>
  accent: 'cyan' | 'amber'
  onToggle: (values: Array<string | number>) => void
}) {
  const client = useNivaroClient()
  const lf = dimension.display_field ?? 'name'
  const [q, setQ] = useState('')
  const rowsToOpts = (rows: Array<Record<string, unknown>>): Opt[] =>
    rows.map((row) => ({ id: row.id as string | number, label: String(row[lf] ?? row.id) }))
  const { data: options = [] } = useQuery<Opt[]>({
    queryKey: ['nvr-scope-options', dimension.name],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dimension.target_collection}`, {
            fields: `id,${lf}`,
            limit: 200,
            ...(dimension.options_sort ? { sort: dimension.options_sort } : {})
          })
        )
        .then((r) => rowsToOpts(r.data ?? []))
  })
  // Big value spaces get a search-to-add picker instead of a pill wall.
  const pickerMode = options.length > 24
  const { data: matches = [], isFetching: searching } = useQuery<Opt[]>({
    queryKey: ['nvr-scope-search', dimension.name, q],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dimension.target_collection}`, {
            fields: `id,${lf}`,
            limit: 30,
            filter: JSON.stringify({ [lf]: { _contains: q } }),
            ...(dimension.options_sort ? { sort: dimension.options_sort } : {})
          })
        )
        .then((r) => rowsToOpts(r.data ?? [])),
    enabled: pickerMode && q.trim().length > 0,
    placeholderData: (prev) => prev
  })
  const known = new Map(options.map((o) => [String(o.id), o.label]))
  for (const m of matches) known.set(String(m.id), m.label)
  const missing = selected.filter((v) => !known.has(String(v)))
  const { data: extraLabels = [] } = useQuery<Opt[]>({
    queryKey: ['nvr-scope-selected-labels', dimension.name, missing.map(String).sort().join(',')],
    queryFn: () =>
      client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${dimension.target_collection}`, {
            fields: `id,${lf}`,
            limit: 100,
            filter: JSON.stringify({ id: { _in: missing } })
          })
        )
        .then((r) => rowsToOpts(r.data ?? [])),
    enabled: missing.length > 0
  })
  for (const e of extraLabels) known.set(String(e.id), e.label)

  const sel = new Set(selected.map(String))
  const toggle = (id: string | number) =>
    onToggle(
      sel.has(String(id)) ? selected.filter((v) => String(v) !== String(id)) : [...selected, id]
    )
  const onCls =
    accent === 'amber'
      ? 'border-amber-400 bg-amber-50 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'
      : 'border-nvr-cyan bg-accent font-medium text-nvr-navy dark:text-nvr-cyan'

  if (!pickerMode) {
    return (
      <div className='flex flex-wrap gap-1'>
        {options.map((o) => {
          const on = sel.has(String(o.id))
          return (
            <button
              key={String(o.id)}
              type='button'
              aria-pressed={on}
              onClick={() => toggle(o.id)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
                on
                  ? onCls
                  : 'border-slate-200 text-slate-500 hover:border-slate-300 dark:border-border dark:text-slate-400'
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    )
  }
  return (
    <div className='max-w-xl'>
      {selected.length > 0 && (
        <div className='mb-1.5 flex flex-wrap gap-1'>
          {selected.map((v) => (
            <span
              key={String(v)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[11.5px]',
                onCls
              )}
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
        placeholder={`Search ${dimension.label.toLowerCase()} to add…`}
        className='h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-card'
      />
      {q.trim().length > 0 && (
        <div className='mt-1 max-h-44 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
          {matches.map((m) => {
            const on = sel.has(String(m.id))
            return (
              <button
                key={String(m.id)}
                type='button'
                onClick={() => toggle(m.id)}
                className={cn(
                  'flex w-full items-center justify-between px-2.5 py-1.5 text-left text-[12px] hover:bg-muted',
                  on
                    ? 'font-medium text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-600 dark:text-slate-300'
                )}
              >
                <span className='truncate'>{m.label}</span>
                <span className='pl-2 text-[11px] text-slate-400'>{on ? 'Remove' : 'Add'}</span>
              </button>
            )
          })}
          {matches.length === 0 && (
            <p className='px-2.5 py-2 text-[11.5px] text-slate-400'>
              {searching ? 'Searching…' : 'No matches.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

type Impact = Array<{
  collection: string
  total: number
  current: number
  proposed: number
  gained?: number
  lost?: number
  gained_sample?: Array<{ id: string; label: string }>
  lost_sample?: Array<{ id: string; label: string }>
}>

export function UserScopesCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: scopes } = useQuery<ScopesInfo>({
    queryKey: ['nvr-user-scopes', userId],
    queryFn: () =>
      client.request<{ data: ScopesInfo }>(get(`/user-scopes/${userId}`)).then((r) => r.data)
  })
  const save = useMutation({
    mutationFn: (body: {
      dimension: string
      mode: 'default' | 'restrict'
      values: Array<string | number>
    }) => client.request(put(`/user-scopes/${userId}`, body)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-user-scopes', userId] })
      void qc.invalidateQueries({ queryKey: ['nvr-person-profile', userId] })
      // When the admin edits their OWN row, the filter seeding and the
      // self-serve defaults card read these keys.
      void qc.invalidateQueries({ queryKey: ['nvr-my-scopes'] })
      void qc.invalidateQueries({ queryKey: ['nvr-profile-scopes'] })
    },
    onError: (e) => toast.error(errorText(e, 'Could not save scopes'))
  })
  // Restriction edits are the scariest change in the system — a wrong value
  // is a quiet total denial. They stage through a blast-radius preview
  // instead of saving on click. Defaults stay instant — they enforce nothing.
  const [pending, setPending] = useState<{
    dimension: string
    values: Array<string | number>
    loading: boolean
    impact: Impact | null
  } | null>(null)
  const stageRestrict = async (dimension: string, values: Array<string | number>) => {
    setPending({ dimension, values, loading: true, impact: null })
    try {
      const r = await client.request<{ data: { impact: Impact } }>(
        post(`/user-scopes/${userId}/impact`, { dimension, values })
      )
      setPending({ dimension, values, loading: false, impact: r.data.impact })
    } catch {
      setPending({ dimension, values, loading: false, impact: null })
    }
  }

  if (!scopes || scopes.dimensions.length === 0) return null
  return (
    <SectionCard
      icon={<SlidersHorizontal className='h-4 w-4' />}
      title='Scopes'
      hint='Defaults pre-fill their filters; restrictions limit what they can see'
      testId='scopes'
    >
      <div className='space-y-4'>
        {scopes.dimensions.map((d) => (
          <div key={d.name}>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              {d.label}
            </p>
            <div className='mt-1.5 space-y-2'>
              <div>
                <p className='mb-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  Defaults
                </p>
                <ValuePills
                  dimension={d}
                  selected={scopes.defaults[d.name] ?? []}
                  accent='cyan'
                  onToggle={(values) => save.mutate({ dimension: d.name, mode: 'default', values })}
                />
              </div>
              <div>
                <p className='mb-1 flex items-center gap-1 text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                  <ShieldAlert className='h-3 w-3 text-amber-500' /> Restricted to
                  <span className='normal-case tracking-normal'>
                    (empty = unrestricted; enforced on every read)
                  </span>
                </p>
                <ValuePills
                  dimension={d}
                  selected={
                    pending?.dimension === d.name
                      ? pending.values
                      : (scopes.restricted[d.name] ?? [])
                  }
                  accent='amber'
                  onToggle={(values) => void stageRestrict(d.name, values)}
                />
                {pending?.dimension === d.name && (
                  <div className='mt-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-900 dark:border-amber-500/30 dark:bg-amber-400/10 dark:text-amber-200'>
                    {pending.loading ? (
                      <p>Computing impact…</p>
                    ) : (
                      <>
                        {(pending.impact ?? []).map((i) => (
                          <div key={i.collection} data-scope-impact-row={i.collection}>
                            <p>
                              <span className='font-mono'>{i.collection}</span>:{' '}
                              {i.current.toLocaleString()} → {i.proposed.toLocaleString()} of{' '}
                              {i.total.toLocaleString()} visible
                              {i.proposed === 0 && (
                                <span className='ml-1 font-semibold text-red-600 dark:text-red-400'>
                                  (sees nothing)
                                </span>
                              )}
                            </p>
                            {((i.gained ?? 0) > 0 || (i.lost ?? 0) > 0) && (
                              <div className='ml-3 mt-0.5 space-y-0.5 text-[11px]'>
                                {(i.gained ?? 0) > 0 && (
                                  <p data-scope-impact-gained={i.gained}>
                                    <span className='font-semibold text-emerald-700 dark:text-emerald-300'>
                                      +{(i.gained ?? 0).toLocaleString()} gained
                                    </span>
                                    {(i.gained_sample?.length ?? 0) > 0 && (
                                      <span className='opacity-80'>
                                        {' '}
                                        · {i.gained_sample!.map((r) => r.label).join(', ')}
                                        {(i.gained ?? 0) > i.gained_sample!.length ? ' …' : ''}
                                      </span>
                                    )}
                                  </p>
                                )}
                                {(i.lost ?? 0) > 0 && (
                                  <p data-scope-impact-lost={i.lost}>
                                    <span className='font-semibold text-red-700 dark:text-red-300'>
                                      −{(i.lost ?? 0).toLocaleString()} lost
                                    </span>
                                    {(i.lost_sample?.length ?? 0) > 0 && (
                                      <span className='opacity-80'>
                                        {' '}
                                        · {i.lost_sample!.map((r) => r.label).join(', ')}
                                        {(i.lost ?? 0) > i.lost_sample!.length ? ' …' : ''}
                                      </span>
                                    )}
                                  </p>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                        {(pending.impact?.length ?? 0) === 0 && (
                          <p>Impact preview unavailable — apply with care.</p>
                        )}
                        <div className='mt-1.5 flex gap-2'>
                          <button
                            type='button'
                            className='rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white'
                            onClick={() => {
                              save.mutate({
                                dimension: d.name,
                                mode: 'restrict',
                                values: pending.values
                              })
                              setPending(null)
                            }}
                          >
                            Apply restriction
                          </button>
                          <button
                            type='button'
                            className='text-[11px] text-slate-500 underline decoration-dotted underline-offset-2'
                            onClick={() => setPending(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

// ─── Microsoft directory ─────────────────────────────────────────────────────

type DirectoryStatus = {
  configured: boolean
  granted: boolean
  roles: string[]
  reason: string | null
}
type DirectoryEntry = {
  id: string
  display_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  upn: string | null
  title: string | null
  department: string | null
  company: string | null
  office_location: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  phone: string | null
  employee_id?: string | null
  preferred_language: string | null
  account_enabled: boolean | null
  manager: DirectoryEntry | null
}

const DIR_FIELDS: Array<{ key: keyof DirectoryEntry; label: string }> = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'title', label: 'Title' },
  { key: 'department', label: 'Department' },
  { key: 'company', label: 'Company' },
  { key: 'phone', label: 'Phone' },
  { key: 'office_location', label: 'Office' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'country', label: 'Country' },
  { key: 'employee_id', label: 'Employee id' },
  { key: 'preferred_language', label: 'Language' }
]

export function UserDirectoryCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const invalidate = useInvalidatePerson(p.id)
  const status = useQuery<DirectoryStatus>({
    queryKey: ['nvr-directory-status'],
    queryFn: () =>
      client.request<{ data: DirectoryStatus }>(get('/directory/status')).then((r) => r.data),
    staleTime: 5 * 60_000
  })
  const entry = useQuery<DirectoryEntry | null>({
    queryKey: ['nvr-directory-entry', p.email],
    queryFn: () =>
      client
        .request<{ data: DirectoryEntry }>(get(`/directory/users/${encodeURIComponent(p.email)}`))
        .then((r) => r.data)
        .catch((err: { status?: number }) => {
          if (err?.status === 404) return null
          throw err
        }),
    enabled: Boolean(status.data?.granted && p.email),
    staleTime: 60_000
  })
  const sync = useMutation({
    mutationFn: () =>
      client
        .request<{
          data: {
            summary: { active: number; disabled: number; missing: number; suspended: number }
          }
        }>(post(`/directory/sync/${p.id}`))
        .then((r) => r.data),
    onSuccess: ({ summary: s }) => {
      invalidate()
      void qc.invalidateQueries({ queryKey: ['nvr-directory-entry', p.email] })
      if (s.active > 0) toast.success('Still with the company — profile synced from the directory')
      else
        toast.warning(
          `${s.missing > 0 ? 'Not in the directory' : 'Disabled in Azure'}${s.suspended > 0 ? ' — suspended' : ''}`
        )
    },
    onError: (e) => toast.error(errorText(e, 'Directory sync failed'))
  })

  // Deployments without a Microsoft tenant never see this card.
  if (status.isLoading || !status.data?.configured) return null
  const current = p as unknown as Record<string, unknown>
  const storedOf = (key: string) =>
    (current[key] as string | null | undefined) ??
    ((p.admin as unknown as Record<string, unknown> | null)?.[key] as string | null | undefined) ??
    null
  const e = entry.data
  const verdict = p.admin?.directory_status ?? null
  const tone =
    verdict === 'active'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-200'
      : verdict === 'disabled' || verdict === 'missing'
        ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-400/30 dark:bg-red-400/10 dark:text-red-200'
        : 'border-slate-200 bg-slate-50 text-slate-600 dark:border-border dark:bg-muted dark:text-muted-foreground'
  const text =
    verdict === 'active'
      ? 'Still with the company'
      : verdict === 'disabled'
        ? 'Account disabled in Azure — no longer with the company'
        : verdict === 'missing'
          ? 'Not in the Microsoft directory — no longer with the company'
          : 'Not checked against the directory yet'

  return (
    <SectionCard
      icon={<BookUser className='h-4 w-4' />}
      title='Microsoft directory'
      hint='Pulling writes every field the directory has a value for; blanks never clear'
      testId='directory'
      actions={
        status.data.granted && (
          <button
            type='button'
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
          >
            <RefreshCw className={cn('h-3 w-3', sync.isPending && 'animate-spin')} />
            {sync.isPending ? 'Checking…' : 'Sync from directory'}
          </button>
        )
      }
    >
      <div
        className={cn('rounded-md border px-3 py-2 text-[12.5px]', tone)}
        data-directory-verdict={verdict ?? 'unchecked'}
      >
        <span className='font-medium'>{text}</span>
        {p.admin?.directory_checked_at && (
          <span className='ml-2 text-[11px] opacity-70'>
            checked {formatRelative(p.admin.directory_checked_at)}
          </span>
        )}
        {(verdict === 'disabled' || verdict === 'missing') && (
          <p className='mt-0.5 text-[11.5px] opacity-80'>
            Hand off what they still own under Admin tools. Redaction stays a separate step.
          </p>
        )}
      </div>

      {!status.data.granted ? (
        <div className='mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'>
          <p className='font-medium'>Directory access is not granted yet.</p>
          <p className='mt-0.5'>
            {status.data.reason ??
              'The app token cannot read other users. Grant User.Read.All as an application permission with admin consent.'}
          </p>
        </div>
      ) : entry.isLoading ? (
        <p className='mt-3 text-[12px] text-slate-400'>Looking up the directory…</p>
      ) : entry.isError ? (
        <p className='mt-3 text-[12px] text-red-600 dark:text-red-400'>
          {errorText(entry.error, 'The directory lookup failed.')}
        </p>
      ) : !e ? (
        <p className='mt-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No directory entry matches {p.email}.
        </p>
      ) : (
        <div className='mt-3 space-y-3'>
          <div className='flex flex-wrap items-center gap-2 text-[12px]'>
            <span className='font-medium text-slate-800 dark:text-foreground'>
              {e.display_name ?? `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim()}
            </span>
            {e.upn && e.upn.toLowerCase() !== p.email.toLowerCase() && (
              <span className='text-slate-400'>UPN {e.upn}</span>
            )}
            {e.account_enabled === false && (
              <span className='rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-400/10 dark:text-red-300'>
                Disabled in Azure
              </span>
            )}
            {e.manager && (
              <span className='text-slate-500 dark:text-muted-foreground'>
                Reports to{' '}
                <span className='font-medium text-slate-700 dark:text-foreground'>
                  {e.manager.display_name ?? e.manager.email}
                </span>
              </span>
            )}
          </div>
          <dl className='grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-2 lg:grid-cols-3'>
            {DIR_FIELDS.filter((f) => f.key in e).map((f) => {
              const next = (e[f.key] as string | null) ?? null
              const stored = storedOf(f.key)
              const differs = Boolean(next) && next !== stored
              return (
                <div
                  key={f.key}
                  className={cn(
                    'bg-white px-3 py-2 dark:bg-card',
                    differs && 'bg-amber-50/60 dark:bg-amber-400/10'
                  )}
                >
                  <dt className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>
                    {f.label}
                  </dt>
                  <dd className='mt-0.5 text-[12.5px] text-slate-800 dark:text-foreground'>
                    {next ?? <span className='text-slate-300 dark:text-slate-600'>—</span>}
                  </dd>
                  {differs && (
                    <dd className='text-[11px] text-slate-400'>
                      stored: {stored ?? <span className='italic'>empty</span>}
                    </dd>
                  )}
                </div>
              )
            })}
          </dl>
        </div>
      )}
    </SectionCard>
  )
}

// ─── API token ───────────────────────────────────────────────────────────────

export function ApiTokenCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const invalidate = useInvalidatePerson(p.id)
  const [token, setToken] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const generate = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { token: string } }>(post(`/users/${p.id}/token`))
        .then((r) => r.data.token),
    onSuccess: (t) => {
      setToken(t)
      setShown(true)
      invalidate()
      toast.success('Token generated — copy it now, it is shown once')
    },
    onError: (e) => toast.error(errorText(e, 'Could not generate a token'))
  })
  const revoke = useMutation({
    mutationFn: () => client.request(del(`/users/${p.id}/token`)),
    onSuccess: () => {
      setToken(null)
      setShown(false)
      invalidate()
      toast.success('Token revoked')
    },
    onError: (e) => toast.error(errorText(e, 'Could not revoke the token'))
  })
  const has = !!p.admin?.has_static_token || !!token
  return (
    <SectionCard
      icon={<KeyRound className='h-4 w-4' />}
      title='API token'
      hint='Static bearer token for scripts and the SDK'
      testId='api-token'
    >
      {has ? (
        <div className='space-y-3'>
          {token ? (
            <div className='flex items-center gap-2'>
              <code className='flex-1 break-all rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'>
                {shown ? token : '•'.repeat(24)}
              </code>
              <button
                type='button'
                onClick={() => setShown((v) => !v)}
                aria-label={shown ? 'Hide token' : 'Reveal token'}
                className='rounded-md border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
              >
                {shown ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
              </button>
              <button
                type='button'
                onClick={() => {
                  void navigator.clipboard.writeText(token)
                  toast.success('Copied')
                }}
                aria-label='Copy token'
                className='rounded-md border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
              >
                <Copy className='h-4 w-4' />
              </button>
            </div>
          ) : (
            <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
              A token is set. The value is never shown again — regenerate to issue a new one.
            </p>
          )}
          <div className='flex gap-2'>
            <ConfirmButton
              onConfirm={() => generate.mutate()}
              disabled={generate.isPending}
              confirmLabel='Replace the current token?'
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
              armedClassName='border-amber-300 text-amber-700 dark:text-amber-300'
            >
              <RefreshCw className='h-3 w-3' /> Regenerate
            </ConfirmButton>
            <ConfirmButton
              onConfirm={() => revoke.mutate()}
              disabled={revoke.isPending}
              confirmLabel='Revoke — scripts using it stop working?'
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-border dark:text-red-400 dark:hover:bg-red-500/10'
              armedClassName='border-red-300'
            >
              <Trash2 className='h-3 w-3' /> Revoke
            </ConfirmButton>
          </div>
        </div>
      ) : (
        <div className='flex flex-wrap items-center gap-3'>
          <EmptyLine>No token issued.</EmptyLine>
          <button
            type='button'
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:text-slate-300 dark:hover:bg-muted'
          >
            <RefreshCw className={cn('h-3 w-3', generate.isPending && 'animate-spin')} />
            {generate.isPending ? 'Generating…' : 'Generate token'}
          </button>
        </div>
      )}
    </SectionCard>
  )
}

// ─── Live sessions ───────────────────────────────────────────────────────────

export function SessionsCard({ userId }: { userId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: sessions = [] } = useQuery<
    Array<{ sid_prefix: string; user_id: string; ttl_seconds: number }>
  >({
    queryKey: ['nvr-user-sessions', userId],
    queryFn: () =>
      client
        .request<{ data: Array<{ sid_prefix: string; user_id: string; ttl_seconds: number }> }>(
          get('/security/sessions', { user_id: userId })
        )
        .then((r) => r.data)
        .catch(() => []),
    staleTime: 30_000
  })
  const revoke = useMutation({
    mutationFn: (prefix: string) => client.request(del(`/security/sessions/${prefix}`)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['nvr-user-sessions', userId] })
      toast.success('Session revoked')
    },
    onError: (e) => toast.error(errorText(e, 'Could not revoke'))
  })
  return (
    <SectionCard
      icon={<MonitorSmartphone className='h-4 w-4' />}
      title={`Live sessions · ${sessions.length}`}
      hint='Revoking one signs that browser out on its next request'
      testId='sessions'
    >
      {sessions.length === 0 ? (
        <EmptyLine>No live sessions.</EmptyLine>
      ) : (
        <ul className='space-y-1.5'>
          {sessions.map((sn) => (
            <li
              key={sn.sid_prefix}
              className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'
            >
              <span className='font-mono text-slate-400'>{sn.sid_prefix}…</span>
              <span className='text-[11px] text-slate-400'>
                expires in {Math.max(1, Math.round(sn.ttl_seconds / 3600))}h
              </span>
              <ConfirmButton
                onConfirm={() => revoke.mutate(sn.sid_prefix)}
                confirmLabel='Sign them out?'
                className='ml-auto text-[11px] text-red-500 underline decoration-dotted hover:text-red-600'
              >
                Revoke
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
