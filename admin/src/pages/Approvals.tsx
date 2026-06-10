import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, GripVertical, Plus, ThumbsUp, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

interface CmsUser {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

interface RoleRow {
  id: string
  name: string
}

interface CollectionMeta {
  collection: string
  name?: string | null
}

interface ChainStep {
  id?: number
  chain?: number
  step_order?: number
  approver: string | null
  approver_role: string | null
  label: string | null
}

interface ApprovalChain {
  id: number
  name: string
  collection: string | null
  is_active: boolean
  steps: ChainStep[]
}

interface InstanceStep {
  step_order: number
  label: string | null
  approver_name: string | null
  approver_role_name: string | null
}

interface InstanceDecision {
  step_order: number
  decision: string
  comment: string | null
  user_name: string | null
  decided_at: string
}

interface ApprovalInstance {
  id: number
  chain: number
  chain_name: string
  collection: string
  item: string
  current_step: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  started_by_name: string | null
  created_at: string
  steps: InstanceStep[]
  decisions: InstanceDecision[]
}

function userLabel(u: CmsUser): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

const NONE_COLLECTION = '__none__'

// ─── Chain editor ─────────────────────────────────────────────────────────────

function ChainEditor({
  chain,
  users,
  roles,
  collections,
  onSaved,
  onDeleted
}: {
  chain: ApprovalChain
  users: CmsUser[]
  roles: RoleRow[]
  collections: CollectionMeta[]
  onSaved: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(chain.name)
  const [collection, setCollection] = useState<string>(chain.collection ?? NONE_COLLECTION)
  const [isActive, setIsActive] = useState(chain.is_active)
  const [steps, setSteps] = useState<ChainStep[]>(chain.steps ?? [])
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset local state when a different chain is selected
  useEffect(() => {
    setName(chain.name)
    setCollection(chain.collection ?? NONE_COLLECTION)
    setIsActive(chain.is_active)
    setSteps(chain.steps ?? [])
    setConfirmDelete(false)
  }, [chain])

  const saveMut = useMutation({
    mutationFn: () =>
      api.patch(`/approvals/chains/${chain.id}`, {
        name,
        collection: collection === NONE_COLLECTION ? null : collection,
        is_active: isActive,
        steps: steps.map((s, i) => ({
          step_order: i,
          approver: s.approver,
          approver_role: s.approver_role,
          label: s.label
        }))
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-chains'] })
      onSaved()
      toast.success('Approval chain saved')
    },
    onError: () => toast.error('Failed to save chain')
  })

  const deleteMut = useMutation({
    mutationFn: () => api.delete(`/approvals/chains/${chain.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-chains'] })
      onDeleted()
      toast.success('Approval chain deleted')
    },
    onError: () => toast.error('Failed to delete chain (it may have approval instances)')
  })

  function addStep() {
    setSteps((prev) => [...prev, { approver: null, approver_role: null, label: null }])
  }

  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx))
  }

  function setStep(idx: number, patch: Partial<ChainStep>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)))
  }

  const stepsValid = steps.every((s) => s.approver || s.approver_role)
  const canSave = name.trim() !== '' && stepsValid

  return (
    <div className='mx-auto max-w-3xl space-y-6 p-6'>
      <div className='space-y-4 rounded-lg border border-border bg-card p-5'>
        <div className='space-y-1.5'>
          <Label htmlFor='chain-name'>Chain Name</Label>
          <Input
            id='chain-name'
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder='e.g. Contract Approval'
          />
        </div>

        <div className='grid grid-cols-2 gap-4'>
          <div className='space-y-1.5'>
            <Label htmlFor='chain-collection'>Collection (optional)</Label>
            <Select value={collection} onValueChange={setCollection}>
              <SelectTrigger id='chain-collection'>
                <SelectValue placeholder='Any collection' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_COLLECTION}>Any collection</SelectItem>
                {collections.map((c) => (
                  <SelectItem key={c.collection} value={c.collection}>
                    {c.name || c.collection}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='chain-active'>Status</Label>
            <Select
              value={isActive ? 'active' : 'inactive'}
              onValueChange={(v) => setIsActive(v === 'active')}
            >
              <SelectTrigger id='chain-active'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='active'>Active</SelectItem>
                <SelectItem value='inactive'>Inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className='space-y-3'>
        <div className='flex items-center justify-between'>
          <h3 className='text-sm font-semibold'>Approval Steps</h3>
          <Button variant='outline' size='sm' onClick={addStep}>
            <Plus className='h-3.5 w-3.5 mr-1.5' />
            Add Step
          </Button>
        </div>

        {steps.length === 0 ? (
          <p className='rounded-lg border border-dashed border-border py-8 text-center text-xs text-muted-foreground'>
            No steps yet. Add at least one step (an approver user or role).
          </p>
        ) : (
          <div className='space-y-2'>
            {steps.map((step, idx) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: steps are order-based, no stable id pre-save
                key={idx}
                className='flex items-start gap-3 rounded-lg border border-border bg-card p-3'
              >
                <div className='flex h-8 items-center text-muted-foreground'>
                  <GripVertical className='h-4 w-4' />
                </div>
                <div className='flex h-8 w-7 shrink-0 items-center justify-center rounded-md bg-nvr-cyan/10 text-xs font-semibold text-nvr-cyan'>
                  {idx + 1}
                </div>
                <div className='grid flex-1 grid-cols-2 gap-3'>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-muted-foreground'>Approver (user)</Label>
                    <Select
                      value={step.approver ?? NONE_COLLECTION}
                      onValueChange={(v) =>
                        setStep(idx, {
                          approver: v === NONE_COLLECTION ? null : v,
                          approver_role: v === NONE_COLLECTION ? step.approver_role : null
                        })
                      }
                    >
                      <SelectTrigger className='h-9'>
                        <SelectValue placeholder='None' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_COLLECTION}>None</SelectItem>
                        {users.map((u) => (
                          <SelectItem key={u.id} value={u.id}>
                            {userLabel(u)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1'>
                    <Label className='text-[11px] text-muted-foreground'>or Role</Label>
                    <Select
                      value={step.approver_role ?? NONE_COLLECTION}
                      onValueChange={(v) =>
                        setStep(idx, {
                          approver_role: v === NONE_COLLECTION ? null : v,
                          approver: v === NONE_COLLECTION ? step.approver : null
                        })
                      }
                    >
                      <SelectTrigger className='h-9'>
                        <SelectValue placeholder='None' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE_COLLECTION}>None</SelectItem>
                        {roles.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='col-span-2 space-y-1'>
                    <Label className='text-[11px] text-muted-foreground'>Label (optional)</Label>
                    <Input
                      className='h-9'
                      value={step.label ?? ''}
                      onChange={(e) => setStep(idx, { label: e.target.value || null })}
                      placeholder='e.g. Manager sign-off'
                    />
                  </div>
                </div>
                <Button
                  variant='ghost'
                  size='icon'
                  className='h-8 w-8 shrink-0 text-destructive hover:text-destructive'
                  onClick={() => removeStep(idx)}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              </div>
            ))}
          </div>
        )}
        {!stepsValid && (
          <p className='text-[11px] text-destructive'>
            Each step needs an approver user or a role.
          </p>
        )}
      </div>

      <div className='flex items-center justify-between border-t border-border pt-4'>
        {confirmDelete ? (
          <div className='flex items-center gap-2'>
            <span className='text-xs text-muted-foreground'>Delete this chain?</span>
            <Button
              variant='destructive'
              size='sm'
              onClick={() => deleteMut.mutate()}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Confirm Delete'}
            </Button>
            <Button variant='ghost' size='sm' onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant='ghost'
            size='sm'
            className='text-destructive hover:text-destructive'
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='h-3.5 w-3.5 mr-1.5' />
            Delete Chain
          </Button>
        )}
        <Button onClick={() => saveMut.mutate()} disabled={!canSave || saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save Changes'}
        </Button>
      </div>
    </div>
  )
}

// ─── Active instances ─────────────────────────────────────────────────────────

const INSTANCE_STATUS_META: Record<
  ApprovalInstance['status'],
  { label: string; className: string }
> = {
  pending: {
    label: 'Pending',
    className: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20'
  },
  approved: {
    label: 'Approved',
    className: 'bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20'
  },
  rejected: {
    label: 'Rejected',
    className: 'bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20'
  },
  cancelled: { label: 'Cancelled', className: 'text-muted-foreground' }
}

function ActiveInstances() {
  const qc = useQueryClient()
  const [decideTarget, setDecideTarget] = useState<{
    instance: ApprovalInstance
    decision: 'approved' | 'rejected'
  } | null>(null)
  const [comment, setComment] = useState('')

  const { data: instances = [], isLoading } = useQuery<ApprovalInstance[]>({
    queryKey: ['approval-instances', 'pending'],
    queryFn: () =>
      api
        .get<{ data: ApprovalInstance[] }>('/approvals/instances?status=pending')
        .then((r) => r.data.data)
  })

  const decideMut = useMutation({
    mutationFn: ({
      id,
      decision,
      comment: c
    }: {
      id: number
      decision: 'approved' | 'rejected'
      comment: string
    }) => api.post(`/approvals/instances/${id}/decide`, { decision, comment: c || null }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['approval-instances'] })
      setDecideTarget(null)
      setComment('')
      toast.success(vars.decision === 'approved' ? 'Step approved' : 'Approval rejected')
    },
    onError: () => toast.error('Failed to record decision')
  })

  function currentStepLabel(inst: ApprovalInstance): string {
    const step = inst.steps.find((s) => s.step_order === inst.current_step)
    if (!step) return `Step ${inst.current_step + 1}`
    const who = step.approver_name ?? step.approver_role_name ?? 'Unassigned'
    return step.label ? `${step.label} · ${who}` : who
  }

  return (
    <div className='space-y-3 p-6'>
      {isLoading ? (
        <div className='space-y-3'>
          {[1, 2].map((i) => (
            <div key={i} className='h-16 rounded-lg bg-muted animate-pulse' />
          ))}
        </div>
      ) : instances.length === 0 ? (
        <p className='rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground'>
          No pending approval instances.
        </p>
      ) : (
        instances.map((inst) => (
          <div key={inst.id} className='rounded-lg border border-border bg-card p-4'>
            <div className='flex items-start justify-between gap-4'>
              <div className='min-w-0 space-y-1'>
                <div className='flex items-center gap-2'>
                  <span className='text-sm font-semibold'>{inst.chain_name}</span>
                  <Badge
                    variant='outline'
                    className={`text-[11px] ${INSTANCE_STATUS_META[inst.status].className}`}
                  >
                    {INSTANCE_STATUS_META[inst.status].label}
                  </Badge>
                </div>
                <Link
                  to={`/collections/${inst.collection}/${inst.item}`}
                  className='inline-block text-xs text-nvr-cyan hover:underline'
                >
                  <code>
                    {inst.collection}/{inst.item}
                  </code>
                </Link>
                <p className='text-[11px] text-muted-foreground'>
                  Current step: {currentStepLabel(inst)} · Started by{' '}
                  {inst.started_by_name ?? 'unknown'} · {formatDate(inst.created_at)}
                </p>
              </div>
              <div className='flex shrink-0 items-center gap-2'>
                <Button
                  size='sm'
                  variant='outline'
                  className='border-green-500/30 text-green-700 hover:bg-green-500/10 dark:text-green-400'
                  onClick={() => {
                    setDecideTarget({ instance: inst, decision: 'approved' })
                    setComment('')
                  }}
                >
                  <Check className='h-3.5 w-3.5 mr-1.5' />
                  Approve
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className='border-red-500/30 text-red-700 hover:bg-red-500/10 dark:text-red-400'
                  onClick={() => {
                    setDecideTarget({ instance: inst, decision: 'rejected' })
                    setComment('')
                  }}
                >
                  <X className='h-3.5 w-3.5 mr-1.5' />
                  Reject
                </Button>
              </div>
            </div>
          </div>
        ))
      )}

      <Dialog
        open={!!decideTarget}
        onOpenChange={(o) => {
          if (!o) setDecideTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {decideTarget?.decision === 'approved' ? 'Approve Step' : 'Reject Approval'}
            </DialogTitle>
          </DialogHeader>
          <div className='space-y-3'>
            <p className='text-sm text-muted-foreground'>
              {decideTarget?.decision === 'approved'
                ? 'Approve the current step of '
                : 'Reject the approval for '}
              <span className='font-medium text-foreground'>
                {decideTarget?.instance.chain_name}
              </span>
              .
            </p>
            <div className='space-y-1.5'>
              <Label htmlFor='decide-comment'>Comment (optional)</Label>
              <Textarea
                id='decide-comment'
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                placeholder='Add a note for the audit trail…'
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDecideTarget(null)}
              disabled={decideMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant={decideTarget?.decision === 'rejected' ? 'destructive' : 'default'}
              onClick={() =>
                decideTarget &&
                decideMut.mutate({
                  id: decideTarget.instance.id,
                  decision: decideTarget.decision,
                  comment
                })
              }
              disabled={decideMut.isPending}
            >
              {decideMut.isPending
                ? 'Saving…'
                : decideTarget?.decision === 'approved'
                  ? 'Approve'
                  : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ApprovalsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tab, setTab] = useState<'chains' | 'instances'>('chains')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const { data: chains = [], isLoading } = useQuery<ApprovalChain[]>({
    queryKey: ['approval-chains'],
    queryFn: () => api.get<{ data: ApprovalChain[] }>('/approvals/chains').then((r) => r.data.data)
  })

  const { data: users = [] } = useQuery<CmsUser[]>({
    queryKey: ['users-list-for-approvals'],
    queryFn: () => api.get<{ data: CmsUser[] }>('/users').then((r) => r.data.data)
  })

  const { data: roles = [] } = useQuery<RoleRow[]>({
    queryKey: ['roles-list-for-approvals'],
    queryFn: () => api.get<{ data: RoleRow[] }>('/roles').then((r) => r.data.data)
  })

  const { data: collections = [] } = useQuery<CollectionMeta[]>({
    queryKey: ['collections-list-for-approvals'],
    queryFn: () =>
      api
        .get<{ data: CollectionMeta[] }>('/collections')
        .then((r) => r.data.data.filter((c) => !c.collection.startsWith('nivaro_')))
  })

  const createMut = useMutation({
    mutationFn: (name: string) => api.post('/approvals/chains', { name, steps: [] }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['approval-chains'] })
      setCreating(false)
      setNewName('')
      const created = (res.data as { data?: ApprovalChain }).data
      if (created?.id) setSelectedId(created.id)
      toast.success('Approval chain created')
    },
    onError: () => toast.error('Failed to create chain')
  })

  const selected = chains.find((c) => c.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-border px-6 py-4 flex items-center justify-between'>
        <div className='flex items-center gap-2.5'>
          <ThumbsUp className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Approvals</h1>
        </div>
        <div className='flex items-center rounded-md border border-border p-0.5'>
          <button
            type='button'
            onClick={() => setTab('chains')}
            className={cn(
              'rounded px-3 py-1 text-[13px] font-medium transition-colors',
              tab === 'chains'
                ? 'bg-nvr-cyan/10 text-nvr-cyan'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Chains
          </button>
          <button
            type='button'
            onClick={() => setTab('instances')}
            className={cn(
              'rounded px-3 py-1 text-[13px] font-medium transition-colors',
              tab === 'instances'
                ? 'bg-nvr-cyan/10 text-nvr-cyan'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            Active Instances
          </button>
        </div>
      </header>

      {tab === 'instances' ? (
        <div className='flex-1 overflow-auto'>
          <ActiveInstances />
        </div>
      ) : (
        <div className='flex flex-1 min-h-0 overflow-hidden'>
          {/* Left list */}
          <aside className='w-[272px] shrink-0 border-r border-border overflow-y-auto'>
            <div className='flex items-center justify-between border-b border-border px-4 py-3'>
              <span className='text-xs font-semibold uppercase tracking-wider text-muted-foreground'>
                Chains
              </span>
              <Button
                variant='ghost'
                size='icon'
                className='h-7 w-7'
                onClick={() => {
                  setCreating(true)
                  setNewName('')
                }}
              >
                <Plus className='h-4 w-4' />
              </Button>
            </div>
            {isLoading ? (
              <div className='space-y-2 p-4'>
                {[1, 2, 3].map((i) => (
                  <div key={i} className='h-12 rounded-md bg-muted animate-pulse' />
                ))}
              </div>
            ) : chains.length === 0 ? (
              <p className='px-4 py-8 text-center text-xs text-muted-foreground'>
                No approval chains yet.
              </p>
            ) : (
              <div className='py-1'>
                {chains.map((c) => (
                  <button
                    key={c.id}
                    type='button'
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left transition-colors',
                      selectedId === c.id ? 'bg-nvr-cyan/10' : 'hover:bg-accent'
                    )}
                  >
                    <div className='flex w-full items-center justify-between gap-2'>
                      <span className='truncate text-[13px] font-medium'>{c.name}</span>
                      {!c.is_active && (
                        <Badge variant='outline' className='text-[10px] text-muted-foreground'>
                          Off
                        </Badge>
                      )}
                    </div>
                    <span className='text-[11px] text-muted-foreground'>
                      {c.collection ?? 'Any collection'} · {c.steps?.length ?? 0} step
                      {(c.steps?.length ?? 0) === 1 ? '' : 's'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </aside>

          {/* Right detail */}
          <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
            {selected ? (
              <ChainEditor
                key={selected.id}
                chain={selected}
                users={users}
                roles={roles}
                collections={collections}
                onSaved={() => {}}
                onDeleted={() => setSelectedId(null)}
              />
            ) : (
              <div className='flex h-full flex-col items-center justify-center text-center'>
                <ThumbsUp className='h-10 w-10 text-muted-foreground mb-3' />
                <p className='text-sm font-medium mb-1'>No chain selected</p>
                <p className='text-xs text-muted-foreground mb-4'>
                  Select a chain to edit its steps, or create a new one.
                </p>
                <Button
                  size='sm'
                  onClick={() => {
                    setCreating(true)
                    setNewName('')
                  }}
                >
                  <Plus className='h-4 w-4 mr-1.5' />
                  New Chain
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create chain dialog */}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Approval Chain</DialogTitle>
          </DialogHeader>
          <div className='space-y-1.5'>
            <Label htmlFor='new-chain-name'>Chain Name</Label>
            <Input
              id='new-chain-name'
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder='e.g. Contract Approval'
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newName.trim()) createMut.mutate(newName.trim())
              }}
            />
            <p className='text-[11px] text-muted-foreground'>
              You can add steps after creating the chain.
            </p>
          </div>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setCreating(false)}
              disabled={createMut.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createMut.mutate(newName.trim())}
              disabled={createMut.isPending || newName.trim() === ''}
            >
              {createMut.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
