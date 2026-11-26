import { QueryErrorState, toastError } from '@nivaro/shared'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import {
  type AuditCategory,
  type AuditQuery,
  CATEGORY_LABEL,
  downloadAuditCsv,
  fetchAudit,
  fetchFleet,
  fleetKeys,
  RESULT_LABEL
} from './fleet-api'

/**
 * Audit (Apps hub tab, admins): every Hub action newest first — promotions, rollbacks, moves,
 * stack changes, key rotations, shared upgrades, app creation, sign-in client changes and other
 * settings — with who, when, what, the result of a run and the reason given. Filters live in the
 * URL (app, environment, person, action, from, to, page) so a filtered view can be shared; CSV
 * exports the same filter.
 */

const PAGE = 50

const RESULT_TONE: Record<string, string> = {
  success: 'text-emerald-700 dark:text-emerald-300',
  done: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-red-700 dark:text-red-300',
  interrupted: 'text-amber-800 dark:text-amber-300',
  cancelled: 'text-slate-500 dark:text-muted-foreground',
  rolled_back: 'text-amber-800 dark:text-amber-300',
  running: 'text-sky-700 dark:text-sky-300'
}

export default function HubAudit() {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const [params, setParams] = useSearchParams()
  const get = (k: string) => params.get(k) ?? ''
  const page = Math.max(0, Number(params.get('page')) || 0)
  const query: AuditQuery = {
    app: get('app'),
    environment: get('environment'),
    user: get('user'),
    action: get('action'),
    from: get('from'),
    to: get('to'),
    offset: page * PAGE,
    limit: PAGE
  }
  const set = (k: string, v: string) =>
    setParams(
      (p) => {
        const out = new URLSearchParams(p)
        if (v) out.set(k, v)
        else out.delete(k)
        if (k !== 'page') out.delete('page')
        if (k === 'app') out.delete('environment')
        return out
      },
      { replace: true }
    )

  const fleet = useQuery({ queryKey: fleetKeys.fleet(), queryFn: fetchFleet, enabled: isAdmin })
  const audit = useQuery({
    queryKey: fleetKeys.audit(query),
    queryFn: () => fetchAudit(query),
    enabled: isAdmin,
    placeholderData: keepPreviousData
  })

  const apps = useMemo(() => {
    const m = new Map<number, string>()
    for (const r of fleet.data?.rows ?? []) m.set(r.app_id, r.app_name)
    return [...m].sort((a, b) => a[1].localeCompare(b[1]))
  }, [fleet.data])
  const appNames = useMemo(
    () => new Map((fleet.data?.rows ?? []).map((r) => [r.app_id, r.app_name])),
    [fleet.data]
  )
  const envs = useMemo(
    () => (fleet.data?.rows ?? []).filter((r) => !query.app || String(r.app_id) === query.app),
    [fleet.data, query.app]
  )
  const [exporting, setExporting] = useState(false)

  if (!isAdmin)
    return (
      <p className='m-6 text-[13px] text-slate-500 dark:text-muted-foreground'>
        The Hub audit timeline is for administrators.
      </p>
    )

  const total = audit.data?.meta.total ?? 0
  const people = audit.data?.meta.people ?? []

  return (
    <div className='relative flex flex-1 min-h-0 flex-col overflow-y-auto bg-slate-50 dark:bg-background'>
      <div className='shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-2'>
          <SimpleSelect
            value={query.app ?? ''}
            onChange={(v) => set('app', v)}
            ariaLabel='App'
            className='h-8 w-[160px] text-[12px]'
            options={[
              { value: '', label: 'Every app' },
              ...apps.map(([id, n]) => ({ value: String(id), label: n }))
            ]}
          />
          <SimpleSelect
            value={query.environment ?? ''}
            onChange={(v) => set('environment', v)}
            ariaLabel='Environment'
            className='h-8 w-[190px] text-[12px]'
            options={[
              { value: '', label: 'Every environment' },
              ...envs.map((r) => ({
                value: String(r.environment_id),
                label: `${r.app_key}/${r.env_key}`
              }))
            ]}
          />
          <SimpleSelect
            value={query.user ?? ''}
            onChange={(v) => set('user', v)}
            ariaLabel='Person'
            className='h-8 w-[170px] text-[12px]'
            options={[
              { value: '', label: 'Anyone' },
              ...people.map((p) => ({ value: p.id, label: p.name }))
            ]}
          />
          <SimpleSelect
            value={query.action ?? ''}
            onChange={(v) => set('action', v)}
            ariaLabel='Action'
            className='h-8 w-[170px] text-[12px]'
            options={[
              { value: '', label: 'Every action' },
              ...(Object.keys(CATEGORY_LABEL) as AuditCategory[]).map((c) => ({
                value: c,
                label: CATEGORY_LABEL[c]
              }))
            ]}
          />
          <div className='flex items-center gap-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            From
            <Input
              aria-label='From'
              type='date'
              value={query.from ?? ''}
              onChange={(e) => set('from', e.target.value)}
              className='h-8 w-[140px] text-[12px]'
            />
          </div>
          <div className='flex items-center gap-1 text-[12px] text-slate-500 dark:text-muted-foreground'>
            To
            <Input
              aria-label='To'
              type='date'
              value={query.to ?? ''}
              onChange={(e) => set('to', e.target.value)}
              className='h-8 w-[140px] text-[12px]'
            />
          </div>
          <button
            type='button'
            className={cn(ghostButton, 'ml-auto')}
            disabled={exporting}
            onClick={async () => {
              setExporting(true)
              try {
                await downloadAuditCsv(query)
              } catch (e) {
                toastError(e, 'Could not export the audit')
              } finally {
                setExporting(false)
              }
            }}
          >
            <Download className='h-3.5 w-3.5' aria-hidden /> CSV
          </button>
        </div>
      </div>

      <div className='p-4'>
        {audit.isPending ? (
          <div className='space-y-2'>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-10 w-full' />
            ))}
          </div>
        ) : audit.isError ? (
          <QueryErrorState
            error={audit.error}
            what='the audit'
            onRetry={() => void audit.refetch()}
          />
        ) : (
          <>
            <p className='m-0 mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
              {total.toLocaleString()} Hub action{total === 1 ? '' : 's'}
            </p>
            {audit.data.meta.truncated && (
              <p className='m-0 mb-2 text-[12px] text-amber-800 dark:text-amber-300'>
                This window holds more than 5,000 Hub actions; only the newest are shown. Narrow the
                dates to see older ones.
              </p>
            )}
            <div className='overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
              <table className='w-full min-w-[560px] border-collapse text-[12px] sm:min-w-[860px]'>
                <thead>
                  <tr className='border-b border-slate-200 text-left text-[11px] text-slate-500 dark:border-border dark:text-muted-foreground'>
                    <th className='px-3 py-2 font-medium'>When</th>
                    <th className='px-3 py-2 font-medium'>What</th>
                    <th className='px-3 py-2 font-medium'>App / environment</th>
                    <th className='hidden px-3 py-2 font-medium sm:table-cell'>Who</th>
                    <th className='hidden px-3 py-2 font-medium sm:table-cell'>Result</th>
                    <th className='px-3 py-2 font-medium'>Reason / detail</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.data.map((r) => (
                    <tr
                      key={r.id}
                      className='border-b border-slate-100 align-top last:border-0 dark:border-border'
                    >
                      <td className='whitespace-nowrap px-3 py-2 tabular-nums text-slate-600 dark:text-muted-foreground'>
                        {r.at ? formatDateTime(r.at) : '—'}
                      </td>
                      <td className='px-3 py-2'>
                        <span className='font-medium text-slate-900 dark:text-foreground'>
                          {r.label}
                        </span>
                        {/* Phone: who and the result ride under the action. */}
                        <p className='m-0 text-[11px] text-slate-500 sm:hidden dark:text-muted-foreground'>
                          {r.user_name ?? '—'}
                          {r.result ? (
                            <span className={RESULT_TONE[r.result]}>
                              {' · '}
                              {RESULT_LABEL[r.result] ?? r.result}
                            </span>
                          ) : null}
                        </p>
                      </td>
                      <td className='px-3 py-2'>
                        {r.app_key ? (
                          <>
                            {(r.app_id != null && appNames.get(r.app_id)) || r.app_key}
                            {r.env_key ? (
                              <span className='text-slate-500'> / {r.env_key}</span>
                            ) : null}
                          </>
                        ) : (
                          <span className='text-slate-400'>—</span>
                        )}
                      </td>
                      <td className='hidden px-3 py-2 sm:table-cell'>{r.user_name ?? '—'}</td>
                      <td
                        className={cn(
                          'hidden px-3 py-2 sm:table-cell',
                          r.result ? RESULT_TONE[r.result] : ''
                        )}
                      >
                        {r.result ? (RESULT_LABEL[r.result] ?? r.result) : '—'}
                      </td>
                      <td className='max-w-[360px] px-3 py-2'>
                        {r.note && (
                          <p className='m-0 text-slate-800 dark:text-foreground'>“{r.note}”</p>
                        )}
                        {r.detail && (
                          <p className='m-0 break-words text-[11px] text-slate-500 dark:text-muted-foreground'>
                            {r.detail}
                          </p>
                        )}
                      </td>
                    </tr>
                  ))}
                  {audit.data.data.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className='px-3 py-8 text-center text-slate-500 dark:text-muted-foreground'
                      >
                        No Hub actions match these filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {total > PAGE && (
              <div className='mt-3 flex items-center gap-2 text-[12px] text-slate-500 dark:text-muted-foreground'>
                <button
                  type='button'
                  className={ghostButton}
                  disabled={page === 0}
                  onClick={() => set('page', String(page - 1))}
                >
                  Newer
                </button>
                <span className='tabular-nums'>
                  {page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}
                </span>
                <button
                  type='button'
                  className={ghostButton}
                  disabled={(page + 1) * PAGE >= total}
                  onClick={() => set('page', String(page + 1))}
                >
                  Older
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
