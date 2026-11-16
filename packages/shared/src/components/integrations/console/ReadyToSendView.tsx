import { CheckCircle2, Clock, Loader2, Play, RefreshCw } from 'lucide-react'
import { type MouseEvent, type ReactNode, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation } from '../../../context'
import { toastError } from '../../../lib/error-toast'
import { cn } from '../../../lib/utils'
import { QueryErrorState } from '../../QueryErrorState'
import { useCheckReadyRecord, useReadyBoard, useRunReadyCheck } from './api'
import { Segment } from './EventsView'
import { agoText, exactTime, TONE_BORDER, TONE_FILL, TONE_SOFT, TONE_TEXT, type Tone } from './tone'
import type { ReadyEntry, ReadyIssue, ReadySeverity } from './types'

export interface ReadyToSendViewProps {
  onOpenRecord?: (collection: string, id: string) => void
}

const SEVERITY: Record<ReadySeverity, { tone: Tone; label: string; short: string }> = {
  block: { tone: 'negative', label: 'Would be refused', short: 'Refused' },
  warn: { tone: 'warning', label: 'Would send incomplete', short: 'Incomplete' },
  ask: { tone: 'info', label: 'Asks for something when sent', short: 'Asks on send' }
}

type SeverityFilter = '' | ReadySeverity

/** Records drawn at a time; "Show more" adds the next page. */
const PAGE = 50

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** Pure: the entries a filter leaves (partner, problem key, severity). */
export function filterReadyEntries(
  entries: ReadyEntry[],
  f: { partner: string | null; problem: string | null; severity: SeverityFilter },
  problemKeyOf: (i: ReadyIssue) => string
): ReadyEntry[] {
  return entries.filter(
    (e) =>
      (!f.partner ||
        e.partners.includes(f.partner) ||
        e.issues.some((i) => i.partner === f.partner)) &&
      (!f.problem || e.issues.some((i) => problemKeyOf(i) === f.problem)) &&
      (!f.severity || e.worst === f.severity)
  )
}

/** Same key the server groups by: severity + the message with its line count folded. */
export const readyProblemKey = (i: Pick<ReadyIssue, 'severity' | 'message'>) =>
  `${i.severity}|${i.message.replace(/\bon \d+ lines?\b/, 'on some lines').trim()}`

/**
 * Integrations console → Ready to send (idea 37). Each night every open record whose next
 * manual step sends to a partner is checked the way its own Push readiness chip checks it;
 * this lists what a partner would refuse (or receive incomplete), by partner and by problem,
 * so it is fixed before someone presses the button.
 */
