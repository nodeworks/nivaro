import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Download, Pencil, SlidersHorizontal } from 'lucide-react'
import { type FormEvent, Fragment, type ReactNode, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { HubCostsNow } from '../costs/HubCostsNow'
import { hubToast } from '../hub-api'
import { Field, ghostButton, SectionCard, segmentButton, segmentGroup } from '../hub-parts'
import { ProviderHome } from '../providers/ProviderHome'
import HubOutsideSpend from './HubOutsideSpend'
import {
  type AppCost,
  type ChargebackReport,
  type ChargebackSettings,
  downloadChargebackCsv,
  fetchChargeback,
  fetchChargebackSettings,
  type GroupCost,
  money,
  placementKeys,
  RATE_FIELDS,
  saveChargebackSettings,
  saveCostCenter
} from './placement-api'

/**
 * Costs (Apps hub tab, idea 49 + Task 44c): Now (the live run-rate, month to date, forecast
 * against budgets and Billed) for app owners and Hub administrators; Chargeback (the rate-card
 * showback per department and owner) for administrators.
 */
const COSTS = ['costs']

export default function HubCosts() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  // Now (live run-rate, budgets) for everyone who owns an app; Chargeback (the rate-card
  // showback per department and owner) for Hub administrators.
  const view = isAdmin && params.get('view') === 'chargeback' ? 'chargeback' : 'now'
  const setView = (v: 'now' | 'chargeback') =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p)
        if (v === 'now') n.delete('view')
        else n.set('view', v)
        return n
      },
      { replace: true }
    )
  const switcher = isAdmin ? (
    <fieldset className={segmentGroup} aria-label='Costs view'>
      <button
        type='button'
        aria-pressed={view === 'now'}
        className={segmentButton(view === 'now')}
        onClick={() => setView('now')}
      >
        Now
      </button>
      <button
        type='button'
        aria-pressed={view === 'chargeback'}
        className={segmentButton(view === 'chargeback')}
        onClick={() => setView('chargeback')}
      >
        Chargeback
      </button>
    </fieldset>
  ) : null
  if (view === 'chargeback') return <Chargeback switcher={switcher} />
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description='What your apps cost running now, the month so far and the forecast. Estimates, beside what the providers billed.'
        actions={switcher}
      />
      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          <HubCostsNow isAdmin={isAdmin} />
          {/* Task 43: what the providers billed, beside the live figures (admins, as Chargeback). */}
          {isAdmin ? <HubOutsideSpend /> : null}
          {/* Budgets and spend limits held at providers: the same kind, so the same page. */}
          <ProviderHome groups={COSTS} isAdmin={isAdmin} idPrefix='hub-home-costs' />
        </div>
      </div>
    </div>
  )
}

/**
 * Chargeback (Hub administrators): a rough monthly cost per app from what the Hub measures (CPU,
 * memory, files, database size) times the rates set here, with each host region's factor; per
 * department and per owner; CSV for the finance team. An estimate for showback, not an invoice.
 */
function Chargeback({ switcher }: { switcher: ReactNode }) {
  const report = useQuery({
    queryKey: placementKeys.chargeback(),
    queryFn: fetchChargeback
  })
  const [rates, setRates] = useState(false)
  const [csvBusy, setCsvBusy] = useState(false)

  const csv = async () => {
    setCsvBusy(true)
    try {
      await downloadChargebackCsv()
    } catch (err) {
      hubToast(err, 'Could not export the costs')
    } finally {
      setCsvBusy(false)
    }
  }

  const r = report.data
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description={
          r
            ? `Estimated monthly cost from the last ${r.window_days} days of samples. As of ${formatDateTime(r.generated_at)}.`
            : 'Estimated monthly cost per app from what the Hub measures.'
        }
        actions={
          <>
            {switcher}
            <button
              type='button'
              className={ghostButton}
              aria-expanded={rates}
              onClick={() => setRates((v) => !v)}
            >
              <SlidersHorizontal className='h-3.5 w-3.5' aria-hidden /> Rates
            </button>
            <button type='button' className={ghostButton} disabled={csvBusy || !r} onClick={csv}>
              <Download className='h-3.5 w-3.5' aria-hidden />
              {csvBusy ? 'Exporting…' : 'Export CSV'}
            </button>
          </>
        }
      />
      <div className='relative min-h-0 flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-4 p-4 sm:p-6'>
          {rates && <RatesCard onDone={() => setRates(false)} />}
          {report.isPending ? (
            <Skeleton className='h-48 w-full' />
          ) : report.isError ? (
            <QueryErrorState
              error={report.error}
              what='the costs'
              onRetry={() => void report.refetch()}
            />
          ) : r ? (
            <Report r={r} openRates={() => setRates(true)} />
          ) : null}
        </div>
      </div>
    </div>
  )
}

