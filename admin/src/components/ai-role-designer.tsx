import { useMutation } from '@tanstack/react-query'
import { Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Design a role from a description (#2010). The AI turns a sentence into a
 * proposed role; the admin edits the change set (drop grants, field limits,
 * UI restrictions, rename), the permission simulator runs on exactly what
 * will be saved, and only a proposal whose simulation is current can be
 * created (the server checks the simulation's hash).
 */

type Action = 'create' | 'read' | 'update' | 'delete'
const ACTIONS: Action[] = ['create', 'read', 'update', 'delete']

interface RowCondition {
  field: string
  op: string
  value?: unknown
}

interface ProposedPolicy {
  collection: string
  action: Action
  fields: string[] | null
  row_filter: RowCondition[] | null
  why: string | null
}

interface RoleProposal {
  name: string
  description: string
  app_access: boolean
  policies: ProposedPolicy[]
  ui_disabled: string[]
  scopes: Array<{ dimension: string; values: string[]; labels: string[] }>
  notes: string[]
}

interface SimulatedCollection {
  collection: string
  label: string
  actions: Record<Action, { allowed: boolean; reason: string }>
  rows: { total: number; visible: number } | null
  rows_error?: string
}

interface DesignResult {
  proposal: RoleProposal
  dropped: string[]
  simulation: SimulatedCollection[]
  hash: string
}

const errOf = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback

const filterText = (rf: RowCondition[]) =>
  rf
    .map((c) => `${c.field} ${c.op}${c.value !== undefined ? ` ${JSON.stringify(c.value)}` : ''}`)
    .join(' and ')

export function RoleDesigner({
  uiRoutes,
  onCreated,
  onCancel
}: {
  uiRoutes: Array<{ path: string; label: string }>
  onCreated: (roleId: string) => void
  onCancel: () => void
}) {
  const [description, setDescription] = useState('')
  const [result, setResult] = useState<DesignResult | null>(null)
  const [proposal, setProposal] = useState<RoleProposal | null>(null)
  const [stale, setStale] = useState(false)

  const take = (data: DesignResult) => {
    setResult(data)
    setProposal(data.proposal)
    setStale(false)
  }

  const design = useMutation({
    mutationFn: () =>
      api
        .post<{ data: DesignResult }>('/ai-design/roles/design', {
          description,
          ui_routes: uiRoutes
        })
        .then((r) => r.data.data),
    onSuccess: take,
    onError: (e) => toast.error(errOf(e, 'The AI could not design the role'))
  })

  const simulate = useMutation({
    mutationFn: (p: RoleProposal) =>
      api
        .post<{ data: DesignResult }>('/ai-design/roles/simulate', {
          proposal: p,
          ui_routes: uiRoutes
        })
        .then((r) => r.data.data),
    onSuccess: take,
    onError: (e) => toast.error(errOf(e, 'Simulation failed'))
  })

  const create = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { id: string; name: string; policies: number } }>('/ai-design/roles/apply', {
          proposal,
          hash: result?.hash,
          ui_routes: uiRoutes
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      toast.success(`Role "${data.name}" created with ${data.policies} policies`)
      onCreated(data.id)
    },
    onError: (e) => toast.error(errOf(e, 'Could not create the role'))
  })

  const edit = (next: RoleProposal) => {
    setProposal(next)
    setStale(true)
  }

  const routeLabel = (p: string) => uiRoutes.find((u) => u.path === p)?.label ?? p

  return (
    <div className='h-full overflow-y-auto p-6' data-ai-role-designer>
      <div className='mb-4 flex items-center justify-between'>
        <h2 className='flex items-center gap-2 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          <Sparkles className='h-4 w-4 text-nvr-cyan' /> Design a role from a description
        </h2>
        <Button size='sm' variant='outline' onClick={onCancel}>
          Cancel
        </Button>
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <label htmlFor='ai-role-desc' className='text-[12px] font-medium text-slate-600'>
          What should people in this role be able to do?
        </label>
        <textarea
          id='ai-role-desc'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder='Reads invoices in Zone 3, approves inventory requests, cannot export'
          className='mt-1 w-full rounded border border-slate-200 bg-white px-2 py-1.5 text-[13px] dark:border-border dark:bg-background'
        />
        <div className='mt-2 flex items-center gap-2'>
          <Button
            size='sm'
            disabled={design.isPending || description.trim().length < 8}
            onClick={() => design.mutate()}
          >
            {design.isPending ? 'Designing…' : result ? 'Design again' : 'Propose a role'}
          </Button>
          <span className='text-[11px] text-slate-400'>
            Nothing is saved until you create the role.
          </span>
        </div>
      </div>

      {proposal && result && (
        <div className='mt-4 space-y-4'>
          <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500'>
              Proposed role
            </p>
            <div className='grid grid-cols-2 gap-3'>
              <Input
                value={proposal.name}
                onChange={(e) => edit({ ...proposal, name: e.target.value })}
                aria-label='Role name'
                className='text-[13px]'
              />
              <Input
                value={proposal.description}
                onChange={(e) => edit({ ...proposal, description: e.target.value })}
                aria-label='Role description'
                className='text-[13px]'
              />
            </div>
            <label className='mt-2 flex items-center gap-2 text-[12px] text-slate-600'>
              <input
                type='checkbox'
                checked={proposal.app_access}
                onChange={(e) => edit({ ...proposal, app_access: e.target.checked })}
                className='h-3.5 w-3.5 accent-nvr-cyan'
              />
              App access
            </label>

            <table className='mt-3 w-full text-[12px]'>
              <thead>
                <tr className='text-left text-[11px] text-slate-500'>
                  <th className='py-1 font-medium'>Collection</th>
                  <th className='py-1 font-medium'>Action</th>
                  <th className='py-1 font-medium'>Limits</th>
                  <th className='py-1 font-medium'>Why</th>
                  <th />
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {proposal.policies.map((p, i) => (
                  <tr key={`${p.collection}:${p.action}`} className='align-top'>
                    <td className='py-1.5 font-mono text-[11.5px]'>{p.collection}</td>
                    <td className='py-1.5 capitalize'>{p.action}</td>
                    <td className='py-1.5'>
                      {p.fields && (
                        <div className='flex flex-wrap gap-1'>
                          {p.fields.map((f) => (
                            <span
                              key={f}
                              className='inline-flex items-center gap-0.5 rounded bg-slate-100 px-1 font-mono text-[10.5px] dark:bg-muted'
                            >
                              {f}
                              {p.fields && p.fields.length > 1 && (
                                <button
                                  type='button'
                                  aria-label={`Remove ${f}`}
                                  onClick={() => {
                                    const policies = [...proposal.policies]
                                    policies[i] = {
                                      ...p,
                                      fields: (p.fields ?? []).filter((x) => x !== f)
                                    }
                                    edit({ ...proposal, policies })
                                  }}
                                >
                                  <X className='h-2.5 w-2.5' />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      )}
                      {p.row_filter && (
                        <p className='mt-0.5 text-[11px] text-slate-500'>
                          Rows where {filterText(p.row_filter)}
                        </p>
                      )}
                      {!p.fields && !p.row_filter && (
                        <span className='text-[11px] text-slate-400'>All fields, all rows</span>
                      )}
                    </td>
                    <td className='py-1.5 text-[11px] text-slate-500'>{p.why}</td>
                    <td className='py-1.5 text-right'>
                      <button
                        type='button'
                        aria-label='Remove grant'
                        onClick={() =>
                          edit({
                            ...proposal,
                            policies: proposal.policies.filter((_, j) => j !== i)
                          })
                        }
                        className='text-slate-400 hover:text-red-500'
                      >
                        <X className='h-3.5 w-3.5' />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {proposal.ui_disabled.length > 0 && (
              <div className='mt-3'>
                <p className='text-[11px] font-medium text-slate-500'>Pages switched off</p>
                <div className='mt-1 flex flex-wrap gap-1'>
                  {proposal.ui_disabled.map((u) => (
                    <span
                      key={u}
                      className='inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] dark:bg-muted'
                    >
                      {routeLabel(u)}
                      <button
                        type='button'
                        aria-label={`Keep ${u} on`}
                        onClick={() =>
                          edit({
                            ...proposal,
                            ui_disabled: proposal.ui_disabled.filter((x) => x !== u)
                          })
                        }
                      >
                        <X className='h-2.5 w-2.5' />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {proposal.scopes.length > 0 && (
              <div className='mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11.5px] dark:border-border dark:bg-muted/30'>
                <p className='font-medium text-slate-600 dark:text-slate-300'>
                  User Scopes for its members
                </p>
                {proposal.scopes.map((s) => (
                  <p key={s.dimension} className='text-slate-500'>
                    {s.dimension}: {s.labels.join(', ')}
                  </p>
                ))}
                <p className='mt-1 text-slate-400'>
                  Scopes belong to people, not roles — set them on each member under Users → Access
                  after adding them to the role.
                </p>
              </div>
            )}

            {(proposal.notes.length > 0 || result.dropped.length > 0) && (
              <ul className='mt-3 space-y-0.5 text-[11.5px]'>
                {proposal.notes.map((n) => (
                  <li key={n} className='text-slate-500'>
                    Note: {n}
                  </li>
                ))}
                {result.dropped.map((d) => (
                  <li key={d} className='text-amber-600'>
                    {d}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <div className='mb-2 flex items-center justify-between'>
              <p className='text-[11px] font-medium uppercase tracking-wide text-slate-500'>
                Permission simulator
              </p>
              {stale && (
                <Button
                  size='sm'
                  variant='outline'
                  disabled={simulate.isPending}
                  onClick={() => simulate.mutate(proposal)}
                >
                  {simulate.isPending ? 'Simulating…' : 'Run simulator on the edits'}
                </Button>
              )}
            </div>
            <div className={cn(stale && 'opacity-50')}>
              <table className='w-full text-[12px]'>
                <thead>
                  <tr className='text-left text-[11px] text-slate-500'>
                    <th className='py-1 font-medium'>Collection</th>
                    {ACTIONS.map((a) => (
                      <th key={a} className='py-1 text-center font-medium capitalize'>
                        {a}
                      </th>
                    ))}
                    <th className='py-1 text-right font-medium'>Rows a member sees</th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-slate-100 dark:divide-border'>
                  {result.simulation.map((s) => (
                    <tr key={s.collection}>
                      <td className='py-1.5'>{s.label}</td>
                      {ACTIONS.map((a) => (
                        <td key={a} className='py-1.5 text-center' data-tip={s.actions[a].reason}>
                          {s.actions[a].allowed ? (
                            <span className='text-emerald-600'>✓</span>
                          ) : (
                            <span className='text-slate-300'>—</span>
                          )}
                        </td>
                      ))}
                      <td className='py-1.5 text-right text-slate-500'>
                        {s.rows
                          ? `${s.rows.visible.toLocaleString()} of ${s.rows.total.toLocaleString()}`
                          : s.rows_error
                            ? 'could not count'
                            : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className='mt-3 flex items-center gap-2'>
              <Button
                size='sm'
                disabled={stale || create.isPending || proposal.policies.length === 0}
                onClick={() => create.mutate()}
              >
                {create.isPending ? 'Creating…' : 'Create role'}
              </Button>
              {stale && (
                <span className='text-[11px] text-amber-600'>
                  You changed the proposal — run the simulator before creating it.
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
