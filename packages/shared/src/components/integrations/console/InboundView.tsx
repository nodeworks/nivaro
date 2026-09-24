import { type ReactNode, useState } from 'react'
import { cn } from '../../../lib/utils'
import {
  ImportDefaultCadenceControl,
  type ImportHealthRow,
  ImportStalenessControl,
  useImportHealth
} from '../../imports/ImportStalenessControl'
import { InboundCallersView } from '../../monitoring/ApiRequestLog'
import { agoText, exactTime, TONE_SOFT, TONE_TEXT, type Tone } from './tone'

const RUN_STATUS: Record<string, { word: string; tone: Tone }> = {
  completed: { word: 'Completed', tone: 'positive' },
  error: { word: 'Failed', tone: 'negative' },
  running: { word: 'Running', tone: 'info' },
  queued: { word: 'Queued', tone: 'neutral' },
  canceled: { word: 'Canceled', tone: 'neutral' }
}

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full px-2 py-px text-[11.5px] font-medium',
        TONE_SOFT[tone],
        tone === 'neutral' ? 'text-muted-foreground' : TONE_TEXT[tone]
      )}
    >
      {children}
    </span>
  )
}

function ImportRow({ row }: { row: ImportHealthRow }) {
  const status = row.last_status ? RUN_STATUS[row.last_status] : null
  const excluded = row.cadence_source === 'excluded'
  return (
    <tr data-ic-import={row.key} className='border-t border-border align-middle'>
      <td className='py-2.5 pl-4 pr-3'>
        <p className='truncate text-[13px] font-medium text-foreground'>{row.label || row.key}</p>
        <p className='truncate font-mono text-[11px] text-muted-foreground'>{row.key}</p>
      </td>
      <td className='px-3 py-2.5'>
        {row.last_run_at ? (
          <span className='flex items-center gap-2 whitespace-nowrap'>
            {status ? (
              <Chip tone={status.tone}>{status.word}</Chip>
            ) : (
              <Chip tone='neutral'>{row.last_status}</Chip>
            )}
            <span
              className='text-[12.5px] text-muted-foreground'
              data-tip={exactTime(row.last_run_at)}
            >
              {agoText(row.last_run_at)}
            </span>
          </span>
        ) : (
          <span className='text-[12.5px] text-muted-foreground'>Never run</span>
        )}
      </td>
      <td className='px-3 py-2.5'>
        <span className='flex items-center gap-2 whitespace-nowrap'>
          <span
            className={cn(
              'text-[12.5px]',
              row.last_ok_at ? 'text-foreground' : 'text-muted-foreground'
            )}
            data-tip={exactTime(row.last_ok_at) || undefined}
          >
            {row.last_ok_at ? agoText(row.last_ok_at) : 'Never'}
          </span>
          {excluded ? (
            <Chip tone='neutral'>Not monitored</Chip>
          ) : row.stale ? (
            <Chip tone='warning'>Stale</Chip>
          ) : null}
        </span>
      </td>
      <td className='px-3 py-2.5 text-right'>
        <span
          className={cn(
            'text-[12.5px] tabular-nums',
            row.failures7d > 0 ? cn('font-medium', TONE_TEXT.negative) : 'text-muted-foreground'
          )}
        >
          {row.failures7d}
        </span>
      </td>
      <td className='py-2.5 pl-3 pr-4'>
        <ImportStalenessControl importKey={row.key} label={row.label} compact />
      </td>
    </tr>
  )
}

/** last-run-failed, then stale, then dormant, then everything else — each
 *  group keeping definition order. Dormant and stale are mutually exclusive
 *  by construction (a dormant cadence never reads stale). */
const rank = (r: ImportHealthRow) =>
  r.last_status === 'error' ? 0 : r.stale ? 1 : r.cadence_source === 'dormant' ? 2 : 3
const isProblem = (r: ImportHealthRow) =>
  r.last_status === 'error' || r.stale || r.cadence_source === 'dormant'

