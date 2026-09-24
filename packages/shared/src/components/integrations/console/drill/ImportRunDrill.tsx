import { useQuery } from '@tanstack/react-query'
import { ExternalLink, FileSpreadsheet } from 'lucide-react'
import type { ReactNode } from 'react'
import { useNavigation, useNivaroClient } from '../../../../context'
import { get } from '../../../../lib/commands'
import { cn, formatDateTime, formatNumber } from '../../../../lib/utils'
import { formatDuration, type ImportRun, runnerName } from '../../../imports/types'
import { TONE_SOFT, TONE_TEXT } from '../tone'
import { pretty } from './json'

const STATUS: Record<
  string,
  { label: string; tone: 'negative' | 'positive' | 'warning' | 'neutral' }
> = {
  error: { label: 'Failed', tone: 'negative' },
  completed: { label: 'Completed', tone: 'positive' },
  running: { label: 'Running', tone: 'warning' },
  queued: { label: 'Queued', tone: 'neutral' },
  canceled: { label: 'Canceled', tone: 'neutral' }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[11.5px] text-muted-foreground'>{label}</dt>
      <dd className='truncate text-[12.5px] tabular-nums text-foreground'>{children}</dd>
    </div>
  )
}

/**
 * One staged import run, opened in place under its Firefight row: status,
 * timings, rows, the file, and the run's whole log — what the Import Console's
 * run sheet shows, without leaving the problem list.
 */
export function ImportRunDrill({ id }: { id: number }) {
  const client = useNivaroClient()
  const nav = useNavigation()
  // Same key and shape as the Import Console's run sheet, so the two share a cache.
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['staged-import-run', id],
    queryFn: () => client.request(get<{ data: ImportRun }>(`/staged-imports/${id}`)),
    staleTime: 15_000
  })
  const run = data?.data

  if (isLoading) {
    return (
      <div className='space-y-2.5' aria-busy>
        {[64, 88, 50].map((w) => (
          <div
            key={w}
            className='h-3 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
            style={{ width: `${w}%` }}
          />
        ))}
        <div className='h-20 animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  }
  if (isError || !run) {
    const msg =
      (error as { response?: { error?: string } })?.response?.error ??
      (error instanceof Error ? error.message : null)
    return (
      <p className={cn('rounded-md px-3 py-2 text-[12px]', TONE_SOFT.negative, TONE_TEXT.negative)}>
        Couldn't load this import run{msg ? ` · ${msg}` : ''}.
      </p>
    )
  }

  const st = STATUS[run.status] ?? { label: run.status, tone: 'neutral' as const }
  const importsUrl = nav.consoleUrl ? nav.consoleUrl('/imports') : '/imports'
  const log = pretty(run.logs)
  return (
    <div className='space-y-4' data-ic-drill={`import_run:${run.id}`}>
      <div
        data-ic-drill-section='summary'
        className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'
      >
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[11px] font-semibold',
            TONE_SOFT[st.tone],
            TONE_TEXT[st.tone]
          )}
        >
          {st.label}
        </span>
        <span className='font-semibold text-foreground'>
          {run.definition_label?.trim() || run.import_key}
        </span>
        <span className='font-mono text-[11.5px]'>run #{run.id}</span>
      </div>

      <dl
        data-ic-drill-section='facts'
        className='grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-6 gap-y-2'
      >
        <Fact label='Started'>{run.started_at ? formatDateTime(run.started_at) : '—'}</Fact>
        <Fact label='Finished'>{run.finished_at ? formatDateTime(run.finished_at) : '—'}</Fact>
        <Fact label='Duration'>{formatDuration(run.duration)}</Fact>
        <Fact label='Rows'>{run.row_count == null ? '—' : formatNumber(run.row_count)}</Fact>
        <Fact label='Queued by'>{runnerName(run) ?? '—'}</Fact>
        <Fact label='File'>
          {run.file_name || run.file ? (
            <span className='inline-flex min-w-0 max-w-full items-center gap-1.5'>
              <FileSpreadsheet className='h-3.5 w-3.5 shrink-0 text-muted-foreground' aria-hidden />
              <span
                className='truncate font-mono text-[11.5px]'
                data-tip={run.file_name ?? undefined}
              >
                {run.file_name ?? run.file}
              </span>
            </span>
          ) : (
            'No file'
          )}
        </Fact>
      </dl>

      <section data-ic-drill-section='log' className='min-w-0'>
        <h4 className='mb-1.5 text-[12px] font-semibold text-foreground'>Run log</h4>
        {log ? (
          <pre
            className={cn(
              'max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2.5 font-mono text-[11.5px] leading-relaxed',
              run.status === 'error'
                ? cn('border-transparent', TONE_SOFT.negative, TONE_TEXT.negative)
                : 'border-border bg-muted/40 text-foreground'
            )}
          >
            {log}
          </pre>
        ) : (
          <p className='text-[12px] text-muted-foreground'>
            {run.status === 'completed' ? 'Completed with nothing to report.' : 'Nothing logged.'}
          </p>
        )}
      </section>

      {importsUrl && (
        <div data-ic-drill-section='actions' className='border-t border-border pt-3'>
          <button
            type='button'
            data-ic-drill-imports
            onClick={() =>
              /^https?:/.test(importsUrl)
                ? window.open(importsUrl, '_blank', 'noopener')
                : nav.navigate(importsUrl)
            }
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            Open in the Import Console
            <ExternalLink className='h-3 w-3 opacity-60' aria-hidden />
          </button>
        </div>
      )}
    </div>
  )
}
