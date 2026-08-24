import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  Loader2,
  Play,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Access Audit ────────────────────────────────────────────────────────────
// "Can every stakeholder still open their record?" — master-detail over audit
// definitions (collection + subject sources), rerunnable, with per-record
// findings that name the exact gate (role permission, RLS, scope dimension)
// that hides the record from that person.

interface AuditSubject {
  type: 'field' | 'pipeline_owners'
  field?: string
  label?: string
}

interface AuditRun {
  id: number
  audit: number
  status: 'running' | 'completed' | 'error'
  checked_records: number
  checked_pairs: number
  violation_count: number
  truncated: boolean | number
  error: string | null
  started_at: string
  finished_at: string | null
}

interface AuditDef {
  id: number
  name: string
  collection: string
  subjects: AuditSubject[]
  is_active: boolean | number
  latest_run: AuditRun | null
}

interface FindingReason {
  type: string
  dimension?: string
  dimension_label?: string
  record_values?: string[]
  message: string
}

interface Finding {
  id: number
  collection: string
  item_id: string
  item_label: string | null
  user: string
  subject: string
  reasons: FindingReason[]
  user_email: string | null
  first_name: string | null
  last_name: string | null
  last_access: string | null
}

function StatusDot({ run }: { run: AuditRun | null }) {
  if (!run) return <span className='h-2 w-2 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600' />
  if (run.status === 'running')
    return <Loader2 className='h-3 w-3 shrink-0 animate-spin text-nvr-cyan' />
  if (run.status === 'error') return <span className='h-2 w-2 shrink-0 rounded-full bg-red-400' />
  return (
    <span
      className={cn(
        'h-2 w-2 shrink-0 rounded-full',
        run.violation_count > 0 ? 'bg-amber-400' : 'bg-emerald-400'
      )}
    />
  )
}

