import { QueryErrorState, toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, RefreshCw, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { HubEnvTag } from '@/components/hub-brand/HubBits'
import { HubToolbar } from '@/components/hub-page'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatRelative } from '@/lib/utils'
import { countLabel, ghostButton, ListPaneHeader, listPaneClass } from '../hub-parts'
import {
  type AppUsage,
  type EnvUsage,
  fetchCollect,
  fetchUsage,
  insightKeys,
  startCollect
} from './insight-api'

/**
 * Usage (Apps hub tab): how many different people use each app, per day and per week, adoption
 * (people active in the last 7 days ÷ people with an account) and the busiest screens — counts
 * only, read once a day over the hub link. Nothing under the privacy floor (at least 5 people)
 * ever leaves the app: such a day shows as "fewer than N", such a screen is not listed.
 * Master-detail: environments on the left, the chosen one on the right (`?env=` in the URL).
 */

const STATE_COPY: Record<string, string> = {
  no_link: 'No hub link: the Hub cannot read usage from this environment.',
  refused: 'The app refused the Hub’s link token.',
  too_old: 'This app is older than 0.3.215 and does not report usage yet.',
  unreachable: 'The app did not answer the last read.',
  failed: 'The last read failed.'
}

export default function HubUsage() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const qc = useQueryClient()
  const usage = useQuery({
    queryKey: insightKeys.usage(),
    queryFn: fetchUsage,
    staleTime: 5 * 60_000
  })
  const [params, setParams] = useSearchParams()
  const envParam = Number(params.get('env') ?? '')
  // Phones show the list or one environment; wider screens both (the list opens on production).
  const detailOpen = params.has('env')

  const list = useMemo(() => {
    const out: Array<{ app: AppUsage; env: EnvUsage }> = []
    for (const app of usage.data?.apps ?? [])
      for (const env of app.environments) out.push({ app, env })
    return out
  }, [usage.data])
  const picked =
    list.find((x) => x.env.environment_id === envParam) ??
    list.find((x) => x.env.production) ??
    list[0] ??
    null

  const collect = useMutation({
    mutationFn: async () => {
      await startCollect()
      const until = Date.now() + 3 * 60_000
      let s = await fetchCollect()
      while (s.status === 'running' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2500))
        s = await fetchCollect()
      }
      return s
    },
    onSuccess: (s) => {
      if (s.status === 'done')
        toast.success(
          `Read ${s.summary?.environments ?? 0} environment${s.summary?.environments === 1 ? '' : 's'}`
        )
      else if (s.status === 'running') toast('Still reading — the page updates when it ends')
      else toast.error('The read did not finish — try again in a few minutes')
      void qc.invalidateQueries({ queryKey: insightKeys.all })
    },
    onError: (e) => toastError(e, 'Could not read usage now')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col bg-slate-50 dark:bg-background'>
      <HubToolbar
        description={
          <>
            <ShieldCheck className='mr-1 inline h-3.5 w-3.5 align-[-2px]' aria-hidden />
            How many people use each app: counts only, rounded down to 5
            {usage.data ? `, and nothing under ${usage.data.floor} people is shown.` : '.'}
          </>
        }
        actions={
          <>
            <Link
              to='/docs?section=hub-insight'
              className='px-2 text-[12px] text-slate-500 hover:underline dark:text-muted-foreground'
            >
              How this works
            </Link>
            {isAdmin && (
              <button
                type='button'
                className={ghostButton}
                disabled={collect.isPending}
                onClick={() => collect.mutate()}
              >
                <RefreshCw
                  className={cn('h-3.5 w-3.5', collect.isPending && 'animate-spin')}
                  aria-hidden
                />
                Read now
              </button>
            )}
          </>
        }
      />

      {usage.isPending ? (
        <div className='space-y-2 p-4'>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className='h-14 w-full' />
          ))}
        </div>
      ) : usage.isError ? (
        <div className='p-4'>
          <QueryErrorState error={usage.error} what='usage' onRetry={() => void usage.refetch()} />
        </div>
      ) : list.length === 0 ? (
        <div className='p-4'>
          <div className='rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
            <p className='m-0 text-[13px] font-medium text-slate-900 dark:text-foreground'>
              No environments yet
            </p>
            <p className='m-0 mt-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Usage appears here the morning after an app is added (the Hub reads it daily).
            </p>
          </div>
        </div>
      ) : (
        <div className='flex flex-1 min-h-0 overflow-hidden'>
          <aside
            className={cn(listPaneClass, detailOpen ? 'hidden md:flex' : 'flex')}
            aria-label='Environments'
          >
            <ListPaneHeader label={countLabel(list.length, 'environment', 'environments')} />
            <ul className='m-0 list-none space-y-0.5 p-2'>
              {list.map(({ app, env }) => {
                const active = picked?.env.environment_id === env.environment_id
                return (
                  <li key={env.environment_id}>
                    <button
                      type='button'
                      aria-current={active ? 'true' : undefined}
                      onClick={() =>
                        setParams(
                          (p) => {
                            const out = new URLSearchParams(p)
                            out.set('env', String(env.environment_id))
                            return out
                          },
                          { replace: true }
                        )
                      }
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50',
                        active && 'bg-accent'
                      )}
                    >
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
                          {app.app_name}
                        </span>
                        <span className='flex items-center gap-1 text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {env.env_key}
                          <HubEnvTag envKey={env.env_key} />
                        </span>
                      </span>
                      <span
                        className='text-right text-[12px] tabular-nums text-slate-700 dark:text-slate-200'
                        data-tip={
                          env.people_7d == null
                            ? env.state === 'ok'
                              ? `Fewer than ${usage.data?.floor ?? 5} people`
                              : 'Not read yet'
                            : undefined
                        }
                      >
                        {env.people_7d ?? '—'}
                        <span className='block text-[10px] text-slate-400 dark:text-muted-foreground'>
                          7 days
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </aside>
          <main
            className={cn(
              'min-w-0 flex-1 overflow-y-auto',
              detailOpen ? 'block' : 'hidden md:block'
            )}
          >
            {detailOpen && (
              <div className='border-b border-slate-200 bg-white px-2 py-1.5 md:hidden dark:border-border dark:bg-card'>
                <button
                  type='button'
                  className={ghostButton}
                  onClick={() =>
                    setParams(
                      (p) => {
                        const out = new URLSearchParams(p)
                        out.delete('env')
                        return out
                      },
                      { replace: true }
                    )
                  }
                >
                  <ChevronLeft className='h-3.5 w-3.5' aria-hidden /> All environments
                </button>
              </div>
            )}
            {picked && <EnvDetail app={picked.app} env={picked.env} floor={usage.data.floor} />}
          </main>
        </div>
      )}
    </div>
  )
}