function ImportsSection() {
  const { data, isLoading, isError } = useImportHealth()
  const [showAll, setShowAll] = useState(false)
  const allRows = (data?.rows ?? [])
    .filter((r) => r.is_active)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i)
    .map(({ r }) => r)
  const problemRows = allRows.filter(isProblem)
  const rows = showAll ? allRows : problemRows
  const stale = allRows.filter((r) => r.stale).length
  const dormant = allRows.filter((r) => r.cadence_source === 'dormant').length
  const excluded = allRows.filter((r) => r.cadence_source === 'excluded').length
  const failing = allRows.filter((r) => r.last_status === 'error').length

  const summary: string[] = [`${allRows.length} active import${allRows.length === 1 ? '' : 's'}`]
  if (stale) summary.push(`${stale} stale`)
  if (failing) summary.push(`${failing} last run failed`)
  if (dormant) summary.push(`${dormant} dormant`)
  if (excluded) summary.push(`${excluded} not monitored`)

  const toggle = allRows.length > 0 && (
    <button
      type='button'
      data-ic-imports-all
      onClick={() => setShowAll((v) => !v)}
      // Brand cyan text is too low-contrast on its own against either
      // theme's card surface — pair it with dark ink in light mode the way
      // the console's own active-tab label does, cyan only in dark mode.
      className='text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
    >
      {showAll ? 'Show only problems' : `Show all ${allRows.length} imports`}
    </button>
  )

  return (
    <section className='space-y-3' data-ic-imports>
      <div className='flex flex-wrap items-end justify-between gap-x-4 gap-y-2'>
        <div className='min-w-0'>
          <h2 className='text-[14px] font-semibold text-foreground'>Scheduled imports</h2>
          <p className='mt-0.5 max-w-[75ch] text-[12.5px] text-muted-foreground'>
            Whether each import is still arriving. One that has succeeded before turns stale when
            its newest success is older than expected — change that per import, or stop watching it.
          </p>
        </div>
        <ImportDefaultCadenceControl />
      </div>

      {isLoading ? (
        <div className='space-y-px overflow-hidden rounded-lg border border-border' aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className='h-[52px] animate-pulse bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : isError ? (
        <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>Couldn't load import health.</p>
      ) : allRows.length === 0 ? (
        <div className='rounded-lg border border-border bg-card px-5 py-6'>
          <p className='text-[14px] font-semibold text-foreground'>No active imports</p>
          <p className='mt-1 max-w-[70ch] text-[12.5px] text-muted-foreground'>
            Staged imports defined in the Import Console appear here once they are active, with
            their last run, last success and how often each one is expected to arrive.
          </p>
        </div>
      ) : !showAll && problemRows.length === 0 ? (
        <div className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-5 py-4'>
          <p className='text-[13px] text-foreground'>
            All {allRows.length} import{allRows.length === 1 ? '' : 's'} are running on time.
          </p>
          {toggle}
        </div>
      ) : (
        <>
          <div className='overflow-x-auto rounded-lg border border-border bg-card'>
            <table className='w-full min-w-[720px] border-collapse text-left'>
              <caption className='caption-top px-4 pb-2 pt-3 text-left text-[12px] text-muted-foreground'>
                {summary.join(' · ')}
                {!showAll && ' · showing problems only'}
              </caption>
              <thead>
                <tr className='text-[11.5px] text-muted-foreground'>
                  <th scope='col' className='py-2 pl-4 pr-3 font-medium'>
                    Import
                  </th>
                  <th scope='col' className='px-3 py-2 font-medium'>
                    Last run
                  </th>
                  <th scope='col' className='px-3 py-2 font-medium'>
                    Last success
                  </th>
                  <th scope='col' className='px-3 py-2 text-right font-medium'>
                    Failures, 7 days
                  </th>
                  <th scope='col' className='py-2 pl-3 pr-4 font-medium'>
                    Stale after
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <ImportRow key={r.key} row={r} />
                ))}
              </tbody>
            </table>
          </div>
          <div className='flex justify-end'>{toggle}</div>
        </>
      )}
    </section>
  )
}

export interface InboundViewProps {
  /** Host content rendered after the shared sections (a deployment's own queues). */
  extra?: ReactNode
}

/**
 * Inbound: health first — the host's own live queue (e.g. MWF), then whether
 * scheduled imports are arriving on time — and investigation last, since who
 * called in and exactly what they sent is what you reach for once something
 * above already looks wrong, not on every visit.
 */
export function InboundView({ extra }: InboundViewProps) {
  return (
    <div className='space-y-8' data-ic-inbound>
      {extra}
      <ImportsSection />
      <InboundCallersView />
    </div>
  )
}