function CollectionCombobox({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: collections = [] } = useQuery<Array<{ collection: string }>>({
    queryKey: ['collections-list'],
    queryFn: () => api.get('/collections').then((r: { data: { data?: Array<{ collection: string }> } }) => r.data.data ?? []),
    staleTime: 60_000
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant='outline' size='sm' className='h-8 w-full justify-between text-[12px] font-normal'>
          <span className={cn('truncate', !value && 'text-slate-400')}>{value || 'Collection…'}</span>
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty>No collections.</CommandEmpty>
            <CommandGroup>
              {collections
                .filter((c) => !c.collection.startsWith('nivaro_'))
                .map((c) => (
                  <CommandItem
                    key={c.collection}
                    value={c.collection}
                    onSelect={() => {
                      onChange(c.collection)
                      setOpen(false)
                    }}
                    className='text-[12px]'
                  >
                    <Check className={cn('mr-2 h-3.5 w-3.5', value === c.collection ? 'opacity-100' : 'opacity-0')} />
                    {c.collection}
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export default function AccessAuditPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newCollection, setNewCollection] = useState('')
  const [newFields, setNewFields] = useState('')
  const [newOwners, setNewOwners] = useState(true)
  const [findingSearch, setFindingSearch] = useState('')
  const [findingPage, setFindingPage] = useState(1)
  const [viewMode, setViewMode] = useState<'all' | 'people'>('all')
  const [activeUser, setActiveUser] = useState<{ id: string; name: string } | null>(null)

  const { data: audits = [], isLoading } = useQuery<AuditDef[]>({
    queryKey: ['access-audits'],
    queryFn: () => api.get('/access-audits').then((r: { data: { data?: AuditDef[] } }) => r.data.data ?? []),
    // Poll while any run is active so the list status flips without a reload.
    refetchInterval: (q) =>
      (q.state.data ?? []).some((a) => a.latest_run?.status === 'running') ? 3000 : false
  })
  const selected = audits.find((a) => a.id === selectedId) ?? audits[0] ?? null
  useEffect(() => {
    if (!selectedId && audits.length > 0) setSelectedId(audits[0].id)
  }, [audits, selectedId])

  const { data: runs = [] } = useQuery<AuditRun[]>({
    queryKey: ['access-audit-runs', selected?.id],
    queryFn: () => api.get(`/access-audits/${selected!.id}/runs`).then((r: { data: { data?: AuditRun[] } }) => r.data.data ?? []),
    enabled: !!selected,
    refetchInterval: (q) =>
      (q.state.data ?? []).some((r) => r.status === 'running') ? 3000 : false
  })
  const activeRun = runs.find((r) => r.id === selectedRunId) ?? runs[0] ?? null
  useEffect(() => {
    setSelectedRunId(null)
    setFindingPage(1)
    setFindingSearch('')
    setActiveUser(null)
  }, [selected?.id])

  const { data: findingsData } = useQuery<{ data: Finding[]; total: number }>({
    queryKey: ['access-audit-findings', activeRun?.id, findingPage, findingSearch, activeUser?.id],
    queryFn: () =>
      api
        .get(`/access-audits/runs/${activeRun!.id}/findings`, {
          params: {
            page: findingPage,
            limit: 50,
            search: findingSearch || undefined,
            user: activeUser?.id || undefined
          }
        })
        .then((r: { data: { data: Finding[]; total: number } }) => r.data),
    enabled: !!activeRun && activeRun.status !== 'running'
  })
  const { data: byUser = [] } = useQuery<
    Array<{ user: string; email: string | null; first_name: string | null; last_name: string | null; last_access: string | null; finding_count: number }>
  >({
    queryKey: ['access-audit-by-user', activeRun?.id],
    queryFn: () =>
      api
        .get(`/access-audits/runs/${activeRun!.id}/by-user`)
        .then((r: { data: { data?: Array<{ user: string; email: string | null; first_name: string | null; last_name: string | null; last_access: string | null; finding_count: number }> } }) => r.data.data ?? []),
    enabled: !!activeRun && activeRun.status === 'completed' && viewMode === 'people'
  })
  const findings = findingsData?.data ?? []
  const findingsTotal = findingsData?.total ?? 0

  const runMut = useMutation({
    mutationFn: (id: number) => api.post(`/access-audits/${id}/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['access-audits'] })
      qc.invalidateQueries({ queryKey: ['access-audit-runs'] })
    }
  })
  const createMut = useMutation({
    mutationFn: () => {
      const subjects: AuditSubject[] = [
        ...newFields
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean)
          .map((f) => ({ type: 'field' as const, field: f, label: f })),
        ...(newOwners ? [{ type: 'pipeline_owners' as const, label: 'Owner' }] : [])
      ]
      return api.post('/access-audits', { name: newName, collection: newCollection, subjects })
    },
    onSuccess: (r: { data: { data?: { id?: number } } }) => {
      qc.invalidateQueries({ queryKey: ['access-audits'] })
      setCreating(false)
      setNewName('')
      setNewCollection('')
      setNewFields('')
      setSelectedId(r.data.data?.id ?? null)
    }
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/access-audits/${id}`),
    onSuccess: () => {
      setSelectedId(null)
      qc.invalidateQueries({ queryKey: ['access-audits'] })
    }
  })
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => setConfirmDelete(false), [selected?.id])

  const runDuration = useMemo(() => {
    if (!activeRun?.finished_at) return null
    const ms = new Date(activeRun.finished_at).getTime() - new Date(activeRun.started_at).getTime()
    if (ms < 1000) return '<1s'
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`
    return `${Math.round(ms / 60_000)}m`
  }, [activeRun])

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <ShieldCheck className='h-[18px] w-[18px] text-slate-400' />
          <h1 className='text-[15px] font-semibold text-slate-800 dark:text-slate-100'>Access Audit</h1>
        </div>
        <p className='mt-0.5 max-w-[72ch] text-[12px] text-slate-500 dark:text-slate-400'>
          Checks that every stakeholder of a record — its creator, contacts, and current pipeline
          owners — can still open it. Data edits and scope changes can quietly revoke access;
          rerun an audit any time and each finding names the exact rule that hides the record.
        </p>
      </header>

      <ExplainAccessBar />

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* ── Audit list ──────────────────────────────────────────────────── */}
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='space-y-2 p-3'>
                {[1, 2].map((i) => (
                  <div key={i} className='animate-pulse h-12 rounded-lg bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                ))}
              </div>
            ) : (
              audits.map((a) => (
                <button
                  key={a.id}
                  type='button'
                  onClick={() => setSelectedId(a.id)}
                  className={cn(
                    'flex w-full items-start gap-2.5 border-b border-slate-100 px-4 py-3 text-left transition-colors dark:border-border/60',
                    selected?.id === a.id
                      ? 'bg-nvr-cyan/10'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                  )}
                >
                  <span className='mt-1.5'>
                    <StatusDot run={a.latest_run} />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-200'>
                      {a.name}
                    </span>
                    <span className='block text-[11px] text-slate-400'>
                      {a.collection}
                      {a.latest_run && a.latest_run.status === 'completed' && (
                        <> · {a.latest_run.violation_count} finding{a.latest_run.violation_count === 1 ? '' : 's'}</>
                      )}
                      {a.latest_run?.status === 'running' && <> · running…</>}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className='border-t border-slate-100 p-3 dark:border-border/60'>
            {creating ? (
              <div className='space-y-2'>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder='Audit name'
                  className='h-8 text-[12px]'
                />
                <CollectionCombobox value={newCollection} onChange={setNewCollection} />
                <Input
                  value={newFields}
                  onChange={(e) => setNewFields(e.target.value)}
                  placeholder='User fields (comma-separated)'
                  className='h-8 text-[12px]'
                />
                <label className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300'>
                  <input
                    type='checkbox'
                    checked={newOwners}
                    onChange={(e) => setNewOwners(e.target.checked)}
                    className='h-3.5 w-3.5'
                  />
                  Include pipeline owners
                </label>
                <div className='flex gap-2'>
                  <Button
                    size='sm'
                    className='h-7 flex-1 text-[12px]'
                    disabled={!newCollection || createMut.isPending}
                    onClick={() => createMut.mutate()}
                  >
                    {createMut.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Create'}
                  </Button>
                  <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => setCreating(false)}>
                    <X className='h-3.5 w-3.5' />
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='h-8 w-full gap-1.5 text-[12px]'
                onClick={() => setCreating(true)}
              >
                <Plus className='h-3.5 w-3.5' />
                New audit
              </Button>
            )}
          </div>
        </aside>

        {/* ── Detail ──────────────────────────────────────────────────────── */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {!selected ? (
            <div className='flex h-full items-center justify-center'>
              <p className='text-[13px] text-slate-400'>Create an audit to get started.</p>
            </div>
          ) : (
            <div className='space-y-5 p-6'>
              <div className='flex items-start justify-between gap-4'>
                <div>
                  <h2 className='text-[14px] font-semibold text-slate-800 dark:text-slate-100'>{selected.name}</h2>
                  <p className='mt-0.5 text-[12px] text-slate-500 dark:text-slate-400'>
                    Checking{' '}
                    {selected.subjects
                      .map((s) => (s.type === 'pipeline_owners' ? 'current pipeline owners' : `"${s.label || s.field}"`))
                      .join(', ')}{' '}
                    on <span className='font-medium'>{selected.collection}</span>.
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                  {confirmDelete ? (
                    <>
                      <span className='text-[12px] text-slate-500'>Delete?</span>
                      <Button size='sm' variant='destructive' className='h-7 text-[12px]' onClick={() => deleteMut.mutate(selected.id)}>
                        Confirm
                      </Button>
                      <Button size='sm' variant='outline' className='h-7 text-[12px]' onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size='sm' variant='outline' className='h-7 gap-1.5 text-[12px] text-slate-500' onClick={() => setConfirmDelete(true)}>
                        <Trash2 className='h-3.5 w-3.5' />
                      </Button>
                      <Button
                        size='sm'
                        className='h-7 gap-1.5 text-[12px]'
                        disabled={runMut.isPending || runs.some((r) => r.status === 'running')}
                        onClick={() => runMut.mutate(selected.id)}
                      >
                        {runs.some((r) => r.status === 'running') ? (
                          <>
                            <Loader2 className='h-3.5 w-3.5 animate-spin' /> Running…
                          </>
                        ) : (
                          <>
                            <Play className='h-3.5 w-3.5' /> Run audit
                          </>
                        )}
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* Latest-run meta grid */}
              {activeRun && (
                <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
                  {[
                    ['Records checked', activeRun.checked_records.toLocaleString()],
                    ['Stakeholder pairs', activeRun.checked_pairs.toLocaleString()],
                    [
                      'Findings',
                      `${activeRun.violation_count.toLocaleString()}${activeRun.truncated ? '+ (capped)' : ''}`
                    ],
                    ['Duration', activeRun.status === 'running' ? 'running…' : (runDuration ?? '—')]
                  ].map(([label, value]) => (
                    <div key={label} className='bg-white px-4 py-3 dark:bg-card'>
                      <p className='text-[10.5px] font-medium uppercase tracking-wide text-slate-400'>{label}</p>
                      <p
                        className={cn(
                          'mt-0.5 text-[15px] font-semibold tabular-nums',
                          label === 'Findings' && activeRun.violation_count > 0
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-slate-800 dark:text-slate-100'
                        )}
                      >
                        {value}
                      </p>
                    </div>
                  ))}
                </div>
              )}
              {activeRun?.status === 'error' && (
                <div className='rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-[12px] text-red-700 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-400'>
                  Run failed: {activeRun.error}
                </div>
              )}

              {/* Run history pills */}
              {runs.length > 1 && (
                <div className='flex flex-wrap items-center gap-1.5'>
                  <span className='text-[11px] text-slate-400'>Runs:</span>
                  {runs.slice(0, 10).map((r) => (
                    <button
                      key={r.id}
                      type='button'
                      onClick={() => {
                        setSelectedRunId(r.id)
                        setFindingPage(1)
                      }}
                      className={cn(
                        'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                        activeRun?.id === r.id
                          ? 'border-nvr-cyan/50 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                          : 'border-slate-200 text-slate-500 hover:bg-slate-100 dark:border-border dark:hover:bg-white/[0.03]'
                      )}
                    >
                      {formatRelative(r.started_at)}
                      {r.status === 'completed' && ` · ${r.violation_count}`}
                      {r.status === 'running' && ' · running'}
                      {r.status === 'error' && ' · failed'}
                    </button>
                  ))}
                </div>
              )}

              {/* Findings */}
              {activeRun && activeRun.status === 'completed' && (
                <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
                  <div className='flex items-center gap-3 border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
                    <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                      Findings
                      <span className='ml-1.5 text-[11px] font-normal text-slate-400'>{findingsTotal.toLocaleString()}</span>
                    </p>
                    <div className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
                      {(
                        [
                          ['all', 'All findings'],
                          ['people', 'By person']
                        ] as const
                      ).map(([mode, label]) => (
                        <button
                          key={mode}
                          type='button'
                          onClick={() => {
                            setViewMode(mode)
                            setActiveUser(null)
                            setFindingPage(1)
                          }}
                          className={cn(
                            'px-2.5 py-1 text-[11.5px] transition-colors',
                            viewMode === mode
                              ? 'bg-nvr-cyan/10 font-medium text-nvr-navy dark:text-nvr-cyan'
                              : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                          )}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    {activeUser && (
                      <button
                        type='button'
                        onClick={() => {
                          setActiveUser(null)
                          setFindingPage(1)
                        }}
                        className='inline-flex items-center gap-1 rounded-full border border-nvr-cyan/50 bg-nvr-cyan/10 px-2.5 py-0.5 text-[11.5px] text-nvr-navy dark:text-nvr-cyan'
                      >
                        {activeUser.name}
                        <X className='h-3 w-3' />
                      </button>
                    )}
                    <div className='relative ml-auto w-64'>
                      <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
                      <Input
                        value={findingSearch}
                        onChange={(e) => {
                          setFindingSearch(e.target.value)
                          setFindingPage(1)
                        }}
                        placeholder='Record, person, email…'
                        className='h-8 pl-8 text-[12px]'
                      />
                    </div>
                  </div>
                  {viewMode === 'people' && !activeUser ? (
                    byUser.length === 0 ? (
                      <p className='px-4 py-10 text-center text-[12.5px] text-slate-400'>
                        No findings — every stakeholder can open their records.
                      </p>
                    ) : (
                      <div className='divide-y divide-slate-100 dark:divide-border/60'>
                        {byUser.map((u) => {
                          const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.user
                          return (
                            <div
                              key={u.user}
                              role='button'
                              tabIndex={0}
                              onClick={() => {
                                setActiveUser({ id: u.user, name })
                                setFindingPage(1)
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  setActiveUser({ id: u.user, name })
                                  setFindingPage(1)
                                }
                              }}
                              className='flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-white/[0.02]'
                            >
                              <span className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10.5px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                                {(((u.first_name?.[0] ?? '') + (u.last_name?.[0] ?? '')) || (u.email?.[0] ?? '?')).toUpperCase()}
                              </span>
                              <span className='min-w-0 flex-1'>
                                <span className='block truncate text-[12.5px] text-slate-700 dark:text-slate-200'>{name}</span>
                                {u.email && <span className='block truncate text-[11px] text-slate-400'>{u.email}</span>}
                              </span>
                              <span className='shrink-0 text-[11px] text-slate-400'>
                                {u.last_access ? `Last seen ${formatRelative(u.last_access)}` : 'Never signed in'}
                              </span>
                              <Link
                                to={`/users/${u.user}`}
                                onClick={(e) => e.stopPropagation()}
                                title='Open user profile'
                                className='shrink-0 rounded p-1 text-slate-300 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.05]'
                              >
                                <UserRound className='h-3.5 w-3.5' />
                              </Link>
                              <span className='shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'>
                                {Number(u.finding_count).toLocaleString()}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )
                  ) : findings.length === 0 ? (
                    <p className='px-4 py-10 text-center text-[12.5px] text-slate-400'>
                      {findingsTotal === 0 && !findingSearch
                        ? 'No findings — every stakeholder can open their records.'
                        : 'No findings match this search.'}
                    </p>
                  ) : (
                    <table className='w-full text-[12px]'>
                      <thead>
                        <tr className='border-b border-slate-100 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border/60'>
                          <th className='px-4 py-2 font-medium'>Record</th>
                          <th className='px-3 py-2 font-medium'>Stakeholder</th>
                          <th className='px-3 py-2 font-medium'>Relationship</th>
                          <th className='px-3 py-2 font-medium'>Record's value</th>
                          <th className='px-3 py-2 font-medium'>Why they can't see it</th>
                        </tr>
                      </thead>
                      <tbody className='divide-y divide-slate-100 dark:divide-border/60'>
                        {findings.map((f) => (
                          <tr key={f.id} className='align-top'>
                            <td className='px-4 py-2.5'>
                              <Link
                                to={`/collections/${f.collection}/${f.item_id}`}
                                className='text-nvr-navy underline decoration-slate-300 decoration-dotted underline-offset-2 hover:decoration-nvr-cyan dark:text-nvr-cyan'
                              >
                                {f.item_label || `#${f.item_id}`}
                              </Link>
                            </td>
                            <td className='px-3 py-2.5'>
                              <Link
                                to={`/users/${f.user}`}
                                className='block w-fit text-slate-700 underline decoration-slate-300 decoration-dotted underline-offset-2 hover:decoration-nvr-cyan dark:text-slate-200'
                              >
                                {[f.first_name, f.last_name].filter(Boolean).join(' ') || f.user_email || f.user}
                              </Link>
                              {f.user_email && (
                                <span className='block text-[11px] text-slate-400'>{f.user_email}</span>
                              )}
                              <span className='block text-[11px] text-slate-400'>
                                {f.last_access ? `Last seen ${formatRelative(f.last_access)}` : 'Never signed in'}
                              </span>
                            </td>
                            <td className='px-3 py-2.5 text-slate-500 dark:text-slate-400'>{f.subject}</td>
                            <td className='px-3 py-2.5'>
                              {f.reasons.some((r) => r.record_values !== undefined) ? (
                                <div className='space-y-1'>
                                  {f.reasons
                                    .filter((r) => r.record_values !== undefined)
                                    .map((r, i) => (
                                      <p key={i} className='whitespace-nowrap'>
                                        <span className='text-slate-400'>{r.dimension_label}: </span>
                                        {(r.record_values ?? []).length > 0 ? (
                                          <span className='text-slate-700 dark:text-slate-200'>
                                            {(r.record_values ?? []).join(', ')}
                                          </span>
                                        ) : (
                                          <span className='italic text-amber-600 dark:text-amber-400'>none linked</span>
                                        )}
                                      </p>
                                    ))}
                                </div>
                              ) : (
                                <span className='text-slate-300'>—</span>
                              )}
                            </td>
                            <td className='px-3 py-2.5'>
                              <div className='space-y-1'>
                                {f.reasons.map((r, i) => (
                                  <p key={i} className='text-slate-600 dark:text-slate-300'>
                                    {r.message}
                                  </p>
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {findingsTotal > 50 && (
                    <div className='flex items-center justify-between border-t border-slate-100 px-4 py-2 text-[12px] text-slate-500 dark:border-border/60'>
                      <span>
                        {(findingPage - 1) * 50 + 1}–{Math.min(findingPage * 50, findingsTotal)} of{' '}
                        {findingsTotal.toLocaleString()}
                      </span>
                      <div className='flex gap-1.5'>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          disabled={findingPage <= 1}
                          onClick={() => setFindingPage((p) => p - 1)}
                        >
                          Previous
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          disabled={findingPage * 50 >= findingsTotal}
                          onClick={() => setFindingPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


// ─── Admin access explain (#120): any user × any record, gate by gate ────────

function ExplainAccessBar() {
  const [userQ, setUserQ] = useState('')
  const [userId, setUserId] = useState<string | null>(null)
  const [collection, setCollection] = useState('')
  const [recordId, setRecordId] = useState('')
  const [result, setResult] = useState<{ access: boolean; reasons: Array<{ type: string; message: string }> } | null>(null)
  const { data: users = [] } = useQuery<Array<{ id: string; first_name: string | null; last_name: string | null; email: string }>>({
    queryKey: ['explain-user-search', userQ],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; first_name: string | null; last_name: string | null; email: string }> }>(
          '/users',
          { params: { limit: 8, search: userQ } }
        )
        .then((r) => r.data.data),
    enabled: userQ.length >= 2,
    staleTime: 30_000
  })
  const explain = useMutation({
    mutationFn: () =>
      api
        .get<{ data: { access: boolean; reasons: Array<{ type: string; message: string }> } }>(
          `/access-explain/${collection.trim()}/${recordId.trim()}`,
          { params: { user_id: userId } }
        )
        .then((r) => r.data.data),
    onSuccess: setResult,
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Explain failed')
  })
  const pickedUser = users.find((u) => u.id === userId)
  return (
    <div className='shrink-0 border-b border-slate-200 bg-white px-6 py-3 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
          Explain access:
        </span>
        <div className='relative'>
          <Input
            value={pickedUser ? `${pickedUser.first_name ?? ''} ${pickedUser.last_name ?? ''}`.trim() || pickedUser.email : userQ}
            onChange={(e) => {
              setUserQ(e.target.value)
              setUserId(null)
            }}
            placeholder='user…'
            className='h-8 w-48 text-[12.5px]'
          />
          {!userId && users.length > 0 && userQ.length >= 2 && (
            <div className='absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'>
              {users.map((u) => (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => setUserId(u.id)}
                  className='block w-full px-2.5 py-1 text-left text-[12.5px] hover:bg-muted'
                >
                  {`${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.email}
                  <span className='ml-1.5 text-[10.5px] text-slate-400'>{u.email}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <Input
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder='collection'
          className='h-8 w-40 font-mono text-[12px]'
        />
        <Input
          value={recordId}
          onChange={(e) => setRecordId(e.target.value)}
          placeholder='record id'
          className='h-8 w-32 font-mono text-[12px]'
        />
        <Button
          type='button'
          size='sm'
          className='h-8 text-[12px]'
          disabled={!userId || !collection.trim() || !recordId.trim() || explain.isPending}
          onClick={() => explain.mutate()}
        >
          {explain.isPending ? 'Checking…' : 'Explain'}
        </Button>
        {result && (
          <span className={cn('text-[12.5px] font-medium', result.access ? 'text-emerald-600' : 'text-red-600')}>
            {result.access ? 'CAN see it' : 'CANNOT see it'}
          </span>
        )}
      </div>
      {result && result.reasons.length > 0 && (
        <ul className='mt-1.5 space-y-0.5'>
          {result.reasons.map((r) => (
            <li key={r.message} className='text-[12px] text-slate-600 dark:text-slate-300'>
              · {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
