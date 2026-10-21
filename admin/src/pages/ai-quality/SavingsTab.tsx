import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// AI Quality → Cost savings: #2471 start-cheap routing (switch + what it
// saved), #2765 compact tool payloads and #2737 reused tool results — both
// measured from the call log, so the saving is shown, not assumed.

interface Routing {
  features: string[]
  cheap_model: string | null
}

interface Savings {
  routed: number
  answered_cheap: number
  escalated: Record<string, number>
  try_harder: number
  cheap_calls: number
  main_calls: number
  cheap_cost_usd: number
  main_cost_usd: number
  main_equivalent_usd: number
  saved_usd: number
  unpriced_calls: number
}

interface ToolRow {
  tool: string
  calls: number
  before: number
  after: number
  reused: number
  saved_pct: number
}

interface SavingsData {
  supported: boolean
  since: string
  routing: Routing
  features: Array<{ key: string; label: string }>
  models: string[]
  capped?: boolean
  savings?: Savings
  tools?: ToolRow[]
}

const FEATURE_HINTS: Record<string, string> = {
  chat: 'The tool loop behind Ask AI. Moves up on a failed tool call, before a proposal or plan, or when the small model cannot answer.',
  review:
    'The pre-submission review. Moves up when the reply is not the list of findings it asked for.',
  summarize:
    'Record summaries (not while streaming). Moves up when the small model cannot summarise.',
  generate:
    'Field value drafts (not while streaming). Moves up when the small model cannot write one.'
}

const REASON_LABELS: Record<string, string> = {
  tool_error: 'a tool call failed',
  proposal: 'a proposal or plan was due',
  cannot_answer: 'the small model could not answer',
  invalid_json: 'the reply was not valid JSON'
}

