import { Download, FileClock, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useApiFetchConfig, useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn, formatNumber } from '../../../lib/utils'
import { Popover, PopoverContent } from '../../ui/popover'
import { Skeleton } from '../../ui/skeleton'
import { btnQuiet, btnSolid } from '../bulk/BulkRun'
import { effectText, inputBase, labelText, tintCard } from '../panel-style'
import { Segmented } from '../settings/controls'
import { ToolButton } from '../toolbar-kit'
import { apiFailure } from './overview-api'

// The layout change log (#2719): every layout change in a period, across this
// collection's forms or every form, as a CSV for auditors — who, when, the
// note and what each change did. The client side of GET /collection-layouts/change-log.

type Period = '30' | '90' | 'year' | 'custom'
type Scope = 'collection' | 'all'

interface ChangeLogRow {
  at: string
  collection: string
  layout_id: number
  layout: string
  who: string
  note: string | null
  summary: string
}

const day = (d: Date) => d.toISOString().slice(0, 10)

/** The period as the API reads it: whole UTC days, both included. */
export function periodRange(
  period: Period,
  custom: { from: string; to: string },
  now = new Date()
) {
  const to = day(now)
  if (period === 'custom') return { from: custom.from, to: custom.to }
  if (period === 'year') return { from: `${to.slice(0, 4)}-01-01`, to }
  const days = Number(period)
  return { from: day(new Date(now.getTime() - (days - 1) * 86_400_000)), to }
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${formatNumber(n)} ${n === 1 ? one : many}`

function when(iso: string) {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function ChangeLogPanel({ collection }: { collection: string }) {
  const client = useNivaroClient()
  const fetchCfg = useApiFetchConfig()
  const [period, setPeriod] = useState<Period>('30')
  const [scope, setScope] = useState<Scope>('collection')
  const [custom, setCustom] = useState(() => periodRange('30', { from: '', to: '' }))
  const [busy, setBusy] = useState<'preview' | 'download' | null>(null)
  const [log, setLog] = useState<{ rows: ChangeLogRow[]; truncated: boolean } | null>(null)
  const range = periodRange(period, custom)
  const badRange = !range.from || !range.to || range.from > range.to
  const query = {
    from: range.from,
    to: range.to,
    ...(scope === 'collection' ? { collection } : {})
  }
  const queryKey = JSON.stringify(query)

  // A different period or scope: the counts no longer describe it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the query's content
  useEffect(() => setLog(null), [queryKey])

  const runPreview = async () => {
    setBusy('preview')
    try {
      const res = await client.request<{ data: { rows: ChangeLogRow[]; truncated: boolean } }>(
        get('/collection-layouts/change-log', query)
      )
      setLog(res?.data ?? { rows: [], truncated: false })
    } catch (err) {
      toast.error(apiFailure(err, 'The change log could not be read').message)
    } finally {
      setBusy(null)
    }
  }

  const download = async () => {
    setBusy('download')
    try {
      const qs = new URLSearchParams({ ...query, format: 'csv' })
      const resp = await fetch(`${fetchCfg.apiBase}/collection-layouts/change-log?${qs}`, {
        headers: fetchCfg.authHeaders,
        credentials: fetchCfg.credentials
      })
      if (!resp.ok) throw new Error(String(resp.status))
      const blob = await resp.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `layout-changes-${scope === 'collection' ? collection : 'all'}-${range.from}-to-${range.to}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch {
      toast.error('The CSV could not be downloaded')
    } finally {
      setBusy(null)
    }
  }

  const people = log ? new Set(log.rows.map((r) => r.who)).size : 0
  const forms = log ? new Set(log.rows.map((r) => r.layout_id)).size : 0

  return (
    <div className='space-y-3'>
      <div className='space-y-1'>
        <span className={labelText}>Period</span>
        <Segmented<Period>
          ariaLabel='Period'
          value={period}
          onChange={setPeriod}
          options={[
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
            { value: 'year', label: 'This year' },
            { value: 'custom', label: 'Dates' }
          ]}
        />
      </div>
      {period === 'custom' && (
        <div className='grid grid-cols-2 gap-2'>
          <label className='block space-y-1'>
            <span className={effectText}>From</span>
            <input
              type='date'
              className={inputBase}
              value={custom.from}
              max={custom.to || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
            />
          </label>
          <label className='block space-y-1'>
            <span className={effectText}>To</span>
            <input
              type='date'
              className={inputBase}
              value={custom.to}
              min={custom.from || undefined}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
            />
          </label>
        </div>
      )}
      <div className='space-y-1'>
        <span className={labelText}>Forms</span>
        <Segmented<Scope>
          ariaLabel='Which forms'
          value={scope}
          onChange={setScope}
          options={[
            { value: 'collection', label: 'This collection' },
            { value: 'all', label: 'Every collection' }
          ]}
        />
      </div>
      {badRange && (
        <p className='text-[12px] text-amber-700 dark:text-amber-300'>
          Pick a start date on or before the end date.
        </p>
      )}
      <div className='flex flex-wrap gap-1.5'>
        <button
          type='button'
          data-change-log-preview=''
          className={btnQuiet}
          disabled={badRange || busy !== null}
          onClick={() => void runPreview()}
        >
          {busy === 'preview' && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
          {log ? 'Count again' : 'Count changes'}
        </button>
        <button
          type='button'
          data-change-log-download=''
          className={btnSolid}
          disabled={badRange || busy !== null}
          onClick={() => void download()}
        >
          {busy === 'download' ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Download className='h-3.5 w-3.5' />
          )}
          Download CSV
        </button>
      </div>
      {busy === 'preview' && !log && (
        <div className='space-y-2' aria-hidden>
          <Skeleton className='h-3 w-1/2' />
          <Skeleton className='h-3 w-2/3' />
        </div>
      )}
      {log && (
        <div data-change-log-summary='' className={cn(tintCard, 'space-y-2 p-2.5')}>
          <p className='text-[12.5px] text-slate-800 dark:text-foreground'>
            {log.rows.length === 0
              ? 'No layout changes in this period.'
              : `${plural(log.rows.length, 'change')} to ${plural(forms, 'form')} by ${plural(people, 'person', 'people')}${log.truncated ? ' (stopped at the cap: pick a shorter period)' : ''}.`}
          </p>
          {log.rows.length > 0 && (
            <ul className='space-y-1.5'>
              {log.rows
                .slice(-4)
                .reverse()
                .map((r) => (
                  <li key={`${r.layout_id}-${r.at}`} className='text-[12px] leading-snug'>
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {r.layout}
                    </span>
                    <span className='text-slate-500 dark:text-muted-foreground'>
                      {' '}
                      · {when(r.at)} · {r.who}
                    </span>
                    <span className='block truncate text-slate-600 dark:text-muted-foreground'>
                      {r.note ? `${r.note} — ` : ''}
                      {r.summary}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
      <p className={effectText}>
        One row per saved change: who, when, the note and what it did. History keeps the newest 30
        versions of each form plus every named one, so older changes may be missing.
      </p>
    </div>
  )
}

/** The overview's "More" entry: the change log export in an anchored popover. */
export function ChangeLogButton({ collection }: { collection: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ToolButton
        popover
        onOpen={() => setOpen(true)}
        label='Change log'
        icon={<FileClock className='h-3.5 w-3.5' />}
        tip='Every layout change in a period, as a CSV for auditors'
        hint='Every change in a period, as CSV'
        data={{ 'data-change-log-button': '' }}
      />
      <PopoverContent
        align='end'
        data-change-log-panel=''
        className='w-[400px] max-w-[calc(100vw-24px)] p-0'
      >
        {open && (
          <div className='space-y-3 p-4'>
            <div>
              <h3 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                Layout change log
              </h3>
              <p className={effectText}>Every saved change to the forms, for an audit trail.</p>
            </div>
            <ChangeLogPanel collection={collection} />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
