import { QueryErrorState } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react'
import { type FormEvent, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatDate, formatDateTime, formatRelative } from '@/lib/utils'
import { AppFilterNote, useAppFilter } from '../app-filter'
import { fetchHubApps, type HubApp, hubKeys, hubToast, useHubApp } from '../hub-api'
import { ghostButton, SectionCard } from '../hub-parts'
import {
  fetchProviderTypes,
  fetchResources,
  providerKeys,
  resourceName,
  typeIndex
} from '../providers/providers-api'
import {
  type CostBudget,
  cents,
  costKeys,
  fetchBudget,
  fetchCostSettings,
  hourly,
  type LiveCosts,
  type LiveSeries,
  saveBudget,
  saveCostSettings,
  signedCents
} from './cost-api'
import { useLiveCosts } from './use-costs'

/**
 * Costs → Now (Task 44c): what the apps cost running as they are now (the run-rate, sampled every
 * 15 minutes), the month so far, the month-end forecast against each app's budget, and beside it
 * what the providers billed through the last day they reported, with the gap. Every figure but
 * Billed is an estimate. Owners see their own apps and their budgets (read only); Hub
 * administrators set budgets and the Hub-wide auto-approve amount.
 */
export function HubCostsNow({ isAdmin }: { isAdmin: boolean }) {
  const live = useLiveCosts(null)
  const apps = useQuery({ queryKey: hubKeys.apps(), queryFn: fetchHubApps })
  if (live.isPending) return <Skeleton className='h-48 w-full' />
  if (live.isError)
    return (
      <QueryErrorState
        error={live.error}
        what='the live costs'
        onRetry={() => void live.refetch()}
      />
    )
  const d = live.data
  return (
    <>
      <Summary d={d} />
      <SectionCard
        title='Per app'
        description={
          isAdmin
            ? 'Open an app for its environments, providers and resources. Set a budget to be told at 80 % and 100 % of the forecast.'
            : 'Your apps. Open one for its environments, providers and resources. Budgets are set by Hub administrators.'
        }
      >
        <AppList d={d} apps={apps.data ?? []} isAdmin={isAdmin} />
      </SectionCard>
      {d.byProvider.length > 0 && <ProviderList d={d} />}
      <AutoApproveCard isAdmin={isAdmin} currency={d.currency} />
    </>
  )
}

const monthName = (month: string) => {
  const d = new Date(`${month}-15T12:00:00Z`)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString(undefined, { month: 'long' }) : month
}

function Cell({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <div className='min-w-0 bg-white px-4 py-3 dark:bg-card'>
      <p className='m-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>{label}</p>
      <p className='m-0 mt-0.5 text-[17px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </p>
      {sub && <p className='m-0 mt-0.5 text-[11.5px] text-slate-600 dark:text-slate-300'>{sub}</p>}
    </div>
  )
}

function billedWords(d: LiveCosts): { value: string; sub: string } {
  if (!d.billed) return { value: 'No bill yet', sub: 'No provider cost feed is connected yet.' }
  if (!d.billed.throughDate)
    return { value: 'No bill yet', sub: 'The providers have not reported this month yet.' }
  const through = formatDate(d.billed.throughDate)
  const gap =
    d.gapCents == null || d.gapCents === 0
      ? 'matches the estimate'
      : `${signedCents(d.gapCents, d.currency)} against the estimate`
  return { value: cents(d.billed.monthToDateCents, d.currency), sub: `Through ${through}, ${gap}` }
}

/** The server's "now" window: two 15-minute samples. */
const STALE_SAMPLE_MS = 30 * 60_000

