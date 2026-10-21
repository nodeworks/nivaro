import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { SimpleSelect } from '@/components/ui/simple-select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  Change,
  Chip,
  cardCls,
  Empty,
  ErrorNote,
  errMsg,
  inputCls,
  Loading,
  money,
  monthLabel,
  Stats,
  tdCls,
  thCls,
  whole
} from './shared'

type Dim = 'model' | 'feature' | 'user'
interface Row {
  key: string
  label: string
  calls: number
  mtd_usd: number
  projected_usd: number
  last_month_usd: number
  change_pct: number | null
  unpriced?: boolean
}
interface Forecast {
  month: string
  last_month: string
  days_in_month: number
  elapsed_days: number
  history: boolean
  history_ready: boolean
  alert_pct: number | null
  totals: {
    mtd_usd: number
    projected_usd: number
    last_month_usd: number
    change_pct: number | null
  }
  by: Record<Dim, Row[]>
  alerts: Array<{ key: string; kind: string; message: string }>
}
interface ReconModel {
  model: string
  logged_usd: number
  billed_usd: number | null
  gap_usd: number | null
  factor: number | null
  price_source: 'setting' | 'built-in' | 'none'
  calls: number
}
interface ReconMonth {
  month: string
  logged_usd: number
  billed_usd: number | null
  gap_usd: number | null
  gap_pct: number | null
  note: string
  history: boolean
  models: ReconModel[]
}
type Prices = Record<string, { input: number; cached: number; output: number }>

const EMPTY_PRICE = { input: '', cached: '', output: '' }

const DIMS: Array<{ value: Dim; label: string }> = [
  { value: 'model', label: 'By model' },
  { value: 'feature', label: 'By feature' },
  { value: 'user', label: 'By person' }
]

