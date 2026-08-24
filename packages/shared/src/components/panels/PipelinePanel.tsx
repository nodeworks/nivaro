import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, ChevronDown, GitBranch, Loader2, Minus, Search, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { OwnerAvatars } from '../queue/OwnerAvatars'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import {
  TransitionRequirementsDialog,
  type TransitionRequirementsPayload
} from './TransitionRequirementsDialog'

// ─── Types ────────────────────────────────────────────────────────────────────

interface PipelineState {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  is_initial: boolean
  is_terminal: boolean
  stage_visibility?: string | null
  description?: string | null
}
interface PipelineTransition {
  id: string
  label: string
  color: string | null
  to_state: string
  from_state: string | null
  group_label: string | null
  condition_rules?: unknown[]
}
interface PipelineHistoryEntry {
  id: number
  from_state: string | null
  to_state: string
  from_state_label: string
  to_state_label: string
  from_state_color: string | null
  to_state_color: string | null
  user_email: string | null
  first_name: string | null
  last_name: string | null
  comment: string | null
  timestamp: string
}
interface PipelineInstance {
  id: string
  current_state: string
  current_state_obj: PipelineState | null
  completed_at: string | null
}
interface PipelineInstanceOwner {
  id: number
  user: string
  first_name: string | null
  last_name: string | null
  email: string
  state: string | null
}
interface PipelinePanelData {
  instance: PipelineInstance | null
  states: PipelineState[]
  available_transitions: PipelineTransition[]
  all_transitions: PipelineTransition[]
  history: PipelineHistoryEntry[]
  binding: { id: number; template: string; collection: string; state_field: string | null } | null
}
interface RequirementsDialogState {
  payload: TransitionRequirementsPayload
  transitionId: string
  comment?: string
  /** Bumped on every 422 payload (initial and retry) — keys the dialog so a
   *  retry's fresh payload remounts it with reseeded state; >1 means retry. */
  revision: number
}

