import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, GitFork, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'

interface BranchState {
  id: string
  key: string
  label: string
  color: string | null
  is_terminal: boolean
}
interface BranchTransition {
  id: string
  label: string
  color: string | null
  to_state: string
  group_label: string | null
}
interface Branch {
  instance_id: string
  state: BranchState | null
  terminal: boolean
  available_transitions: BranchTransition[]
}
interface SplitConfig {
  id: string
  label: string
  branch_states: BranchState[]
  join_state: BranchState | null
}
interface BranchesData {
  parent: { id: string; current_state: string; completed_at: string | null }
  active: boolean
  branches: Branch[]
  join_state: BranchState | null
  waiting_on: number
  total: number
  split_configs: SplitConfig[]
}

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

function BranchRow({
  branch,
  index,
  onTransition,
  transitioning
}: {
  branch: Branch
  index: number
  onTransition: (instanceId: string, transitionId: string, comment?: string) => void
  transitioning: boolean
}) {
  const [pending, setPending] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 space-y-2'>
      <div className='flex items-center gap-2.5 flex-wrap'>
        <span className='text-[11px] font-medium text-slate-400 w-14 shrink-0'>
          Branch {index + 1}
        </span>
        {branch.state ? (
          <StateBadge label={branch.state.label} color={branch.state.color} small />
        ) : (
          <span className='text-[12px] text-slate-400 italic'>Unknown state</span>
        )}
        {branch.terminal && (
          <span className='flex items-center gap-1 text-[11px] text-emerald-600'>
            <Check className='h-3 w-3' />
            Done
          </span>
        )}
        {!branch.terminal && branch.available_transitions.length > 0 && (
          <div className='flex flex-wrap gap-1.5 ml-auto'>
            {branch.available_transitions.map((tx) => (
              <Button
                key={tx.id}
                size='sm'
                variant={pending === tx.id ? 'default' : 'outline'}
                className='h-6 gap-1 px-2 text-[11px]'
                style={
                  tx.color && pending !== tx.id
                    ? { borderColor: tx.color, color: tx.color }
                    : tx.color && pending === tx.id
                      ? { backgroundColor: tx.color, borderColor: tx.color }
                      : undefined
                }
                onClick={() => setPending(pending === tx.id ? null : tx.id)}
              >
                {tx.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {pending && (
        <div className='rounded-md border border-slate-200 bg-white p-2 space-y-2'>
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder='Add a comment (optional)'
            className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
          <div className='flex items-center justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-6 text-[11px]'
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-6 text-[11px]'
              disabled={transitioning}
              onClick={() => {
                onTransition(branch.instance_id, pending, comment.trim() || undefined)
                setPending(null)
                setComment('')
              }}
            >
              {transitioning ? <Loader2 className='h-3 w-3 animate-spin' /> : 'Confirm'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

export function WorkflowPanel({ collection, item }: { collection: string; item: string }) {
  if (item === 'new') return null
  return <WorkflowPanelInner collection={collection} item={item} />
}

function WorkflowPanelInner({ collection, item }: { collection: string; item: string }) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()

  const { data: pipelineData } = useQuery<{
    instance: { id: string; current_state: string; completed_at: string | null } | null
  } | null>({
    queryKey: ['pipeline-instance', collection, item],
    queryFn: () =>
      client
        .request<{
          data: {
            instance: { id: string; current_state: string; completed_at: string | null } | null
          } | null
        }>(get(`/pipelines/instance/${collection}/${item}`))
        .then((r) => r.data),
    staleTime: 10_000
  })

  const instanceId = pipelineData?.instance?.id ?? null
  const branchesKey = ['workflow-branches', instanceId]

  const { data, isLoading } = useQuery<BranchesData>({
    queryKey: branchesKey,
    queryFn: () =>
      client
        .request<{ data: BranchesData }>(get(`/workflows/instance/${instanceId}/branches`))
        .then((r) => r.data),
    enabled: !!instanceId,
    refetchInterval: (q) => (q.state.data?.active ? 15_000 : false)
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: branchesKey })
    queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
  }

  const split = useMutation({
    mutationFn: (config: SplitConfig) =>
      client.request(
        post(`/workflows/instance/${instanceId}/split`, {
          branch_states: config.branch_states.map((s) => s.key),
          join_state: config.join_state?.key
        })
      ),
    onSuccess: () => {
      invalidate()
      toast.success('Workflow split into parallel branches')
    },
    onError: (err: unknown) => {
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to split workflow'
      )
    }
  })

  const transition = useMutation({
    mutationFn: ({
      branchInstanceId,
      transitionId,
      comment
    }: {
      branchInstanceId: string
      transitionId: string
      comment?: string
    }) =>
      client
        .request<{ data: { joined: boolean } }>(
          post(`/workflows/instance/${branchInstanceId}/transition`, {
            transition_id: transitionId,
            comment
          })
        )
        .then((r) => r.data),
    onSuccess: (result) => {
      invalidate()
      toast.success(
        result?.joined ? 'All branches complete — workflow joined' : 'Branch transitioned'
      )
    },
    onError: (err: unknown) => {
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to execute transition'
      )
    }
  })

  if (!instanceId) return null
  if (isLoading)
    return (
      <div className='rounded-xl border border-slate-200 bg-white p-5 space-y-3'>
        <Skeleton className='h-4 w-36' />
        <Skeleton className='h-8 w-full' />
      </div>
    )
  if (!data) return null
  const canSplit =
    !data.active && !data.parent?.completed_at && (data.split_configs?.length ?? 0) > 0
  if (!data.active && !canSplit) return null

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-5 space-y-4'>
      <div className='flex items-center gap-2'>
        <GitFork className='h-4 w-4 text-slate-400' />
        <span className='text-[11px] font-medium text-slate-500'>Parallel Branches</span>
        {data.active && (
          <span className='ml-auto text-[11px] text-slate-500'>
            Waiting on {data.waiting_on} of {data.total} branches
          </span>
        )}
      </div>
      {data.active ? (
        <>
          <div className='space-y-2'>
            {data.branches.map((b, i) => (
              <BranchRow
                key={b.instance_id}
                branch={b}
                index={i}
                transitioning={transition.isPending}
                onTransition={(branchInstanceId, transitionId, comment) =>
                  transition.mutate({ branchInstanceId, transitionId, comment })
                }
              />
            ))}
          </div>
          {data.join_state && (
            <div className='flex items-center gap-2 text-[12px] text-slate-500'>
              <span>When all branches complete</span>
              <ArrowRight className='h-3 w-3 text-slate-300' />
              <StateBadge label={data.join_state.label} color={data.join_state.color} small />
            </div>
          )}
        </>
      ) : (
        <div className='space-y-2'>
          {data.split_configs.map((cfg) => (
            <div
              key={cfg.id}
              className='flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50/60 p-3 flex-wrap'
            >
              <div className='flex items-center gap-1.5 flex-wrap min-w-0 flex-1'>
                {cfg.branch_states.map((s) => (
                  <StateBadge key={s.id} label={s.label} color={s.color} small />
                ))}
                <ArrowRight className='h-3 w-3 text-slate-300 shrink-0' />
                {cfg.join_state && (
                  <StateBadge label={cfg.join_state.label} color={cfg.join_state.color} small />
                )}
              </div>
              <Button
                size='sm'
                variant='outline'
                className='h-7 gap-1.5 text-[12px] shrink-0'
                disabled={split.isPending}
                onClick={() => split.mutate(cfg)}
              >
                {split.isPending ? (
                  <Loader2 className='h-3 w-3 animate-spin' />
                ) : (
                  <GitFork className='h-3 w-3' />
                )}
                {cfg.label || 'Split'}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