const usd = (n: number) => {
  const abs = Math.abs(n)
  const s = abs >= 1 ? abs.toFixed(2) : abs.toFixed(4)
  return `${n < 0 ? '−' : ''}$${s}`
}
const num = (n: number) => n.toLocaleString('en-US')
const errMsg = (e: unknown) =>
  (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
  'Something went wrong'
const cardCls = 'rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'

export function SavingsTab() {
  const qc = useQueryClient()
  const [window, setWindow] = useState<'month' | '30d'>('month')
  const q = useQuery({
    queryKey: ['ai-quality', 'savings', window],
    queryFn: async () =>
      (await api.get('/ai/quality/savings', { params: { window } })).data.data as SavingsData
  })
  // The PUT replaces the whole quality block — budgets and fallback ride along unchanged.
  const cfg = useQuery({
    queryKey: ['ai-quality', 'config'],
    queryFn: async () =>
      (await api.get('/ai/quality/config')).data.data as {
        budgets: unknown
        fallback_model: string | null
      }
  })
  const [draft, setDraft] = useState<Routing | null>(null)
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.routing)
  }, [q.data, draft])
  const save = useMutation({
    mutationFn: async () =>
      api.put('/ai/quality/config', {
        budgets: cfg.data?.budgets,
        fallback_model: cfg.data?.fallback_model ?? null,
        routing: draft
      }),
    onSuccess: () => {
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: ['ai-quality'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })

  if (q.isError)
    return (
      <div className={cn(cardCls, 'text-[12px] text-red-600 dark:text-red-400')}>
        Could not load the savings figures. {errMsg(q.error)}
      </div>
    )
  if (!q.data || !draft) return <SavingsSkeleton />

  const d = q.data
  const dirty = JSON.stringify(draft) !== JSON.stringify(d.routing)
  const on = !!draft.cheap_model && draft.features.length > 0
  const toggle = (key: string, v: boolean) =>
    setDraft({
      ...draft,
      features: v ? [...draft.features, key] : draft.features.filter((f) => f !== key)
    })

  return (
    <div className='space-y-4'>
      <section className={cn(cardCls, 'space-y-3 text-[12px]')} aria-labelledby='start-cheap'>
        <div className='space-y-1'>
          <h2 id='start-cheap' className='text-[14px] font-semibold'>
            Start cheap
          </h2>
          <p className='max-w-[75ch] text-slate-600 dark:text-muted-foreground'>
            The first call goes to a small model and moves up to the feature's main model only when
            it has to. Proposals and plans are always made by the main model, and anyone can click
            “Try harder” on a quick answer. Off until you pick a model and a feature.
          </p>
        </div>
        <div className='flex flex-wrap items-center gap-2'>
          <span className='font-medium'>Small model</span>
          <SimpleSelect
            className='h-8 w-60 text-[12px]'
            ariaLabel='Small model'
            value={draft.cheap_model ?? ''}
            onChange={(v) => setDraft({ ...draft, cheap_model: v || null })}
            options={[
              { value: '', label: 'None (routing off)' },
              ...d.models.map((m) => ({ value: m, label: m }))
            ]}
          />
        </div>
        <ul className='divide-y divide-slate-100 border-t border-slate-100 dark:divide-border dark:border-border'>
          {d.features.map((f) => {
            const checked = draft.features.includes(f.key)
            return (
              <li key={f.key} className='flex items-start gap-3 py-2.5'>
                <Switch
                  id={`route-${f.key}`}
                  className='mt-0.5'
                  checked={checked}
                  disabled={!draft.cheap_model}
                  onCheckedChange={(v) => toggle(f.key, v)}
                />
                <label htmlFor={`route-${f.key}`} className='min-w-0 flex-1 cursor-pointer'>
                  <span className='block font-medium text-slate-900 dark:text-foreground'>
                    {f.label}
                  </span>
                  <span className='block text-slate-500 dark:text-muted-foreground'>
                    {FEATURE_HINTS[f.key]}
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
        <div className='flex items-center gap-3'>
          <Button size='sm' onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <span className='text-slate-500 dark:text-muted-foreground'>
            {on
              ? `${draft.features.length} feature${draft.features.length === 1 ? '' : 's'} start on ${draft.cheap_model}.`
              : 'Every feature uses its main model.'}
          </span>
        </div>
      </section>

      <div className='flex items-center gap-2 text-[12px]'>
        <span className='text-slate-500 dark:text-muted-foreground'>Figures for</span>
        <SimpleSelect
          className='h-8 w-40 text-[12px]'
          ariaLabel='Period'
          value={window}
          onChange={(v) => setWindow(v === '30d' ? '30d' : 'month')}
          options={[
            { value: 'month', label: 'This month' },
            { value: '30d', label: 'Last 30 days' }
          ]}
        />
        <span className='text-slate-500 dark:text-muted-foreground'>
          since {new Date(d.since).toLocaleDateString()}
          {d.capped ? ' · newest 20,000 calls' : ''}
        </span>
      </div>

      {!d.supported ? (
        <div className={cn(cardCls, 'text-[12px] text-slate-600 dark:text-muted-foreground')}>
          Routing and payload-size figures start once the latest database update has run. The
          switches above already work.
        </div>
      ) : (
        <>
          <RoutingFigures s={d.savings!} />
          <ToolPayloads rows={d.tools ?? []} />
        </>
      )}
    </div>
  )
}

function RoutingFigures({ s }: { s: Savings }) {
  const moved = Object.entries(s.escalated).sort((a, b) => b[1] - a[1])
  const movedTotal = moved.reduce((n, [, v]) => n + v, 0)
  return (
    <section className={cn(cardCls, 'space-y-3 text-[12px]')} aria-labelledby='routing-saved'>
      <h2 id='routing-saved' className='text-[14px] font-semibold'>
        What starting cheap saved
      </h2>
      {s.routed === 0 && s.try_harder === 0 ? (
        <p className='text-slate-500 dark:text-muted-foreground'>
          No question started on the small model in this period. Once a feature is switched on, each
          answer's calls are priced here against what the main model would have charged.
        </p>
      ) : (
        <>
          <dl className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
            <Cell
              label='Saved'
              value={usd(s.saved_usd)}
              tone={s.saved_usd < 0 ? 'bad' : s.saved_usd > 0 ? 'good' : undefined}
            />
            <Cell label='Started cheap' value={num(s.routed)} />
            <Cell label='Answered by the small model' value={num(s.answered_cheap)} />
            <Cell label='“Try harder” clicks' value={num(s.try_harder)} />
          </dl>
          <p className='max-w-[75ch] text-slate-600 dark:text-muted-foreground'>
            The small model's useful calls cost {usd(s.cheap_cost_usd)}; the same tokens on the main
            model would have cost {usd(s.main_equivalent_usd)}. Calls thrown away (a question asked
            again on the main model, or replaced by “Try harder”) count as a loss. The main model's
            own calls on these questions cost {usd(s.main_cost_usd)}.
            {s.unpriced_calls > 0 &&
              ` ${num(s.unpriced_calls)} call(s) ran on a model with no known price and are left out.`}
          </p>
          {movedTotal > 0 && (
            <div>
              <p className='font-medium'>Moved up to the main model ({num(movedTotal)})</p>
              <ul className='mt-1 space-y-0.5 text-slate-600 dark:text-muted-foreground'>
                {moved.map(([reason, n]) => (
                  <li key={reason}>
                    {num(n)} — {REASON_LABELS[reason] ?? reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd
        className={cn(
          'mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 dark:text-foreground',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
          tone === 'bad' && 'text-red-600 dark:text-red-400'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

function ToolPayloads({ rows }: { rows: ToolRow[] }) {
  const before = rows.reduce((n, r) => n + r.before, 0)
  const after = rows.reduce((n, r) => n + r.after, 0)
  const reused = rows.reduce((n, r) => n + r.reused, 0)
  return (
    <section className={cn(cardCls, 'space-y-3 text-[12px]')} aria-labelledby='tool-payloads'>
      <div className='space-y-1'>
        <h2 id='tool-payloads' className='text-[14px] font-semibold'>
          Tool results sent to the model
        </h2>
        <p className='max-w-[75ch] text-slate-600 dark:text-muted-foreground'>
          Ask AI sends lists of records as compact tables — column names once, each row as values, a
          link's label once per column. Both sizes are measured on every call (about four characters
          per token). Reused results came from earlier in the same conversation instead of a new
          query. Show the steps still lists the readable rows.
        </p>
      </div>
      {rows.length === 0 ? (
        <p className='text-slate-500 dark:text-muted-foreground'>
          No tool results were logged in this period. They appear after the next Ask AI question
          that uses a tool.
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full min-w-[560px] text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 text-left text-[11px] font-medium text-slate-500 dark:border-border dark:text-muted-foreground'>
                <th className='py-1.5 pr-3 font-medium'>Tool</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Results</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Readable tokens</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Sent tokens</th>
                <th className='py-1.5 pr-3 text-right font-medium'>Smaller by</th>
                <th className='py-1.5 text-right font-medium'>Reused</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.tool}
                  className='border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-border dark:hover:bg-muted'
                >
                  <td className='py-2 pr-3 font-mono'>{r.tool}</td>
                  <td className='py-2 pr-3 text-right tabular-nums'>{num(r.calls)}</td>
                  <td className='py-2 pr-3 text-right tabular-nums'>{num(r.before)}</td>
                  <td className='py-2 pr-3 text-right tabular-nums'>{num(r.after)}</td>
                  <td className='py-2 pr-3 text-right tabular-nums'>
                    {r.saved_pct > 0 ? `${r.saved_pct}%` : '—'}
                  </td>
                  <td className='py-2 text-right tabular-nums'>
                    {r.reused > 0 ? num(r.reused) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className='border-t border-slate-200 font-medium dark:border-border'>
                <td className='py-2 pr-3'>All tools</td>
                <td className='py-2 pr-3 text-right tabular-nums'>
                  {num(rows.reduce((n, r) => n + r.calls, 0))}
                </td>
                <td className='py-2 pr-3 text-right tabular-nums'>{num(before)}</td>
                <td className='py-2 pr-3 text-right tabular-nums'>{num(after)}</td>
                <td className='py-2 pr-3 text-right tabular-nums'>
                  {before > 0 && after < before
                    ? `${Math.round(((before - after) / before) * 1000) / 10}%`
                    : '—'}
                </td>
                <td className='py-2 text-right tabular-nums'>{reused > 0 ? num(reused) : '—'}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  )
}

function SavingsSkeleton() {
  return (
    <div className='space-y-4' aria-busy='true'>
      <div className={cn(cardCls, 'space-y-3')}>
        <Skeleton className='h-4 w-32' />
        <Skeleton className='h-3 w-3/4' />
        <Skeleton className='h-8 w-60' />
        <Skeleton className='h-10 w-full' />
        <Skeleton className='h-10 w-full' />
      </div>
      <div className={cn(cardCls, 'space-y-3')}>
        <Skeleton className='h-4 w-48' />
        <Skeleton className='h-14 w-full' />
      </div>
    </div>
  )
}