// Shared by both executeTransition mutations below: pulls the 422 requirements
// payload out of a failed transition request, or null when the failure is
// something else (409 conflict, permission error, etc).
export function transitionRequirementsFromError(err: unknown): TransitionRequirementsPayload | null {
  const e = err as {
    status?: number
    response?: { error?: string; requirements?: TransitionRequirementsPayload }
  }
  if (e?.status === 422 && e.response?.error === 'TRANSITION_REQUIREMENTS') {
    return e.response.requirements ?? []
  }
  return null
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
      key={label}
      className={`nvr-state-pulse inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-300 ${size}`}
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

// ─── State track ─────────────────────────────────────────────────────────────

/**
 * Time-in-step bar — where the record's calendar time actually went. Each
 * segment is one stay in a state (a send-back produces a second, separate
 * segment for the same state — deliberately honest), width proportional to
 * duration, ending at now for the current stay. Built purely from the history
 * the panel already fetched; no extra requests. Hidden until there are at
 * least two segments — a single open stay carries no comparison.
 */
function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

function StateDurationTimeline({
  history,
  completedAt
}: {
  history: PipelineHistoryEntry[]
  completedAt: string | null
}) {
  const ordered = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  if (ordered.length === 0) return null
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const segments = ordered
    .map((h, i) => {
      const start = new Date(h.timestamp).getTime()
      const stop = i + 1 < ordered.length ? new Date(ordered[i + 1].timestamp).getTime() : end
      return {
        key: h.id,
        label: h.to_state_label,
        color: h.to_state_color,
        ms: Math.max(0, stop - start),
        current: i === ordered.length - 1 && !completedAt
      }
    })
    .filter((seg) => seg.ms > 0 || seg.current)
  if (segments.length < 2) return null
  const total = segments.reduce((sum, seg) => sum + seg.ms, 0)
  if (total <= 0) return null

  return (
    <div data-state-timeline>
      <div className='mb-1 flex items-center justify-between'>
        <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
          Time in step
        </p>
        <p className='text-[10px] tabular-nums text-slate-400 dark:text-slate-500'>
          {fmtDur(total)} total{completedAt ? '' : ' · so far'}
        </p>
      </div>
      <div className='flex h-4 w-full overflow-hidden rounded'>
        {segments.map((seg) => {
          const pct = (seg.ms / total) * 100
          return (
            <div
              key={seg.key}
              data-tip={`${seg.label} — ${fmtDur(seg.ms)}${seg.current ? ' (current)' : ''}`}
              className='relative flex min-w-[8px] items-center overflow-hidden border-r border-white/60 last:border-r-0 dark:border-black/30'
              style={{
                width: `${pct}%`,
                backgroundColor: seg.color ? `${seg.color}55` : 'rgba(100,116,139,.25)'
              }}
            >
              {pct >= 14 && (
                <span className='truncate px-1.5 text-[9.5px] font-medium leading-none text-slate-700 dark:text-slate-200'>
                  {seg.label} · {fmtDur(seg.ms)}
                </span>
              )}
              {seg.current && (
                <span
                  className='absolute inset-y-0 right-0 w-[2px]'
                  style={{ backgroundColor: seg.color ?? '#64748b' }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StateTrack({
  states,
  allTransitions,
  availableTransitions,
  currentStateId,
  history,
  onPathIds,
  skippedStates
}: {
  states: PipelineState[]
  allTransitions: PipelineTransition[]
  availableTransitions: PipelineTransition[]
  currentStateId: string | null
  history: PipelineHistoryEntry[]
  /** Server-computed relevant-state ids (condition-aware branch pruning from
   *  /owners/all). null while loading — the client BFS below is the fallback. */
  onPathIds?: Set<string> | null
  /** State id → why the engine will skip it. null while loading. */
  skippedStates?: Map<string, string[]> | null
}) {
  const visitedIds = new Set(history.map((h) => h.to_state))
  // The initial state is never any transition's destination, so history alone
  // never marks it — leaving "Started" hollow on a record that plainly
  // started. Every record passed through it; the only time it is not done is
  // when the record is sitting in it right now.
  const initialState = states.find((s) => s.is_initial)
  if (initialState && initialState.id !== currentStateId) visitedIds.add(initialState.id)
  const firstFrom = history[0]?.from_state
  if (firstFrom && firstFrom !== currentStateId) visitedIds.add(firstFrom)
  const relevant = (() => {
    // Server relevance (owners/all on_path) is authoritative when loaded — it
    // is condition-aware and understands skip-jump history edges; the client
    // BFS below dead-ends on both (kept only as a fallback while loading).
    if (onPathIds) {
      return states
        .filter((s) => onPathIds.has(s.id) || visitedIds.has(s.id) || s.id === currentStateId)
        .filter((s) => {
          const v = s.stage_visibility ?? 'always'
          if (v === 'hide') return false
          if (v === 'hide_unless_active') return visitedIds.has(s.id) || s.id === currentStateId
          return true
        })
        .sort((a, b) => a.sort - b.sort)
    }
    if (allTransitions.length === 0) {
      const show = new Set([...visitedIds])
      if (currentStateId) show.add(currentStateId)
      return states.filter((s) => show.has(s.id)).sort((a, b) => a.sort - b.sort)
    }
    const takenEdges = new Set(
      history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
    )
    const visitedFromIds = new Set(history.map((h) => h.from_state).filter(Boolean) as string[])
    const explicit = allTransitions.filter((t) => t.from_state !== null)
    const fwd = new Map<string, string[]>()
    for (const t of explicit) {
      const fromId = t.from_state!
      if (visitedFromIds.has(fromId) && !takenEdges.has(`${fromId}:${t.to_state}`)) continue
      const arr = fwd.get(fromId) ?? []
      arr.push(t.to_state)
      fwd.set(fromId, arr)
    }
    if (currentStateId) {
      // Available transitions alone can dead-end the track: auto transitions
      // and condition-gated ones (e.g. Submit hidden until an order number is
      // entered) never appear in `available`, so union in the template's own
      // explicit edges from the current state — a hidden button is a pending
      // path, not a missing one.
      const explicitFromCurrent = explicit
        .filter((t) => t.from_state === currentStateId)
        .map((t) => t.to_state)
      fwd.set(currentStateId, [
        ...new Set([...availableTransitions.map((t) => t.to_state), ...explicitFromCurrent])
      ])
    }
    const pathIds = new Set<string>()
    const queue = states.filter((s) => s.is_initial).map((s) => s.id)
    while (queue.length) {
      const id = queue.shift()!
      if (pathIds.has(id)) continue
      pathIds.add(id)
      for (const next of fwd.get(id) ?? []) if (!pathIds.has(next)) queue.push(next)
    }
    const show = new Set([...pathIds, ...visitedIds])
    if (currentStateId) show.add(currentStateId)
    return states
      .filter((s) => show.has(s.id))
      .filter((s) => {
        const v = s.stage_visibility ?? 'always'
        if (v === 'hide') return false
        if (v === 'hide_unless_active') return visitedIds.has(s.id) || s.id === currentStateId
        return true
      })
      .sort((a, b) => a.sort - b.sort)
  })()
  if (relevant.length < 2) return null

  // Who moved the record across this gap. Position-based, not exact-pair:
  // a transition that SKIPS steps (manager approval jumping straight to VP)
  // has no adjacent-pair edge, so exact matching silently dropped the
  // approver's initials from the track (Rob's transition.png report). A
  // forward hop annotates the segment leaving its ORIGIN; a send-back the
  // segment beside its destination — one attribution per hop, never one per
  // crossed segment (that would read as three approvals).
  const trackIndex = new Map(relevant.map((st, i) => [st.id, i]))
  const labelOf = new Map(states.map((st) => [st.id, st.label]))
  function edgeEntries(fromId: string, _toId: string) {
    const i = trackIndex.get(fromId)
    if (i == null) return []
    return [...history]
      .filter((h) => {
        if (!h.from_state) return false
        const f = trackIndex.get(h.from_state)
        const t = trackIndex.get(h.to_state)
        if (f == null || t == null) return false
        return (f === i && t > i) || (t === i && f > i)
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }
  function entryInitials(h: PipelineHistoryEntry) {
    return (
      ((h.first_name?.[0] ?? '') + (h.last_name?.[0] ?? '')).toUpperCase() ||
      h.user_email?.[0]?.toUpperCase() ||
      '?'
    )
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
          const skipReasons = !isVisited && !isCurrent ? skippedStates?.get(s.id) : undefined
          const isSkipped = skipReasons !== undefined
          const nodeColor = s.color ?? '#94a3b8'
          const isLast = i === relevant.length - 1
          const nextState = !isLast ? relevant[i + 1] : null
          const edge = nextState ? edgeEntries(s.id, nextState.id) : []
          return (
            <div key={s.id} className='flex min-w-[48px] flex-1 items-start'>
              <div className='flex min-w-0 flex-1 flex-col items-center gap-1.5 px-1'>
                <div
                  key={isCurrent ? 'cur' : isDone ? 'done' : isSkipped ? 'skip' : 'todo'}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    isCurrent || isDone ? 'nvr-fill-sweep' : ''
                  }`}
                  // Per-state help text (#81) — instant tip via TipLayer.
                  data-tip={s.description || undefined}
                  style={{
                    backgroundColor: isCurrent || isDone ? nodeColor : isSkipped ? 'transparent' : '#f1f5f9',
                    border: isCurrent || isDone
                      ? 'none'
                      : isSkipped
                        ? '1.5px dashed #cbd5e1'
                        : '1.5px solid #e2e8f0',
                    boxShadow: isCurrent ? `0 0 0 3px white, 0 0 0 5px ${nodeColor}` : undefined
                  }}
                >
                  {isDone ? (
                    <Check className='h-3.5 w-3.5 text-white' strokeWidth={2.5} />
                  ) : isCurrent ? (
                    <div className='h-2.5 w-2.5 rounded-full bg-white/80' />
                  ) : isSkipped ? (
                    <Minus className='h-3 w-3 text-slate-400' strokeWidth={2.5} />
                  ) : (
                    <div className='h-2 w-2 rounded-full bg-slate-300' />
                  )}
                </div>
                {isSkipped ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className='w-full cursor-help break-words text-center leading-snug'
                        style={{
                          fontSize: '11px',
                          color: '#94a3b8',
                          fontWeight: 400,
                          wordBreak: 'break-word',
                          textDecoration: 'line-through',
                          textDecorationColor: '#cbd5e1'
                        }}
                      >
                        {s.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className='max-w-[260px]'>
                      <p className='text-[11px] font-medium'>Skipped for this record</p>
                      {skipReasons.length > 0 ? (
                        <ul className='mt-1 space-y-0.5 text-[11px] opacity-90'>
                          {skipReasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className='mt-1 text-[11px] opacity-90'>
                          Its skip conditions are met.
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : (
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
                )}
              </div>
              {!isLast && (
                <div className='mt-[13px] flex w-10 shrink-0 flex-col items-center gap-1.5'>
                  {(() => {
                    const lineColor = isDone ? `${nodeColor}55` : '#e8ecf0'
                    return (
                      <div className='flex w-full shrink-0 items-center'>
                        <div
                          className='h-0.5 flex-1 rounded-l-sm'
                          style={{ backgroundColor: lineColor }}
                        />
                        <div
                          style={{
                            width: 0,
                            height: 0,
                            borderTop: '3px solid transparent',
                            borderBottom: '3px solid transparent',
                            borderLeft: `5px solid ${lineColor}`
                          }}
                        />
                      </div>
                    )
                  })()}
                  {edge.map((h) => {
                    const isSendback = h.from_state !== s.id
                    const hopSpan =
                      Math.abs(
                        (trackIndex.get(h.to_state) ?? 0) -
                          (trackIndex.get(h.from_state ?? '') ?? 0)
                      ) > 1
                        ? (labelOf.get(h.to_state) ?? '')
                        : null
                    return (
                      <Tooltip key={h.id}>
                        <TooltipTrigger asChild>
                          <div className='flex w-full cursor-default flex-col items-center gap-0.5'>
                            <span
                              className='text-center font-mono text-[9px] font-semibold leading-none'
                              style={{ color: isSendback ? '#d97706' : '#475569' }}
                            >
                              {isSendback && '↩ '}
                              {entryInitials(h)}
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
                          {hopSpan && (
                            <p className='text-muted-foreground'>→ straight to {hopSpan}</p>
                          )}
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

// ─── History timeline ─────────────────────────────────────────────────────────

function HistoryTimeline({ history }: { history: PipelineHistoryEntry[] }) {
  if (history.length === 0)
    return <p className='text-[12px] text-slate-400 italic'>No transitions yet.</p>
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
              {h.comment && <p className='mt-1 text-slate-500 italic'>"{h.comment}"</p>}
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

// ─── Async user picker ────────────────────────────────────────────────────────

function AsyncUserPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const client = useNivaroClient()
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

  type User = { id: string; first_name: string | null; last_name: string | null; email: string }
  const { data, isLoading } = useQuery<User[]>({
    queryKey: ['users', 'async-search', debouncedQuery],
    queryFn: () =>
      client
        .request<{ data: User[]; total: number }>(
          get('/users', {
            limit: 50,
            sort: 'first_name',
            ...(debouncedQuery ? { search: debouncedQuery } : {})
          })
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000
  })
  const { data: selectedUser } = useQuery<User | null>({
    queryKey: ['users', 'single', value],
    queryFn: () => client.request<{ data: User }>(get(`/users/${value}`)).then((r) => r.data),
    enabled: !!value,
    staleTime: 5 * 60_000
  })
  const selectedLabel = selectedUser
    ? [selectedUser.first_name, selectedUser.last_name].filter(Boolean).join(' ').trim() ||
      selectedUser.email
    : value || null
  const users = data ?? []
  const nameOf = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim()

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
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
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
              const name = nameOf(u)
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

// ─── Owners section ───────────────────────────────────────────────────────────

function OwnersSection({
  collection,
  item,
  states,
  currentStateId
}: {
  collection: string
  item: string
  states: PipelineState[]
  currentStateId?: string | null
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [stateScope, setStateScope] = useState('')
  const [scopeOpen, setScopeOpen] = useState(false)
  const ownersKey = ['pipeline-instance-owners', collection, item]

  const { data: owners, isLoading: ownersLoading } = useQuery<PipelineInstanceOwner[]>({
    queryKey: ownersKey,
    queryFn: () =>
      client
        .request<{ data: PipelineInstanceOwner[] }>(
          get(`/pipelines/instance/${collection}/${item}/owners`)
        )
        .then((r) => r.data)
  })

  // Resolved owners per state (owner-group derived) — same key/data as the
  // Approval Chain popover, so the cache is shared between the two.
  const { data: allOwners, isLoading: groupOwnersLoading } = useQuery<Record<
    string,
    AllOwnersEntry
  > | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    enabled: !!currentStateId,
    staleTime: 30_000
  })

  // Group-derived owners for the CURRENT state, minus anyone already listed as
  // a manual assignment — manual rows carry the state chip + remove button.
  const manualUserIds = new Set((owners ?? []).map((o) => o.user))
  const groupOwners = currentStateId
    ? (allOwners?.[currentStateId]?.owners ?? []).filter((o) => !manualUserIds.has(o.id))
    : []

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ownersKey })
    queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
  }

  const addOwner = useMutation({
    mutationFn: () =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/owners`, {
          user: userId,
          state: stateScope || undefined
        })
      ),
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
    mutationFn: (id: number) => client.request(del(`/pipelines/instance-owners/${id}`)),
    onSuccess: () => {
      invalidate()
      toast.success('Owner removed')
    },
    onError: () => toast.error('Failed to remove owner')
  })

  const ownerInitials = (o: PipelineInstanceOwner) => {
    const f = o.first_name?.[0] ?? ''
    const l = o.last_name?.[0] ?? ''
    return (`${f}${l}`.trim() || o.email[0] || '?').toUpperCase()
  }
  const stateLabelFor = (v: string | null) => {
    if (!v) return null
    return states.find((s) => s.id === v || s.key === v)?.label ?? v
  }

  return (
    <div>
      <div className='mb-3 flex items-center justify-between'>
        <span className='flex items-center gap-1.5 text-[11px] font-medium text-slate-400'>
          <Users className='h-3.5 w-3.5' />
          Owners
          {ownersLoading || groupOwnersLoading ? (
            <span className='inline-block h-3 w-4 animate-pulse rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
          ) : (
            <span className='text-slate-300'>({groupOwners.length + (owners?.length ?? 0)})</span>
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
      {ownersLoading || groupOwnersLoading ? (
        <div className='flex items-center gap-2 py-1.5 text-[12px] text-slate-400'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          Resolving owners…
        </div>
      ) : groupOwners.length === 0 && (!owners || owners.length === 0) ? (
        <p className='text-[12px] text-slate-400'>No owners assigned.</p>
      ) : (
        <div className='space-y-px'>
          {groupOwners.map((o) => {
            const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
            const initials = (
              `${o.first_name?.[0] ?? ''}${o.last_name?.[0] ?? ''}`.trim() ||
              o.email[0] ||
              '?'
            ).toUpperCase()
            return (
              <div
                key={`group-${o.id}`}
                className='-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-50'
              >
                <span className='flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy/80'>
                  {initials}
                </span>
                <div className='min-w-0 flex-1'>
                  <span className='block truncate text-[12px] font-medium text-slate-700'>
                    {name}
                  </span>
                  <span className='block truncate text-[11px] text-slate-400'>{o.email}</span>
                </div>
                <span className='shrink-0 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy/70 dark:text-nvr-cyan'>
                  owner group
                </span>
              </div>
            )
          })}
          {(owners ?? []).map((o) => (
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
              <span className='shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'>
                manual
              </span>
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
      {adding && (
        <div className='mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-border p-3'>
          <p className='text-[11px] font-semibold text-slate-500'>Add owner</p>
          <AsyncUserPicker value={userId} onChange={setUserId} />
          <Popover open={scopeOpen} onOpenChange={setScopeOpen}>
            <PopoverTrigger asChild>
              <button
                type='button'
                className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 transition-colors hover:border-slate-300 dark:border-border dark:bg-transparent dark:text-slate-300'
              >
                <span className='truncate'>
                  {stateScope
                    ? (states.find((s) => s.id === stateScope)?.label ?? stateScope)
                    : 'All states'}
                </span>
                <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
              </button>
            </PopoverTrigger>
            <PopoverContent align='start' sideOffset={4} className='w-52 p-1'>
              {(['', ...states.map((s) => s.id)] as string[]).map((id) => {
                const label =
                  id === '' ? 'All states' : (states.find((s) => s.id === id)?.label ?? id)
                const active = stateScope === id
                return (
                  <button
                    key={id}
                    type='button'
                    className={cn(
                      'flex w-full rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-slate-50 dark:hover:bg-white/5',
                      active && 'font-medium text-slate-800 dark:text-slate-200'
                    )}
                    onClick={() => {
                      setStateScope(id)
                      setScopeOpen(false)
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </PopoverContent>
          </Popover>
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

// ─── Approval Chain View ──────────────────────────────────────────────────────

interface AllOwnersEntry {
  state: PipelineState
  owners: Array<{ id: string; email: string; first_name: string | null; last_name: string | null }>
  /** Server-predicted: this state's skip criteria currently evaluate true
   *  (no resolved owners, threshold conditions, lookup_compare…) — the
   *  pipeline will pass straight through it. */
  skipped?: boolean
  /** Human sentences explaining WHY the skip criteria match right now
   *  (e.g. "requisition amount (14,560) is below the threshold amount of 25,000"). */
  skip_reasons?: string[]
  /** Server-computed: this state is on the record's actual path — reachable
   *  from the initial state through the taken history edges and any branch
   *  edges whose conditions this record satisfies. false = another branch's
   *  state (e.g. Beeline submission on an Oracle-path workflow); hide it. */
  on_path?: boolean
}

function ApprovalChainView({
  collection,
  item,
  states,
  currentStateId
}: {
  collection: string
  item: string
  states: PipelineState[]
  currentStateId?: string | null
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery<Record<string, AllOwnersEntry> | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    enabled: open,
    staleTime: 30_000
  })

  // Only the record's actual path — other branches' states (on_path false)
  // are noise here. Legacy responses without the flag show everything.
  const sorted = [...states]
    .filter((s) => !data || data[s.id]?.on_path !== false)
    .sort((a, b) => a.sort - b.sort)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='View approval chain'
          className='flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
          onClick={(e) => e.stopPropagation()}
        >
          <Users className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[576px] p-0 overflow-hidden'>
        <div className='border-b border-slate-100 px-4 py-3'>
          <p className='text-[12px] font-semibold text-slate-700'>Approval Chain</p>
          <p className='text-[11px] text-slate-400 mt-0.5'>Owners per pipeline state</p>
        </div>
        <div className='max-h-[504px] overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-px p-3'>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : !data ? (
            <p className='px-4 py-3 text-[12px] text-slate-400'>No pipeline configured.</p>
          ) : (
            <div className='divide-y divide-slate-100 dark:divide-border/60'>
              {sorted.map((s) => {
                const owners = (data[s.id]?.owners ?? []).map((o) => ({
                  id: o.id,
                  name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
                }))
                const isCurrent = s.id === currentStateId
                const isSkipped = data[s.id]?.skipped === true && !isCurrent
                const skipReasons = (data[s.id]?.skip_reasons ?? []).filter(Boolean)
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5',
                      // Hex-with-alpha rather than bg-nvr-cyan/N — the
                      // nvr-cyan token is an opaque var() so Tailwind silently
                      // drops opacity modifiers on it. Kept very light so the
                      // tint doesn't clash with the state badge's own color.
                      isCurrent && 'bg-[#00ceff0f] dark:bg-[#00ceff1c]',
                      isSkipped && 'opacity-60'
                    )}
                  >
                    <StateBadge label={s.label} color={s.color} small />
                    <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5'>
                      {isSkipped ? (
                        // Radix tooltip with zero delay — native `title` waits on
                        // the OS hover timer, and a truncated reason needs its
                        // full text the moment the cursor lands on it.
                        <TooltipProvider delayDuration={0}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className='flex min-w-0 flex-1 cursor-default items-center gap-2'>
                                <span className='inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10.5px] font-medium text-slate-400 dark:border-slate-600 dark:text-slate-500'>
                                  Skipped
                                </span>
                                {skipReasons.length > 0 && (
                                  <span className='min-w-0 flex-1 truncate text-[11px] text-slate-400 dark:text-slate-500'>
                                    {skipReasons.join(' · ')}
                                  </span>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side='bottom'
                              align='start'
                              className='max-w-[420px] space-y-0.5 text-[11.5px] leading-snug'
                            >
                              <p className='text-slate-500 dark:text-slate-400'>
                                The pipeline will pass through this state without stopping:
                              </p>
                              {skipReasons.length > 0 ? (
                                skipReasons.map((r) => <p key={r}>{r}</p>)
                              ) : (
                                <p>Skip criteria currently match</p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <OwnerAvatars owners={owners} max={10} emptyLabel='—' />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Pipeline Panel ───────────────────────────────────────────────────────────

export function PipelinePanel({
  collection,
  item,
  defaultExpanded,
  title,
  showApprovalChain,
  onBeforeTransition,
  addendumPending,
  addendumView
}: {
  collection: string
  item: string
  defaultExpanded?: boolean
  title?: string
  showApprovalChain?: boolean
  onBeforeTransition?: () => boolean | Promise<boolean>
  addendumPending?: boolean
  addendumView?: boolean
}) {
  if (item === 'new') return null
  return (
    <PipelinePanelInner
      key={`${collection}:${item}`}
      collection={collection}
      item={item}
      defaultExpanded={defaultExpanded}
      title={title}
      showApprovalChain={showApprovalChain}
      onBeforeTransition={onBeforeTransition}
      addendumPending={addendumPending}
      addendumView={addendumView}
    />
  )
}

/**
 * "What am I approving?" — the change summary for the state the approver is
 * signing off on. Fetched only while a transition confirm is open; a record
 * untouched since entering the state renders one quiet line rather than
 * nothing, because "no changes" is itself the answer.
 */
function ApprovalBriefStrip({ collection, item }: { collection: string; item: string | number }) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['approval-brief', collection, String(item)],
    queryFn: () =>
      client
        .request<{
          data: {
            entered_at: string
            days_in_state: number
            revisions: number
            field_changes: Array<{ field: string; old?: unknown; new: unknown }>
            changed_total: number
            comments: number
            addendums: { count: number; cost_impact: number }
            edited_by: string[]
          } | null
        }>(get(`/pipelines/instance/${collection}/${item}/approval-brief`))
        .then((r) => r.data),
    staleTime: 30_000,
    retry: false
  })
  if (!data) return null

  const fmt = (v: unknown) => {
    if (v === null || v === undefined || v === '') return '—'
    const s = String(v)
    return s.length > 36 ? `${s.slice(0, 36)}…` : s
  }

  return (
    <div className='rounded-md border border-slate-200 bg-white px-3 py-2 text-[11.5px] dark:border-border dark:bg-card'>
      <p className='text-slate-500 dark:text-muted-foreground'>
        <span className='font-medium text-slate-700 dark:text-foreground'>
          Since entering this state
        </span>{' '}
        ({data.days_in_state}d ago):{' '}
        {data.changed_total === 0 && data.comments === 0 && data.addendums.count === 0 ? (
          <span>no changes to this record.</span>
        ) : (
          <>
            {data.changed_total > 0 && (
              <span>
                {data.changed_total} field{data.changed_total === 1 ? '' : 's'} changed
                {data.edited_by.length > 0 ? ` by ${data.edited_by.join(', ')}` : ''}
              </span>
            )}
            {data.comments > 0 && (
              <span>
                {data.changed_total > 0 ? ' · ' : ''}
                {data.comments} comment{data.comments === 1 ? '' : 's'}
              </span>
            )}
            {data.addendums.count > 0 && (
              <span>
                {' · '}
                {data.addendums.count} addendum{data.addendums.count === 1 ? '' : 's'}
                {data.addendums.cost_impact !== 0
                  ? ` (${data.addendums.cost_impact > 0 ? '+' : ''}$${Math.abs(data.addendums.cost_impact).toLocaleString()})`
                  : ''}
              </span>
            )}
          </>
        )}
      </p>
      {data.field_changes.length > 0 && (
        <div className='mt-1 space-y-0.5'>
          {data.field_changes.slice(0, 5).map((f) => (
            <p key={f.field} className='font-mono text-[10.5px] text-slate-500 dark:text-muted-foreground'>
              {f.field}:{' '}
              {f.old !== undefined && (
                <>
                  <span className='text-red-600 line-through dark:text-red-400'>{fmt(f.old)}</span>{' '}
                </>
              )}
              <span className='text-emerald-600 dark:text-emerald-400'>{fmt(f.new)}</span>
            </p>
          ))}
          {data.field_changes.length > 5 && (
            <p className='text-[10.5px] text-slate-400'>
              +{data.field_changes.length - 5} more — see History for the full trail
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PipelinePanelInner({
  collection,
  item,
  defaultExpanded,
  title,
  showApprovalChain,
  onBeforeTransition,
  addendumPending,
  addendumView
}: {
  collection: string
  item: string
  defaultExpanded?: boolean
  title?: string
  showApprovalChain?: boolean
  onBeforeTransition?: () => boolean | Promise<boolean>
  addendumPending?: boolean
  addendumView?: boolean
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [requirementsDialog, setRequirementsDialog] = useState<RequirementsDialogState | null>(null)
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])
  const trySetPending = async (txId: string) => {
    if (pendingTransition === txId) {
      setPendingTransition(null)
      return
    }
    // The guard may save the form first, so it can be async — awaiting it is
    // what lets one click mean "save, then transition".
    if (onBeforeTransition && !(await onBeforeTransition())) return
    // Most transitions are simply "yes, move it on": a confirm step there is a
    // second click carrying no information. Only stop and ask when the
    // transition is configured to want a note.
    const tx = (transitions ?? []).find((t) => t.id === txId)
    const mode = String((tx as { comment_mode?: string } | undefined)?.comment_mode ?? 'none')
    if (mode !== 'optional' && mode !== 'required') {
      executeTransition.mutate({ transition_id: txId })
      return
    }
    setPendingTransition(txId)
  }
  const queryKey = ['pipeline-instance', collection, item]
  const { data, isLoading } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      client
        .request<{ data: PipelinePanelData | null }>(
          get(`/pipelines/instance/${collection}/${item}`)
        )
        .then(
          (r) =>
            r.data ?? {
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
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return
        const k = event.query.queryKey
        if (Array.isArray(k) && k[0] === 'item' && k[1] === collection && String(k[2]) === item)
          queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
      }),
    [queryClient, collection, item]
  )
  // Server-computed path relevance for the state track — same key/data as the
  // Approval Chain popover + OwnersSection, so the cache is shared.
  const { data: pathOwners } = useQuery<Record<string, AllOwnersEntry> | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    enabled: expanded && !!data?.instance,
    staleTime: 30_000
  })
  const onPathIds = useMemo(() => {
    if (!pathOwners) return null
    const entries = Object.entries(pathOwners)
    if (entries.length === 0 || entries.every(([, e]) => e.on_path === undefined)) return null
    return new Set(entries.filter(([, e]) => e.on_path !== false).map(([id]) => id))
  }, [pathOwners])

  // Which states this record will never enter, with the engine's own reason.
  // The approval chain already renders these; the track showed them as plain
  // grey, identical to states still ahead — so "skipped forever" and "coming
  // next" were indistinguishable.
  const skippedStates = useMemo(() => {
    if (!pathOwners) return null
    const out = new Map<string, string[]>()
    for (const [id, e] of Object.entries(pathOwners)) {
      if (e.skipped) out.set(id, e.skip_reasons ?? [])
    }
    return out
  }, [pathOwners])

  const startPipeline = useMutation({
    mutationFn: () => client.request(post(`/pipelines/instance/${collection}/${item}/start`, {})),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success('Pipeline started')
    },
    onError: () => toast.error('Failed to start pipeline')
  })
  const executeTransition = useMutation({
    mutationFn: ({ transition_id, comment }: { transition_id: string; comment?: string }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment })
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      if (collection === 'nivaro_addendums') queryClient.invalidateQueries({ queryKey: ['addendums'] })
      setComment('')
      setPendingTransition(null)
      setRequirementsDialog(null)
      toast.success('Transition executed')
    },
    onError: (err: unknown, variables) => {
      const requirements = transitionRequirementsFromError(err)
      if (requirements) {
        setRequirementsDialog((prev) => ({
          payload: requirements,
          transitionId: variables.transition_id,
          comment: variables.comment,
          revision: (prev?.revision ?? 0) + 1
        }))
        return
      }
      // The SDK attaches the parsed error body as `response` (same shape
      // transitionRequirementsFromError reads); `data.error` covers
      // axios-shaped hosts. Show the FULL server message — for a blocked
      // external submission it carries the transition label + HTTP status +
      // response body, which is what the user needs to act on.
      const resp = (
        err as { response?: { status?: number; error?: string; data?: { error?: string } } }
      )?.response
      toast.error(resp?.error ?? resp?.data?.error ?? 'Failed to execute transition', {
        duration: 12000
      })
      // A blocked transition (e.g. MDSi failure) lands here as a plain 422:
      // the dialog's line values already saved — close it and refresh the
      // persistent failure banner immediately.
      setRequirementsDialog(null)
      setPendingTransition(null)
      queryClient.invalidateQueries({ queryKey: ['erp-submissions', collection, String(item)] })
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
      }
    }
  })

  if (isLoading)
    // Collapsed-shell skeleton at the real header height (px-5 py-3.5 row) —
    // returning null here made the whole Progress bar pop in after load and
    // shove everything below it down.
    return (
      <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex w-full items-center gap-2.5 px-5 py-3.5'>
          <Skeleton className='h-3.5 w-3.5 shrink-0 rounded' />
          <Skeleton className='h-4 w-20' />
          <Skeleton className='h-[22px] w-40 rounded-full' />
          <Skeleton className='ml-auto h-3.5 w-3.5 rounded' />
        </div>
      </div>
    )
  if (!data?.binding) return null

  const { instance, available_transitions: transitions, history, states } = data
  const stateById = new Map((states ?? []).map((s) => [s.id, s]))
  const currentState = instance?.current_state_obj ?? null
  const pendingTx = pendingTransition
    ? (transitions ?? []).find((t) => t.id === pendingTransition)
    : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null
  const hasTransitions = !instance?.completed_at && transitions && transitions.length > 0

  const renderTransitionButtons = (txList: PipelineTransition[], small = false) => {
    const byLabel = new Map<string, PipelineTransition[]>()
    for (const tx of txList) {
      const l = byLabel.get(tx.label) ?? []
      l.push(tx)
      byLabel.set(tx.label, l)
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
            className={`${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5`}
            style={colorStyle(isActive)}
            onClick={() => trySetPending(tx.id)}
          >
            {label}
          </Button>
        )
      }
      return (
        <DropdownMenu key={label}>
          <DropdownMenuTrigger asChild>
            <Button
              size='sm'
              variant={isActive ? 'default' : 'outline'}
              className={`${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5`}
              style={colorStyle(isActive)}
            >
              {label}
              <ChevronDown className='h-3 w-3' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start'>
            {[...txs]
              .sort(
                (a, b) =>
                  (stateById.get(a.to_state)?.sort ?? 999) -
                  (stateById.get(b.to_state)?.sort ?? 999)
              )
              .map((tx) => (
                <DropdownMenuItem key={tx.id} onSelect={() => trySetPending(tx.id)}>
                  {tx.color && (
                    <span
                      className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                      style={{ backgroundColor: tx.color }}
                    />
                  )}
                  {stateById.get(tx.to_state)?.label ?? tx.to_state}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    })
  }

  const confirmForm = (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-border p-3.5'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
        {pendingTx && (
          <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>
        )}
        {currentState && pendingToState && (
          <div className='ml-auto flex items-center gap-1.5'>
            <StateBadge label={currentState.label} color={currentState.color} small />
            <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
            <StateBadge label={pendingToState.label} color={pendingToState.color} small />
          </div>
        )}
      </div>
      <ApprovalBriefStrip collection={collection} item={item} />
      <input
        type='text'
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          String((pendingTx as { comment_mode?: string } | undefined)?.comment_mode ?? '') ===
          'required'
            ? 'Add a note (required)'
            : 'Add a comment (optional)'
        }
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
          // A required note that can be skipped is not required.
          disabled={
            executeTransition.isPending ||
            (String((pendingTx as { comment_mode?: string } | undefined)?.comment_mode ?? '') ===
              'required' &&
              comment.trim() === '')
          }
          onClick={() =>
            executeTransition.mutate({
              transition_id: pendingTransition!,
              comment: comment.trim() || undefined
            })
          }
        >
          {executeTransition.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <>
              <span>Confirm</span>
              <Check className='h-3 w-3' />
            </>
          )}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <div className={`overflow-hidden rounded-xl border bg-white dark:bg-card ${addendumView ? 'border-amber-300 dark:border-amber-600/50' : 'border-slate-200 dark:border-border'}`}>
        <div
          role='button'
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setExpanded((v) => !v)}
          className='flex w-full cursor-pointer items-center gap-2.5 px-5 py-3.5 transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
        >
          <GitBranch className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {title || 'Pipeline'}
          </span>
          <div className='flex items-center gap-1.5'>
            {addendumView && (
              <span className='flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
                Addendum workflow
              </span>
            )}
            {currentState && <StateBadge label={currentState.label} color={currentState.color} />}
            {addendumPending && (
              <span className='flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0' />
                Addendum in review
              </span>
            )}
          </div>
          <div className='ml-auto flex items-center gap-2' onClick={(e) => e.stopPropagation()}>
            {!expanded && hasTransitions && (
              <div className='flex flex-wrap items-center gap-1.5'>
                {renderTransitionButtons(transitions, true)}
              </div>
            )}
            {!expanded && !instance && data?.binding && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 gap-1.5 text-[11px]'
                onClick={(e) => {
                  e.stopPropagation()
                  startPipeline.mutate()
                }}
                disabled={startPipeline.isPending}
              >
                {startPipeline.isPending ? (
                  <Loader2 className='h-3 w-3 animate-spin' />
                ) : (
                  <GitBranch className='h-3 w-3' />
                )}
                Start
              </Button>
            )}
            {/* Instance-only workflows (addendums) have no collection binding —
                the chain resolves from the instance's template server-side. */}
            {showApprovalChain && (data?.binding || data?.instance) && (
              <ApprovalChainView
                collection={collection}
                item={item}
                states={states ?? []}
                currentStateId={data?.instance?.current_state ?? null}
              />
            )}
          </div>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
              expanded && 'rotate-180'
            )}
          />
        </div>
        {!expanded && pendingTransition && (
          <div className='border-t border-slate-100 dark:border-border/60 px-4 py-3'>
            {confirmForm}
          </div>
        )}
        {expanded && (
          <div className='border-t border-slate-100 dark:border-border/60'>
            {addendumPending && (
              <div className='flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/10'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0' />
                <p className='text-[12px] text-amber-700 dark:text-amber-400'>
                  An addendum is in review — coordinate transitions carefully.
                </p>
              </div>
            )}
            {!instance ? (
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
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {(states ?? []).length > 1 && (
                  <div className='space-y-3 px-5 py-4'>
                    <StateTrack
                      states={states}
                      allTransitions={data?.all_transitions ?? []}
                      availableTransitions={transitions ?? []}
                      currentStateId={instance.current_state}
                      history={history ?? []}
                      onPathIds={onPathIds}
                      skippedStates={skippedStates}
                    />
                    <StateDurationTimeline
                      history={history ?? []}
                      completedAt={instance.completed_at}
                    />
                  </div>
                )}
                <div className='px-5 py-4'>
                  <OwnersSection
                    collection={collection}
                    item={item}
                    states={states ?? []}
                    currentStateId={data?.instance?.current_state ?? null}
                  />
                </div>
                {hasTransitions && (
                  <div className='space-y-3 px-5 py-4'>
                    <div className='flex flex-wrap justify-end gap-2'>
                      {renderTransitionButtons(transitions)}
                    </div>
                    {pendingTransition && confirmForm}
                  </div>
                )}
                <div className='px-5 py-3'>
                  <button
                    type='button'
                    className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-slate-600'
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform duration-200',
                        showHistory && 'rotate-180'
                      )}
                    />
                    Transition history{' '}
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
          </div>
        )}
      </div>
      {requirementsDialog && (
        <TransitionRequirementsDialog
          key={requirementsDialog.revision}
          payload={requirementsDialog.payload}
          isRetry={requirementsDialog.revision > 1}
          onSubmitted={() =>
            executeTransition.mutate({
              transition_id: requirementsDialog.transitionId,
              comment: requirementsDialog.comment
            })
          }
          executing={executeTransition.isPending}
          onClose={() => setRequirementsDialog(null)}
        />
      )}
    </>
  )
}

// ─── Transition buttons (for use next to Save button) ────────────────────────

export function PipelineTransitionButtons({
  collection,
  item,
  onBeforeTransition
}: {
  collection: string
  item: string
  onBeforeTransition?: () => boolean | Promise<boolean>
}) {
  if (item === 'new') return null
  return (
    <PipelineTransitionButtonsInner
      collection={collection}
      item={item}
      onBeforeTransition={onBeforeTransition}
    />
  )
}

function PipelineTransitionButtonsInner({
  collection,
  item,
  onBeforeTransition
}: {
  collection: string
  item: string
  onBeforeTransition?: () => boolean | Promise<boolean>
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [requirementsDialog, setRequirementsDialog] = useState<RequirementsDialogState | null>(null)
  const trySetPending = async (txId: string) => {
    if (pendingTransition === txId) {
      setPendingTransition(null)
      return
    }
    // The guard may save the form first, so it can be async — awaiting it is
    // what lets one click mean "save, then transition".
    if (onBeforeTransition && !(await onBeforeTransition())) return
    // Most transitions are simply "yes, move it on": a confirm step there is a
    // second click carrying no information. Only stop and ask when the
    // transition is configured to want a note.
    const tx = (transitions ?? []).find((t) => t.id === txId)
    const mode = String((tx as { comment_mode?: string } | undefined)?.comment_mode ?? 'none')
    if (mode !== 'optional' && mode !== 'required') {
      executeTransition.mutate({ transition_id: txId })
      return
    }
    setPendingTransition(txId)
  }
  const queryKey = ['pipeline-instance', collection, item]
  const { data } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      client
        .request<{ data: PipelinePanelData | null }>(
          get(`/pipelines/instance/${collection}/${item}`)
        )
        .then(
          (r) =>
            r.data ?? {
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
  const executeTransition = useMutation({
    mutationFn: ({ transition_id, comment }: { transition_id: string; comment?: string }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/transition`, { transition_id, comment })
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      if (collection === 'nivaro_addendums') queryClient.invalidateQueries({ queryKey: ['addendums'] })
      setComment('')
      setPendingTransition(null)
      setRequirementsDialog(null)
      toast.success('Transition executed')
    },
    onError: (err: unknown, variables) => {
      const requirements = transitionRequirementsFromError(err)
      if (requirements) {
        setRequirementsDialog((prev) => ({
          payload: requirements,
          transitionId: variables.transition_id,
          comment: variables.comment,
          revision: (prev?.revision ?? 0) + 1
        }))
        return
      }
      // The SDK attaches the parsed error body as `response` (same shape
      // transitionRequirementsFromError reads); `data.error` covers
      // axios-shaped hosts. Show the FULL server message — for a blocked
      // external submission it carries the transition label + HTTP status +
      // response body, which is what the user needs to act on.
      const resp = (
        err as { response?: { status?: number; error?: string; data?: { error?: string } } }
      )?.response
      toast.error(resp?.error ?? resp?.data?.error ?? 'Failed to execute transition', {
        duration: 12000
      })
      // A blocked transition (e.g. MDSi failure) lands here as a plain 422:
      // the dialog's line values already saved — close it and refresh the
      // persistent failure banner immediately.
      setRequirementsDialog(null)
      setPendingTransition(null)
      queryClient.invalidateQueries({ queryKey: ['erp-submissions', collection, String(item)] })
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
      }
    }
  })
  if (!data?.binding || !data?.instance || data.instance.completed_at) return null
  const transitions = data.available_transitions ?? []
  if (transitions.length === 0) return null
  const stateById = new Map((data.states ?? []).map((s) => [s.id, s]))
  const currentState = data.instance.current_state_obj ?? null
  const pendingTx = pendingTransition ? transitions.find((t) => t.id === pendingTransition) : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null
  const byLabel = new Map<string, PipelineTransition[]>()
  for (const tx of transitions) {
    const l = byLabel.get(tx.label) ?? []
    l.push(tx)
    byLabel.set(tx.label, l)
  }

  return (
    <div className='relative'>
      <div className='flex flex-wrap justify-end gap-2'>
        {Array.from(byLabel.entries()).map(([label, txs]) => {
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
                onClick={() => trySetPending(tx.id)}
              >
                {label}
              </Button>
            )
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
                {[...txs]
                  .sort(
                    (a, b) =>
                      (stateById.get(a.to_state)?.sort ?? 999) -
                      (stateById.get(b.to_state)?.sort ?? 999)
                  )
                  .map((tx) => (
                    <DropdownMenuItem key={tx.id} onSelect={() => trySetPending(tx.id)}>
                      {tx.color && (
                        <span
                          className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                          style={{ backgroundColor: tx.color }}
                        />
                      )}
                      {stateById.get(tx.to_state)?.label ?? tx.to_state}
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
      </div>
      {pendingTransition && (
        <div className='absolute right-0 top-full z-50 mt-1 w-[600px] space-y-3 rounded-lg border border-slate-200 bg-white shadow-lg dark:bg-card dark:border-border p-3.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
            {pendingTx && (
              <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>
            )}
            {currentState && pendingToState && (
              <div className='ml-auto flex items-center gap-1.5'>
                <StateBadge label={currentState.label} color={currentState.color} small />
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={pendingToState.label} color={pendingToState.color} small />
              </div>
            )}
          </div>
          <ApprovalBriefStrip collection={collection} item={item} />
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              String((pendingTx as { comment_mode?: string } | null)?.comment_mode ?? '') ===
              'required'
                ? 'Add a note (required)'
                : 'Add a comment (optional)'
            }
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
               // Same rule as the panel's confirm: a required note must be
               // filled in before this commits.
               disabled={
                 executeTransition.isPending ||
                 (String((pendingTx as { comment_mode?: string } | null)?.comment_mode ?? '') ===
                   'required' &&
                   comment.trim() === '')
               }
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
                  <span>Confirm</span>
                  <Check className='h-3 w-3' />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      {requirementsDialog && (
        <TransitionRequirementsDialog
          key={requirementsDialog.revision}
          payload={requirementsDialog.payload}
          isRetry={requirementsDialog.revision > 1}
          onSubmitted={() =>
            executeTransition.mutate({
              transition_id: requirementsDialog.transitionId,
              comment: requirementsDialog.comment
            })
          }
          onClose={() => setRequirementsDialog(null)}
        />
      )}
    </div>
  )
}