function Summary({ d }: { d: LiveCosts }) {
  const billed = billedWords(d)
  const month = monthName(d.month)
  // The Hub answers "now" only from a sample under 30 minutes old: an older one means the
  // sampling stopped, which is not the same as nothing running.
  const stale = !!d.sampledAt && Date.now() - new Date(d.sampledAt).getTime() > STALE_SAMPLE_MS
  return (
    <SectionCard
      title={`${month} so far`}
      description={
        d.sampledAt
          ? `Estimated from the run-rate sampled ${formatRelative(d.sampledAt)} (${formatDateTime(d.sampledAt)}). ${stale ? 'The Hub has not sampled since; it does every 15 minutes while its scheduled jobs run.' : 'Updates by itself.'}`
          : 'No figures yet. The Hub samples costs every 15 minutes once it manages a priced resource or a stack with rates set.'
      }
    >
      <div className='grid grid-cols-2 gap-px overflow-hidden border-b border-slate-200 bg-slate-200 lg:grid-cols-4 dark:border-border dark:bg-border'>
        <Cell
          label='Running now'
          value={stale ? 'Not sampled' : `${cents(d.nowCents, d.currency)}/mo`}
          sub={
            stale && d.sampledAt
              ? `Last sample ${formatRelative(d.sampledAt)}`
              : d.nowCents
                ? `About ${hourly(d.nowCents, d.currency)} an hour`
                : 'Nothing priced runs now'
          }
        />
        <Cell
          label='Month to date'
          value={cents(d.monthToDateCents, d.currency)}
          sub={`Estimated since ${month} 1`}
        />
        <Cell
          label='Forecast, month end'
          value={cents(d.forecastCents, d.currency)}
          sub={
            stale ? 'Month to date only, until the next sample' : 'If what runs now keeps running'
          }
        />
        <Cell label='Billed' value={billed.value} sub={billed.sub} />
      </div>
      <p className='m-0 px-4 py-2.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Estimates use list prices for provider resources and the Hub’s own rates for stacks. They
        leave out tax, data transfer and credits unless a resource lists them. The providers’ bills
        are the truth; the gap above shows how far apart they are.
      </p>
    </SectionCard>
  )
}

// ─── Per app ─────────────────────────────────────────────────────────────────

const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_minmax(11rem,15rem)]'

