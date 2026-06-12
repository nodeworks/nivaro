import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Search,
  UserPlus,
  Users,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@/components/ui/tooltip'
import {
  api,
  type PipelineHistoryEntry,
  type PipelineInstance,
  type PipelineInstanceOwner,
  type PipelineState,
  type PipelineTransition,
  type User
} from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── State track ─────────────────────────────────────────────────────────────

function StateTrack({
  states,
  allTransitions,
  availableTransitions,
  currentStateId,
  history
}: {
  states: PipelineState[]
  allTransitions: PipelineTransition[]
  availableTransitions: PipelineTransition[]
  currentStateId: string | null
  history: PipelineHistoryEntry[]
}) {
  const visitedIds = new Set(history.map((h) => h.to_state))

  const relevant = (() => {
    if (allTransitions.length === 0) {
      // No template data yet — show visited + current only
      const show = new Set([...visitedIds])
      if (currentStateId) show.add(currentStateId)
      return states.filter((s) => show.has(s.id)).sort((a, b) => a.sort - b.sort)
    }

    // Edges actually taken, keyed as "fromId:toId"
    const takenEdges = new Set(
      history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
    )
    // States that appear as from_state in history — we already know which edge they took
    const visitedFromIds = new Set(history.map((h) => h.from_state).filter(Boolean) as string[])

    // Build forward adjacency from explicit transitions (excludes global from_state=null).
    // For visited states: only follow edges that history shows were actually taken — this
    // prevents un-taken conditional branches (e.g. "Beeline" when Oracle was chosen) from
    // appearing in the track.
    // For unvisited states: follow all explicit transitions (future path unknown).
    const explicit = allTransitions.filter((t) => t.from_state !== null)
    const fwd = new Map<string, string[]>()
    for (const t of explicit) {
      const fromId = t.from_state!
      if (visitedFromIds.has(fromId) && !takenEdges.has(`${fromId}:${t.to_state}`)) continue
      const arr = fwd.get(fromId) ?? []
      arr.push(t.to_state)
      fwd.set(fromId, arr)
    }

    // For the current state, replace forward edges with condition-evaluated available
    // transitions so only passing branches appear ahead in the track.
    if (currentStateId) {
      fwd.set(currentStateId, availableTransitions.map((t) => t.to_state))
    }

    // BFS from initial states
    const pathIds = new Set<string>()
    const queue = states.filter((s) => s.is_initial).map((s) => s.id)
    while (queue.length) {
      const id = queue.shift()!
      if (pathIds.has(id)) continue
      pathIds.add(id)
      for (const next of fwd.get(id) ?? []) {
        if (!pathIds.has(next)) queue.push(next)
      }
    }

    // Always include visited states (user may have taken a conditional branch in the past)
    const show = new Set([...pathIds, ...visitedIds])
    if (currentStateId) show.add(currentStateId)
    return states
      .filter((s) => show.has(s.id))
      .filter((s) => {
        const v = s.stage_visibility ?? 'always'
        if (v === 'hide') return false
        if (v === 'hide_unless_active')
          return visitedIds.has(s.id) || s.id === currentStateId
        return true
      })
      .sort((a, b) => a.sort - b.sort)
  })()

  if (relevant.length < 2) return null

  function edgeEntries(fromId: string, toId: string) {
    return [...history]
      .filter((h) => (h.from_state === fromId && h.to_state === toId) ||
                     (h.from_state === toId   && h.to_state === fromId))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }

  function entryInitials(h: PipelineHistoryEntry) {
    const f = h.first_name?.[0] ?? ''
    const l = h.last_name?.[0] ?? ''
    return (f + l).toUpperCase() || h.user_email?.[0]?.toUpperCase() || '?'
  }

  function entryName(h: PipelineHistoryEntry) {
    return [h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email || 'System'
  }

  return (
    <TooltipProvider delayDuration={200}>
    <div className='flex w-full items-start'>
      {relevant.map((s, i) => {
        const isCurrent = s.id === currentStateId
        const isVisited = visitedIds.has(s.id)
        const isDone = isVisited && !isCurrent
        const nodeColor = s.color ?? '#94a3b8'
        const isLast = i === relevant.length - 1
        const nextState = !isLast ? relevant[i + 1] : null
        const edge = nextState ? edgeEntries(s.id, nextState.id) : []
        const hasEdge = edge.length > 0

        return (
          <div key={s.id} className='flex min-w-[48px] flex-1 items-start'>
            {/* Node + label */}
            <div className='flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1'>
              <div
                className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full'
                style={{
                  backgroundColor: isCurrent || isDone ? nodeColor : '#f1f5f9',
                  border: isCurrent || isDone ? 'none' : '1.5px solid #e2e8f0',
                  boxShadow: isCurrent
                    ? `0 0 0 3px white, 0 0 0 5px ${nodeColor}`
                    : undefined
                }}
              >
                {isDone ? (
                  <Check className='h-3.5 w-3.5 text-white' strokeWidth={2.5} />
                ) : isCurrent ? (
                  <div className='h-2.5 w-2.5 rounded-full bg-white/80' />
                ) : (
                  <div className='h-2 w-2 rounded-full bg-slate-300' />
                )}
              </div>
              <span
                className='w-full break-words text-center leading-snug'
                style={{
                  fontSize: '11px',
                  color: isCurrent ? nodeColor : isDone ? '#475569' : '#94a3b8',
                  fontWeight: isCurrent ? 600 : isDone ? 500 : 400,
                  wordBreak: 'break-word'
                }}
              >
                {s.label}
              </span>
            </div>

            {/* Connector: line + transition history chips */}
            {!isLast && (
              <div className='mt-[13px] flex w-10 shrink-0 flex-col items-center gap-1.5'>
                {/* Line with arrowhead */}
                {(() => {
                  const lineColor = isDone ? `${nodeColor}55` : '#e8ecf0'
                  return (
                    <div className='flex w-full shrink-0 items-center'>
                      <div className='h-0.5 flex-1 rounded-l-sm' style={{ backgroundColor: lineColor }} />
                      <div style={{
                        width: 0, height: 0,
                        borderTop: '3px solid transparent',
                        borderBottom: '3px solid transparent',
                        borderLeft: `5px solid ${lineColor}`
                      }} />
                    </div>
                  )
                })()}

                {/* History chips — one per transition on this edge */}
                {hasEdge && edge.map((h) => {
                  const isSendback = h.from_state !== s.id
                  return (
                    <Tooltip key={h.id}>
                      <TooltipTrigger asChild>
                        <div className='flex w-full cursor-default flex-col items-center gap-0.5'>
                          <span
                            className='text-center font-mono text-[9px] font-semibold leading-none'
                            style={{ color: isSendback ? '#d97706' : '#475569' }}
                          >
                            {isSendback && '↩ '}{entryInitials(h)}
                          </span>
                          <span className='text-[8.5px] leading-none text-slate-400'>
                            {formatRelative(h.timestamp)}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side='top' className='space-y-0.5 text-[12px]'>
                        <p className='font-medium'>
                          {isSendback ? '↩ Sent back by' : 'Approved by'} {entryName(h)}
                        </p>
                        <p className='text-muted-foreground'>
                          {new Date(h.timestamp).toLocaleString()}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
    </TooltipProvider>
  )
}

// ─── State badge ──────────────────────────────────────────────────────────────

function StateBadge({
  label,
  color,
  small
}: {
  label: string
  color: string | null
  small?: boolean
}) {
  const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full font-medium ${size}`}
      style={{
        backgroundColor: color ? `${color}22` : '#f1f5f9',
        color: color ?? '#475569',
        border: `1px solid ${color ? `${color}44` : '#e2e8f0'}`
      }}
    >
      {label}
    </span>
  )
}

// ─── History timeline ─────────────────────────────────────────────────────────

function HistoryTimeline({ history }: { history: PipelineHistoryEntry[] }) {
  if (history.length === 0) {
    return <p className='text-[12px] text-slate-400 italic'>No transitions yet.</p>
  }
  return (
    <div className='space-y-3'>
      {history.map((h) => {
        const userName =
          h.first_name || h.last_name
            ? [h.first_name, h.last_name].filter(Boolean).join(' ')
            : (h.user_email ?? 'System')
        return (
          <div key={h.id} className='flex items-start gap-2.5 text-[12px]'>
            <div className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-200' />
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-1.5 flex-wrap'>
                {h.from_state_label ? (
                  <StateBadge label={h.from_state_label} color={h.from_state_color} small />
                ) : (
                  <span className='text-[11px] text-slate-400 italic'>started</span>
                )}
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={h.to_state_label} color={h.to_state_color} small />
              </div>
              {h.comment && (
                <p className='mt-1 text-slate-500 italic'>"{h.comment}"</p>
              )}
              <p className='mt-0.5 text-slate-400'>
                {userName} · {formatRelative(h.timestamp)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ownerInitials(o: { first_name: string | null; last_name: string | null; email: string }) {
  const f = o.first_name?.[0] ?? ''
  const l = o.last_name?.[0] ?? ''
  const combined = `${f}${l}`.trim()
  return (combined || o.email[0] || '?').toUpperCase()
}

// ─── Async user picker ────────────────────────────────────────────────────────

function AsyncUserPicker({
  value,
  onChange
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  const { data, isLoading } = useQuery<User[]>({
    queryKey: ['users', 'async-search', debouncedQuery],
    queryFn: () =>
      api
        .get<{ data: User[]; total: number }>('/users', {
          params: { limit: 50, sort: 'first_name', ...(debouncedQuery ? { search: debouncedQuery } : {}) }
        })
        .then((r) => r.data.data),
    enabled: open,
    staleTime: 30_000
  })

  const { data: selectedUser } = useQuery<User | null>({
    queryKey: ['users', 'single', value],
    queryFn: () => api.get<{ data: User }>(`/users/${value}`).then((r) => r.data.data),
    enabled: !!value,
    staleTime: 5 * 60_000
  })

  const selectedLabel = selectedUser
    ? [selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' ').trim() ||
      selectedUser.email
    : value || null

  const users = data ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className='relative flex h-8 w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={`flex-1 truncate ${selectedLabel ? '' : 'text-slate-400'}`}>
              {selectedLabel ?? 'Select a user…'}
            </span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
      <PopoverContent align='start' className='w-72 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search users…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {isLoading ? (
            <div className='flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Loading…
            </div>
          ) : users.length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            users.map((u) => {
              const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
              const label = name ? `${name} (${u.email})` : u.email
              const selected = u.id === value
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => {
                    onChange(u.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`}
                >
                  <Check
                    className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}`}
                  />
                  {label}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Mini combobox (state scope picker) ──────────────────────────────────────

function MiniCombobox({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  noneLabel
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  noneLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])

  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options
  const selectedLabel = value ? (options.find((o) => o.value === value)?.label ?? value) : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className='relative flex h-8 w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={`flex-1 truncate text-left ${selectedLabel ? '' : 'text-slate-400'}`}>
              {selectedLabel ?? placeholder}
            </span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
      <PopoverContent align='start' className='w-64 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-52 overflow-y-auto py-1'>
          {noneLabel !== undefined && (
            <button
              type='button'
              onClick={() => {
                onChange('')
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${!value ? 'font-medium text-slate-800' : 'text-slate-500'}`}
            >
              <Check className={`h-3.5 w-3.5 shrink-0 ${!value ? 'text-nvr-cyan' : 'opacity-0'}`} />
              {noneLabel}
            </button>
          )}
          {filtered.map((o) => (
            <button
              key={o.value}
              type='button'
              onClick={() => {
                onChange(o.value)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${value === o.value ? 'font-medium text-slate-800' : 'text-slate-600'}`}
            >
              <Check
                className={`h-3.5 w-3.5 shrink-0 ${value === o.value ? 'text-nvr-cyan' : 'opacity-0'}`}
              />
              {o.label}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Owners section ───────────────────────────────────────────────────────────

function OwnersSection({
  collection,
  item,
  states
}: {
  collection: string
  item: string
  states: PipelineState[]
}) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [stateScope, setStateScope] = useState('')

  const ownersKey = ['pipeline-instance-owners', collection, item]

  const { data: owners, isLoading: ownersLoading } = useQuery<PipelineInstanceOwner[]>({
    queryKey: ownersKey,
    queryFn: () =>
      api
        .get<{ data: PipelineInstanceOwner[] }>(`/pipelines/instance/${collection}/${item}/owners`)
        .then((r) => r.data.data)
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ownersKey })
    queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
  }

  const addOwner = useMutation({
    mutationFn: () =>
      api
        .post(`/pipelines/instance/${collection}/${item}/owners`, {
          user: userId,
          state: stateScope || undefined
        })
        .then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setUserId('')
      setStateScope('')
      setAdding(false)
      toast.success('Owner added')
    },
    onError: () => toast.error('Failed to add owner')
  })

  const removeOwner = useMutation({
    mutationFn: (id: number) => api.delete(`/pipelines/instance-owners/${id}`),
    onSuccess: () => {
      invalidate()
      toast.success('Owner removed')
    },
    onError: () => toast.error('Failed to remove owner')
  })

  const stateLabelFor = (stateVal: string | null) => {
    if (!stateVal) return null
    const s = states.find((s) => s.id === stateVal) ?? states.find((s) => s.key === stateVal)
    return s?.label ?? stateVal
  }

  return (
    <div>
      {/* Section header */}
      <div className='mb-3 flex items-center justify-between'>
        <span className='flex items-center gap-1.5 text-[11px] font-medium text-slate-400'>
          <Users className='h-3.5 w-3.5' />
          Owners
          {ownersLoading ? (
            <span className='inline-block h-3 w-4 animate-pulse rounded bg-slate-200' />
          ) : (
            <span className='text-slate-300'>({owners?.length ?? 0})</span>
          )}
        </span>
        {!adding && (
          <button
            type='button'
            onClick={() => setAdding(true)}
            className='flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-nvr-cyan'
          >
            <UserPlus className='h-3 w-3' />
            Add
          </button>
        )}
      </div>

      {/* Owner rows */}
      {ownersLoading ? (
        <div className='space-y-2'>
          <Skeleton className='h-8 w-full rounded-md' />
          <Skeleton className='h-8 w-3/4 rounded-md' />
        </div>
      ) : !owners || owners.length === 0 ? (
        <p className='text-[12px] text-slate-400'>No owners assigned.</p>
      ) : (
        <div className='space-y-px'>
          {owners.map((o) => (
            <div
              key={o.id}
              className='group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-50'
            >
              <span className='flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy/80'>
                {ownerInitials(o)}
              </span>
              <div className='min-w-0 flex-1'>
                <span className='block truncate text-[12px] font-medium text-slate-700'>
                  {[o.first_name, o.last_name].filter(Boolean).join(' ') || o.email}
                </span>
                <span className='block truncate text-[11px] text-slate-400'>{o.email}</span>
              </div>
              <span className='shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500'>
                {o.state ? stateLabelFor(o.state) : 'all states'}
              </span>
              <button
                type='button'
                onClick={() => removeOwner.mutate(o.id)}
                className='shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100'
              >
                <X className='h-3 w-3' />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add owner form */}
      {adding && (
        <div className='mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3'>
          <p className='text-[11px] font-semibold text-slate-500'>Add owner</p>
          <AsyncUserPicker value={userId} onChange={setUserId} />
          <MiniCombobox
            value={stateScope}
            onChange={setStateScope}
            placeholder='All states'
            noneLabel='All states'
            options={states.map((s) => ({ value: s.id, label: s.label }))}
          />
          <div className='flex items-center justify-end gap-2 pt-0.5'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              onClick={() => {
                setAdding(false)
                setUserId('')
                setStateScope('')
              }}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-7 text-[12px]'
              disabled={!userId || addOwner.isPending}
              onClick={() => addOwner.mutate()}
            >
              {addOwner.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Panel ────────────────────────────────────────────────────────────────────

interface PipelinePanelData {
  instance: PipelineInstance | null
  states: PipelineState[]
  available_transitions: PipelineTransition[]
  all_transitions: PipelineTransition[]
  history: PipelineHistoryEntry[]
  binding: { id: number; template: string; collection: string; state_field: string | null } | null
}

export function PipelinePanel({ collection, item, defaultExpanded, title, onBeforeTransition }: { collection: string; item: string; defaultExpanded?: boolean; title?: string; onBeforeTransition?: () => boolean }) {
  if (item === 'new') return null
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const trySetPending = (txId: string) => {
    if (pendingTransition === txId) { setPendingTransition(null); return }
    if (onBeforeTransition && !onBeforeTransition()) return
    setPendingTransition(txId)
  }
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])

  const queryKey = ['pipeline-instance', collection, item]

  const { data, isLoading } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      api
        .get<{ data: PipelinePanelData | null }>(`/pipelines/instance/${collection}/${item}`)
        .then(
          (r) =>
            r.data.data ?? {
              instance: null,
              states: [],
              available_transitions: [],
              all_transitions: [],
              history: [],
              binding: null
            }
        ),
    staleTime: 10_000
  })

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      const k = event.query.queryKey
      if (Array.isArray(k) && k[0] === 'item' && k[1] === collection && String(k[2]) === item) {
        queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
      }
    })
  }, [queryClient, collection, item])

  const startPipeline = useMutation({
    mutationFn: () =>
      api.post(`/pipelines/instance/${collection}/${item}/start`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success('Pipeline started')
    },
    onError: () => toast.error('Failed to start pipeline')
  })

  const executeTransition = useMutation({
    mutationFn: ({ transition_id, comment }: { transition_id: string; comment?: string }) =>
      api
        .post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment })
        .then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setComment('')
      setPendingTransition(null)
      toast.success('Transition executed')
    },
    onError: (err: unknown) => {
      const resp = (err as { response?: { status?: number; data?: { error?: string } } })?.response
      toast.error(resp?.data?.error ?? 'Failed to execute transition')
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
        setPendingTransition(null)
      }
    }
  })

  // ── Loading state ─────────────────────────────────────────────────────────
  // Return null while loading rather than a skeleton: the pipeline panel is a
  // supplementary UI element, not primary content, so it should only appear once
  // the data is ready (with content, or null when unbound). This avoids the
  // skeleton-flash where the panel renders a skeleton then vanishes on unbound
  // collections.

  if (isLoading) return null

  if (!data?.binding) return null

  const { instance, available_transitions: transitions, history, states } = data ?? {}
  const stateById = new Map((states ?? []).map((s) => [s.id, s]))
  const currentState = instance?.current_state_obj ?? null

  // Context for the confirm step
  const pendingTx = pendingTransition
    ? (transitions ?? []).find((t) => t.id === pendingTransition)
    : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null

  const hasTransitions = !instance?.completed_at && transitions && transitions.length > 0

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
      {/* ── Collapsed / header row ── */}
      <div className='flex items-center gap-3 px-4 py-2.5'>
        <GitBranch className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span className='text-[12px] font-semibold text-slate-500'>{title || 'Pipeline'}</span>
        <div className='flex items-center gap-1.5'>
          {instance?.completed_at && (
            <span className='flex items-center gap-1 text-[11px] font-medium text-emerald-600'>
              <CheckCircle2 className='h-3.5 w-3.5' />
              Completed
            </span>
          )}
          {currentState && <StateBadge label={currentState.label} color={currentState.color} />}
          {instance && !currentState && <span className='text-[12px] italic text-slate-400'>Unknown state</span>}
        </div>
        {/* Inline transition buttons when collapsed */}
        {!expanded && hasTransitions && (
          <div className='flex flex-wrap items-center gap-1.5'>
            {(() => {
              const byLabel = new Map<string, PipelineTransition[]>()
              for (const tx of transitions ?? []) {
                const list = byLabel.get(tx.label) ?? []; list.push(tx); byLabel.set(tx.label, list)
              }
              return Array.from(byLabel.entries()).map(([label, txs]) => {
                const txColor = txs[0]?.color ?? null
                const isActive = txs.some(t => t.id === pendingTransition)
                const colorStyle = (active: boolean) => txColor
                  ? active ? { backgroundColor: txColor, borderColor: txColor } : { borderColor: txColor, color: txColor }
                  : undefined
                if (txs.length === 1) {
                  const tx = txs[0]
                  return (
                    <Button key={label} size='sm' variant={isActive ? 'default' : 'outline'}
                      className='h-7 gap-1 text-[11px]' style={colorStyle(isActive)}
                      onClick={() => trySetPending(tx.id)}>
                      {label}
                    </Button>
                  )
                }
                return (
                  <DropdownMenu key={label}>
                    <DropdownMenuTrigger asChild>
                      <Button size='sm' variant={isActive ? 'default' : 'outline'}
                        className='h-7 gap-1 text-[11px]' style={colorStyle(isActive)}>
                        {label}<ChevronDown className='h-3 w-3' />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align='start'>
                      {[...txs].sort((a,b)=>(stateById.get(a.to_state)?.sort??999)-(stateById.get(b.to_state)?.sort??999)).map(tx => (
                        <DropdownMenuItem key={tx.id} onSelect={() => trySetPending(tx.id)}>
                          {tx.color && <span className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full' style={{backgroundColor:tx.color}} />}
                          {stateById.get(tx.to_state)?.label ?? tx.to_state}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              })
            })()}
          </div>
        )}
        {!expanded && !instance && data?.binding && (
          <Button size='sm' variant='outline' className='h-7 gap-1.5 text-[11px]'
            onClick={() => startPipeline.mutate()} disabled={startPipeline.isPending}>
            {startPipeline.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : <GitBranch className='h-3 w-3' />}
            Start
          </Button>
        )}
        <button type='button' onClick={() => setExpanded(v => !v)}
          className='ml-auto rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600'>
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform duration-150', expanded && 'rotate-180')} />
        </button>
      </div>

      {/* Inline confirm when collapsed */}
      {!expanded && pendingTransition && (
        <div className='border-t border-slate-100 px-4 py-3 space-y-2'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
            {pendingTx && <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>}
            {currentState && pendingToState && (
              <div className='ml-auto flex items-center gap-1.5'>
                <StateBadge label={currentState.label} color={currentState.color} small />
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={pendingToState.label} color={pendingToState.color} small />
              </div>
            )}
          </div>
          <input type='text' value={comment} onChange={e => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30' />
          <div className='flex justify-end gap-2'>
            <Button type='button' size='sm' variant='ghost' className='h-7 text-[12px]' onClick={() => setPendingTransition(null)}>Cancel</Button>
            <Button type='button' size='sm' className='h-7 gap-1.5 text-[12px]' disabled={executeTransition.isPending}
              onClick={() => executeTransition.mutate({ transition_id: pendingTransition, comment: comment.trim() || undefined })}>
              {executeTransition.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <>Confirm<Check className='h-3 w-3' /></>}
            </Button>
          </div>
        </div>
      )}

      {/* ── Expanded full panel ── */}
      {expanded && <div className='border-t border-slate-100'>

      {/* ── Body ── */}
      {!instance ? (
        /* Not started */
        <div className='flex items-center justify-between gap-4 px-5 py-4'>
          <p className='text-[13px] text-slate-500'>Pipeline not started for this record.</p>
          <Button
            size='sm'
            variant='outline'
            className='shrink-0 gap-1.5 text-[12px]'
            onClick={() => startPipeline.mutate()}
            disabled={startPipeline.isPending}
          >
            {startPipeline.isPending ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <GitBranch className='h-3.5 w-3.5' />
            )}
            Start Pipeline
          </Button>
        </div>
      ) : (
        <div className='divide-y divide-slate-100'>
          {/* ── State track ── */}
          {(states ?? []).length > 1 && (
            <div className='px-5 py-4'>
              <StateTrack
                states={states ?? []}
                allTransitions={data?.all_transitions ?? []}
                availableTransitions={transitions ?? []}
                currentStateId={instance.current_state}
                history={history ?? []}
              />
            </div>
          )}

          {/* ── Owners ── */}
          <div className='px-5 py-4'>
            <OwnersSection collection={collection} item={item} states={states ?? []} />
          </div>

          {/* ── Transitions ── */}
          {hasTransitions && (
            <div className='space-y-3 px-5 py-4'>
              <div className='flex flex-wrap gap-2'>
                {(() => {
                  const byLabel = new Map<string, PipelineTransition[]>()
                  for (const tx of transitions) {
                    const list = byLabel.get(tx.label) ?? []
                    list.push(tx)
                    byLabel.set(tx.label, list)
                  }
                  return Array.from(byLabel.entries()).map(([label, txs]) => {
                    const txColor = txs[0]?.color ?? null
                    const isActive = txs.some((t) => t.id === pendingTransition)
                    const colorStyle = (active: boolean) =>
                      txColor
                        ? active
                          ? { backgroundColor: txColor, borderColor: txColor }
                          : { borderColor: txColor, color: txColor }
                        : undefined

                    if (txs.length === 1) {
                      const tx = txs[0]
                      return (
                        <Button
                          key={label}
                          size='sm'
                          variant={isActive ? 'default' : 'outline'}
                          className='gap-1.5 text-[12px]'
                          style={colorStyle(isActive)}
                          onClick={() =>
                            trySetPending(tx.id)
                          }
                        >
                          {label}
                        </Button>
                      )
                    }

                    const sortedTxs = [...txs].sort(
                      (a, b) => (stateById.get(a.to_state)?.sort ?? 999) - (stateById.get(b.to_state)?.sort ?? 999)
                    )
                    const toStateCount = new Map<string, number>()
                    for (const tx of sortedTxs) {
                      toStateCount.set(tx.to_state, (toStateCount.get(tx.to_state) ?? 0) + 1)
                    }

                    return (
                      <DropdownMenu key={label}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size='sm'
                            variant={isActive ? 'default' : 'outline'}
                            className='gap-1.5 text-[12px]'
                            style={colorStyle(isActive)}
                          >
                            {label}
                            <ChevronDown className='h-3 w-3' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='start'>
                          {sortedTxs.map((tx) => {
                            const toLabel = stateById.get(tx.to_state)?.label ?? tx.to_state
                            const fromLabel = tx.from_state
                              ? (stateById.get(tx.from_state)?.label ?? tx.from_state)
                              : null
                            const hasCollision = (toStateCount.get(tx.to_state) ?? 0) > 1
                            const hasConditions =
                              tx.condition_rules != null && tx.condition_rules.length > 0
                            return (
                              <DropdownMenuItem
                                key={tx.id}
                                onSelect={() =>
                                  setPendingTransition(
                                    pendingTransition === tx.id ? null : tx.id
                                  )
                                }
                              >
                                {tx.color && (
                                  <span
                                    className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                                    style={{ backgroundColor: tx.color }}
                                  />
                                )}
                                <span className='flex items-center gap-1.5'>
                                  {toLabel}
                                  {hasCollision && fromLabel && (
                                    <span className='text-[11px] text-slate-400'>
                                      from {fromLabel}
                                    </span>
                                  )}
                                  {hasConditions && (
                                    <span
                                      className='text-[11px] text-amber-500'
                                      title='Has conditions'
                                    >
                                      ⚡
                                    </span>
                                  )}
                                </span>
                              </DropdownMenuItem>
                            )
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  })
                })()}
              </div>

              {/* Confirm step */}
              {pendingTransition && (
                <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
                    {pendingTx && (
                      <span className='text-[12px] font-medium text-slate-700'>
                        {pendingTx.label}
                      </span>
                    )}
                    {currentState && pendingToState && (
                      <div className='ml-auto flex items-center gap-1.5'>
                        <StateBadge
                          label={currentState.label}
                          color={currentState.color}
                          small
                        />
                        <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                        <StateBadge
                          label={pendingToState.label}
                          color={pendingToState.color}
                          small
                        />
                      </div>
                    )}
                  </div>
                  <input
                    type='text'
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder='Add a comment (optional)'
                    className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
                  />
                  <div className='flex items-center justify-end gap-2'>
                    <Button
                      type='button'
                      size='sm'
                      variant='ghost'
                      className='h-7 text-[12px]'
                      onClick={() => setPendingTransition(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      className='h-7 gap-1.5 text-[12px]'
                      disabled={executeTransition.isPending}
                      onClick={() =>
                        executeTransition.mutate({
                          transition_id: pendingTransition,
                          comment: comment.trim() || undefined
                        })
                      }
                    >
                      {executeTransition.isPending ? (
                        <Loader2 className='h-3.5 w-3.5 animate-spin' />
                      ) : (
                        <>
                          Confirm
                          <Check className='h-3 w-3' />
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── History ── */}
          <div className='px-5 py-3'>
            <button
              type='button'
              className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-slate-600'
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? (
                <ChevronDown className='h-3.5 w-3.5' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5' />
              )}
              Transition history
              <span className='tabular-nums'>({history?.length ?? 0})</span>
            </button>
            {showHistory && (
              <div className='mt-3'>
                <HistoryTimeline history={history ?? []} />
              </div>
            )}
          </div>
        </div>
      )}
      </div>}
    </div>
  )
}

export function PipelineTransitionButtons({ collection, item, onBeforeTransition }: { collection: string; item: string; onBeforeTransition?: () => boolean }) {
  if (item === 'new') return null
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const trySetPending = (txId: string) => {
    if (pendingTransition === txId) { setPendingTransition(null); return }
    if (onBeforeTransition && !onBeforeTransition()) return
    setPendingTransition(txId)
  }

  const queryKey = ['pipeline-instance', collection, item]

  const { data } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      api.get<{ data: PipelinePanelData | null }>(`/pipelines/instance/${collection}/${item}`)
        .then(r => r.data.data ?? { instance: null, states: [], available_transitions: [], all_transitions: [], history: [], binding: null }),
    staleTime: 10_000
  })

  const executeTransition = useMutation({
    mutationFn: ({ transition_id, comment }: { transition_id: string; comment?: string }) =>
      api.post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setComment('')
      setPendingTransition(null)
      toast.success('Transition executed')
    },
    onError: (err: unknown) => {
      const resp = (err as { response?: { status?: number; data?: { error?: string } } })?.response
      toast.error(resp?.data?.error ?? 'Failed to execute transition')
      if (resp?.status === 409) { queryClient.invalidateQueries({ queryKey }); setPendingTransition(null) }
    }
  })

  if (!data?.binding || !data?.instance || data.instance.completed_at) return null

  const transitions = data.available_transitions ?? []
  if (transitions.length === 0) return null

  const stateById = new Map((data.states ?? []).map(s => [s.id, s]))
  const currentState = data.instance.current_state_obj ?? null
  const pendingTx = pendingTransition ? transitions.find(t => t.id === pendingTransition) : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null

  const byLabel = new Map<string, PipelineTransition[]>()
  for (const tx of transitions) {
    const list = byLabel.get(tx.label) ?? []
    list.push(tx)
    byLabel.set(tx.label, list)
  }

  return (
    <div className='space-y-2'>
      <div className='flex flex-wrap gap-2'>
        {Array.from(byLabel.entries()).map(([label, txs]) => {
          const txColor = txs[0]?.color ?? null
          const isActive = txs.some(t => t.id === pendingTransition)
          const colorStyle = (active: boolean) => txColor
            ? active ? { backgroundColor: txColor, borderColor: txColor } : { borderColor: txColor, color: txColor }
            : undefined

          if (txs.length === 1) {
            const tx = txs[0]
            return (
              <Button key={label} size='sm' variant={isActive ? 'default' : 'outline'} className='gap-1.5 text-[12px]'
                style={colorStyle(isActive)} onClick={() => trySetPending(tx.id)}>
                {label}
              </Button>
            )
          }

          const sorted = [...txs].sort((a, b) => (stateById.get(a.to_state)?.sort ?? 999) - (stateById.get(b.to_state)?.sort ?? 999))
          return (
            <DropdownMenu key={label}>
              <DropdownMenuTrigger asChild>
                <Button size='sm' variant={isActive ? 'default' : 'outline'} className='gap-1.5 text-[12px]' style={colorStyle(isActive)}>
                  {label}<ChevronDown className='h-3 w-3' />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='start'>
                {sorted.map(tx => (
                  <DropdownMenuItem key={tx.id} onSelect={() => trySetPending(tx.id)}>
                    {tx.color && <span className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full' style={{ backgroundColor: tx.color }} />}
                    {stateById.get(tx.to_state)?.label ?? tx.to_state}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
      </div>

      {pendingTransition && (
        <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
            {pendingTx && <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>}
            {currentState && pendingToState && (
              <div className='ml-auto flex items-center gap-1.5'>
                <StateBadge label={currentState.label} color={currentState.color} small />
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={pendingToState.label} color={pendingToState.color} small />
              </div>
            )}
          </div>
          <input type='text' value={comment} onChange={e => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30' />
          <div className='flex items-center justify-end gap-2'>
            <Button type='button' size='sm' variant='ghost' className='h-7 text-[12px]' onClick={() => setPendingTransition(null)}>Cancel</Button>
            <Button type='button' size='sm' className='h-7 gap-1.5 text-[12px]' disabled={executeTransition.isPending}
              onClick={() => executeTransition.mutate({ transition_id: pendingTransition, comment: comment.trim() || undefined })}>
              {executeTransition.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : <>Confirm<Check className='h-3 w-3' /></>}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
