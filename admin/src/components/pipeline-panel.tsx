import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Trash2,
  UserPlus,
  Users
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import {
  api,
  type PipelineHistoryEntry,
  type PipelineInstance,
  type PipelineInstanceOwner,
  type PipelineState,
  type PipelineTransition,
  type User
} from '@/lib/api'
import { formatRelative } from '@/lib/utils'

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
  const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[13px]'
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
    <div className='space-y-2'>
      {history.map((h) => {
        const userName =
          h.first_name || h.last_name
            ? [h.first_name, h.last_name].filter(Boolean).join(' ')
            : (h.user_email ?? 'System')
        return (
          <div key={h.id} className='flex items-start gap-2.5 text-[12px]'>
            <div className='mt-1 h-1.5 w-1.5 rounded-full bg-slate-300 shrink-0' />
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-1.5 flex-wrap'>
                {h.from_state_label ? (
                  <StateBadge label={h.from_state_label} color={h.from_state_color} small />
                ) : (
                  <span className='text-slate-400 italic text-[11px]'>started</span>
                )}
                <ArrowRight className='h-3 w-3 text-slate-300 shrink-0' />
                <StateBadge label={h.to_state_label} color={h.to_state_color} small />
              </div>
              {h.comment && <p className='mt-0.5 text-slate-500 italic'>"{h.comment}"</p>}
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

// ─── Owners section ───────────────────────────────────────────────────────────

function initials(o: { first_name: string | null; last_name: string | null; email: string }) {
  const f = o.first_name?.[0] ?? ''
  const l = o.last_name?.[0] ?? ''
  const combined = `${f}${l}`.trim()
  return (combined || o.email[0] || '?').toUpperCase()
}

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
  const [expanded, setExpanded] = useState(false)
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [stateScope, setStateScope] = useState('')

  const ownersKey = ['pipeline-instance-owners', collection, item]

  const { data: owners } = useQuery<PipelineInstanceOwner[]>({
    queryKey: ownersKey,
    queryFn: () =>
      api
        .get<{ data: PipelineInstanceOwner[] }>(`/pipelines/instance/${collection}/${item}/owners`)
        .then((r) => r.data.data)
  })

  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'picker'],
    queryFn: () =>
      api
        .get<{ data: User[]; total: number }>('/users', { params: { limit: 200 } })
        .then((r) => r.data.data),
    enabled: adding
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

  const stateLabel = (key: string | null) => {
    if (!key) return null
    return states.find((s) => s.key === key)?.label ?? key
  }

  return (
    <div className='space-y-2 border-t border-slate-100 pt-3'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-slate-700'
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5' />
        )}
        <Users className='h-3.5 w-3.5' />
        Owners ({owners?.length ?? 0})
      </button>

      {expanded && (
        <div className='space-y-2 pl-1'>
          {!owners || owners.length === 0 ? (
            <p className='text-[12px] text-slate-400 italic'>No owners assigned.</p>
          ) : (
            <div className='space-y-1.5'>
              {owners.map((o) => (
                <div key={o.id} className='flex items-center gap-2.5'>
                  <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-[10px] font-semibold text-slate-600'>
                    {initials(o)}
                  </span>
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-center gap-1.5 flex-wrap'>
                      <span className='text-[12px] font-medium text-slate-700'>
                        {[o.first_name, o.last_name].filter(Boolean).join(' ') || o.email}
                      </span>
                      {o.state ? (
                        <span className='rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500'>
                          {stateLabel(o.state)}
                        </span>
                      ) : (
                        <span className='rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-400'>
                          all states
                        </span>
                      )}
                    </div>
                    <p className='text-[11px] text-slate-400'>{o.email}</p>
                  </div>
                  <button
                    type='button'
                    onClick={() => removeOwner.mutate(o.id)}
                    className='rounded p-1 text-slate-400 hover:text-red-500'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </div>
              ))}
            </div>
          )}

          {adding ? (
            <div className='space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5'>
              <select
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
              >
                <option value=''>Select a user…</option>
                {(users ?? []).map((u) => {
                  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
                  return (
                    <option key={u.id} value={u.id}>
                      {name ? `${name} (${u.email})` : u.email}
                    </option>
                  )
                })}
              </select>
              <select
                value={stateScope}
                onChange={(e) => setStateScope(e.target.value)}
                className='h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[13px]'
              >
                <option value=''>All states</option>
                {states.map((s) => (
                  <option key={s.id} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
              <div className='flex items-center justify-end gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='text-[12px]'
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
                  className='text-[12px]'
                  disabled={!userId || addOwner.isPending}
                  onClick={() => addOwner.mutate()}
                >
                  {addOwner.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Add'}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-7 gap-1 text-[12px]'
              onClick={() => setAdding(true)}
            >
              <UserPlus className='h-3 w-3' />
              Add Owner
            </Button>
          )}
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
  history: PipelineHistoryEntry[]
  binding: { id: number; template: string; collection: string; state_field: string | null } | null
}

export function PipelinePanel({ collection, item }: { collection: string; item: string }) {
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const queryKey = ['pipeline-instance', collection, item]

  const { data, isLoading } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      api.get<{ data: PipelinePanelData | null }>(`/pipelines/instance/${collection}/${item}`).then(
        (r) =>
          r.data.data ?? {
            instance: null,
            states: [],
            available_transitions: [],
            history: [],
            binding: null
          }
      ),
    staleTime: 10_000
  })

  // Conditional transitions depend on the record's field values. ItemEdit invalidates
  // ['item', collection, id] after save — piggyback on that refetch to refresh the
  // available transitions so condition-filtered actions stay in sync with the record.
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
      // 409 = transition conditions no longer met (stale view) — refresh the offered actions.
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
        setPendingTransition(null)
      }
    }
  })

  if (isLoading) {
    return (
      <div className='rounded-xl border border-slate-200 bg-white p-5 space-y-3'>
        <Skeleton className='h-4 w-32' />
        <Skeleton className='h-8 w-48' />
      </div>
    )
  }

  // No pipeline bound to this collection
  if (!data?.binding) return null

  const { instance, available_transitions: transitions, history } = data ?? {}
  const currentState = instance?.current_state_obj ?? null

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-5 space-y-4'>
      {/* Header */}
      <div className='flex items-center gap-2'>
        <GitBranch className='h-4 w-4 text-slate-400' />
        <span className='text-[11px] font-medium text-slate-500'>Pipeline</span>
      </div>

      {!instance ? (
        /* Not started yet */
        <div className='flex items-center justify-between'>
          <p className='text-[13px] text-slate-500'>
            No pipeline instance started for this record.
          </p>
          <Button
            size='sm'
            variant='outline'
            className='gap-1.5 text-[12px]'
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
        <>
          {/* Current state */}
          <div className='flex items-center gap-3'>
            <span className='text-[12px] text-slate-500'>Current state:</span>
            {currentState ? (
              <StateBadge label={currentState.label} color={currentState.color} />
            ) : (
              <span className='text-[13px] text-slate-400 italic'>Unknown</span>
            )}
            {instance.completed_at && (
              <span className='flex items-center gap-1 text-[11px] text-emerald-600'>
                <Check className='h-3 w-3' />
                Completed
              </span>
            )}
          </div>

          {/* Owners */}
          <OwnersSection collection={collection} item={item} states={data?.states ?? []} />

          {/* Available transitions */}
          {!instance.completed_at && transitions && transitions.length > 0 && (
            <div className='space-y-2'>
              <p className='text-[11px] font-medium text-slate-500'>Actions</p>
              <div className='flex flex-wrap gap-2'>
                {(() => {
                  // Group transitions: same group_label → dropdown; no group_label → individual button
                  const groups: Map<string, PipelineTransition[]> = new Map()
                  const ungrouped: PipelineTransition[] = []
                  for (const tx of transitions) {
                    if (tx.group_label) {
                      const existing = groups.get(tx.group_label) ?? []
                      existing.push(tx)
                      groups.set(tx.group_label, existing)
                    } else {
                      ungrouped.push(tx)
                    }
                  }
                  const elements: React.ReactNode[] = []
                  // Render grouped transitions as dropdown buttons
                  for (const [groupLabel, groupTxs] of groups) {
                    const isActive = groupTxs.some((t) => t.id === pendingTransition)
                    const activeColor = groupTxs[0]?.color ?? null
                    elements.push(
                      <DropdownMenu key={`group-${groupLabel}`}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size='sm'
                            variant={isActive ? 'default' : 'outline'}
                            className='gap-1.5 text-[12px]'
                            style={
                              activeColor && !isActive
                                ? { borderColor: activeColor, color: activeColor }
                                : activeColor && isActive
                                  ? { backgroundColor: activeColor, borderColor: activeColor }
                                  : undefined
                            }
                          >
                            {groupLabel}
                            <ChevronDown className='h-3 w-3' />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='start'>
                          {groupTxs.map((tx) => (
                            <DropdownMenuItem
                              key={tx.id}
                              onSelect={() =>
                                setPendingTransition(pendingTransition === tx.id ? null : tx.id)
                              }
                            >
                              {tx.color && (
                                <span
                                  className='mr-2 inline-block h-2 w-2 rounded-full shrink-0'
                                  style={{ backgroundColor: tx.color }}
                                />
                              )}
                              {tx.label}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  }
                  // Render ungrouped transitions as individual buttons
                  for (const tx of ungrouped) {
                    elements.push(
                      <Button
                        key={tx.id}
                        size='sm'
                        variant={pendingTransition === tx.id ? 'default' : 'outline'}
                        className='gap-1.5 text-[12px]'
                        style={
                          tx.color && pendingTransition !== tx.id
                            ? { borderColor: tx.color, color: tx.color }
                            : tx.color && pendingTransition === tx.id
                              ? { backgroundColor: tx.color, borderColor: tx.color }
                              : undefined
                        }
                        onClick={() =>
                          setPendingTransition(pendingTransition === tx.id ? null : tx.id)
                        }
                      >
                        {tx.label}
                      </Button>
                    )
                  }
                  return elements
                })()}
              </div>

              {pendingTransition && (
                <div className='rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2'>
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
                      className='text-[12px]'
                      onClick={() => setPendingTransition(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      className='text-[12px]'
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
                        'Confirm'
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* History toggle */}
          <div>
            <button
              type='button'
              className='text-[12px] text-nvr-cyan hover:underline'
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? 'Hide' : 'Show'} history ({history?.length ?? 0})
            </button>
            {showHistory && (
              <div className='mt-3'>
                <HistoryTimeline history={history ?? []} />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
