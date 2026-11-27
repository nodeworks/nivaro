import { QueryErrorState } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { Fragment } from 'react'
import { Link } from 'react-router'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatDate, formatRelative } from '@/lib/utils'
import { SectionCard } from '../hub-parts'
import { money } from './placement-api'

/**
 * Outside spend (Costs tab, Task 34): what provider connections with a cost feed billed — AWS
 * Cost Explorer, Azure Cost Management, Anthropic, OpenAI — per app, per provider, month to date
 * and the last 12 calendar months, with shared resources and unassigned spend on their own rows.
 * Read once a day by the Hub (06:10 UTC); the chargeback CSV carries the same rows. Admins only
 * (the Costs page is). GET /api/hub/costs/outside.
 */

export type SpendKind = 'app' | 'shared' | 'unassigned'

export interface SpendRow {
  kind: SpendKind
  app_id: number | null
  app_key: string | null
  app_name: string | null
  provider: string
  provider_label: string
  currency: string
  month_to_date_cents: number
  last_12_months_cents: number
  months_cents: number[]
}

export interface SpendFeed {
  connection_id: number
  name: string
  provider: string
  provider_label: string
  through: string | null
  last_read_at: string | null
  ok: boolean | null
  error: string | null
}

export interface OutsideSpend {
  generated_at: string
  months: string[]
  rows: SpendRow[]
  totals: Array<{ currency: string; month_to_date_cents: number; last_12_months_cents: number }>
  feeds: SpendFeed[]
}

export const outsideSpendKey = () => ['hub', 'placement', 'outside-spend'] as const

export const fetchOutsideSpend = () =>
  api.get<{ data: OutsideSpend }>('/hub/costs/outside').then((r) => r.data.data)

const cents = (c: number, currency: string) => money(c / 100, currency)

const groupLabel = (r: SpendRow) =>
  r.kind === 'app'
    ? (r.app_name ?? r.app_key ?? 'App')
    : r.kind === 'shared'
      ? 'Shared resources'
      : 'Not assigned to an app'

const groupHint = (k: SpendKind) =>
  k === 'shared'
    ? 'Managed resources that belong to no single app.'
    : k === 'unassigned'
      ? 'Billed rows that name no managed resource and carry no nivaro-hub:app tag.'
      : null

/** Rows grouped by app (then shared, then unassigned), in the order the server sorted them. */
function groupsOf(rows: SpendRow[]) {
  const out: Array<{ key: string; kind: SpendKind; label: string; rows: SpendRow[] }> = []
  for (const r of rows) {
    const key = `${r.kind}:${r.app_id ?? ''}`
    const last = out[out.length - 1]
    if (last && last.key === key) last.rows.push(r)
    else out.push({ key, kind: r.kind, label: groupLabel(r), rows: [r] })
  }
  return out
}

function monthName(ym: string): string {
  const d = new Date(`${ym}-01T00:00:00Z`)
  return Number.isFinite(d.getTime())
    ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
    : ym
}

export default function HubOutsideSpend() {
  const q = useQuery({ queryKey: outsideSpendKey(), queryFn: fetchOutsideSpend })
  const s = q.data
  const range = s?.months.length
    ? `${monthName(s.months[0])} – ${monthName(s.months[s.months.length - 1])}`
    : null
  return (
    <SectionCard
      title='Outside spend'
      description={
        s?.feeds.length
          ? `What providers billed, read once a day from their cost feeds. Last 12 months: ${range}.`
          : 'What providers billed, read once a day from their cost feeds.'
      }
    >
      {q.isPending ? (
        <div className='p-4'>
          <Skeleton className='h-28 w-full' />
        </div>
      ) : q.isError ? (
        <QueryErrorState
          error={q.error}
          what='the outside spend'
          onRetry={() => void q.refetch()}
          className='m-3'
        />
      ) : !s || s.feeds.length === 0 ? (
        <p className='m-0 px-4 py-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
          No provider connection reports its bill yet. Connections whose provider has a cost feed
          (AWS Cost Explorer, Azure Cost Management, Anthropic, OpenAI) fill this in once a day.{' '}
          <Link
            to='/hub/connections'
            className='font-medium text-slate-700 underline underline-offset-2 hover:text-slate-900 dark:text-foreground'
          >
            Open connections
          </Link>
        </p>
      ) : (
        <>
          {s.rows.length === 0 ? (
            <p className='m-0 px-4 py-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Nothing billed in the last 12 months yet.
            </p>
          ) : (
            <SpendTable s={s} />
          )}
          <Feeds feeds={s.feeds} />
        </>
      )}
    </SectionCard>
  )
}

const th = 'whitespace-nowrap py-2 pr-3 text-left text-[11px] font-medium'
const num = 'py-2 pr-4 text-right tabular-nums'