function Report({ r, openRates }: { r: ChargebackReport; openRates: () => void }) {
  const [by, setBy] = useState<'department' | 'owner'>('department')
  const groups = by === 'department' ? r.departments : r.owners
  return (
    <>
      {r.unrated && (
        <p className='m-0 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12.5px] text-slate-700 dark:border-border dark:bg-card dark:text-foreground'>
          No rate is set yet, so every amount is 0. The usage figures below are real.
          <button type='button' className={cn(ghostButton, 'h-7')} onClick={openRates}>
            Set the rates
          </button>
        </p>
      )}
      <SectionCard
        title={by === 'department' ? 'By department' : 'By owner'}
        description={
          by === 'owner'
            ? 'An app with several owners is counted under each, so these totals overlap.'
            : 'Set an app’s department in the table below.'
        }
        actions={
          <fieldset className={segmentGroup} aria-label='Group by'>
            <button
              type='button'
              aria-pressed={by === 'department'}
              className={segmentButton(by === 'department')}
              onClick={() => setBy('department')}
            >
              Department
            </button>
            <button
              type='button'
              aria-pressed={by === 'owner'}
              className={segmentButton(by === 'owner')}
              onClick={() => setBy('owner')}
            >
              Owner
            </button>
          </fieldset>
        }
      >
        <GroupBars groups={groups} currency={r.currency} />
        <p className='m-0 flex items-baseline justify-between gap-3 border-t border-slate-200 px-4 py-3 text-[12px] text-slate-600 dark:border-border dark:text-muted-foreground'>
          <span>
            All {r.apps.length} {r.apps.length === 1 ? 'app' : 'apps'}, per month
          </span>
          <span className='text-[15px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
            {money(r.total, r.currency)}
          </span>
        </p>
      </SectionCard>
      <SectionCard
        title='Per app'
        description='Open an app for its environments and what each figure costs.'
      >
        <AppTable r={r} />
      </SectionCard>
      <HubOutsideSpend />
    </>
  )
}

function GroupBars({ groups, currency }: { groups: GroupCost[]; currency: string }) {
  const top = Math.max(0, ...groups.map((g) => g.total))
  if (!groups.length)
    return (
      <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        No apps yet.
      </p>
    )
  return (
    <ul className='m-0 list-none space-y-2 p-4'>
      {groups.map((g) => (
        <li
          key={g.key || g.label}
          className='grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[12px] sm:grid-cols-[minmax(0,14rem)_1fr_auto]'
        >
          <span className='truncate text-slate-800 dark:text-foreground'>
            {g.label}
            <span className='ml-1.5 text-slate-500 tabular-nums dark:text-muted-foreground'>
              {g.apps} {g.apps === 1 ? 'app' : 'apps'}
            </span>
          </span>
          <span className='h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-muted' aria-hidden>
            <span
              className='block h-full rounded-full bg-slate-500 dark:bg-slate-400'
              style={{ width: `${top > 0 ? Math.max(2, (g.total / top) * 100) : 0}%` }}
            />
          </span>
          <span className='text-right font-medium tabular-nums text-slate-900 dark:text-foreground'>
            {money(g.total, currency)}
          </span>
        </li>
      ))}
    </ul>
  )
}

const fig = (n: number | null, unit: string) =>
  n == null ? '—' : `${n.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`

/** One figure of an environment and what it costs; an unmeasured one says so, with no amount. */
function Part(p: { label: string; v: number | null; unit: string; cost: number; cur: string }) {
  return (
    <span>
      {p.label} {p.v == null ? '—' : `${fig(p.v, p.unit)} · ${money(p.cost, p.cur)}`}
    </span>
  )
}

