import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative } from '@/lib/utils'

interface ApprovalChain {
  id: number | string
  name: string
  description?: string | null
}

interface ApprovalDecision {
  id: number | string
  step?: number
  step_label?: string | null
  approver?: string | null
  approver_name?: string | null
  decision?: 'approved' | 'rejected' | 'pending' | null
  status?: string | null
  comment?: string | null
  decided_at?: string | null
}

interface ApprovalInstance {
  id: number | string
  chain_id?: number | string
  chain_name?: string | null
  status?: string | null
  current_step?: number | null
  decisions?: ApprovalDecision[]
  created_at?: string | null
}

function decisionState(d: ApprovalDecision): 'approved' | 'rejected' | 'pending' {
  const v = (d.decision ?? d.status ?? 'pending').toLowerCase()
  if (v === 'approved') return 'approved'
  if (v === 'rejected') return 'rejected'
  return 'pending'
}

/**
 * Optional per-record approval chains. Renders null when the collection has no
 * chains configured AND the item has no approval instances — users who don't
 * use approvals never see this panel.
 */
export function ApprovalPanel({ collection, item }: { collection: string; item: string }) {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [requesting, setRequesting] = useState(false)
  const [chainOpen, setChainOpen] = useState(false)
  const [decidingId, setDecidingId] = useState<string | null>(null)
  const [pendingDecision, setPendingDecision] = useState<'approved' | 'rejected' | null>(null)
  const [comment, setComment] = useState('')

  const enabled = !!collection && !!item && item !== 'new'

  const { data: chains = [] } = useQuery({
    queryKey: ['approval-chains', collection],
    queryFn: () =>
      api
        .get<{ data: ApprovalChain[] }>('/approvals/chains', { params: { collection } })
        .then((r) => r.data.data ?? []),
    enabled,
    staleTime: 60_000
  })

  const { data: instances = [] } = useQuery({
    queryKey: ['approval-instances', collection, item],
    queryFn: () =>
      api
        .get<{ data: ApprovalInstance[] }>('/approvals/instances', {
          params: { collection, item }
        })
        .then((r) => r.data.data ?? []),
    enabled
  })

  const startMut = useMutation({
    mutationFn: (chainId: number | string) =>
      api.post('/approvals/start', { chain_id: chainId, collection, item }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-instances', collection, item] })
      setRequesting(false)
      toast.success('Approval requested')
    },
    onError: () => toast.error('Failed to start approval')
  })

  const decideMut = useMutation({
    mutationFn: ({
      instanceId,
      decision
    }: {
      instanceId: number | string
      decision: 'approved' | 'rejected'
    }) =>
      api.post(`/approvals/instances/${instanceId}/decide`, {
        decision,
        comment: comment.trim() || undefined
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['approval-instances', collection, item] })
      setDecidingId(null)
      setPendingDecision(null)
      setComment('')
      toast.success('Decision recorded')
    },
    onError: () => toast.error('Failed to record decision')
  })

  // Keep this panel invisible for collections/items that don't use approvals.
  if (!enabled || (chains.length === 0 && instances.length === 0)) return null

  const activeInstances = instances.filter(
    (i) => (i.status ?? 'pending').toLowerCase() === 'pending'
  )
  const hasActive = activeInstances.length > 0

  return (
    <Card>
      <CardHeader className='pb-2'>
        <div className='flex items-center justify-between'>
          <CardTitle className='text-sm font-medium text-slate-500 flex items-center gap-1.5'>
            <ShieldCheck className='h-3.5 w-3.5' />
            Approvals
          </CardTitle>
          {!hasActive && chains.length > 0 && !requesting && (
            <button
              type='button'
              onClick={() => setRequesting(true)}
              className='text-[12px] text-slate-400 transition-colors hover:text-nvr-cyan'
            >
              Request approval
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className='space-y-4'>
        {requesting && !hasActive && (
          <div className='flex items-center gap-2'>
            <Popover open={chainOpen} onOpenChange={setChainOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant='outline'
                  role='combobox'
                  aria-expanded={chainOpen}
                  className='h-8 flex-1 justify-between px-2.5 text-[12px] font-normal'
                  disabled={startMut.isPending}
                >
                  <span className='text-muted-foreground'>Choose approval chain…</span>
                  <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
                </Button>
              </PopoverTrigger>
              <PopoverContent className='w-[280px] p-0' align='start'>
                <Command>
                  <CommandInput placeholder='Search chains…' className='h-8 text-[12px]' />
                  <CommandList>
                    <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
                      No chains found
                    </CommandEmpty>
                    <CommandGroup>
                      {chains.map((c) => (
                        <CommandItem
                          key={String(c.id)}
                          value={c.name}
                          onSelect={() => {
                            setChainOpen(false)
                            startMut.mutate(c.id)
                          }}
                          className='text-[12px]'
                        >
                          {c.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              className='h-8 text-[12px]'
              onClick={() => setRequesting(false)}
            >
              Cancel
            </Button>
          </div>
        )}

        {instances.length === 0 && !requesting && (
          <p className='text-[12px] text-slate-400'>No approvals requested for this item.</p>
        )}

        {instances.map((inst) => {
          const decisions = inst.decisions ?? []
          const firstPendingIdx = decisions.findIndex((d) => decisionState(d) === 'pending')
          const instanceStatus = (inst.status ?? 'pending').toLowerCase()
          return (
            <div key={String(inst.id)} className='rounded-lg border border-slate-200'>
              <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2'>
                <span className='text-[12px] font-medium text-slate-700'>
                  {inst.chain_name ?? 'Approval'}
                </span>
                <span
                  className={cn(
                    'rounded-full px-2 py-0.5 text-[10px] font-medium',
                    instanceStatus === 'approved'
                      ? 'bg-emerald-100 text-emerald-700'
                      : instanceStatus === 'rejected'
                        ? 'bg-red-100 text-red-600'
                        : 'bg-amber-100 text-amber-700'
                  )}
                >
                  {instanceStatus}
                </span>
              </div>
              <div className='divide-y divide-slate-50'>
                {decisions.map((d, idx) => {
                  const state = decisionState(d)
                  const isCurrent = instanceStatus === 'pending' && idx === firstPendingIdx
                  const isMine =
                    isCurrent &&
                    !!d.approver &&
                    !!user?.id &&
                    String(d.approver) === String(user.id)
                  return (
                    <div
                      key={String(d.id)}
                      className={cn(
                        'px-3 py-2',
                        isCurrent && 'bg-nvr-cyan/5 border-l-2 border-l-nvr-cyan'
                      )}
                    >
                      <div className='flex items-center gap-2'>
                        <span
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold',
                            state === 'approved'
                              ? 'bg-emerald-100 text-emerald-600'
                              : state === 'rejected'
                                ? 'bg-red-100 text-red-500'
                                : 'bg-slate-100 text-slate-400'
                          )}
                        >
                          {state === 'approved' ? (
                            <Check className='h-2.5 w-2.5' />
                          ) : state === 'rejected' ? (
                            <X className='h-2.5 w-2.5' />
                          ) : (
                            idx + 1
                          )}
                        </span>
                        <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700'>
                          {d.step_label ?? `Step ${idx + 1}`}
                        </span>
                        <span className='shrink-0 text-[11px] text-slate-400'>
                          {d.approver_name ?? ''}
                        </span>
                        {d.decided_at && (
                          <span className='shrink-0 text-[10px] text-slate-300'>
                            {formatRelative(d.decided_at)}
                          </span>
                        )}
                      </div>
                      {d.comment && (
                        <p className='mt-1 pl-6 text-[11px] italic text-slate-500'>"{d.comment}"</p>
                      )}
                      {isMine && decidingId !== String(inst.id) && (
                        <div className='mt-2 flex gap-2 pl-6'>
                          <Button
                            size='sm'
                            className='h-6 bg-emerald-600 px-2 text-[11px] text-white hover:bg-emerald-700'
                            onClick={() => {
                              setDecidingId(String(inst.id))
                              setPendingDecision('approved')
                            }}
                          >
                            Approve
                          </Button>
                          <Button
                            size='sm'
                            variant='outline'
                            className='h-6 px-2 text-[11px] text-red-500 hover:border-red-200 hover:bg-red-50'
                            onClick={() => {
                              setDecidingId(String(inst.id))
                              setPendingDecision('rejected')
                            }}
                          >
                            Reject
                          </Button>
                        </div>
                      )}
                      {isMine && decidingId === String(inst.id) && pendingDecision && (
                        <div className='mt-2 space-y-2 pl-6'>
                          <Textarea
                            value={comment}
                            onChange={(e) => setComment(e.target.value)}
                            rows={2}
                            className='text-[12px]'
                            placeholder='Optional comment…'
                          />
                          <div className='flex justify-end gap-2'>
                            <Button
                              size='sm'
                              variant='outline'
                              className='h-6 px-2 text-[11px]'
                              onClick={() => {
                                setDecidingId(null)
                                setPendingDecision(null)
                                setComment('')
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size='sm'
                              className={cn(
                                'h-6 px-2 text-[11px] text-white',
                                pendingDecision === 'approved'
                                  ? 'bg-emerald-600 hover:bg-emerald-700'
                                  : 'bg-red-500 hover:bg-red-600'
                              )}
                              disabled={decideMut.isPending}
                              onClick={() =>
                                decideMut.mutate({ instanceId: inst.id, decision: pendingDecision })
                              }
                            >
                              {decideMut.isPending
                                ? 'Saving…'
                                : `Confirm ${pendingDecision === 'approved' ? 'approval' : 'rejection'}`}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