function SpendTable({ s }: { s: OutsideSpend }) {
  const groups = groupsOf(s.rows)
  return (
    <>
      {/* Phone: one block per app, its providers as lines. */}
      <ul className='m-0 list-none divide-y divide-slate-100 p-0 md:hidden dark:divide-border'>
        {groups.map((g) => (
          <li key={g.key} className='px-4 py-3'>
            <p
              className={cn(
                'm-0 text-[13px] font-medium',
                g.kind === 'app'
                  ? 'text-slate-900 dark:text-foreground'
                  : 'text-slate-600 dark:text-muted-foreground'
              )}
            >
              {g.label}
            </p>
            <ul className='m-0 mt-1.5 list-none space-y-1 p-0'>
              {g.rows.map((r) => (
                <li
                  key={`${r.provider}:${r.currency}`}
                  className='flex items-baseline justify-between gap-3 text-[12px]'
                >
                  <span className='min-w-0 truncate text-slate-600 dark:text-muted-foreground'>
                    {r.provider_label}
                  </span>
                  <span className='shrink-0 text-right tabular-nums'>
                    <span className='font-medium text-slate-900 dark:text-foreground'>
                      {cents(r.month_to_date_cents, r.currency)}
                    </span>
                    <span className='text-slate-500 dark:text-muted-foreground'>
                      {' '}
                      · {cents(r.last_12_months_cents, r.currency)} in 12 mo
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      <div className='hidden overflow-x-auto md:block'>
        <table className='w-full min-w-[600px] text-[12px]'>
          <thead className='text-slate-500 dark:text-muted-foreground'>
            <tr>
              <th className={cn(th, 'pl-4')}>App</th>
              <th className={th}>Provider</th>
              <th className={cn(th, 'text-right')}>Month to date</th>
              <th className={cn(th, 'pr-4 text-right')}>Last 12 months</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                {g.rows.map((r, i) => (
                  <tr
                    key={`${r.provider}:${r.currency}`}
                    className={cn(
                      'align-top',
                      i === 0 && 'border-t border-slate-100 dark:border-border'
                    )}
                  >
                    <td className='py-2 pr-3 pl-4'>
                      {i === 0 && (
                        <>
                          {g.kind === 'app' && r.app_id != null ? (
                            <Link
                              to={`/hub?app=${r.app_id}`}
                              className='font-medium text-slate-900 hover:underline dark:text-foreground'
                            >
                              {g.label}
                            </Link>
                          ) : (
                            <span className='font-medium text-slate-600 dark:text-muted-foreground'>
                              {g.label}
                            </span>
                          )}
                          {groupHint(g.kind) && (
                            <span className='mt-0.5 block max-w-[280px] text-[11px] text-slate-500 dark:text-muted-foreground'>
                              {groupHint(g.kind)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className='py-2 pr-3 text-slate-700 dark:text-foreground'>
                      {r.provider_label}
                    </td>
                    <td className={cn(num, 'pr-3 font-medium text-slate-900 dark:text-foreground')}>
                      {cents(r.month_to_date_cents, r.currency)}
                    </td>
                    <td className={cn(num, 'text-slate-700 dark:text-foreground')}>
                      {cents(r.last_12_months_cents, r.currency)}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            {s.totals.map((t) => (
              <tr
                key={t.currency}
                className='border-t border-slate-200 text-slate-600 dark:border-border dark:text-muted-foreground'
              >
                <td className='py-2.5 pr-3 pl-4' colSpan={2}>
                  All outside spend{s.totals.length > 1 ? ` (${t.currency})` : ''}
                </td>
                <td
                  className={cn(
                    num,
                    'pr-3 text-[13px] font-semibold text-slate-900 dark:text-foreground'
                  )}
                >
                  {cents(t.month_to_date_cents, t.currency)}
                </td>
                <td
                  className={cn(
                    num,
                    'text-[13px] font-semibold text-slate-900 dark:text-foreground'
                  )}
                >
                  {cents(t.last_12_months_cents, t.currency)}
                </td>
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      {/* Phone: the totals once, under the blocks. */}
      <div className='border-t border-slate-200 px-4 py-2.5 md:hidden dark:border-border'>
        {s.totals.map((t) => (
          <p
            key={t.currency}
            className='m-0 flex items-baseline justify-between gap-3 text-[12px] text-slate-600 dark:text-muted-foreground'
          >
            <span>All outside spend{s.totals.length > 1 ? ` (${t.currency})` : ''}</span>
            <span className='text-[13px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
              {cents(t.month_to_date_cents, t.currency)}
            </span>
          </p>
        ))}
      </div>
    </>
  )
}

/** Each cost feed: how far its bill goes, and how its last daily read went. */
function Feeds({ feeds }: { feeds: SpendFeed[] }) {
  return (
    <ul className='m-0 list-none space-y-1 border-t border-slate-200 bg-slate-50/70 px-4 py-2.5 text-[11.5px] text-slate-600 dark:border-border dark:bg-muted/30 dark:text-muted-foreground'>
      {feeds.map((f) => (
        <li key={f.connection_id} className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
          <span className='font-medium text-slate-800 dark:text-foreground'>{f.name}</span>
          <span>{f.provider_label}</span>
          <span aria-hidden>·</span>
          <span className='tabular-nums'>
            {f.through ? `Billed through ${formatDate(f.through)}` : 'Nothing billed yet'}
          </span>
          {f.last_read_at && (
            <>
              <span aria-hidden>·</span>
              <span>read {formatRelative(f.last_read_at)}</span>
            </>
          )}
          {f.ok === false && (
            <span className='inline-flex min-w-0 basis-full items-start gap-1 text-amber-800 dark:text-amber-300'>
              <AlertTriangle className='mt-0.5 h-3 w-3 shrink-0' aria-hidden />
              <span className='min-w-0 break-words'>
                The last read failed{f.error ? `: ${f.error.replace(/[.\s]+$/, '')}` : ''}. The Hub
                tries again tomorrow.
              </span>
            </span>
          )}
          {f.ok == null && <span>· first read at 06:10 UTC</span>}
        </li>
      ))}
    </ul>
  )
}