function EnvDetail({ app, env, floor }: { app: AppUsage; env: EnvUsage; floor: number }) {
  const max = Math.max(1, ...env.daily.map((d) => d.people ?? 0))
  const under = `fewer than ${floor}`
  const fig = (n: number | null) => (n == null ? under : String(n))
  return (
    <div className='space-y-4 p-4'>
      <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1'>
        <h2 className='m-0 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          {app.app_name} <span className='text-slate-400'>/</span> {env.env_key}
        </h2>
        <p className='m-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
          {env.collected_at ? `Read ${formatRelative(env.collected_at)}` : 'Not read yet'}
        </p>
      </div>
      {env.state && env.state !== 'ok' && STATE_COPY[env.state] && (
        <p className='m-0 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200'>
          {STATE_COPY[env.state]} The figures below are from the last good read.
        </p>
      )}

      <dl className='m-0 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
        <Meta
          label='People, last 7 days'
          value={env.people_7d == null ? under : String(env.people_7d)}
        />
        <Meta label='People with an account' value={fig(env.accounts)} />
        <Meta
          label='Adoption'
          value={env.adoption == null ? '—' : `${Math.round(env.adoption * 100)} %`}
          hint='People active in the last 7 days ÷ people with an account'
        />
        <Meta
          label='Screens held back'
          value={env.screens_hidden == null ? '—' : String(env.screens_hidden)}
          hint={`Screens fewer than ${floor} people opened are never listed`}
        />
      </dl>

      <section className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
        <h3 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          Different people per day
        </h3>
        <p className='m-0 mt-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Completed days only, rounded down to 5 — today is counted tomorrow.
        </p>
        {env.daily.length === 0 ? (
          <p className='m-0 mt-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No days read yet.
          </p>
        ) : (
          <>
            <div
              className='mt-3 flex h-[120px] items-end gap-px'
              role='img'
              aria-label={`Different people per day over ${env.daily.length} days, at most ${max}`}
            >
              {env.daily.map((d) => (
                <div
                  key={d.day}
                  className='flex h-full min-w-[2px] flex-1 items-end'
                  data-tip={`${d.day ? formatDate(d.day) : ''}: ${d.under_floor ? under : `${d.people ?? 0} people`}`}
                >
                  {d.under_floor ? (
                    <div className='h-[3px] w-full rounded-sm bg-slate-300 dark:bg-slate-600' />
                  ) : (
                    <div
                      className='w-full rounded-t-sm bg-nvr-cyan/80'
                      style={{ height: `${Math.max(2, ((d.people ?? 0) / max) * 100)}%` }}
                    />
                  )}
                </div>
              ))}
            </div>
            <div className='mt-1 flex justify-between text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
              <span>{env.daily[0]?.day ? formatDate(env.daily[0].day) : null}</span>
              <span>
                {env.daily.at(-1)?.day ? formatDate(env.daily.at(-1)?.day as string) : null}
              </span>
            </div>
            <p className='m-0 mt-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
              Grey marks are days with {under} people: the app never sends their figures.
            </p>
          </>
        )}
      </section>

      <div className='grid gap-4 lg:grid-cols-2'>
        <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <h3 className='m-0 border-b border-slate-200 px-4 py-2.5 text-[13px] font-semibold text-slate-900 dark:border-border dark:text-foreground'>
            Average people per day, by week
          </h3>
          <table className='w-full border-collapse text-[12px]'>
            <thead>
              <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
                <th className='px-4 py-1.5 font-medium'>Week of</th>
                <th className='px-4 py-1.5 text-right font-medium'>People / day</th>
              </tr>
            </thead>
            <tbody>
              {[...env.weekly]
                .reverse()
                .slice(0, 12)
                .map((w) => (
                  <tr key={w.week} className='border-t border-slate-100 dark:border-border'>
                    <td className='px-4 py-1.5 tabular-nums text-slate-700 dark:text-slate-200'>
                      {w.week}
                    </td>
                    <td className='px-4 py-1.5 text-right tabular-nums text-slate-900 dark:text-foreground'>
                      {w.avg_people == null ? under : w.avg_people}
                    </td>
                  </tr>
                ))}
              {env.weekly.length === 0 && (
                <tr>
                  <td colSpan={2} className='px-4 py-4 text-slate-500 dark:text-muted-foreground'>
                    No weeks yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
        <section className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <h3 className='m-0 border-b border-slate-200 px-4 py-2.5 text-[13px] font-semibold text-slate-900 dark:border-border dark:text-foreground'>
            Busiest screens{env.period_days ? `, last ${env.period_days} days` : ''}
          </h3>
          <table className='w-full border-collapse text-[12px]'>
            <thead>
              <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
                <th className='px-4 py-1.5 font-medium'>Screen</th>
                <th className='px-4 py-1.5 text-right font-medium'>People</th>
                <th className='px-4 py-1.5 text-right font-medium'>Views</th>
              </tr>
            </thead>
            <tbody>
              {env.screens.map((s) => (
                <tr key={s.route} className='border-t border-slate-100 dark:border-border'>
                  <td
                    className='max-w-[280px] truncate px-4 py-1.5 font-mono text-[11px] text-slate-700 dark:text-slate-200'
                    data-tip={s.route}
                  >
                    {s.route}
                  </td>
                  <td className='px-4 py-1.5 text-right tabular-nums text-slate-900 dark:text-foreground'>
                    {s.people}
                  </td>
                  <td className='px-4 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300'>
                    {s.views}
                  </td>
                </tr>
              ))}
              {env.screens.length === 0 && (
                <tr>
                  <td colSpan={3} className='px-4 py-4 text-slate-500 dark:text-muted-foreground'>
                    No screen had {floor} or more people yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}

function Meta({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground' data-tip={hint}>
        {label}
      </dt>
      <dd className='m-0 mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {value}
      </dd>
    </div>
  )
}
