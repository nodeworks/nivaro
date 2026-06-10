import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Check, GitFork, Loader2, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type PipelineState, type PipelineTemplate } from '@/lib/api'

// ─── Types (mirrors GET /workflows/templates/:id/splits) ──────────────────────

type SplitStateLite = {
  id: string
  key: string
  label: string
  color: string | null
  is_terminal: boolean
}

type SplitConfig = {
  id: string
  label: string
  branch_states: string[]
  branch_state_objs: SplitStateLite[]
  join_state: string
  join_state_obj: SplitStateLite | null
}

// ─── Small state chip ─────────────────────────────────────────────────────────

function StateChip({
  state,
  selected,
  onClick
}: {
  state: { key: string; label: string; color: string | null }
  selected?: boolean
  onClick?: () => void
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium'
  const style = {
    backgroundColor: state.color ? `${state.color}22` : '#f1f5f9',
    color: state.color ?? '#475569',
    border: `1px solid ${selected ? (state.color ?? '#475569') : state.color ? `${state.color}44` : '#e2e8f0'}`,
    boxShadow: selected ? `0 0 0 1px ${state.color ?? '#475569'}` : undefined
  }
  if (!onClick) {
    return (
      <span className={base} style={style}>
        {state.label}
      </span>
    )
  }
  return (
    <button type='button' className={`${base} transition-shadow`} style={style} onClick={onClick}>
      {selected && <Check className='h-3 w-3' />}
      {state.label}
    </button>
  )
}

// ─── Split create form ────────────────────────────────────────────────────────

function SplitForm({
  states,
  saving,
  onSave,
  onCancel
}: {
  states: PipelineState[]
  saving: boolean
  onSave: (data: { branch_states: string[]; join_state: string; label: string }) => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState('')
  const [branchKeys, setBranchKeys] = useState<string[]>([])
  const [joinKey, setJoinKey] = useState('')

  const toggleBranch = (key: string) => {
    setBranchKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    if (joinKey === key) setJoinKey('')
  }

  const valid = branchKeys.length >= 2 && !!joinKey && !branchKeys.includes(joinKey)

  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50 p-4 space-y-4'>
      <div className='space-y-1.5'>
        <Label className='text-[12px]'>Label</Label>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='e.g. Review in parallel'
          className='text-[13px] bg-white'
        />
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>
          Branch start states
          <span className='ml-1.5 font-normal text-slate-400'>(pick 2 or more)</span>
        </Label>
        <div className='flex flex-wrap gap-1.5'>
          {states.map((s) => (
            <StateChip
              key={s.id}
              state={s}
              selected={branchKeys.includes(s.key)}
              onClick={() => toggleBranch(s.key)}
            />
          ))}
        </div>
      </div>

      <div className='space-y-1.5'>
        <Label className='text-[12px]'>
          Join state
          <span className='ml-1.5 font-normal text-slate-400'>
            (parent auto-transitions here when all branches finish)
          </span>
        </Label>
        <div className='flex flex-wrap gap-1.5'>
          {states
            .filter((s) => !branchKeys.includes(s.key))
            .map((s) => (
              <StateChip
                key={s.id}
                state={s}
                selected={joinKey === s.key}
                onClick={() => setJoinKey(joinKey === s.key ? '' : s.key)}
              />
            ))}
        </div>
      </div>

      <div className='flex items-center justify-end gap-2'>
        <Button type='button' size='sm' variant='ghost' className='text-[12px]' onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='text-[12px]'
          disabled={!valid || saving}
          onClick={() =>
            onSave({ branch_states: branchKeys, join_state: joinKey, label: label.trim() })
          }
        >
          {saving ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Create Split'}
        </Button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function WorkflowEditPage() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const [addingSplit, setAddingSplit] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: templateData, isLoading } = useQuery<PipelineTemplate>({
    queryKey: ['pipeline-template', id],
    queryFn: () => api.get<{ data: PipelineTemplate }>(`/pipelines/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const splitsKey = ['workflow-splits', id]
  const { data: splits } = useQuery<SplitConfig[]>({
    queryKey: splitsKey,
    queryFn: () =>
      api
        .get<{ data: SplitConfig[] }>(`/workflows/templates/${id}/splits`)
        .then((r) => r.data.data),
    enabled: !!id
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: splitsKey })
    queryClient.invalidateQueries({ queryKey: ['pipeline-template', id] })
  }

  const createSplit = useMutation({
    mutationFn: (body: { branch_states: string[]; join_state: string; label: string }) =>
      api.post(`/workflows/templates/${id}/splits`, body).then((r) => r.data),
    onSuccess: () => {
      invalidate()
      setAddingSplit(false)
      toast.success('Split created')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to create split')
    }
  })

  const deleteSplit = useMutation({
    mutationFn: (splitId: string) => api.delete(`/workflows/templates/${id}/splits/${splitId}`),
    onSuccess: () => {
      invalidate()
      setConfirmDelete(null)
      toast.success('Split deleted')
    },
    onError: () => toast.error('Failed to delete split')
  })

  if (isLoading || !templateData) {
    return (
      <div className='p-8 space-y-4'>
        <Skeleton className='h-8 w-64' />
        <Skeleton className='h-48 rounded-xl' />
      </div>
    )
  }

  const states: PipelineState[] = templateData.states ?? []

  return (
    <div className='flex flex-1 min-h-0 flex-col overflow-auto'>
      {/* Sticky header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 shrink-0'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            <Link
              to='/pipelines'
              className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              Pipelines
            </Link>
            <span className='text-slate-300'>/</span>
            <span className='font-medium text-slate-800'>{templateData.name}</span>
            <span className='text-slate-300'>/</span>
            <span className='text-slate-500'>Workflow</span>
          </div>
          <Link to={`/pipelines/${id}`}>
            <Button size='sm' variant='outline' className='text-[12px]'>
              Open full editor
            </Button>
          </Link>
        </div>
      </div>

      <div className='p-6 lg:p-8 space-y-6'>
        {/* Parallel Branches */}
        <div className='rounded-xl border border-slate-200 bg-white p-6 space-y-4'>
          <div className='flex items-center justify-between'>
            <h2 className='flex items-center gap-2 text-[13px] font-semibold text-slate-800'>
              <GitFork className='h-4 w-4 text-slate-400' />
              Parallel Branches
              <span className='font-mono text-[11px] font-normal text-slate-400'>
                {splits?.length ?? 0}
              </span>
            </h2>
            {!addingSplit && (
              <Button
                size='sm'
                variant='outline'
                className='gap-1.5 text-[12px] h-7'
                onClick={() => setAddingSplit(true)}
                disabled={states.length < 3}
              >
                <Plus className='h-3 w-3' />
                Add Split
              </Button>
            )}
          </div>

          <p className='text-[12px] text-slate-500'>
            A split runs multiple branches of this workflow in parallel. Each branch starts at its
            own state; when every branch reaches a terminal state, the record auto-transitions to
            the join state.
          </p>

          {states.length < 3 && (
            <p className='text-[13px] text-slate-400'>
              Define at least 3 states (2 branch starts + 1 join) before adding a split.
            </p>
          )}

          {(splits?.length ?? 0) === 0 && !addingSplit && states.length >= 3 && (
            <p className='text-[13px] text-slate-400'>
              No splits defined yet. Splits appear as a "Split" action on bound records.
            </p>
          )}

          {(splits ?? []).map((split) => (
            <div
              key={split.id}
              className='flex items-center gap-3 rounded-lg border border-slate-200 p-3 flex-wrap'
            >
              <div className='min-w-0 flex-1 space-y-1.5'>
                <p className='text-[12px] font-medium text-slate-700'>{split.label}</p>
                <div className='flex items-center gap-1.5 flex-wrap'>
                  {split.branch_state_objs.map((s) => (
                    <StateChip key={s.id} state={s} />
                  ))}
                  <ArrowRight className='h-3 w-3 text-slate-300 shrink-0' />
                  {split.join_state_obj ? (
                    <StateChip state={split.join_state_obj} />
                  ) : (
                    <span className='text-[12px] text-slate-400 italic'>missing join state</span>
                  )}
                </div>
              </div>
              {confirmDelete === split.id ? (
                <div className='flex items-center gap-2 shrink-0'>
                  <span className='text-[12px] text-slate-500'>Delete?</span>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-7 text-[12px]'
                    disabled={deleteSplit.isPending}
                    onClick={() => deleteSplit.mutate(split.id)}
                  >
                    {deleteSplit.isPending ? (
                      <Loader2 className='h-3 w-3 animate-spin' />
                    ) : (
                      'Confirm'
                    )}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 text-[12px]'
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type='button'
                  className='rounded p-1.5 text-slate-400 hover:text-red-500 shrink-0'
                  onClick={() => setConfirmDelete(split.id)}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              )}
            </div>
          ))}

          {addingSplit && (
            <SplitForm
              states={states}
              saving={createSplit.isPending}
              onSave={(data) => createSplit.mutate(data)}
              onCancel={() => setAddingSplit(false)}
            />
          )}
        </div>
      </div>
    </div>
  )
}