export function SpendTab() {
  const [dim, setDim] = useState<Dim>('model')
  const f = useQuery({
    queryKey: ['ai-quality', 'spend-forecast'],
    queryFn: async () => (await api.get('/ai/spend/forecast')).data.data as Forecast
  })
  if (f.isLoading) return <Loading />
  if (f.error || !f.data) return <ErrorNote error={f.error} />
  const d = f.data
  const rows = d.by[dim]
  return (
    <div className='space-y-6'>
      <section className='space-y-3'>
        <div>
          <h2 className='text-sm font-semibold'>{monthLabel(d.month)}</h2>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            Spent so far, and where the month ends if the last week’s daily pace holds. Day{' '}
            {Math.ceil(d.elapsed_days)} of {d.days_in_month}.
          </p>
        </div>
        <Stats
          items={[
            { label: 'Spent so far', value: money(d.totals.mtd_usd) },
            { label: 'Projected month end', value: money(d.totals.projected_usd) },
            {
              label: monthLabel(d.last_month),
              value: d.history ? money(d.totals.last_month_usd) : '—',
              hint: d.history ? undefined : 'Shows once the nightly roll-up has run'
            },
            {
              label: 'Against last month',
              value:
                d.totals.change_pct == null
                  ? '—'
                  : `${d.totals.change_pct > 0 ? '+' : ''}${d.totals.change_pct}%`
            }
          ]}
        />
        {d.alerts.length > 0 && (
          <ul className='space-y-1.5' aria-label='Spend alerts'>
            {d.alerts.map((a) => (
              <li
                key={a.key}
                className='rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'
              >
                {a.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className='space-y-2'>
        <div className='flex items-center gap-2'>
          <SimpleSelect
            ariaLabel='Break down by'
            className='h-8 w-36 text-[12px]'
            value={dim}
            onChange={(v) => setDim(v as Dim)}
            options={DIMS}
          />
        </div>
        {rows.length === 0 ? (
          <Empty>No AI calls logged this month or last.</Empty>
        ) : (
          <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <table className='w-full text-[12px]'>
              <thead className='border-b border-slate-200 dark:border-border'>
                <tr>
                  <th className={thCls}>
                    {DIMS.find((x) => x.value === dim)?.label.replace('By ', '')}
                  </th>
                  <th className={cn(thCls, 'text-right')}>Calls</th>
                  <th className={cn(thCls, 'text-right')}>So far</th>
                  <th className={cn(thCls, 'text-right')}>Projected</th>
                  <th className={cn(thCls, 'text-right')}>Last month</th>
                  <th className={cn(thCls, 'text-right')}>Change</th>
                </tr>
              </thead>
              <tbody className='divide-y divide-slate-100 dark:divide-border'>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className={tdCls}>
                      <span className={dim === 'model' ? 'font-mono' : undefined}>{r.label}</span>
                      {r.unpriced && (
                        <span className='ml-2'>
                          <Chip tone='warn'>no price set</Chip>
                        </span>
                      )}
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{whole(r.calls)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>{money(r.mtd_usd)}</td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>
                      {money(r.projected_usd)}
                    </td>
                    <td className={cn(tdCls, 'text-right tabular-nums')}>
                      {d.history ? money(r.last_month_usd) : '—'}
                    </td>
                    <td className={cn(tdCls, 'text-right')}>
                      <Change pct={d.history ? r.change_pct : null} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <AlertSettings alertPct={d.alert_pct} />
      <Reconcile />
    </div>
  )
}

function AlertSettings({ alertPct }: { alertPct: number | null }) {
  const qc = useQueryClient()
  const [pct, setPct] = useState(alertPct == null ? '' : String(alertPct))
  useEffect(() => setPct(alertPct == null ? '' : String(alertPct)), [alertPct])
  const save = useMutation({
    mutationFn: async () =>
      api.put('/ai/spend/settings', { forecast_alert_pct: pct.trim() === '' ? null : Number(pct) }),
    onSuccess: () => {
      toast.success('Saved')
      qc.invalidateQueries({ queryKey: ['ai-quality', 'spend-forecast'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const run = useMutation({
    mutationFn: async () =>
      (await api.post('/ai/spend/alerts/run')).data.data as { alerts: unknown[]; told: number },
    onSuccess: (r) =>
      toast.success(
        r.alerts.length === 0
          ? 'Nothing is over a limit'
          : r.told > 0
            ? `${r.told} admin(s) told`
            : 'Already told this month'
      ),
    onError: (e) => toast.error(errMsg(e))
  })
  return (
    <section className={cn(cardCls, 'space-y-2 text-[12px]')}>
      <h2 className='text-sm font-semibold'>Heads-up for admins</h2>
      <p className='text-slate-500 dark:text-muted-foreground'>
        Admins get one notice a month when the projection passes a daily budget (set under Budgets
        &amp; fallback, counted over the whole month) or last month by this share.
      </p>
      <div className='flex flex-wrap items-center gap-2'>
        <label htmlFor='ai-alert-pct'>Tell admins when above last month by</label>
        <input
          id='ai-alert-pct'
          className={cn(inputCls, 'w-20 text-right')}
          inputMode='numeric'
          placeholder='off'
          value={pct}
          onChange={(e) => setPct(e.target.value)}
        />
        <span>%</span>
        <Button size='sm' onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
        <Button size='sm' variant='outline' onClick={() => run.mutate()} disabled={run.isPending}>
          Check and tell admins now
        </Button>
      </div>
    </section>
  )
}

function Reconcile() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['ai-quality', 'spend-reconcile'],
    queryFn: async () =>
      (await api.get('/ai/spend/reconcile', { params: { months: 3 } })).data.data as {
        months: ReconMonth[]
        prices: Prices
        history_ready: boolean
      }
  })
  // typed-but-unsaved bill figures: month -> model ('*' = whole-month figure) -> text
  const [bills, setBills] = useState<Record<string, Record<string, string>>>({})
  const [prices, setPrices] = useState<
    Record<string, Record<'input' | 'cached' | 'output', string>>
  >({})
  const [csv, setCsv] = useState('')
  useEffect(() => {
    if (!q.data) return
    const next: typeof prices = {}
    for (const [m, p] of Object.entries(q.data.prices))
      next[m] = { input: String(p.input), cached: String(p.cached), output: String(p.output) }
    setPrices(next)
  }, [q.data])
  const saveBills = useMutation({
    mutationFn: async () => {
      const out: Record<string, Record<string, number>> = {}
      for (const mo of q.data?.months ?? []) {
        const typed = bills[mo.month]
        if (!typed) continue
        const row: Record<string, number> = {}
        for (const m of mo.models) if (m.billed_usd != null) row[m.model] = m.billed_usd
        for (const [k, v] of Object.entries(typed)) {
          if (v.trim() === '') delete row[k]
          else if (Number.isFinite(Number(v))) row[k] = Number(v)
        }
        out[mo.month] = row
      }
      return api.put('/ai/spend/bills', { bills: out })
    },
    onSuccess: () => {
      toast.success('Bills saved')
      setBills({})
      qc.invalidateQueries({ queryKey: ['ai-quality', 'spend-reconcile'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const importCsv = useMutation({
    mutationFn: async () => api.put('/ai/spend/bills', { csv }),
    onSuccess: () => {
      toast.success('Bills imported')
      setCsv('')
      qc.invalidateQueries({ queryKey: ['ai-quality', 'spend-reconcile'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  const savePrices = useMutation({
    mutationFn: async () => {
      const out: Prices = {}
      for (const [m, p] of Object.entries(prices)) {
        if (p.input.trim() === '' && p.output.trim() === '') continue
        out[m] = {
          input: Number(p.input),
          output: Number(p.output),
          cached: Number(p.cached || p.input)
        }
      }
      return api.put('/ai/spend/settings', { prices: out })
    },
    onSuccess: () => {
      toast.success('Prices saved; new calls use them')
      qc.invalidateQueries({ queryKey: ['ai-quality'] })
    },
    onError: (e) => toast.error(errMsg(e))
  })
  if (q.isLoading) return <Loading rows={3} />
  if (q.error || !q.data) return <ErrorNote error={q.error} />
  const models = [
    ...new Set([
      ...q.data.months.flatMap((m) => m.models.map((x) => x.model)),
      ...Object.keys(prices)
    ])
  ]
  const edited = Object.keys(bills).length > 0
  return (
    <section className='space-y-3'>
      <div>
        <h2 className='text-sm font-semibold'>Log against the bill</h2>
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Enter what the provider or gateway charged. A gap means calls that never reached the log
          (an extension calling the client directly, a path that skips logging) or prices that
          drifted.
        </p>
      </div>
      <div className='grid gap-3 lg:grid-cols-3'>
        {q.data.months.map((mo) => (
          <div key={mo.month} className={cn(cardCls, 'space-y-2 text-[12px]')}>
            <div className='flex items-baseline justify-between gap-2'>
              <h3 className='text-sm font-semibold'>{monthLabel(mo.month)}</h3>
              {mo.gap_pct != null && (
                <Chip tone={Math.abs(mo.gap_pct) < 3 ? 'good' : 'warn'}>
                  gap {mo.gap_usd != null && mo.gap_usd > 0 ? '+' : ''}
                  {money(mo.gap_usd)} ({mo.gap_pct}%)
                </Chip>
              )}
            </div>
            <dl className='grid grid-cols-2 gap-x-3'>
              <dt className='text-slate-500 dark:text-muted-foreground'>Logged</dt>
              <dd className='text-right tabular-nums'>{money(mo.logged_usd)}</dd>
              <dt className='text-slate-500 dark:text-muted-foreground'>Billed</dt>
              <dd className='text-right tabular-nums'>{money(mo.billed_usd)}</dd>
            </dl>
            <p>{mo.note}</p>
            {!mo.history && (
              <p className='text-slate-500 dark:text-muted-foreground'>
                Only the retained 30 days of the log are counted for this month.
              </p>
            )}
            <table className='w-full'>
              <thead>
                <tr>
                  <th className='py-1 text-left font-medium text-slate-500'>Model</th>
                  <th className='py-1 text-right font-medium text-slate-500'>Logged</th>
                  <th className='py-1 text-right font-medium text-slate-500'>Billed</th>
                </tr>
              </thead>
              <tbody>
                {mo.models.map((m) => (
                  <tr key={m.model}>
                    <td className='py-1 pr-2 font-mono'>{m.model}</td>
                    <td className='py-1 text-right tabular-nums'>{money(m.logged_usd)}</td>
                    <td className='py-1 text-right'>
                      <input
                        aria-label={`Billed for ${m.model} in ${mo.month}`}
                        className={cn(inputCls, 'h-7 w-24 text-right')}
                        inputMode='decimal'
                        placeholder='—'
                        value={
                          bills[mo.month]?.[m.model] ??
                          (m.billed_usd == null ? '' : String(m.billed_usd))
                        }
                        onChange={(e) =>
                          setBills({
                            ...bills,
                            [mo.month]: { ...bills[mo.month], [m.model]: e.target.value }
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      <div className='flex flex-wrap items-center gap-2'>
        <Button
          size='sm'
          onClick={() => saveBills.mutate()}
          disabled={!edited || saveBills.isPending}
        >
          Save bills
        </Button>
        <details className='text-[12px]'>
          <summary className='cursor-pointer text-slate-600 dark:text-muted-foreground'>
            Import from CSV
          </summary>
          <div className='mt-2 flex items-start gap-2'>
            <textarea
              aria-label='Bill CSV'
              className={cn(inputCls, 'h-20 w-80 py-1 font-mono')}
              placeholder={'month,model,usd\n2026-09,claude-4-6-sonnet,412.50'}
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
            />
            <Button
              size='sm'
              variant='outline'
              onClick={() => importCsv.mutate()}
              disabled={!csv.trim() || importCsv.isPending}
            >
              Import
            </Button>
          </div>
        </details>
      </div>

      <div className={cn(cardCls, 'space-y-2 text-[12px]')}>
        <h3 className='text-sm font-semibold'>Prices per model</h3>
        <p className='text-slate-500 dark:text-muted-foreground'>
          US dollars per million tokens. A price set here beats the built-in list for every call
          logged from now on, so the estimate matches the bill. Leave blank to use the built-in
          price.
        </p>
        <table className='w-full'>
          <thead>
            <tr>
              <th className='py-1 text-left font-medium text-slate-500'>Model</th>
              <th className='py-1 text-left font-medium text-slate-500'>Source</th>
              <th className='py-1 text-right font-medium text-slate-500'>Input</th>
              <th className='py-1 text-right font-medium text-slate-500'>Cached input</th>
              <th className='py-1 text-right font-medium text-slate-500'>Output</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => {
              const src = q.data.months
                .flatMap((x) => x.models)
                .find((x) => x.model === m)?.price_source
              return (
                <tr key={m}>
                  <td className='py-1 pr-2 font-mono'>{m}</td>
                  <td className='py-1'>
                    <Chip tone={prices[m] ? 'good' : src === 'none' ? 'warn' : 'neutral'}>
                      {prices[m] ? 'set here' : src === 'none' ? 'no price' : 'built-in'}
                    </Chip>
                  </td>
                  {(['input', 'cached', 'output'] as const).map((k) => (
                    <td key={k} className='py-1 text-right'>
                      <input
                        aria-label={`${k} price for ${m}`}
                        className={cn(inputCls, 'h-7 w-20 text-right')}
                        inputMode='decimal'
                        value={prices[m]?.[k] ?? ''}
                        onChange={(e) =>
                          setPrices({
                            ...prices,
                            [m]: { ...(prices[m] ?? EMPTY_PRICE), [k]: e.target.value }
                          })
                        }
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        <Button size='sm' onClick={() => savePrices.mutate()} disabled={savePrices.isPending}>
          Save prices
        </Button>
      </div>
    </section>
  )
}
