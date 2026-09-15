import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { api, type User } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Bulk hand-off for everyone the directory says is gone: pick ONE successor,
 * every departed user's claims, open ownerships, tasks, owner-group seats,
 * delegate chains and subscriptions move to them in one pass — the same
 * offboarding run the user page offers one person at a time.
 */

type Holdings = {
  user: { id: string; name: string; status: string | null }
  holdings: Record<string, number>
}

const HOLDING_LABELS: Record<string, string> = {
  queue_claims: 'claims',
  instance_ownerships: 'ownerships',
  open_tasks: 'tasks',
  owner_group_memberships: 'owner seats',
  delegates_pointing_here: 'delegations',
  direct_reports: 'reports',
  notification_subscriptions: 'subscriptions',
  field_watches: 'watches'
}

function describe(h: Record<string, number>) {
  const parts = Object.entries(h)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${HOLDING_LABELS[k] ?? k}`)
  return parts.length ? parts.join(' · ') : 'nothing to hand off'
}

function SuccessorPicker({
  value,
  onPick
}: {
  value: { id: string; name: string } | null
  onPick: (u: { id: string; name: string } | null) => void
}) {
  const [search, setSearch] = useState('')
  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['handoff-successor-search', search],
    queryFn: () => api.get('/users', { params: { search, limit: 8 } }).then((r) => r.data.data),
    enabled: search.length > 1
  })
  if (value) {
    return (
      <span className='inline-flex items-center gap-1.5 rounded-full bg-nvr-cyan/10 px-2.5 py-1 text-[12px] font-medium text-nvr-navy dark:text-nvr-cyan'>
        {value.name}
        <button
          type='button'
          onClick={() => onPick(null)}
          aria-label='Clear'
          className='text-[11px]'
        >
          ✕
        </button>
      </span>
    )
  }
  return (
    <div className='relative'>
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder='Search for the person taking over…'
        className='h-8 text-[12.5px]'
        autoComplete='off'
      />
      {search.length > 1 && users.length > 0 && (
        <div className='absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-md border border-slate-200 bg-white shadow-md dark:border-border dark:bg-card'>
          {users
            .filter((u) => u.status !== 'suspended')
            .map((u) => {
              const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => {
                    onPick({ id: u.id, name })
                    setSearch('')
                  }}
                  className='flex w-full flex-col items-start px-3 py-1.5 text-left hover:bg-muted'
                >
                  <span className='text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                    {name}
                  </span>
                  <span className='text-[11px] text-slate-400'>{u.email}</span>
                </button>
              )
            })}
        </div>
      )}
    </div>
  )
}

export function DepartedHandoffDialog({
  open,
  onOpenChange,
  users
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The departed users (directory_status disabled or missing). */
  users: User[]
}) {
  const qc = useQueryClient()
  const [successor, setSuccessor] = useState<{ id: string; name: string } | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const holdings = useQueries({
    queries: users.map((u) => ({
      queryKey: ['offboard-holdings', u.id],
      queryFn: () => api.get(`/offboarding/${u.id}`).then((r) => r.data.data as Holdings),
      enabled: open
    }))
  })
  const rows = users.map((u, i) => ({
    user: u,
    holdings: holdings[i]?.data?.holdings ?? null,
    total: Object.values(holdings[i]?.data?.holdings ?? {}).reduce((a, b) => a + b, 0)
  }))
  const targets = rows.filter((r) => !excluded.has(r.user.id) && r.total > 0)

  const run = useMutation({
    mutationFn: async () => {
      const done: string[] = []
      const failed: string[] = []
      for (const r of targets) {
        try {
          await api.post(`/offboarding/${r.user.id}/run`, {
            successor: successor?.id,
            include: {},
            suspend: true
          })
          done.push(r.user.id)
        } catch {
          failed.push(r.user.email)
        }
      }
      return { done, failed }
    },
    onSuccess: ({ done, failed }) => {
      qc.invalidateQueries({ queryKey: ['users'] })
      qc.invalidateQueries({ queryKey: ['offboard-holdings'] })
      if (failed.length === 0) {
        toast.success(
          `Handed off ${done.length} ${done.length === 1 ? 'person' : 'people'} to ${successor?.name}`
        )
        onOpenChange(false)
      } else {
        toast.error(`${done.length} handed off, ${failed.length} failed: ${failed.join(', ')}`)
      }
    }
  })

  const name = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-xl'>
        <DialogHeader>
          <DialogTitle>Hand off departed users</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className='space-y-4'>
            <p className='text-[12.5px] text-slate-600 dark:text-muted-foreground'>
              Everything these people still hold — claims, open record ownerships, tasks,
              owner-group seats, delegations, subscriptions — moves to one successor. They stay
              suspended. Redaction is a separate step.
            </p>
            <div className='space-y-1.5'>
              <p className='text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                Successor
              </p>
              <SuccessorPicker value={successor} onPick={setSuccessor} />
            </div>
            <div className='max-h-72 overflow-y-auto rounded-md border border-slate-200 dark:border-border'>
              {rows.length === 0 && (
                <p className='px-3 py-3 text-[12px] text-slate-400'>Nobody is marked departed.</p>
              )}
              {rows.map((r) => {
                const off = excluded.has(r.user.id)
                return (
                  <label
                    key={r.user.id}
                    className={cn(
                      'flex cursor-pointer items-start gap-2.5 border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-border',
                      off && 'opacity-50'
                    )}
                  >
                    <input
                      type='checkbox'
                      className='mt-0.5'
                      checked={!off && r.total > 0}
                      disabled={r.total === 0}
                      onChange={(e) =>
                        setExcluded((s) => {
                          const n = new Set(s)
                          if (e.target.checked) n.delete(r.user.id)
                          else n.add(r.user.id)
                          return n
                        })
                      }
                    />
                    <span className='min-w-0 flex-1'>
                      <span className='flex items-center gap-2 text-[12.5px] font-medium text-slate-800 dark:text-foreground'>
                        {name(r.user)}
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                            r.user.directory_status === 'missing'
                              ? 'bg-red-50 text-red-700 dark:bg-red-400/10 dark:text-red-300'
                              : 'bg-amber-50 text-amber-800 dark:bg-amber-400/10 dark:text-amber-200'
                          )}
                        >
                          {r.user.directory_status === 'missing' ? 'Not in directory' : 'Disabled'}
                        </span>
                      </span>
                      <span className='block text-[11px] text-slate-400'>
                        {r.holdings ? describe(r.holdings) : 'counting…'}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type='button'
            onClick={() => run.mutate()}
            disabled={!successor || targets.length === 0 || run.isPending}
          >
            {run.isPending
              ? 'Handing off…'
              : `Hand off ${targets.length} ${targets.length === 1 ? 'person' : 'people'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
