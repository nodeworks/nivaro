import { useQuery } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ActivityTrailStrip } from '@/components/activity-trail-strip'
import { HubToolbar } from '@/components/hub-page'
import { api } from '@/lib/api'
import { formatDate, formatDateTime, formatNumber, formatRelative } from '@/lib/utils'

/**
 * Security & privacy → Log retention (#16/#17): the tamper-evident activity trail (status,
 * checks, evidence export) and every log Nivaro keeps — how long, where that is set, size,
 * oldest entry, next purge. GET /api/log-retention, /api/activity-trail/*.
 */

interface Entry {
  key: string
  label: string
  what: string
  table: string | null
  keep: string
  setting: string
  rows: number | null
  oldest_at: string | null
  purge: { how: string; next_run_at: string | null; last_run_at: string | null }
  legal_holds: boolean
  present: boolean
}

interface Inventory {
  entries: Entry[]
  retention_pass: {
    last_run_at: string | null
    next_run_at: string | null
    last_result: { activity_deleted: number; activity_bridged: number; error?: string } | null
  }
  cloud: boolean
}

const SKELETON_ROWS = ['s1', 's2', 's3', 's4', 's5', 's6']

const today = () => new Date().toISOString().slice(0, 10)
const monthAgo = () => new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)

function EvidenceExport() {
  const [from, setFrom] = useState(monthAgo)
  const [to, setTo] = useState(today)
  const [busy, setBusy] = useState(false)

  const download = async () => {
    setBusy(true)
    try {
      const res = await api.get('/activity/evidence', {
        params: { from, to },
        responseType: 'blob'
      })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `activity-evidence_${from}_${to}.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      toast.success('Evidence bundle downloaded')
    } catch (e) {
      const blob = (e as { response?: { data?: Blob } }).response?.data
      let msg = 'Could not build the evidence bundle'
      if (blob && typeof blob.text === 'function') {
        try {
          msg = (JSON.parse(await blob.text()) as { error?: string }).error ?? msg
        } catch {
          /* not JSON */
        }
      }
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className='rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
        Evidence export
      </p>
      <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400'>
        A zip an auditor can check without Nivaro: every activity entry in the window with its seal,
        a manifest with the chain heads and a fresh verification, and a summary page. Exports are
        logged.
      </p>
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <label className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
          From
          <input
            type='date'
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className='h-8 rounded-md border border-slate-200 bg-background px-2 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
          />
        </label>
        <label className='flex items-center gap-1.5 text-[12px] text-slate-500 dark:text-slate-400'>
          To
          <input
            type='date'
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            className='h-8 rounded-md border border-slate-200 bg-background px-2 text-[12.5px] text-slate-800 dark:border-border dark:text-foreground'
          />
        </label>
        <button
          type='button'
          onClick={() => void download()}
          disabled={busy || !from || !to}
          className='inline-flex h-8 items-center gap-1.5 rounded-md bg-nvr-cyan px-3 text-[12px] font-medium text-white disabled:opacity-50'
        >
          <Download className='size-3.5' aria-hidden />
          {busy ? 'Building…' : 'Download bundle'}
        </button>
      </div>
    </div>
  )
}

/** A future time as "in 3h" (formatRelative only reads the past). */
function when(iso: string | null): string {
  if (!iso) return '—'
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60_000)
  if (!Number.isFinite(mins) || mins <= 0) return formatRelative(iso)
  if (mins < 60) return `in ${mins}m`
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)}h`
  return formatDateTime(iso)
}

export default function LogRetention() {
  const { data, isLoading } = useQuery<Inventory>({
    queryKey: ['log-retention'],
    queryFn: () => api.get('/log-retention').then((r) => r.data.data)
  })
  const pass = data?.retention_pass

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Every log this instance keeps, how long, and where that is set — and the tamper-evident activity trail.' />

      <div className='flex-1 space-y-4 overflow-y-auto p-4 sm:p-6'>
        <ActivityTrailStrip full />
        <EvidenceExport />

        <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-200 px-4 py-3 dark:border-border'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>Logs</p>
            {pass && (
              <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
                Daily retention pass on this process:{' '}
                {pass.last_run_at ? `last ${formatRelative(pass.last_run_at)}` : 'not run yet'}
                {pass.next_run_at && ` · next ${when(pass.next_run_at)}`}
                {pass.last_result &&
                  ` · ${formatNumber(pass.last_result.activity_deleted)} activity entries purged`}
                {pass.last_result?.error && ` · last error: ${pass.last_result.error}`}
              </p>
            )}
            <p className='ml-auto text-[11.5px] text-slate-500 dark:text-slate-400'>
              Records under a{' '}
              <Link to='/security-center/holds' className='underline underline-offset-2'>
                legal hold
              </Link>{' '}
              keep their history in every purge marked “Holds”.
            </p>
          </div>
          <div className='overflow-x-auto'>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 text-left text-[11px] uppercase tracking-wide text-slate-500 dark:border-border dark:text-slate-400'>
                  <th className='px-4 py-2 font-medium'>Log</th>
                  <th className='px-3 py-2 font-medium'>Kept</th>
                  <th className='px-3 py-2 font-medium'>Set in</th>
                  <th className='px-3 py-2 text-right font-medium'>Rows</th>
                  <th className='px-3 py-2 font-medium'>Oldest</th>
                  <th className='px-3 py-2 font-medium'>Purge</th>
                </tr>
              </thead>
              <tbody>
                {isLoading &&
                  SKELETON_ROWS.map((k) => (
                    <tr key={k} className='border-b border-slate-100 dark:border-border'>
                      <td colSpan={6} className='px-4 py-2.5'>
                        <div className='h-4 animate-pulse rounded bg-[var(--nvr-skeleton)]' />
                      </td>
                    </tr>
                  ))}
                {data?.entries.map((e) => (
                  <tr
                    key={e.key}
                    className='border-b border-slate-100 align-top last:border-0 hover:bg-muted dark:border-border'
                  >
                    <td className='px-4 py-2'>
                      <p className='font-medium text-slate-800 dark:text-foreground'>
                        {e.label}
                        {e.legal_holds && (
                          <span className='ml-1.5 rounded bg-nvr-cyan/10 px-1.5 py-px text-[10.5px] font-medium text-slate-700 dark:text-slate-200'>
                            Holds
                          </span>
                        )}
                        {!e.present && (
                          <span className='ml-1.5 text-[10.5px] font-normal text-slate-400'>
                            not on this database
                          </span>
                        )}
                      </p>
                      <p className='max-w-[360px] text-[11.5px] text-slate-500 dark:text-slate-400'>
                        {e.what}
                      </p>
                      {e.table && (
                        <p className='font-mono text-[10.5px] text-slate-400'>{e.table}</p>
                      )}
                    </td>
                    <td className='px-3 py-2 text-slate-700 dark:text-slate-200'>{e.keep}</td>
                    <td className='max-w-[260px] px-3 py-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                      {e.setting}
                    </td>
                    <td className='px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200'>
                      {e.rows == null ? '—' : formatNumber(e.rows)}
                    </td>
                    <td className='whitespace-nowrap px-3 py-2 text-slate-600 dark:text-slate-300'>
                      {e.oldest_at ? (
                        <span data-tip={formatDateTime(e.oldest_at)}>
                          {formatDate(e.oldest_at)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className='max-w-[240px] px-3 py-2 text-[11.5px] text-slate-500 dark:text-slate-400'>
                      {e.purge.how}
                      {e.purge.next_run_at && (
                        <span className='block text-slate-700 dark:text-slate-200'>
                          Next {when(e.purge.next_run_at)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {data?.cloud && (
          <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
            Hosted instances: retention runs per tenant on the platform's schedule.
          </p>
        )}
      </div>
    </div>
  )
}
