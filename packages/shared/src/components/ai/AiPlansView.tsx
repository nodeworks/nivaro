import { useQuery, useQueryClient } from '@tanstack/react-query'
import { History, LayoutTemplate, ListChecks, Loader2, Undo2, Workflow } from 'lucide-react'
import { useState } from 'react'
import { useNavigation, useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { type AiPlan, AiPlanCard, type AiPlanSubscribe } from './AiPlanCard'

/**
 * Ask AI plans outside the chat: HISTORY (#1954) — every plan run, who
 * approved it and when, its steps, the records it touched and how it ended,
 * with the change report (#2002), Undo where the writes can still be
 * reverted, and "Make a draft flow" (#1849) — and TEMPLATES (#1952):
 * ready-made plans with blanks, proposed and previewed like any other plan.
 *
 * Everyone sees their own plans and can use templates; administrators see
 * every plan, undo, make flows and define templates. The server enforces
 * all of it — `isAdmin` only decides what to offer.
 */

interface PlanListRow {
  plan_id: string
  title: string
  status: AiPlan['status']
  owner: { id: string; name: string }
  approved_by: { id: string; name: string } | null
  approved_at: string | null
  created_at: string | null
  executed_at: string | null
  steps: number
  steps_failed: number
  records_changed: number
  impact: string
  schedule: { run_at: string } | null
  template: string | null
  source: string | null
  has_undo: boolean
}

interface UndoRecord {
  id: string
  collection: string
  label: string
  status: 'revertible' | 'changed' | 'gone' | 'undone'
  reason?: string
}

interface UndoStep {
  step_id: string
  n: number
  title: string
  kind_label: string
  not_revertible?: string
  revertible: number
  blocked: number
  undone_at: string | null
  records: UndoRecord[]
}

interface TemplateBlank {
  key: string
  label: string
  type: string
  help?: string
  optional?: boolean
}

interface PlanTemplate {
  key: string
  label: string
  description: string
  builtin: boolean
  blanks: TemplateBlank[]
  title: string
  steps: Array<Record<string, unknown>>
}

const STATUS_CLS: Record<string, string> = {
  executed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  failed: 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400',
  running: 'bg-nvr-cyan/10 text-nvr-cyan',
  scheduled: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  proposed: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  paused: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
}

const STATUS_FILTERS = ['', 'executed', 'failed', 'scheduled', 'proposed', 'running', 'rejected']

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1.5 py-px text-[10px] font-medium capitalize',
        STATUS_CLS[status] ?? 'bg-muted text-muted-foreground'
      )}
    >
      {status}
    </span>
  )
}

function errText(err: unknown): string {
  return (err as Error)?.message || 'The request failed'
}

export function AiPlansView({
  isAdmin,
  planId,
  onSelectPlan,
  subscribe,
  className
}: {
  isAdmin: boolean
  /** The selected plan (the host keeps it in the URL, e.g. ?plan=<id>). */
  planId?: string | null
  onSelectPlan?: (id: string | null) => void
  subscribe?: AiPlanSubscribe
  className?: string
}) {
  const [tab, setTab] = useState<'history' | 'templates'>('history')
  const [localId, setLocalId] = useState<string | null>(null)
  const selected = planId !== undefined ? planId : localId
  const select = (id: string | null) => {
    setLocalId(id)
    onSelectPlan?.(id)
  }

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col', className)}>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3 dark:border-border dark:bg-card'>
        <ListChecks className='h-4 w-4 text-slate-400' />
        <h1 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>Plans</h1>
        <div className='ml-4 flex gap-1'>
          {(
            [
              ['history', 'History', History],
              ['templates', 'Templates', LayoutTemplate]
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              type='button'
              onClick={() => setTab(key)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium',
                tab === key
                  ? 'bg-nvr-cyan/10 text-nvr-cyan'
                  : 'text-slate-500 hover:bg-muted dark:text-muted-foreground'
              )}
            >
              <Icon className='h-3.5 w-3.5' />
              {label}
            </button>
          ))}
        </div>
      </header>
      {tab === 'history' ? (
        <PlanHistory
          isAdmin={isAdmin}
          selected={selected}
          onSelect={select}
          subscribe={subscribe}
        />
      ) : (
        <PlanTemplates
          isAdmin={isAdmin}
          subscribe={subscribe}
          onOpen={(id) => {
            setTab('history')
            select(id)
          }}
        />
      )}
    </div>
  )
}