function AppList({ d, apps, isAdmin }: { d: LiveCosts; apps: HubApp[]; isAdmin: boolean }) {
  // `?app=<id>`: one app's row, opened on its environments (the link on an app's page).
  const { appId, clear } = useAppFilter()
  const [open, setOpen] = useState<Set<number>>(() => new Set(appId != null ? [appId] : []))
  const [editing, setEditing] = useState<number | null>(null)
  const nameOf = (id: number) => apps.find((a) => a.id === id)
  const only = appId != null && nameOf(appId) ? appId : null
  // Every app the caller sees, priced or not (an app with nothing priced still has a budget).
  const ids = [...new Set([...d.byApp.map((a) => a.app_id), ...apps.map((a) => a.id)])]
  const rows = ids
    .map(
      (id) =>
        d.byApp.find((a) => a.app_id === id) ?? {
          app_id: id,
          nowCents: 0,
          monthToDateCents: 0,
          forecastCents: 0
        }
    )
    .filter((r) => nameOf(r.app_id) || r.nowCents || r.monthToDateCents)
    .filter((r) => only == null || r.app_id === only)
    .sort(
      (a, b) =>
        b.forecastCents - a.forecastCents ||
        (nameOf(a.app_id)?.name ?? '').localeCompare(nameOf(b.app_id)?.name ?? '')
    )
  if (!rows.length)
    return (
      <p className='m-0 px-4 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        No apps yet.
      </p>
    )
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return (
    <div>
      {appId != null && (
        <div className='border-b border-slate-200 p-2 dark:border-border'>
          <AppFilterNote name={nameOf(appId)?.name ?? null} onClear={clear} />
        </div>
      )}
      <div
        className={cn(
          ROW_GRID,
          'hidden border-b border-slate-200 px-4 py-2 text-[11.5px] font-medium text-slate-500 sm:grid dark:border-border dark:text-muted-foreground'
        )}
        aria-hidden
      >
        <span>App</span>
        <span className='text-right'>Running now</span>
        <span className='text-right'>Month to date</span>
        <span>Forecast against budget</span>
      </div>
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
        {rows.map((r) => {
          const app = nameOf(r.app_id)
          const isOpen = open.has(r.app_id)
          return (
            <li key={r.app_id}>
              <div className={cn(ROW_GRID, 'px-4 py-2 text-[12.5px]')}>
                <button
                  type='button'
                  aria-expanded={isOpen}
                  onClick={() => toggle(r.app_id)}
                  className='inline-flex min-w-0 items-center gap-1 justify-self-start rounded px-1 py-0.5 -ml-1 text-left font-medium text-slate-900 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 dark:text-foreground dark:hover:bg-muted'
                >
                  {isOpen ? (
                    <ChevronDown className='h-3.5 w-3.5 shrink-0' aria-hidden />
                  ) : (
                    <ChevronRight className='h-3.5 w-3.5 shrink-0' aria-hidden />
                  )}
                  <span className='truncate'>{app?.name ?? `App ${r.app_id}`}</span>
                </button>
                <span
                  className='text-right tabular-nums text-slate-900 dark:text-foreground'
                  data-tip={
                    r.nowCents ? `About ${hourly(r.nowCents, d.currency)} an hour` : undefined
                  }
                >
                  <span className='text-slate-500 sm:hidden dark:text-muted-foreground'>Now </span>
                  {cents(r.nowCents, d.currency)}/mo
                </span>
                <span className='hidden text-right tabular-nums text-slate-700 sm:block dark:text-slate-300'>
                  {cents(r.monthToDateCents, d.currency)}
                </span>
                <div className='col-span-2 sm:col-span-1'>
                  <BudgetCell
                    appId={r.app_id}
                    appName={app?.name ?? `App ${r.app_id}`}
                    forecastCents={r.forecastCents}
                    currency={d.currency}
                    isAdmin={isAdmin}
                    editing={editing === r.app_id}
                    onEdit={() => setEditing(r.app_id)}
                  />
                </div>
                <span className='col-span-2 text-[11.5px] tabular-nums text-slate-600 sm:hidden dark:text-slate-300'>
                  Month to date {cents(r.monthToDateCents, d.currency)}
                </span>
              </div>
              {editing === r.app_id && (
                <BudgetEditor
                  appId={r.app_id}
                  appName={app?.name ?? `App ${r.app_id}`}
                  currency={d.currency}
                  onDone={() => setEditing(null)}
                />
              )}
              {isOpen && <AppDrill appId={r.app_id} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** Forecast against the app's budget: a bar, the two amounts, and the editor for admins. */
function BudgetCell({
  appId,
  appName,
  forecastCents,
  currency,
  isAdmin,
  editing,
  onEdit
}: {
  appId: number
  appName: string
  forecastCents: number
  currency: string
  isAdmin: boolean
  editing: boolean
  onEdit: () => void
}) {
  const budget = useQuery({ queryKey: costKeys.budget(appId), queryFn: () => fetchBudget(appId) })
  if (budget.isPending) return <Skeleton className='h-5 w-full' />
  if (budget.isError)
    return (
      <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        Budget could not be read
      </span>
    )
  const b = budget.data
  const has = b.monthly_cents > 0
  const pct = has ? (forecastCents / b.monthly_cents) * 100 : 0
  const tone = pct >= 100 ? 'over' : pct >= 80 ? 'near' : 'ok'
  return (
    <div className='flex min-w-0 items-center gap-2'>
      <div className='min-w-0 flex-1'>
        {has ? (
          <>
            <div
              className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
              aria-hidden
            >
              <span
                className={cn(
                  'block h-full rounded-full',
                  tone === 'over'
                    ? 'bg-red-600 dark:bg-red-500'
                    : tone === 'near'
                      ? 'bg-amber-500 dark:bg-amber-400'
                      : 'bg-slate-500 dark:bg-slate-400'
                )}
                style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
              />
            </div>
            <p
              className={cn(
                'm-0 mt-1 text-[11.5px] tabular-nums',
                tone === 'over'
                  ? 'text-red-700 dark:text-red-300'
                  : tone === 'near'
                    ? 'text-amber-800 dark:text-amber-300'
                    : 'text-slate-600 dark:text-slate-300'
              )}
            >
              {cents(forecastCents, currency)} of {cents(b.monthly_cents, currency)}
              {tone === 'over' ? ' · over budget' : tone === 'near' ? ' · near the budget' : ''}
            </p>
          </>
        ) : (
          <p className='m-0 text-[11.5px] tabular-nums text-slate-600 dark:text-slate-300'>
            {cents(forecastCents, currency)}
            <span className='text-slate-500 dark:text-muted-foreground'> · no budget</span>
          </p>
        )}
      </div>
      {isAdmin && (
        <button
          type='button'
          aria-label={`Edit the budget of ${appName}`}
          aria-expanded={editing}
          data-tip='Edit the budget'
          className={cn(ghostButton, 'h-7 w-7 shrink-0 px-0')}
          onClick={onEdit}
        >
          <Pencil className='h-3.5 w-3.5' aria-hidden />
        </button>
      )}
    </div>
  )
}

/** The budget editor, a full-width strip under the app's row (Hub administrators). */
function BudgetEditor({
  appId,
  appName,
  currency,
  onDone
}: {
  appId: number
  appName: string
  currency: string
  onDone: () => void
}) {
  const budget = useQuery({ queryKey: costKeys.budget(appId), queryFn: () => fetchBudget(appId) })
  if (!budget.data) return null
  return (
    <div className='border-t border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-border dark:bg-muted/30'>
      <BudgetForm budget={budget.data} appName={appName} currency={currency} onDone={onDone} />
    </div>
  )
}

/** Text in currency units → cents; '' = null; a bad value = NaN. */
function toCents(text: string): number | null {
  const t = text.trim().replace(/[$,\s]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN
}

const fromCents = (n: number | null | undefined) =>
  n == null ? '' : (n / 100).toFixed(2).replace(/\.00$/, '')

function BudgetForm({
  budget,
  appName,
  currency,
  onDone
}: {
  budget: CostBudget
  appName: string
  currency: string
  onDone: () => void
}) {
  const qc = useQueryClient()
  const id = useId()
  const [monthly, setMonthly] = useState(fromCents(budget.monthly_cents || null))
  const [auto, setAuto] = useState(fromCents(budget.auto_approve_under_cents))
  const m = toCents(monthly)
  const a = toCents(auto)
  const bad = Number.isNaN(m) || Number.isNaN(a)
  const save = useMutation({
    mutationFn: () =>
      saveBudget(budget.app_id, {
        monthly_cents: m ?? 0,
        auto_approve_under_cents: a
      }),
    onSuccess: () => {
      toast.success(`Budget saved for ${appName}`)
      void qc.invalidateQueries({ queryKey: costKeys.budget(budget.app_id) })
      onDone()
    },
    onError: (err) => hubToast(err, 'Could not save the budget')
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!bad) save.mutate()
  }
  return (
    <form onSubmit={submit} className='space-y-1.5'>
      <div className='flex flex-wrap items-end gap-2'>
        <label className='space-y-0.5' htmlFor={`${id}-m`}>
          <span className='block text-[11px] text-slate-600 dark:text-slate-300'>
            Budget a month ({currency})
          </span>
          <Input
            id={`${id}-m`}
            inputMode='decimal'
            value={monthly}
            onChange={(e) => setMonthly(e.target.value)}
            placeholder='None'
            autoFocus
            aria-invalid={Number.isNaN(m) || undefined}
            className='h-7 w-28 text-[12px] tabular-nums'
          />
        </label>
        <label className='space-y-0.5' htmlFor={`${id}-a`}>
          <span className='block text-[11px] text-slate-600 dark:text-slate-300'>
            Approve under ({currency})
          </span>
          <Input
            id={`${id}-a`}
            inputMode='decimal'
            value={auto}
            onChange={(e) => setAuto(e.target.value)}
            placeholder='Hub-wide'
            aria-invalid={Number.isNaN(a) || undefined}
            className='h-7 w-28 text-[12px] tabular-nums'
          />
        </label>
      </div>
      <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
        {bad
          ? 'Amounts are numbers, 0 or more.'
          : 'Blank budget = none. Blank approve = the Hub-wide amount; 0 = every costed change waits.'}
      </p>
      <div className='flex gap-1.5'>
        <button type='submit' className={cn(ghostButton, 'h-7')} disabled={bad || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type='button' className={cn(ghostButton, 'h-7')} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// ─── Drill: environment → provider → resource ────────────────────────────────

function AppDrill({ appId }: { appId: number }) {
  const live = useLiveCosts(appId)
  const app = useHubApp(appId)
  const resources = useQuery({
    queryKey: providerKeys.resources({ app: appId }),
    queryFn: () => fetchResources({ app: appId })
  })
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  if (live.isPending) return <Skeleton className='mx-4 mb-3 h-16' />
  if (live.isError)
    return (
      <div className='px-4 pb-3'>
        <QueryErrorState
          error={live.error}
          what='this app’s costs'
          onRetry={() => void live.refetch()}
        />
      </div>
    )
  const d = live.data
  const envKey = (id: number | null) =>
    id == null
      ? 'Not tied to an environment'
      : (app.data?.environments.find((e) => e.id === id)?.key ?? `Environment ${id}`)
  const resourceLabel = (s: LiveSeries) => {
    if (s.kind === 'stack') return 'Docker stack (Hub rates)'
    const r = resources.data?.find((x) => x.id === s.resource_id)
    return r ? `${resourceName(r)} · ${idx.typeLabel(r.type)}` : `Resource ${s.resource_id}`
  }
  const groups = new Map<string, { envId: number | null; rows: LiveSeries[] }>()
  for (const s of d.series) {
    const k = String(s.environment_id ?? '')
    const g = groups.get(k) ?? { envId: s.environment_id, rows: [] }
    g.rows.push(s)
    groups.set(k, g)
  }
  const billed = billedWords(d)
  return (
    <div className='space-y-2 border-t border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-border dark:bg-muted/30 [&>*]:max-w-3xl'>
      <p className='m-0 text-[11.5px] text-slate-600 dark:text-slate-300'>
        Billed:{' '}
        <span className='font-medium text-slate-800 dark:text-foreground'>{billed.value}</span>
        {d.billed ? ` · ${billed.sub}` : ''}
      </p>
      {groups.size === 0 ? (
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Nothing priced runs for this app yet.
        </p>
      ) : (
        [...groups.values()].map((g) => {
          const byProvider = new Map<string, LiveSeries[]>()
          for (const s of g.rows) {
            const p = s.kind === 'stack' ? 'hub-stack' : (s.provider ?? 'other')
            byProvider.set(p, [...(byProvider.get(p) ?? []), s])
          }
          const total = g.rows.reduce((n, s) => n + s.nowCents, 0)
          return (
            <div key={String(g.envId)} className='space-y-1'>
              <p className='m-0 flex items-baseline justify-between gap-3 text-[12px] font-medium text-slate-800 dark:text-foreground'>
                <span className={cn(g.envId != null && 'font-mono')}>{envKey(g.envId)}</span>
                <span className='tabular-nums'>{cents(total, d.currency)}/mo</span>
              </p>
              <ul className='m-0 list-none space-y-1 p-0 pl-3'>
                {[...byProvider.entries()].map(([p, rows]) => (
                  <li key={p}>
                    <p className='m-0 text-[11.5px] font-medium text-slate-600 dark:text-slate-300'>
                      {p === 'hub-stack' ? 'Nivaro Hub' : idx.providerLabel(p)}
                    </p>
                    <ul className='m-0 list-none p-0 pl-3'>
                      {rows.map((s) => (
                        <li
                          key={`${s.kind}-${s.resource_id ?? 'stack'}`}
                          className='flex items-baseline justify-between gap-3 py-0.5 text-[11.5px] text-slate-700 dark:text-slate-300'
                        >
                          <span className='min-w-0 truncate'>{resourceLabel(s)}</span>
                          <span className='shrink-0 tabular-nums'>
                            {s.confidence === 'unknown' ? (
                              'No estimate'
                            ) : (
                              <>
                                {cents(s.nowCents, d.currency)}/mo
                                <span className='hidden text-slate-500 sm:inline dark:text-muted-foreground'>
                                  {' '}
                                  · {cents(s.monthToDateCents, d.currency)} so far
                                </span>
                              </>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          )
        })
      )}
    </div>
  )
}

// ─── By provider, approvals ──────────────────────────────────────────────────

function ProviderList({ d }: { d: LiveCosts }) {
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const idx = typeIndex(types.data)
  const top = Math.max(0, ...d.byProvider.map((p) => p.nowCents))
  return (
    <SectionCard title='By provider' description='Running now, and the month so far.'>
      <ul className='m-0 list-none space-y-2 p-4'>
        {d.byProvider.map((p) => (
          <li
            key={p.provider}
            className='grid grid-cols-[minmax(0,8rem)_1fr_auto] items-center gap-3 text-[12px] sm:grid-cols-[minmax(0,12rem)_1fr_auto]'
          >
            <span className='truncate text-slate-800 dark:text-foreground'>
              {p.provider === 'hub-stack' ? 'Hub stacks' : idx.providerLabel(p.provider)}
            </span>
            <span
              className='h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
              aria-hidden
            >
              <span
                className='block h-full rounded-full bg-slate-500 dark:bg-slate-400'
                style={{ width: `${top > 0 ? Math.max(2, (p.nowCents / top) * 100) : 0}%` }}
              />
            </span>
            <span className='text-right tabular-nums text-slate-900 dark:text-foreground'>
              {cents(p.nowCents, d.currency)}/mo
              <span className='block text-[11px] text-slate-500 dark:text-muted-foreground'>
                {cents(p.monthToDateCents, d.currency)} so far
              </span>
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  )
}

function AutoApproveCard({ isAdmin, currency }: { isAdmin: boolean; currency: string }) {
  const qc = useQueryClient()
  const id = useId()
  const settings = useQuery({ queryKey: costKeys.settings(), queryFn: fetchCostSettings })
  const [text, setText] = useState<string | null>(null)
  const current = settings.data?.cost_auto_approve_under_cents ?? 0
  const value = text ?? fromCents(current || null)
  const c = toCents(value)
  const bad = Number.isNaN(c)
  const save = useMutation({
    mutationFn: () => saveCostSettings({ cost_auto_approve_under_cents: c ?? 0 }),
    onSuccess: () => {
      toast.success('Saved')
      setText(null)
      void qc.invalidateQueries({ queryKey: costKeys.settings() })
    },
    onError: (err) => hubToast(err, 'Could not save the amount')
  })
  const words = current
    ? `An owner’s change that adds less than ${cents(current, currency)} a month (and costs less than that once) starts without waiting for approval. A change with no estimate always waits.`
    : 'Every owner change that costs money waits for a Hub administrator to approve it.'
  return (
    <SectionCard
      title='Approving costed changes'
      description={isAdmin ? 'Hub-wide; an app’s budget can set its own amount.' : undefined}
    >
      <div className='space-y-2 p-4'>
        <p className='m-0 text-[12px] text-slate-700 dark:text-slate-300'>{words}</p>
        {isAdmin && (
          <form
            className='space-y-1.5'
            onSubmit={(e) => {
              e.preventDefault()
              if (!bad) save.mutate()
            }}
          >
            <label
              htmlFor={`${id}-auto`}
              className='block text-[12px] font-medium text-slate-700 dark:text-foreground'
            >
              Approve without asking under ({currency} a month)
            </label>
            <div className='flex flex-wrap items-center gap-2'>
              <Input
                id={`${id}-auto`}
                inputMode='decimal'
                value={value}
                placeholder='0 = always ask'
                onChange={(e) => setText(e.target.value)}
                aria-invalid={bad || undefined}
                className='h-8 w-40 text-[13px] tabular-nums'
              />
              <Button
                type='submit'
                size='sm'
                className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                disabled={bad || text == null || save.isPending}
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
              {bad && (
                <span className='text-[11px] text-red-600 dark:text-red-400'>
                  A number, 0 or more.
                </span>
              )}
            </div>
          </form>
        )}
      </div>
    </SectionCard>
  )
}