function AppTable({ r }: { r: ChargebackReport }) {
  const [open, setOpen] = useState<Set<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const apps = [...r.apps].sort((a, b) => b.total - a.total || a.app_key.localeCompare(b.app_key))
  return (
    <div className='overflow-x-auto'>
      <table className='w-full min-w-[720px] text-[12px]'>
        <thead className='text-left text-slate-500 dark:text-muted-foreground'>
          <tr>
            <th className='whitespace-nowrap py-2 pr-3 pl-4 font-medium'>App</th>
            <th className='whitespace-nowrap py-2 pr-3 font-medium'>Department</th>
            <th className='whitespace-nowrap py-2 pr-3 font-medium'>Cost centre</th>
            <th className='whitespace-nowrap py-2 pr-3 font-medium'>Owners</th>
            <th className='whitespace-nowrap py-2 pr-3 text-right font-medium'>Environments</th>
            <th className='whitespace-nowrap py-2 pr-4 text-right font-medium'>Per month</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((a) => (
            <Fragment key={a.app_id}>
              <tr className='border-t border-slate-100 align-middle dark:border-border'>
                <td className='py-2 pr-3 pl-2'>
                  <button
                    type='button'
                    aria-expanded={open.has(a.app_id)}
                    onClick={() => toggle(a.app_id)}
                    className='inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground dark:hover:bg-muted'
                  >
                    {open.has(a.app_id) ? (
                      <ChevronDown className='h-3.5 w-3.5 shrink-0' aria-hidden />
                    ) : (
                      <ChevronRight className='h-3.5 w-3.5 shrink-0' aria-hidden />
                    )}
                    <span className='truncate'>{a.app_name}</span>
                  </button>
                </td>
                {editing === a.app_id ? (
                  <td colSpan={2} className='py-1.5 pr-3'>
                    <CostCenterForm app={a} onDone={() => setEditing(null)} />
                  </td>
                ) : (
                  <>
                    <td className='py-2 pr-3 text-slate-700 dark:text-foreground'>
                      <span className='inline-flex items-center gap-1'>
                        {a.department ?? <span className='text-slate-400'>—</span>}
                        <button
                          type='button'
                          aria-label={`Edit the department of ${a.app_name}`}
                          className='rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                          onClick={() => setEditing(a.app_id)}
                        >
                          <Pencil className='h-3 w-3' aria-hidden />
                        </button>
                      </span>
                    </td>
                    <td className='py-2 pr-3 text-slate-700 dark:text-foreground'>
                      {a.cost_center ?? <span className='text-slate-400'>—</span>}
                    </td>
                  </>
                )}
                <td className='max-w-[220px] truncate py-2 pr-3 text-slate-600 dark:text-muted-foreground'>
                  {a.owners.map((o) => o.name).join(', ') || '—'}
                </td>
                <td className='py-2 pr-3 text-right tabular-nums text-slate-600 dark:text-muted-foreground'>
                  {a.environments.length}
                </td>
                <td className='py-2 pr-4 text-right font-semibold tabular-nums text-slate-900 dark:text-foreground'>
                  {money(a.total, r.currency)}
                </td>
              </tr>
              {open.has(a.app_id) &&
                a.environments.map((e) => (
                  <tr
                    key={e.env_id}
                    className='bg-slate-50/60 align-top text-[11.5px] dark:bg-muted/30'
                  >
                    <td className='py-1.5 pr-3 pl-9'>
                      <Link
                        to={`/hub?app=${a.app_id}`}
                        className='font-medium text-slate-800 hover:underline dark:text-foreground'
                      >
                        {e.env_key}
                      </Link>
                      <span className='block text-slate-500 dark:text-muted-foreground'>
                        {e.runs_on}
                        {e.region ? ` · ${e.region}` : ''}
                        {e.cost.factor_percent !== 100 ? ` · ×${e.cost.factor_percent}%` : ''}
                      </span>
                    </td>
                    <td
                      colSpan={3}
                      className='py-1.5 pr-3 tabular-nums text-slate-600 dark:text-muted-foreground'
                    >
                      <span className='flex flex-wrap gap-x-3 gap-y-0.5'>
                        <Part
                          label='CPU'
                          v={e.usage.cpu_cores}
                          unit='cores'
                          cost={e.cost.cpu}
                          cur={r.currency}
                        />
                        <Part
                          label='Memory'
                          v={e.usage.memory_gb}
                          unit='GB'
                          cost={e.cost.memory}
                          cur={r.currency}
                        />
                        <Part
                          label='Files'
                          v={e.usage.storage_gb}
                          unit='GB'
                          cost={e.cost.storage}
                          cur={r.currency}
                        />
                        <Part
                          label='Database'
                          v={e.usage.database_gb}
                          unit='GB'
                          cost={e.cost.database}
                          cur={r.currency}
                        />
                        <span>Flat {money(e.cost.environment, r.currency)}</span>
                      </span>
                      {e.gaps.length > 0 && (
                        <span className='mt-0.5 block text-amber-800 dark:text-amber-300'>
                          Not measured: {e.gaps.join(', ')} (counted as nothing)
                        </span>
                      )}
                    </td>
                    <td />
                    <td className='py-1.5 pr-4 text-right tabular-nums text-slate-800 dark:text-foreground'>
                      {money(e.cost.total, r.currency)}
                    </td>
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function CostCenterForm({ app, onDone }: { app: AppCost; onDone: () => void }) {
  const qc = useQueryClient()
  const [dept, setDept] = useState(app.department ?? '')
  const [cc, setCc] = useState(app.cost_center ?? '')
  const save = useMutation({
    mutationFn: () => saveCostCenter(app.app_id, { department: dept, cost_center: cc }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: placementKeys.chargeback() })
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the department')
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }
  return (
    <form onSubmit={submit} className='flex flex-wrap items-center gap-1.5'>
      <Input
        aria-label='Department'
        value={dept}
        onChange={(e) => setDept(e.target.value)}
        placeholder='Department'
        className='h-7 w-[140px] text-[12px]'
        autoFocus
      />
      <Input
        aria-label='Cost centre'
        value={cc}
        onChange={(e) => setCc(e.target.value)}
        placeholder='Cost centre'
        className='h-7 w-[110px] text-[12px]'
      />
      <button type='submit' className={cn(ghostButton, 'h-7')} disabled={save.isPending}>
        Save
      </button>
      <button type='button' className={cn(ghostButton, 'h-7')} onClick={onDone}>
        Cancel
      </button>
    </form>
  )
}

function RatesCard({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: placementKeys.chargebackSettings(),
    queryFn: fetchChargebackSettings
  })
  if (settings.isPending) return <Skeleton className='h-40 w-full' />
  if (settings.isError)
    return (
      <QueryErrorState
        error={settings.error}
        what='the rates'
        onRetry={() => void settings.refetch()}
      />
    )
  return (
    <RatesForm
      initial={settings.data}
      onDone={onDone}
      onSaved={() => void qc.invalidateQueries({ queryKey: placementKeys.all })}
    />
  )
}

function RatesForm({
  initial,
  onDone,
  onSaved
}: {
  initial: ChargebackSettings
  onDone: () => void
  onSaved: () => void
}) {
  const [currency, setCurrency] = useState(initial.currency)
  const [win, setWin] = useState(String(initial.window_days))
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(RATE_FIELDS.map((f) => [f.key, String(initial.rates[f.key])]))
  )
  const bad = (k: string) => {
    const n = Number(vals[k])
    return vals[k].trim() === '' || !Number.isFinite(n) || n < 0 || n > 1_000_000
  }
  const winN = Number(win)
  const winBad = !Number.isInteger(winN) || winN < 7 || winN > 31
  const curBad = !/^[A-Za-z]{3}$/.test(currency.trim())
  const anyBad = winBad || curBad || RATE_FIELDS.some((f) => bad(f.key))
  const save = useMutation({
    mutationFn: () =>
      saveChargebackSettings({
        currency: currency.trim().toUpperCase(),
        window_days: winN,
        rates: Object.fromEntries(
          RATE_FIELDS.map((f) => [f.key, Number(vals[f.key])])
        ) as unknown as ChargebackSettings['rates']
      }),
    onSuccess: () => {
      toast.success('Rates saved')
      onSaved()
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the rates')
  })
  return (
    <SectionCard
      title='Rates'
      description='Your own prices for what an app uses; a host region’s cost factor is applied on top.'
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (!anyBad) save.mutate()
        }}
        className='grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4'
      >
        {RATE_FIELDS.map((f) => (
          <Field
            key={f.key}
            id={`rate-${f.key}`}
            label={`${f.label} (${currency.toUpperCase() || '—'})`}
            hint={f.unit}
            error={bad(f.key) ? 'A number, 0 or more.' : null}
          >
            <Input
              id={`rate-${f.key}`}
              inputMode='decimal'
              value={vals[f.key]}
              onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
              className='h-8 text-[13px] tabular-nums'
            />
          </Field>
        ))}
        <Field
          id='rate-currency'
          label='Currency'
          hint='Three-letter code, shown beside every amount.'
          error={curBad ? 'Three letters, like USD.' : null}
        >
          <Input
            id='rate-currency'
            value={currency}
            maxLength={3}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            className='h-8 font-mono text-[13px]'
          />
        </Field>
        <Field
          id='rate-window'
          label='Window (days)'
          hint='Days of samples the averages cover, 7–31.'
          error={winBad ? 'A whole number, 7–31.' : null}
        >
          <Input
            id='rate-window'
            inputMode='numeric'
            value={win}
            onChange={(e) => setWin(e.target.value)}
            className='h-8 text-[13px] tabular-nums'
          />
        </Field>
        <div className='flex gap-2 sm:col-span-2 lg:col-span-4'>
          <Button
            type='submit'
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
            disabled={anyBad || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save rates'}
          </Button>
          <button type='button' className={ghostButton} onClick={onDone}>
            Cancel
          </button>
        </div>
      </form>
    </SectionCard>
  )
}