function PlanHistory({
  isAdmin,
  selected,
  onSelect,
  subscribe
}: {
  isAdmin: boolean
  selected: string | null
  onSelect: (id: string | null) => void
  subscribe?: AiPlanSubscribe
}) {
  const client = useNivaroClient()
  const [scope, setScope] = useState<'mine' | 'all'>(isAdmin ? 'all' : 'mine')
  const [status, setStatus] = useState('')
  const list = useQuery({
    queryKey: ['ai-plans', 'history', scope, status],
    queryFn: () =>
      client.request<{ data: PlanListRow[]; total: number }>(
        get('/ai/plans', { scope, ...(status ? { status } : {}), limit: 200 })
      ),
    refetchInterval: 30_000
  })
  const rows = list.data?.data ?? []

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className='flex w-[320px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-1 border-b border-slate-100 px-3 py-2 dark:border-border'>
          {isAdmin &&
            (['all', 'mine'] as const).map((s) => (
              <button
                key={s}
                type='button'
                onClick={() => setScope(s)}
                className={cn(
                  'h-6 rounded px-2 text-[11.5px]',
                  scope === s
                    ? 'bg-accent font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                )}
              >
                {s === 'all' ? 'Everyone' : 'Mine'}
              </button>
            ))}
          <span className='mx-1 h-4 w-px bg-border' />
          {STATUS_FILTERS.map((s) => (
            <button
              key={s || 'any'}
              type='button'
              onClick={() => setStatus(s)}
              className={cn(
                'h-6 rounded px-1.5 text-[11px] capitalize',
                status === s
                  ? 'bg-accent font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              )}
            >
              {s || 'any'}
            </button>
          ))}
        </div>
        <div className='flex-1 overflow-y-auto'>
          {list.isLoading && (
            <p className='flex items-center gap-1.5 p-4 text-[12px] text-muted-foreground'>
              <Loader2 className='h-3 w-3 animate-spin' /> Loading…
            </p>
          )}
          {!list.isLoading && rows.length === 0 && (
            <p className='p-4 text-[12px] text-muted-foreground'>
              No plans yet. Ask AI proposes one when a request needs several changes together, or
              start from a template.
            </p>
          )}
          {rows.map((p) => (
            <button
              key={p.plan_id}
              type='button'
              onClick={() => onSelect(p.plan_id)}
              className={cn(
                'block w-full border-b border-slate-100 px-3 py-2 text-left dark:border-border',
                selected?.toUpperCase() === p.plan_id.toUpperCase() ? 'bg-accent' : 'hover:bg-muted'
              )}
            >
              <div className='flex items-center gap-1.5'>
                <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground'>
                  {p.title}
                </span>
                <StatusPill status={p.status} />
              </div>
              <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>{p.impact}</p>
              <p className='mt-0.5 truncate text-[11px] text-muted-foreground'>
                {p.owner.name}
                {p.approved_by && p.approved_by.id !== p.owner.id
                  ? ` · approved by ${p.approved_by.name}`
                  : ''}
                {p.created_at ? ` · ${formatRelative(p.created_at)}` : ''}
                {p.records_changed > 0 ? ` · ${p.records_changed} changed` : ''}
              </p>
            </button>
          ))}
        </div>
      </aside>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-5 dark:bg-background'>
        {selected ? (
          <PlanDetail key={selected} id={selected} isAdmin={isAdmin} subscribe={subscribe} />
        ) : (
          <div className='flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground'>
            <History className='h-6 w-6' />
            <p className='text-[12.5px]'>Pick a plan to see its steps, changes and outcome.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function PlanDetail({
  id,
  isAdmin,
  subscribe
}: {
  id: string
  isAdmin: boolean
  subscribe?: AiPlanSubscribe
}) {
  const client = useNivaroClient()
  const plan = useQuery({
    queryKey: ['ai-plans', 'plan', id],
    queryFn: () =>
      client
        .request<{ data: AiPlan & { created_at?: string | null; executed_at?: string | null } }>(
          get(`/ai/plans/${encodeURIComponent(id)}`)
        )
        .then((r) => r.data)
  })
  if (plan.isLoading) {
    return (
      <p className='flex items-center gap-1.5 text-[12px] text-muted-foreground'>
        <Loader2 className='h-3 w-3 animate-spin' /> Loading…
      </p>
    )
  }
  if (!plan.data) {
    return <p className='text-[12px] text-rose-700 dark:text-rose-400'>{errText(plan.error)}</p>
  }
  const p = plan.data
  const meta: Array<[string, string]> = [
    ['Approved', p.approved_at ? formatRelative(p.approved_at) : '—'],
    ['Created', p.created_at ? formatRelative(p.created_at) : '—'],
    ['Finished', p.executed_at ? formatRelative(p.executed_at) : '—'],
    ['From', p.template?.label ?? p.source?.label ?? 'Ask AI']
  ]
  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border md:grid-cols-4'>
        {meta.map(([k, v]) => (
          <div key={k} className='bg-white px-3 py-2 dark:bg-card'>
            <p className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>{k}</p>
            <p className='truncate text-[12.5px] text-foreground'>{v}</p>
          </div>
        ))}
      </div>
      <AiPlanCard plan={p} subscribe={subscribe} className='mt-0 bg-white dark:bg-card' />
      {isAdmin && (p.made_steps?.length ?? 0) > 0 && <UndoPanel id={id} />}
      {isAdmin && p.status === 'executed' && <FlowPanel id={id} flowId={p.flow_id ?? null} />}
    </div>
  )
}

function UndoPanel({ id }: { id: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const check = useQuery({
    queryKey: ['ai-plans', 'undo', id],
    queryFn: () =>
      client
        .request<{ data: { steps: UndoStep[] } }>(get(`/ai/plans/${encodeURIComponent(id)}/undo`))
        .then((r) => r.data.steps)
  })
  const run = (stepId: string | null) => {
    setBusy(true)
    void client
      .request<{ data: { undone: number; skipped: number; failed: number; errors: string[] } }>(
        post(`/ai/plans/${encodeURIComponent(id)}/undo`, stepId ? { step_id: stepId } : {})
      )
      .then((r) => {
        const d = r.data
        setResult(
          `Reverted ${d.undone} record(s)${d.skipped ? `; ${d.skipped} changed since and were left alone` : ''}${d.failed ? `; ${d.failed} failed (${d.errors[0] ?? ''})` : ''}.`
        )
        void qc.invalidateQueries({ queryKey: ['ai-plans'] })
      })
      .catch((err) => setResult(errText(err)))
      .finally(() => {
        setBusy(false)
        setConfirm(null)
      })
  }
  const steps = check.data ?? []
  const total = steps.reduce((n, s) => n + s.revertible, 0)
  return (
    <section className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-2.5 dark:border-border'>
        <Undo2 className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-foreground'>Undo</h2>
        <span className='text-[11.5px] text-muted-foreground'>
          Reverts a record only when nothing has changed it since the plan ran.
        </span>
        {total > 0 && (
          <Button
            size='sm'
            variant='outline'
            className='ml-auto h-7'
            disabled={busy}
            onClick={() => (confirm === '*' ? run(null) : setConfirm('*'))}
          >
            {confirm === '*' ? `Yes, revert ${total} record(s)` : 'Undo everything revertible'}
          </Button>
        )}
      </div>
      {result && (
        <p className='border-b border-slate-100 px-4 py-2 text-[12px] text-emerald-700 dark:border-border dark:text-emerald-400'>
          {result}
        </p>
      )}
      {check.isLoading && (
        <p className='px-4 py-3 text-[12px] text-muted-foreground'>Checking what can be undone…</p>
      )}
      {check.error && (
        <p className='px-4 py-3 text-[12px] text-rose-700 dark:text-rose-400'>
          {errText(check.error)}
        </p>
      )}
      <ul className='divide-y divide-slate-100 dark:divide-border'>
        {steps.map((s) => (
          <li key={s.step_id} className='px-4 py-2.5'>
            <div className='flex items-center gap-2'>
              <span className='text-[11px] tabular-nums text-muted-foreground'>{s.n}.</span>
              <span className='min-w-0 flex-1 truncate text-[12.5px] text-foreground'>
                {s.title}
              </span>
              {s.not_revertible ? (
                <span className='text-[11.5px] text-muted-foreground'>{s.not_revertible}</span>
              ) : (
                <>
                  <span className='text-[11.5px] text-muted-foreground'>
                    {s.revertible} revertible{s.blocked ? ` · ${s.blocked} changed since` : ''}
                  </span>
                  {s.revertible > 0 && (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='h-6 text-[11.5px]'
                      disabled={busy}
                      onClick={() =>
                        confirm === s.step_id ? run(s.step_id) : setConfirm(s.step_id)
                      }
                    >
                      {confirm === s.step_id ? 'Yes, revert' : 'Undo step'}
                    </Button>
                  )}
                </>
              )}
            </div>
            {s.records.some((r) => r.status !== 'revertible') && (
              <ul className='mt-1 space-y-px pl-5'>
                {s.records
                  .filter((r) => r.status !== 'revertible')
                  .slice(0, 8)
                  .map((r) => (
                    <li
                      key={`${r.collection}:${r.id}`}
                      className='text-[11px] text-muted-foreground'
                    >
                      {r.label} — {r.status === 'undone' ? 'already reverted' : r.reason}
                    </li>
                  ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

const FLOW_RECORDS: Array<{ key: 'same' | 'filter' | 'trigger'; label: string; help: string }> = [
  {
    key: 'same',
    label: 'The same records',
    help: 'A manual flow over the exact records the plan changed.'
  },
  {
    key: 'filter',
    label: 'Records matching the filter',
    help: 'A manual flow that looks the records up again each run.'
  },
  {
    key: 'trigger',
    label: 'Whichever record changed',
    help: 'An event flow on updates to the collection.'
  }
]

function FlowPanel({ id, flowId }: { id: string; flowId: string | null }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  const qc = useQueryClient()
  const [records, setRecords] = useState<'same' | 'filter' | 'trigger'>('same')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const make = () => {
    setBusy(true)
    setError(null)
    void client
      .request<{ data: { flow_id: string } }>(
        post(`/ai/plans/${encodeURIComponent(id)}/flow`, { records })
      )
      .then((r) => {
        void qc.invalidateQueries({ queryKey: ['ai-plans', 'plan', id] })
        nav.navigate(`/flows/${r.data.flow_id}?test=1`)
      })
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <section className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <div className='flex items-center gap-2'>
        <Workflow className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-foreground'>Make a draft flow</h2>
        {flowId && (
          <button
            type='button'
            className='ml-auto text-[11.5px] font-medium text-nvr-cyan hover:underline'
            onClick={() => nav.navigate(`/flows/${flowId}?test=1`)}
          >
            Open the flow made from this plan
          </button>
        )}
      </div>
      <p className='mt-1 text-[11.5px] text-muted-foreground'>
        The same steps as flow operations, created switched off and opened in the tester.
      </p>
      <div className='mt-2 flex flex-wrap gap-2'>
        {FLOW_RECORDS.map((o) => (
          <button
            key={o.key}
            type='button'
            onClick={() => setRecords(o.key)}
            data-tip={o.help}
            className={cn(
              'h-7 rounded-md border px-2.5 text-[12px]',
              records === o.key
                ? 'border-nvr-cyan bg-nvr-cyan/10 text-foreground'
                : 'border-slate-200 text-muted-foreground hover:bg-muted dark:border-border'
            )}
          >
            {o.label}
          </button>
        ))}
        <Button
          size='sm'
          className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={busy}
          onClick={make}
        >
          {busy ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
          Create draft flow
        </Button>
      </div>
      {error && <p className='mt-2 text-[11.5px] text-rose-700 dark:text-rose-400'>{error}</p>}
    </section>
  )
}

function PlanTemplates({
  isAdmin,
  subscribe,
  onOpen
}: {
  isAdmin: boolean
  subscribe?: AiPlanSubscribe
  onOpen: (id: string) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ['ai-plans', 'templates'],
    queryFn: () =>
      client.request<{ data: PlanTemplate[] }>(get('/ai/plan-templates')).then((r) => r.data)
  })
  const [picked, setPicked] = useState<string | null>(null)
  const [editing, setEditing] = useState<PlanTemplate | 'new' | null>(null)
  const templates = list.data ?? []
  const current = templates.find((t) => t.key === picked) ?? null

  return (
    <div className='flex flex-1 min-h-0 overflow-hidden'>
      <aside className='w-[320px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
        {isAdmin && (
          <div className='border-b border-slate-100 px-3 py-2 dark:border-border'>
            <Button
              size='sm'
              variant='outline'
              className='h-7 w-full'
              onClick={() => {
                setPicked(null)
                setEditing('new')
              }}
            >
              New template
            </Button>
          </div>
        )}
        {templates.map((t) => (
          <button
            key={t.key}
            type='button'
            onClick={() => {
              setEditing(null)
              setPicked(t.key)
            }}
            className={cn(
              'block w-full border-b border-slate-100 px-3 py-2 text-left dark:border-border',
              picked === t.key ? 'bg-accent' : 'hover:bg-muted'
            )}
          >
            <div className='flex items-center gap-1.5'>
              <span className='min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground'>
                {t.label}
              </span>
              {!t.builtin && (
                <span className='rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground'>
                  custom
                </span>
              )}
            </div>
            <p className='mt-0.5 line-clamp-2 text-[11px] text-muted-foreground'>{t.description}</p>
          </button>
        ))}
      </aside>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-5 dark:bg-background'>
        {editing ? (
          <TemplateEditor
            template={editing === 'new' ? null : editing}
            onDone={() => {
              setEditing(null)
              void qc.invalidateQueries({ queryKey: ['ai-plans', 'templates'] })
            }}
          />
        ) : current ? (
          <TemplateForm
            key={current.key}
            template={current}
            isAdmin={isAdmin}
            subscribe={subscribe}
            onOpen={onOpen}
            onEdit={() => setEditing(current)}
            onDeleted={() => {
              setPicked(null)
              void qc.invalidateQueries({ queryKey: ['ai-plans', 'templates'] })
            }}
          />
        ) : (
          <div className='flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground'>
            <LayoutTemplate className='h-6 w-6' />
            <p className='text-[12.5px]'>
              Pick a template, fill in its blanks and preview the plan before anything runs.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

const BLANK_HINT: Record<string, string> = {
  collection: 'collection name, e.g. orders',
  field: 'field name, e.g. status',
  person: 'name or email',
  record: 'record id',
  number: 'a number',
  value: 'a value',
  text: ''
}

function TemplateForm({
  template,
  isAdmin,
  subscribe,
  onOpen,
  onEdit,
  onDeleted
}: {
  template: PlanTemplate
  isAdmin: boolean
  subscribe?: AiPlanSubscribe
  onOpen: (id: string) => void
  onEdit: () => void
  onDeleted: () => void
}) {
  const client = useNivaroClient()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<AiPlan | null>(null)
  const propose = () => {
    setBusy(true)
    setError(null)
    void client
      .request<{ data: AiPlan }>(post('/ai/plan-templates/propose', { key: template.key, values }))
      .then((r) => setPlan(r.data))
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  const remove = () => {
    void client
      .request(del(`/ai/plan-templates/${encodeURIComponent(template.key)}`))
      .then(onDeleted)
      .catch((err) => setError(errText(err)))
  }
  return (
    <div className='space-y-4'>
      <section className='rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2'>
          <h2 className='text-[13px] font-semibold text-foreground'>{template.label}</h2>
          {isAdmin && !template.builtin && (
            <span className='ml-auto flex gap-1'>
              <Button size='sm' variant='ghost' className='h-7' onClick={onEdit}>
                Edit
              </Button>
              <Button size='sm' variant='ghost' className='h-7' onClick={remove}>
                Delete
              </Button>
            </span>
          )}
        </div>
        <p className='mt-0.5 text-[11.5px] text-muted-foreground'>{template.description}</p>
        <div className='mt-3 grid gap-3 md:grid-cols-2'>
          {template.blanks.map((b) => (
            <div key={b.key} className='space-y-1'>
              <label
                htmlFor={`plan-blank-${b.key}`}
                className='block text-[11.5px] font-medium text-foreground'
              >
                {b.label}
                {b.optional ? (
                  <span className='font-normal text-muted-foreground'> (optional)</span>
                ) : null}
              </label>
              <Input
                id={`plan-blank-${b.key}`}
                value={values[b.key] ?? ''}
                onChange={(e) => setValues({ ...values, [b.key]: e.target.value })}
                placeholder={b.help ?? BLANK_HINT[b.type] ?? ''}
                inputMode={b.type === 'number' ? 'numeric' : undefined}
                className='h-8 text-[12.5px]'
              />
            </div>
          ))}
        </div>
        {error && <p className='mt-2 text-[11.5px] text-rose-700 dark:text-rose-400'>{error}</p>}
        <div className='mt-3 flex items-center gap-2'>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={busy}
            onClick={propose}
          >
            {busy ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
            Preview the plan
          </Button>
          <span className='text-[11px] text-muted-foreground'>
            Nothing runs until you approve it.
          </span>
        </div>
      </section>
      {plan && (
        <div>
          <AiPlanCard key={plan.plan_id} plan={plan} subscribe={subscribe} className='mt-0' />
          <button
            type='button'
            className='mt-1 text-[11.5px] text-nvr-cyan hover:underline'
            onClick={() => onOpen(plan.plan_id)}
          >
            Open in history
          </button>
        </div>
      )}
    </div>
  )
}

const TEMPLATE_EXAMPLE = {
  blanks: [{ key: 'collection', label: 'Collection', type: 'collection' }],
  steps: [
    {
      kind: 'bulk_update',
      collection: '{{collection}}',
      filter: { status: { _eq: 'Draft' } },
      changes: { status: 'Canceled' }
    }
  ]
}

function TemplateEditor({
  template,
  onDone
}: {
  template: PlanTemplate | null
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [label, setLabel] = useState(template?.label ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [title, setTitle] = useState(template?.title ?? '')
  const [body, setBody] = useState(
    JSON.stringify(
      template ? { blanks: template.blanks, steps: template.steps } : TEMPLATE_EXAMPLE,
      null,
      2
    )
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = () => {
    let parsed: { blanks?: unknown; steps?: unknown }
    try {
      parsed = JSON.parse(body)
    } catch {
      setError('Blanks and steps are not valid JSON')
      return
    }
    setBusy(true)
    setError(null)
    const payload = { label, description, title, blanks: parsed.blanks, steps: parsed.steps }
    void client
      .request(
        template
          ? patch(`/ai/plan-templates/${encodeURIComponent(template.key)}`, payload)
          : post('/ai/plan-templates', payload)
      )
      .then(onDone)
      .catch((err) => setError(errText(err)))
      .finally(() => setBusy(false))
  }
  return (
    <section className='space-y-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
      <h2 className='text-[13px] font-semibold text-foreground'>
        {template ? 'Edit template' : 'New template'}
      </h2>
      <div className='grid gap-3 md:grid-cols-2'>
        <div className='space-y-1'>
          <label htmlFor='plan-tpl-name' className='block text-[11.5px] font-medium'>
            Name
          </label>
          <Input
            id='plan-tpl-name'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className='h-8'
          />
        </div>
        <div className='space-y-1'>
          <label htmlFor='plan-tpl-title' className='block text-[11.5px] font-medium'>
            Plan title
          </label>
          <Input
            id='plan-tpl-title'
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='May use {{blank}} placeholders'
            className='h-8'
          />
        </div>
      </div>
      <div className='space-y-1'>
        <label htmlFor='plan-tpl-desc' className='block text-[11.5px] font-medium'>
          Description
        </label>
        <Input
          id='plan-tpl-desc'
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className='h-8'
        />
      </div>
      <div className='space-y-1'>
        <label htmlFor='plan-tpl-body' className='block text-[11.5px] font-medium'>
          Blanks and steps (JSON)
        </label>
        <Textarea
          id='plan-tpl-body'
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={16}
          className='font-mono text-[12px]'
        />
        <span className='block text-[11px] text-muted-foreground'>
          Steps use the Ask AI plan step kinds. "{'{{key}}'}" puts a blank in; "{'{{$ago:key}}'}" is
          the date that many days ago; an object with "$if": "key" is dropped when that blank is
          empty.
        </span>
      </div>
      {error && <p className='text-[11.5px] text-rose-700 dark:text-rose-400'>{error}</p>}
      <div className='flex gap-2'>
        <Button
          size='sm'
          className='h-7 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          disabled={busy || !label.trim()}
          onClick={save}
        >
          Save template
        </Button>
        <Button size='sm' variant='ghost' className='h-7' onClick={onDone}>
          Cancel
        </Button>
      </div>
    </section>
  )
}
