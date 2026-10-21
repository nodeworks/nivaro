import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'
import { cn } from '@/lib/utils'
import { SavingsTab } from './ai-quality/SavingsTab'

type Tab = 'review' | 'budgets' | 'savings' | 'health' | 'compare' | 'replay' | 'live'
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'review', label: 'Review queue' },
  { id: 'budgets', label: 'Budgets & fallback' },
  { id: 'savings', label: 'Cost savings' },
  { id: 'health', label: 'Provider health' },
  { id: 'compare', label: 'Compare models' },
  { id: 'replay', label: 'Replay questions' },
  { id: 'live', label: 'Live calls' }
]

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(4)}`)
const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'Something went wrong'
const inputCls =
  'h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
const cardCls = 'rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'

/** AI Quality — review queue, budgets, provider health, model comparison, replay, live calls. */
export function AiQualityPage() {
  const [tab, setTab] = useState<Tab>('review')
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <ShieldCheck className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div>
          <h1 className='text-base font-semibold'>AI Quality</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Poor answers to fix, spend limits, provider health, and trying another model first.
          </p>
        </div>
      </header>
      <nav className='flex shrink-0 gap-1 border-b border-slate-200 bg-white px-4 dark:border-border dark:bg-card'>
        {TABS.map((t) => (
          <button
            key={t.id}
            type='button'
            onClick={() => setTab(t.id)}
            className={cn(
              'border-b-2 px-3 py-2 text-[12px] font-medium',
              tab === t.id
                ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-muted-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {tab === 'review' && <ReviewTab />}
        {tab === 'budgets' && <BudgetsTab />}
        {tab === 'savings' && <SavingsTab />}
        {tab === 'health' && <HealthTab />}
        {tab === 'compare' && <CompareTab />}
        {tab === 'replay' && <ReplayTab />}
        {tab === 'live' && <LiveTab />}
      </div>
    </div>
  )
}

// ─── review queue ───────────────────────────────────────────────────────────

interface ReviewItem {
  request_id: string
  created_at: string
  person: string | null
  comment: string | null
  question: string | null
  answer: string | null
  tools: string[]
  tool_errors: number
  cause: string
  cause_label: string
  handled_at: string | null
  playbook_id: number | null
}

function ReviewTab() {
  const qc = useQueryClient()
  const [status, setStatus] = useState('open')
  const [cause, setCause] = useState('')
  const [hints, setHints] = useState<Record<string, string>>({})
  const q = useQuery({
    queryKey: ['ai-quality', 'review', status, cause],
    queryFn: async () =>
      (await api.get('/ai/review-queue', { params: { status, cause: cause || undefined } })).data
        .data as { items: ReviewItem[]; counts: Record<string, number>; total: number }
  })
  const act = useMutation({
    mutationFn: async (b: { id: string; action: string; hint?: string; cause?: string }) =>
      api.post(`/ai/review-queue/${b.id}/handle`, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-quality', 'review'] })
      toast.success('Done')
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const causes = Object.entries(q.data?.counts ?? {})
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <SimpleSelect
          className='h-8 w-36 text-[12px]'
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'handled', label: 'Handled' },
            { value: 'all', label: 'All' }
          ]}
        />
        <SimpleSelect
          className='h-8 w-48 text-[12px]'
          value={cause}
          onChange={setCause}
          options={[
            { value: '', label: 'Every cause' },
            ...causes.map(([c, n]) => ({ value: c, label: `${c.replace(/_/g, ' ')} (${n})` }))
          ]}
        />
        <span className='text-[12px] text-slate-500'>{q.data?.total ?? 0} in this view</span>
      </div>
      {q.isLoading && <p className='text-[12px] text-slate-500'>Loading…</p>}
      {q.data?.items.length === 0 && (
        <p className={cn(cardCls, 'text-[12px] text-slate-500')}>No poor answers here.</p>
      )}
      {q.data?.items.map((i) => (
        <div key={i.request_id} className={cn(cardCls, 'space-y-2 text-[12px]')}>
          <div className='flex flex-wrap items-center gap-2'>
            <span className='rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-300'>
              {i.cause_label}
            </span>
            <span className='text-slate-500'>
              {i.person ?? 'Someone'} · {new Date(i.created_at).toLocaleString()}
            </span>
            {i.handled_at && <span className='text-emerald-600'>Handled</span>}
          </div>
          <p>
            <b>Question:</b> {i.question ?? '—'}
          </p>
          <p className='whitespace-pre-wrap'>
            <b>Answer:</b> {(i.answer ?? '—').slice(0, 800)}
          </p>
          <p>
            <b>Tools:</b> {i.tools.join(', ') || 'none'}
            {i.tool_errors > 0 && ` (${i.tool_errors} failed)`}
          </p>
          {i.comment && (
            <p>
              <b>Their comment:</b> {i.comment}
            </p>
          )}
          <div className='flex flex-wrap items-center gap-2 pt-1'>
            <SimpleSelect
              className='h-8 w-44 text-[12px]'
              value={i.cause}
              onChange={(c) => act.mutate({ id: i.request_id, action: 'set_cause', cause: c })}
              options={[
                'wrong_tool',
                'wrong_filter',
                'missing_data',
                'permission',
                'misunderstood',
                'unclassified'
              ].map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))}
            />
            {i.playbook_id != null && (
              <Button
                size='sm'
                variant='outline'
                onClick={() => act.mutate({ id: i.request_id, action: 'delete_playbook' })}
              >
                Delete learned playbook
              </Button>
            )}
            <input
              className={cn(inputCls, 'w-64')}
              placeholder='Hint for the data guide'
              value={hints[i.request_id] ?? ''}
              onChange={(e) => setHints({ ...hints, [i.request_id]: e.target.value })}
            />
            <Button
              size='sm'
              variant='outline'
              disabled={!hints[i.request_id]?.trim()}
              onClick={() =>
                act.mutate({ id: i.request_id, action: 'add_hint', hint: hints[i.request_id] })
              }
            >
              Add hint
            </Button>
            {!i.handled_at && (
              <Button size='sm' onClick={() => act.mutate({ id: i.request_id, action: 'handled' })}>
                Mark handled
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── budgets & fallback ─────────────────────────────────────────────────────

interface Cap {
  id: string
  who: 'everyone' | 'person' | 'role'
  who_id: string | null
  feature: string | null
  pooled: boolean
  daily_usd: number
  cheaper_model: string | null
}
interface QConfig {
  budgets: { enabled: boolean; caps: Cap[] }
  fallback_model: string | null
  models: string[]
}

function BudgetsTab() {
  const qc = useQueryClient()
  const cfg = useQuery({
    queryKey: ['ai-quality', 'config'],
    queryFn: async () => (await api.get('/ai/quality/config')).data.data as QConfig
  })
  const status = useQuery({
    queryKey: ['ai-quality', 'budget-status'],
    queryFn: async () =>
      (await api.get('/ai/budget/status')).data.data as {
        resets_at: string
        caps: Array<{
          cap: Cap
          pooled_used_usd: number | null
          people: Array<{ user: string; name: string; used_usd: number; over: boolean }>
        }>
      }
  })
  const [draft, setDraft] = useState<QConfig | null>(null)
  useEffect(() => {
    if (cfg.data && !draft) setDraft(cfg.data)
  }, [cfg.data, draft])
  const save = useMutation({
    mutationFn: async () =>
      api.put('/ai/quality/config', {
        budgets: draft?.budgets,
        fallback_model: draft?.fallback_model
      }),
    onSuccess: () => {
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: ['ai-quality'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  if (!draft) return <p className='text-[12px] text-slate-500'>Loading…</p>
  const setCap = (i: number, patch: Partial<Cap>) =>
    setDraft({
      ...draft,
      budgets: {
        ...draft.budgets,
        caps: draft.budgets.caps.map((c, idx) => (idx === i ? { ...c, ...patch } : c))
      }
    })
  const modelOpts = [
    { value: '', label: 'None' },
    ...draft.models.map((m) => ({ value: m, label: m }))
  ]
  return (
    <div className='space-y-4'>
      <div className={cn(cardCls, 'space-y-3 text-[12px]')}>
        <div className='flex items-center gap-3'>
          <Switch
            checked={draft.budgets.enabled}
            onCheckedChange={(v) =>
              setDraft({ ...draft, budgets: { ...draft.budgets, enabled: v } })
            }
          />
          <span className='font-medium'>Daily AI spend caps</span>
          <span className='text-slate-500'>
            Off by default. Past a cap a feature uses the cheaper model if one is set, otherwise it
            stops until the day resets (UTC midnight).
          </span>
        </div>
        {draft.budgets.caps.map((c, i) => (
          <div key={c.id} className='flex flex-wrap items-center gap-2'>
            <SimpleSelect
              className='h-8 w-32 text-[12px]'
              value={c.who}
              onChange={(v) => setCap(i, { who: v as Cap['who'], who_id: null })}
              options={[
                { value: 'everyone', label: 'Everyone' },
                { value: 'person', label: 'Person (id)' },
                { value: 'role', label: 'Role (id)' }
              ]}
            />
            {c.who !== 'everyone' && (
              <input
                className={cn(inputCls, 'w-64')}
                placeholder={c.who === 'person' ? 'User id' : 'Role id'}
                value={c.who_id ?? ''}
                onChange={(e) => setCap(i, { who_id: e.target.value })}
              />
            )}
            <input
              className={cn(inputCls, 'w-28')}
              placeholder='Feature (all)'
              value={c.feature ?? ''}
              onChange={(e) => setCap(i, { feature: e.target.value || null })}
            />
            <input
              className={cn(inputCls, 'w-24')}
              type='number'
              min={0}
              step='0.5'
              value={c.daily_usd}
              onChange={(e) => setCap(i, { daily_usd: Number(e.target.value) })}
            />
            <span className='text-slate-500'>USD / day</span>
            <span className='flex items-center gap-1'>
              <Switch checked={c.pooled} onCheckedChange={(v) => setCap(i, { pooled: v })} />
              shared pool
            </span>
            <SimpleSelect
              className='h-8 w-52 text-[12px]'
              value={c.cheaper_model ?? ''}
              onChange={(v) => setCap(i, { cheaper_model: v || null })}
              options={modelOpts}
            />
            <Button
              size='sm'
              variant='ghost'
              onClick={() =>
                setDraft({
                  ...draft,
                  budgets: { ...draft.budgets, caps: draft.budgets.caps.filter((_, x) => x !== i) }
                })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          size='sm'
          variant='outline'
          onClick={() =>
            setDraft({
              ...draft,
              budgets: {
                ...draft.budgets,
                caps: [
                  ...draft.budgets.caps,
                  {
                    id: crypto.randomUUID(),
                    who: 'everyone',
                    who_id: null,
                    feature: null,
                    pooled: false,
                    daily_usd: 5,
                    cheaper_model: null
                  }
                ]
              }
            })
          }
        >
          Add cap
        </Button>
      </div>
      <div className={cn(cardCls, 'flex items-center gap-3 text-[12px]')}>
        <span className='font-medium'>Fallback model</span>
        <SimpleSelect
          className='h-8 w-60 text-[12px]'
          value={draft.fallback_model ?? ''}
          onChange={(v) => setDraft({ ...draft, fallback_model: v || null })}
          options={modelOpts}
        />
        <span className='text-slate-500'>
          Used on the same provider when a call fails. None set: features say AI is unavailable.
        </span>
      </div>
      <Button size='sm' onClick={() => save.mutate()} disabled={save.isPending}>
        Save
      </Button>
      {status.data && status.data.caps.length > 0 && (
        <div className={cn(cardCls, 'space-y-2 text-[12px]')}>
          <p className='font-medium'>
            Spend today against each cap (resets {new Date(status.data.resets_at).toLocaleString()})
          </p>
          {status.data.caps.map((s) => (
            <div key={s.cap.id}>
              <p>
                {s.cap.who} · {s.cap.feature ?? 'all features'} · limit {usd(s.cap.daily_usd)}
                {s.pooled_used_usd != null && ` · pool used ${usd(s.pooled_used_usd)}`}
              </p>
              {s.people.map((p) => (
                <p key={p.user} className={cn('pl-4', p.over && 'text-red-600')}>
                  {p.name}: {usd(p.used_usd)}
                </p>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── provider health ────────────────────────────────────────────────────────

function HealthTab() {
  const [fresh, setFresh] = useState(0)
  const h = useQuery({
    queryKey: ['ai-quality', 'health', fresh],
    queryFn: async () =>
      (await api.get('/ai/health', { params: { fresh: fresh ? 1 : undefined } })).data.data as {
        status: string
        detail: string
        latency_ms: number | null
        model: string | null
        provider: string | null
        fallback_model: string | null
        checked_at: string
      }
  })
  return (
    <div className={cn(cardCls, 'max-w-xl space-y-2 text-[12px]')}>
      {h.isLoading && <p>Checking the provider…</p>}
      {h.data && (
        <>
          <p className='text-sm font-semibold capitalize'>{h.data.status}</p>
          <p>{h.data.detail}</p>
          <p className='text-slate-500'>
            {h.data.provider ?? '—'} · {h.data.model ?? '—'} · {h.data.latency_ms ?? '—'} ms ·
            checked {new Date(h.data.checked_at).toLocaleTimeString()}
          </p>
          <p className='text-slate-500'>Fallback model: {h.data.fallback_model ?? 'none set'}</p>
        </>
      )}
      <Button size='sm' variant='outline' onClick={() => setFresh(Date.now())}>
        Check now (one tiny paid call)
      </Button>
    </div>
  )
}

// ─── compare models ─────────────────────────────────────────────────────────

interface CompareResult {
  model: string
  answered_by?: string
  text?: string
  error?: string
  input_tokens?: number | null
  output_tokens?: number | null
  cost_usd?: number | null
  latency_ms: number
}

function CompareTab() {
  const cfg = useQuery({
    queryKey: ['ai-quality', 'config'],
    queryFn: async () => (await api.get('/ai/quality/config')).data.data as QConfig
  })
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [prompt, setPrompt] = useState('')
  const [system, setSystem] = useState('')
  const [est, setEst] = useState<number | null | undefined>(undefined)
  const [results, setResults] = useState<CompareResult[] | null>(null)
  const body = { models: [a, b], prompt, system }
  const estimate = useMutation({
    mutationFn: async () => (await api.post('/ai/compare/estimate', body)).data.data,
    onSuccess: (d) => setEst(d.total_usd ?? null),
    onError: (e) => toast.error(errMsg(e))
  })
  const run = useMutation({
    mutationFn: async () =>
      (await api.post('/ai/compare/run', { ...body, confirmed_cost_usd: est ?? 0 })).data.data,
    onSuccess: (d) => setResults(d.results),
    onError: (e) => toast.error(errMsg(e))
  })
  const opts = (cfg.data?.models ?? []).map((m) => ({ value: m, label: m }))
  return (
    <div className='space-y-3'>
      <div className='flex gap-2'>
        <SimpleSelect
          className='h-8 w-60 text-[12px]'
          value={a}
          onChange={setA}
          options={[{ value: '', label: 'Model A' }, ...opts]}
        />
        <SimpleSelect
          className='h-8 w-60 text-[12px]'
          value={b}
          onChange={setB}
          options={[{ value: '', label: 'Model B' }, ...opts]}
        />
      </div>
      <textarea
        className={cn(inputCls, 'h-28 w-full py-1')}
        placeholder='Prompt'
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value)
          setEst(undefined)
        }}
      />
      <textarea
        className={cn(inputCls, 'h-14 w-full py-1')}
        placeholder='System prompt (optional)'
        value={system}
        onChange={(e) => {
          setSystem(e.target.value)
          setEst(undefined)
        }}
      />
      <div className='flex items-center gap-2 text-[12px]'>
        <Button
          size='sm'
          variant='outline'
          onClick={() => estimate.mutate()}
          disabled={!a || !b || !prompt}
        >
          Estimate cost
        </Button>
        {est !== undefined && (
          <>
            <span>Up to {usd(est)}</span>
            <Button size='sm' onClick={() => run.mutate()} disabled={run.isPending}>
              Run on both
            </Button>
          </>
        )}
      </div>
      {results && (
        <div className='grid gap-3 md:grid-cols-2'>
          {results.map((r) => (
            <div key={r.model} className={cn(cardCls, 'space-y-1 text-[12px]')}>
              <p className='font-semibold'>{r.model}</p>
              <p className='text-slate-500'>
                {usd(r.cost_usd)} · {r.input_tokens ?? '—'} in / {r.output_tokens ?? '—'} out ·{' '}
                {r.latency_ms} ms
              </p>
              <p className={cn('whitespace-pre-wrap', r.error && 'text-red-600')}>
                {r.error ?? r.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── replay ─────────────────────────────────────────────────────────────────

interface ReplaySide {
  answer: string
  tools: string[]
  rounds: number
  cost_usd: number | null
  latency_ms: number
  error?: string
}
interface ReplayRunData {
  status: string
  total: number
  done: number
  error?: string
  items: Array<{
    request_id: string
    question: string
    asker: string
    original: ReplaySide
    replay?: ReplaySide
  }>
}

function ReplayTab() {
  const cfg = useQuery({
    queryKey: ['ai-quality', 'config'],
    queryFn: async () => (await api.get('/ai/quality/config')).data.data as QConfig
  })
  const [model, setModel] = useState('')
  const [count, setCount] = useState(10)
  const [est, setEst] = useState<{ cost_usd: number | null; calls: number } | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const estimate = useMutation({
    mutationFn: async () => (await api.post('/ai/replay/estimate', { model, count })).data.data,
    onSuccess: (d) => setEst(d.estimate),
    onError: (e) => toast.error(errMsg(e))
  })
  const start = useMutation({
    mutationFn: async () =>
      (await api.post('/ai/replay/run', { model, count, confirmed_cost_usd: est?.cost_usd ?? 0 }))
        .data.data,
    onSuccess: (d) => setRunId(d.run_id),
    onError: (e) => toast.error(errMsg(e))
  })
  const run = useQuery({
    queryKey: ['ai-quality', 'replay', runId],
    enabled: !!runId,
    queryFn: async () => (await api.get(`/ai/replay/${runId}`)).data.data as ReplayRunData,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false)
  })
  const opts = (cfg.data?.models ?? []).map((m) => ({ value: m, label: m }))
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2 text-[12px]'>
        <SimpleSelect
          className='h-8 w-60 text-[12px]'
          value={model}
          onChange={(v) => {
            setModel(v)
            setEst(null)
          }}
          options={[{ value: '', label: 'Candidate model' }, ...opts]}
        />
        <input
          className={cn(inputCls, 'w-20')}
          type='number'
          min={1}
          max={50}
          value={count}
          onChange={(e) => {
            setCount(Number(e.target.value))
            setEst(null)
          }}
        />
        <span className='text-slate-500'>recent questions, each as its asker</span>
        <Button size='sm' variant='outline' disabled={!model} onClick={() => estimate.mutate()}>
          Estimate cost
        </Button>
        {est && (
          <>
            <span>
              {est.calls} questions · about {usd(est.cost_usd)}
            </span>
            <Button size='sm' onClick={() => start.mutate()} disabled={start.isPending}>
              Replay
            </Button>
          </>
        )}
      </div>
      {run.data && (
        <>
          <p className='text-[12px] text-slate-500'>
            {run.data.status} · {run.data.done}/{run.data.total}
            {run.data.error && ` · ${run.data.error}`}
          </p>
          {run.data.items.map((i) => (
            <div key={i.request_id} className={cn(cardCls, 'space-y-2 text-[12px]')}>
              <p className='font-medium'>
                {i.question} <span className='font-normal text-slate-500'>— {i.asker}</span>
              </p>
              <div className='grid gap-3 md:grid-cols-2'>
                {(
                  [
                    ['Current', i.original],
                    ['Candidate', i.replay]
                  ] as const
                ).map(([label, s]) => (
                  <div key={label}>
                    <p className='font-semibold'>{label}</p>
                    {s ? (
                      <>
                        <p className='text-slate-500'>
                          {usd(s.cost_usd)} · {s.latency_ms} ms · {s.rounds} rounds · tools:{' '}
                          {s.tools.join(', ') || 'none'}
                        </p>
                        <p className={cn('whitespace-pre-wrap', s.error && 'text-red-600')}>
                          {s.error ?? s.answer.slice(0, 700)}
                        </p>
                      </>
                    ) : (
                      <p className='text-slate-500'>Waiting…</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

// ─── live calls ─────────────────────────────────────────────────────────────

interface LiveCall {
  seq?: number
  at: string
  feature: string
  model: string
  user_name?: string
  status: 'ok' | 'error'
  cost_usd: number | null
  latency_ms: number
  error?: string | null
}

function LiveTab() {
  const [rows, setRows] = useState<LiveCall[]>([])
  const seq = useRef(0)
  useEffect(() => {
    const leave = joinWatchRoom('ai-calls')
    const off = adminRealtime.on('ai:call', (p: LiveCall) =>
      setRows((prev) => [{ ...p, seq: seq.current++ }, ...prev].slice(0, 200))
    )
    return () => {
      off()
      leave()
    }
  }, [])
  return (
    <div className='space-y-2'>
      <p className='text-[12px] text-slate-500'>
        AI calls as they finish (streamed only while this tab is open).
      </p>
      <table className='w-full text-[12px]'>
        <thead className='text-left text-slate-500'>
          <tr>
            <th className='py-1'>Time</th>
            <th>Feature</th>
            <th>Model</th>
            <th>Person</th>
            <th>Cost</th>
            <th>Time taken</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.seq} className='border-t border-slate-200 dark:border-border'>
              <td className='py-1'>{new Date(r.at).toLocaleTimeString()}</td>
              <td>{r.feature}</td>
              <td>{r.model}</td>
              <td>{r.user_name || '—'}</td>
              <td>{usd(r.cost_usd)}</td>
              <td>{r.latency_ms} ms</td>
              <td className={r.status === 'error' ? 'text-red-600' : ''}>
                {r.status === 'error' ? (r.error ?? 'error') : 'ok'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