export function ReadyToSendView({ onOpenRecord }: ReadyToSendViewProps) {
  const board = useReadyBoard()
  const run = useRunReadyCheck()
  const [partner, setPartner] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [severity, setSeverity] = useState<SeverityFilter>('')
  const [limit, setLimit] = useState(PAGE)

  const data = board.data
  const entries = useMemo(() => data?.entries ?? [], [data])
  const shown = useMemo(
    () => filterReadyEntries(entries, { partner, problem, severity }, readyProblemKey),
    [entries, partner, problem, severity]
  )
  // A new filter starts the list from the top again.
  const filterKey = `${partner}|${problem}|${severity}`
  const [seenFilter, setSeenFilter] = useState(filterKey)
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey)
    setLimit(PAGE)
  }

  if (board.isLoading) {
    return (
      <div className='space-y-3' aria-busy data-ic-ready-loading>
        <div className='h-5 w-80 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        <div className='grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]'>
          <div className='h-48 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-72 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      </div>
    )
  }
  if (board.isError || !data) {
    return (
      <QueryErrorState
        error={board.error}
        what='the ready-to-send board'
        onRetry={() => board.refetch()}
      />
    )
  }

  const runNow = () =>
    run.mutate(undefined, {
      onSuccess: () =>
        toast.success('Checking every record that sends next. The board fills in when it is done.'),
      onError: (err) => toastError(err, 'Could not start the check')
    })
  const runButton = data.can_run ? (
    <button
      type='button'
      data-ic-ready-run
      disabled={run.isPending || data.running}
      onClick={runNow}
      className='inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
    >
      {run.isPending || data.running ? (
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
      ) : (
        <Play className='h-3.5 w-3.5' />
      )}
      {data.running ? 'Checking…' : 'Run now'}
    </button>
  ) : null

  if (!data.run) {
    return (
      <div className='space-y-4' data-ic-ready-empty>
        <SummaryRow runButton={runButton}>
          <span className='font-medium text-foreground'>
            {data.running ? 'The first check is running' : 'Not checked yet'}
          </span>
          {data.running && data.progress?.total
            ? ` · ${data.progress.checked} of ${data.progress.total} records so far`
            : ''}
        </SummaryRow>
        <div className='rounded-lg border border-border bg-card px-5 py-6'>
          <p className='max-w-[68ch] text-[12.5px] leading-relaxed text-muted-foreground'>
            Every night, each open record whose next step sends to a partner is checked the way its
            Push readiness check does: missing values, conditions, and what the partner needs. What
            would be refused shows up here, so it can be fixed before someone presses the button.
          </p>
        </div>
      </div>
    )
  }

  const totals = data.totals ?? { records: 0, refused: 0, warnings: 0, asks: 0 }
  const generated = data.run.generated_at
  const cov = data.coverage
  const filtering = !!(partner || problem || severity)
  // Records with a send next that are neither ready nor on this board: could not be checked,
  // or (for a reader with narrower access) not shown to them. Said, so the numbers add up.
  const notShown = cov ? Math.max(0, cov.checked - cov.ready - cov.errors - totals.records) : 0

  return (
    <div className='space-y-4' data-ic-ready>
      <SummaryRow runButton={runButton}>
        {totals.records === 0 ? (
          <span className='font-medium text-foreground'>Nothing in the way of the next sends</span>
        ) : (
          <>
            <Count n={totals.refused} tone='negative' /> would be refused
            {' · '}
            <Count n={totals.warnings} tone='warning' /> would send incomplete
            {' · '}
            <Count n={totals.asks} tone='info' /> ask for something when sent
          </>
        )}
        {' · '}
        <span data-tip={exactTime(generated)}>checked {agoText(generated)}</span>
        {cov && (
          <>
            {' · '}
            <span data-ic-ready-coverage>
              {plural(cov.checked, 'record')} with a send next
              {cov.ready > 0 ? `, ${cov.ready} ready` : ''}
              {cov.errors > 0 ? `, ${cov.errors} could not be checked` : ''}
              {notShown > 0 ? `, ${notShown} not shown to you` : ''}
            </span>
          </>
        )}
      </SummaryRow>

      {data.running && (
        <Banner
          tone='info'
          icon={<Loader2 className='mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin' />}
          data-ic-ready-running
        >
          A new check is running
          {data.progress?.total
            ? ` (${data.progress.checked} of ${data.progress.total} records so far)`
            : ''}
          . This board is from the last complete check and updates when it finishes.
          {data.progress?.total ? (
            <span
              className='mt-2 block h-1 w-full max-w-[320px] overflow-hidden rounded-full bg-black/10 dark:bg-white/15'
              role='progressbar'
              aria-label='Records checked'
              aria-valuemin={0}
              aria-valuemax={data.progress.total}
              aria-valuenow={data.progress.checked}
            >
              <span
                className='block h-full rounded-full bg-current transition-[width] duration-500'
                style={{
                  width: `${Math.min(100, Math.round((data.progress.checked / data.progress.total) * 100))}%`
                }}
              />
            </span>
          ) : null}
        </Banner>
      )}
      {!data.running && data.stopped_short && (
        <Banner
          tone='warning'
          icon={<Clock className='mt-0.5 h-3.5 w-3.5 shrink-0' />}
          data-ic-ready-stopped
        >
          The latest check stopped before it finished
          {data.stopped
            ? ` (at ${data.stopped.checked}${data.stopped.total != null ? ` of ${data.stopped.total}` : ''} records${data.stopped.at ? `, started ${agoText(data.stopped.at)}` : ''})`
            : ''}
          , so this board is from the last complete check. The next check starts from the beginning.
        </Banner>
      )}

      {totals.records === 0 ? (
        <div
          data-ic-ready-clear
          className='flex flex-col items-start gap-1 rounded-lg border border-border bg-card px-5 py-6'
        >
          <p className='flex items-center gap-2 text-[14px] font-semibold text-foreground'>
            <CheckCircle2 className={cn('h-4 w-4', TONE_TEXT.positive)} />
            Every record you can see is ready to send
          </p>
          <p className='text-[12.5px] text-muted-foreground'>
            Records whose next step sends to a partner show up here when something would stop or
            weaken that send.
          </p>
        </div>
      ) : (
        <div className='grid items-start gap-5 lg:grid-cols-[260px_minmax(0,1fr)]'>
          <aside className='space-y-5' aria-label='Group the board'>
            <RailSection title='Partner'>
              <RailButton
                on={!partner}
                onClick={() => setPartner(null)}
                label='All partners'
                count={totals.records}
              />
              {(data.partners ?? []).map((p) => (
                <RailButton
                  key={p.partner}
                  data-ic-ready-partner={p.partner}
                  on={partner === p.partner}
                  onClick={() => setPartner(partner === p.partner ? null : p.partner)}
                  label={p.partner}
                  count={p.records}
                  tone={p.refused > 0 ? 'negative' : p.warnings > 0 ? 'warning' : 'info'}
                  hint={[
                    p.refused ? `${p.refused} refused` : '',
                    p.warnings ? `${p.warnings} incomplete` : '',
                    p.asks ? `${p.asks} ask on send` : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              ))}
            </RailSection>
            <RailSection title='Problem'>
              {(data.problems ?? []).map((g) => (
                <RailButton
                  key={g.key}
                  data-ic-ready-problem={g.key}
                  on={problem === g.key}
                  onClick={() => setProblem(problem === g.key ? null : g.key)}
                  label={g.label}
                  count={g.records}
                  tone={SEVERITY[g.severity].tone}
                  hint={[
                    SEVERITY[g.severity].short,
                    g.lines > 0 ? plural(g.lines, 'line') : '',
                    g.partners.length && !partner ? g.partners.join(', ') : ''
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  wrap
                />
              ))}
            </RailSection>
          </aside>

          <section className='min-w-0 space-y-3' aria-label='Records'>
            <div className='flex flex-wrap items-center gap-2'>
              <Segment<SeverityFilter>
                label='Show'
                value={severity}
                onChange={setSeverity}
                options={[
                  ['', 'All'],
                  ['block', 'Refused'],
                  ['warn', 'Incomplete'],
                  ['ask', 'Asks on send']
                ]}
                data-ic-ready-severity
              />
              <span className='text-[12px] text-muted-foreground tabular-nums'>
                {plural(shown.length, 'send')}
                {filtering && ` of ${entries.length}`}
              </span>
              {filtering && (
                <button
                  type='button'
                  onClick={() => {
                    setPartner(null)
                    setProblem(null)
                    setSeverity('')
                  }}
                  className='rounded text-[12px] font-medium text-sky-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-nvr-cyan'
                >
                  Clear filters
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className='rounded-lg border border-border bg-card px-4 py-5 text-[12.5px] text-muted-foreground'>
                Nothing matches these filters.
              </p>
            ) : (
              <ul className='divide-y divide-border overflow-hidden rounded-lg border border-border bg-card'>
                {shown.slice(0, limit).map((e) => (
                  <ReadyRow
                    key={`${e.collection}:${e.item}:${e.transition.id}`}
                    entry={e}
                    collectionLabel={collectionWord(data.collections, e.collection)}
                    onOpenRecord={onOpenRecord}
                  />
                ))}
              </ul>
            )}
            {shown.length > limit && (
              <button
                type='button'
                data-ic-ready-more
                onClick={() => setLimit((n) => n + PAGE)}
                className='inline-flex h-8 items-center rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              >
                Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit} left
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}

/** A line's label from a display template with an empty part ("· Line 1"): the dangling
 *  separators go, so a list reads "Line 1, Line 2". */
export function tidyRowLabel(label: string): string {
  return label.replace(/^[\s·•|,–—-]+|[\s·•|,–—-]+$/g, '').trim() || label
}

/** The collection's own name for a row; nothing when only its raw key is known. */
function collectionWord(labels: Record<string, string> | undefined, key: string): string | null {
  const l = labels?.[key]?.trim()
  return l && l !== key ? l : null
}

/** Summary sentence + Run now: side by side on a wide page; on a phone the sentence takes the
 *  width and the button sits on its own line under it. */
function SummaryRow({ runButton, children }: { runButton: ReactNode; children: ReactNode }) {
  return (
    <div className='flex flex-wrap items-center gap-x-4 gap-y-2'>
      <p
        className='min-w-0 basis-full text-[13px] leading-relaxed text-muted-foreground sm:flex-1 sm:basis-auto'
        data-ic-ready-summary
      >
        {children}
      </p>
      {runButton && <div className='sm:ml-auto'>{runButton}</div>}
    </div>
  )
}

function Count({ n, tone }: { n: number; tone: Tone }) {
  return (
    <span className={cn('font-semibold tabular-nums', n > 0 ? TONE_TEXT[tone] : 'text-foreground')}>
      {n}
    </span>
  )
}

function Banner({
  tone,
  icon,
  children,
  ...rest
}: {
  tone: Tone
  icon: ReactNode
  children: ReactNode
} & { [data: `data-${string}`]: string | boolean | undefined }) {
  return (
    <div
      role='status'
      {...rest}
      className={cn(
        'flex items-start gap-2 rounded-lg border px-4 py-2.5 text-[12.5px]',
        TONE_BORDER[tone],
        TONE_SOFT[tone],
        TONE_TEXT[tone]
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  )
}

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className='mb-1.5 px-2 text-[12px] font-semibold text-foreground'>{title}</h3>
      <div className='flex flex-col gap-0.5'>{children}</div>
    </div>
  )
}

function RailButton({
  on,
  onClick,
  label,
  count,
  tone,
  hint,
  wrap,
  ...rest
}: {
  on: boolean
  onClick: () => void
  label: string
  count: number
  tone?: Tone
  hint?: string
  wrap?: boolean
} & { [data: `data-${string}`]: string | boolean | undefined }) {
  return (
    <button
      type='button'
      aria-pressed={on}
      onClick={onClick}
      {...rest}
      className={cn(
        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        on ? 'bg-accent text-foreground' : 'text-foreground hover:bg-muted'
      )}
    >
      {tone && (
        <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', TONE_FILL[tone])} />
      )}
      <span className='min-w-0 flex-1'>
        <span
          className={cn(
            'block text-[12.5px] leading-snug',
            wrap ? 'break-words' : 'truncate',
            on && 'font-medium'
          )}
        >
          {label}
        </span>
        {hint && (
          <span className='block text-[11.5px] leading-snug text-muted-foreground'>{hint}</span>
        )}
      </span>
      <span className='shrink-0 pt-px text-[12px] font-medium tabular-nums text-muted-foreground'>
        {count}
      </span>
    </button>
  )
}

function ReadyRow({
  entry: e,
  collectionLabel,
  onOpenRecord
}: {
  entry: ReadyEntry
  collectionLabel: string | null
  onOpenRecord?: (collection: string, id: string) => void
}) {
  const nav = useItemNavigation()
  const check = useCheckReadyRecord()
  const target = { collection: e.collection, itemId: e.item }
  const open = (ev: MouseEvent<HTMLAnchorElement>) => {
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.button !== 0) return
    ev.preventDefault()
    if (onOpenRecord) onOpenRecord(e.collection, e.item)
    else nav.open(target)
  }
  const sev = SEVERITY[e.worst]
  const checkAgain = () =>
    check.mutate(
      { collection: e.collection, item: e.item },
      {
        onSuccess: (a) => {
          if (!a.sending) toast.success(`${e.label} no longer has a send next`)
          else if (a.ready) toast.success(`${e.label} is ready to send`)
          else
            toast.message(
              `${e.label} still has ${plural(
                a.entries.reduce((n, x) => n + x.issues.length, 0),
                'problem'
              )}`
            )
        },
        onError: (err) => toastError(err, 'Could not check this record', { retry: checkAgain })
      }
    )
  return (
    <li className='px-4 py-3' data-ic-ready-row={`${e.collection}:${e.item}`} data-worst={e.worst}>
      <div className='flex flex-wrap items-start gap-x-3 gap-y-2'>
        <div className='min-w-0 flex-1'>
          <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
            <a
              href={nav.urlFor(target)}
              onClick={open}
              className='truncate text-[13px] font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded'
            >
              {e.label}
            </a>
            {collectionLabel && (
              <span className='text-[12px] text-muted-foreground'>{collectionLabel}</span>
            )}
            <span
              className={cn(
                'rounded px-1.5 py-px text-[11px] font-semibold',
                TONE_SOFT[sev.tone],
                TONE_TEXT[sev.tone]
              )}
            >
              {sev.short}
            </span>
          </div>
          <p className='mt-0.5 text-[12px] text-muted-foreground'>
            {e.state ? `${e.state} → ` : ''}
            <span className='text-foreground'>{e.transition.label}</span>
            {e.partners.length > 0 && <> · sends to {e.partners.join(', ')}</>}
          </p>
        </div>
        <button
          type='button'
          data-ic-ready-check
          disabled={check.isPending}
          onClick={checkAgain}
          className='inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <RefreshCw className={cn('h-3 w-3', check.isPending && 'animate-spin')} />
          {check.isPending ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <ul className='mt-2 space-y-1'>
        {e.issues.map((i) => {
          const t = SEVERITY[i.severity].tone
          const rows = i.rows ?? []
          return (
            <li
              key={`${i.severity}:${i.partner ?? ''}:${i.message}`}
              className='flex items-start gap-2 text-[12.5px] leading-snug'
            >
              <span className={cn('mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full', TONE_FILL[t])} />
              <span className='min-w-0'>
                <span className={i.severity === 'ask' ? 'text-foreground' : TONE_TEXT[t]}>
                  {i.message}
                </span>
                {rows.length > 0 && (
                  <span className='text-muted-foreground'>
                    {' — '}
                    {rows
                      .slice(0, 3)
                      .map((r) => tidyRowLabel(r.label))
                      .join(', ')}
                    {rows.length > 3 ? ` and ${rows.length - 3} more` : ''}
                  </span>
                )}
              </span>
            </li>
          )
        })}
      </ul>
      <p className='mt-2 text-[11.5px] text-muted-foreground'>
        {e.owners.length > 0 ? (
          <>
            Step owner{e.owners.length === 1 ? '' : 's'}: {e.owners.map((o) => o.name).join(', ')}
          </>
        ) : (
          'Nobody owns this step'
        )}
        {e.checked_by && (
          <>
            {' · '}checked again by {e.checked_by} {agoText(e.checked_at)}
          </>
        )}
      </p>
    </li>
  )
}
