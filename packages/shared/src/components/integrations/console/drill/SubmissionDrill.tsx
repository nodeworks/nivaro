import { ArrowRight, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { useNavigation } from '../../../../context'
import { cn, titleCase } from '../../../../lib/utils'
import { useRetrySubmission, useSubmissionDetail } from '../api'
import { agoText, exactTime, TONE_SOFT, TONE_TEXT } from '../tone'
import type { Requester, SubmissionDetail } from '../types'
import { AttemptHistory } from './attempts'
import { CodeBlock, pretty } from './json'
import { RequesterChip } from './requester'
import { StatusPill } from './status'

export interface SubmissionDrillProps {
  id: number
  onOpenRecord?: (collection: string, id: string) => void
  /** The row's own Retry action — keeps the result on the row. Absent = the
   *  drill retries through the submissions route itself. */
  onRetry?: () => void
  retryBusy?: boolean
}

/** Resolve an admin-shaped path through the host; null = the host has no such page. */
function useConsolePath() {
  const nav = useNavigation()
  return (path: string | null | undefined) => {
    if (!path) return null
    return nav.consoleUrl ? nav.consoleUrl(path) : path
  }
}

function openPath(nav: ReturnType<typeof useNavigation>, url: string) {
  if (/^https?:/.test(url)) window.open(url, '_blank', 'noopener')
  else nav.navigate(url)
}

function Section({ name, title, children }: { name: string; title: string; children: ReactNode }) {
  return (
    <section data-ic-drill-section={name} className='min-w-0'>
      <h4 className='mb-1.5 text-[12px] font-semibold text-foreground'>{title}</h4>
      {children}
    </section>
  )
}

/** A label/value row of a small definition list. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className='text-[11.5px] text-muted-foreground'>{label}</dt>
      <dd className='min-w-0 text-[12px] text-foreground'>{children}</dd>
    </>
  )
}

function Dot() {
  return (
    <span aria-hidden className='text-muted-foreground'>
      ·
    </span>
  )
}

const ERROR_CLASS_WORD: Record<string, string> = {
  transient: 'Temporary failure',
  rate_limited: 'Rate limited',
  auth: 'Credentials refused',
  not_found: 'Target not found',
  validation: 'Content refused',
  unknown: 'Unclassified failure'
}

const OUTCOME_TONE: Record<string, 'negative' | 'warning' | 'positive' | 'neutral'> = {
  sent: 'positive',
  failed: 'negative',
  overdue: 'negative',
  missing: 'negative',
  pending: 'warning',
  skipped: 'neutral',
  superseded: 'neutral'
}

function DrillSkeleton() {
  return (
    <div className='space-y-2.5' aria-busy>
      {[72, 96, 60, 84].map((w) => (
        <div
          key={w}
          className='h-3 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]'
          style={{ width: `${w}%` }}
        />
      ))}
      <div className='h-16 animate-pulse rounded-md bg-[hsl(var(--nvr-skeleton))]' />
    </div>
  )
}

/**
 * One failed (or any) outbound push, in full, opened in place under its
 * Firefight row: what happened, every attempt, the exact request and
 * response, what sent it and who, the partner's own call log, and what can be
 * done about it.
 */
export function SubmissionDrill({ id, onOpenRecord, onRetry, retryBusy }: SubmissionDrillProps) {
  const { data, isLoading, isError, error } = useSubmissionDetail(id)
  const retry = useRetrySubmission()

  if (isLoading) return <DrillSkeleton />
  if (isError || !data) {
    const msg =
      (error as { response?: { error?: string } })?.response?.error ??
      (error instanceof Error ? error.message : null)
    return (
      <p className={cn('rounded-md px-3 py-2 text-[12px]', TONE_SOFT.negative, TONE_TEXT.negative)}>
        Couldn't load this push{msg ? ` · ${msg}` : ''}.
      </p>
    )
  }
  return (
    <SubmissionDrillBody
      d={data}
      onOpenRecord={onOpenRecord}
      onRetry={onRetry ?? (() => retry.mutate(id))}
      retryBusy={onRetry ? !!retryBusy : retry.isPending}
      retryError={
        onRetry
          ? null
          : retry.isError
            ? ((retry.error as { response?: { error?: string } })?.response?.error ??
              'The retry failed')
            : null
      }
    />
  )
}

function SubmissionDrillBody({
  d,
  onOpenRecord,
  onRetry,
  retryBusy,
  retryError
}: {
  d: SubmissionDetail
  onOpenRecord?: (collection: string, id: string) => void
  onRetry: () => void
  retryBusy: boolean
  retryError: string | null
}) {
  const nav = useNavigation()
  const consolePath = useConsolePath()
  const s = d.submission
  const requesters = useMemo(
    () => new Map<number, Requester>(d.attempt_requesters.map((a) => [a.attempt, a.requester])),
    [d.attempt_requesters]
  )
  const recordWord = titleCase(s.collection).replace(/s$/, '')
  const triggerUrl = consolePath(d.trigger.link)
  const callLogsUrl = d.partner.id != null ? consolePath(`/external-apis/${d.partner.id}`) : null
  const ob = d.obligation
  const laterStarters = d.attempt_requesters.filter(
    (a) =>
      a.attempt > 1 && a.requester.label !== d.triggered_by.label && a.requester.kind !== 'unknown'
  )

  return (
    <div className='space-y-4' data-ic-drill={`submission:${s.id}`}>
      {/* 1. The push in one line. */}
      <div
        data-ic-drill-section='summary'
        className='flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'
      >
        <span className='font-semibold text-foreground'>{d.partner.name ?? 'Partner'}</span>
        <Dot />
        <span className='font-mono text-[11.5px] text-foreground'>
          {d.endpoint.method} {d.endpoint.path ?? '—'}
        </span>
        <Dot />
        {onOpenRecord ? (
          <button
            type='button'
            data-ic-drill-record
            onClick={() => onOpenRecord(s.collection, s.item)}
            className='inline-flex items-center gap-1 font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            {recordWord} {s.record_label}
            <ExternalLink className='h-3 w-3 opacity-60' aria-hidden />
          </button>
        ) : (
          <span className='font-medium text-foreground'>
            {recordWord} {s.record_label}
          </span>
        )}
        <Dot />
        <StatusPill status={s.status} />
        {s.error_class && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] font-medium',
              TONE_SOFT.warning,
              TONE_TEXT.warning
            )}
            data-tip={`Error class: ${s.error_class}`}
          >
            {ERROR_CLASS_WORD[s.error_class] ?? s.error_class}
          </span>
        )}
        <Dot />
        <span className='tabular-nums'>
          {s.attempts} attempt{s.attempts === 1 ? '' : 's'}
        </span>
        <Dot />
        <span className='inline-flex items-center gap-1 tabular-nums'>
          <span data-tip={exactTime(s.created_at)}>first sent {agoText(s.created_at)}</span>
          <ArrowRight className='h-3 w-3' aria-hidden />
          <span data-tip={exactTime(s.updated_at)}>last tried {agoText(s.updated_at)}</span>
        </span>
      </div>

      {/* 2. What went wrong — the whole message, never clamped. */}
      {(s.last_error || ob?.reason) && (
        <Section name='error' title='What went wrong'>
          {s.last_error && (
            <p
              className={cn(
                'whitespace-pre-wrap break-words rounded-md px-3 py-2 font-mono text-[11.5px] leading-relaxed',
                TONE_SOFT.negative,
                TONE_TEXT.negative
              )}
            >
              {s.last_error}
            </p>
          )}
          {ob?.reason && ob.reason !== s.last_error && (
            <p className='mt-1.5 max-w-[80ch] text-[12px] leading-relaxed text-muted-foreground'>
              <span className='font-medium text-foreground'>Obligation:</span> {ob.reason}
            </p>
          )}
        </Section>
      )}

      {/* 3. Every attempt, and who started each one. */}
      <Section name='attempts' title='Attempts'>
        <AttemptHistory submissionId={s.id} requesters={requesters} title={null} />
      </Section>

      {/* 4. The newest request and response, whole. */}
      <Section
        name='bodies'
        title={s.attempts > 1 ? 'Latest request and response' : 'Request and response'}
      >
        <div className='grid gap-3 lg:grid-cols-2'>
          <CodeBlock label='Request' value={pretty(s.payload)} fold />
          <CodeBlock label='Response' value={pretty(s.response)} fold />
        </div>
      </Section>

      <div className='grid gap-4 xl:grid-cols-2'>
        {/* 5. Why it was sent — and who. */}
        <Section name='why' title='Why it was sent — and who'>
          <dl className='grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1.5'>
            <Fact label='Triggered by'>
              <span className='inline-flex max-w-full' data-ic-drill-triggered-by>
                <RequesterChip r={d.triggered_by} />
              </span>
            </Fact>
            <Fact label='What sent it'>
              {triggerUrl ? (
                <button
                  type='button'
                  onClick={() => openPath(nav, triggerUrl)}
                  className='inline-flex items-center gap-1 text-left font-medium underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                >
                  {d.trigger.label}
                  <ExternalLink className='h-3 w-3 shrink-0 opacity-60' aria-hidden />
                </button>
              ) : (
                <span
                  className={d.trigger.kind === 'unknown' ? 'italic text-muted-foreground' : ''}
                >
                  {d.trigger.label}
                </span>
              )}
            </Fact>
            {laterStarters.length > 0 && (
              <Fact label='Retried by'>
                <span className='flex flex-col gap-1'>
                  {laterStarters.map((a) => (
                    <span key={a.attempt} className='inline-flex items-center gap-1.5'>
                      <span className='text-[11.5px] tabular-nums text-muted-foreground'>
                        #{a.attempt}
                      </span>
                      <RequesterChip r={a.requester} size='sm' />
                    </span>
                  ))}
                </span>
              </Fact>
            )}
            <Fact label='Obligation'>
              {ob ? (
                <span className='inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5'>
                  <span className='font-mono text-[11.5px]'>{ob.kind}</span>
                  <span
                    className={cn(
                      'rounded px-1.5 py-px text-[11px] font-medium',
                      TONE_SOFT[OUTCOME_TONE[ob.outcome] ?? 'neutral'],
                      TONE_TEXT[OUTCOME_TONE[ob.outcome] ?? 'neutral']
                    )}
                  >
                    {ob.outcome}
                  </span>
                  <span className='text-[11.5px] text-muted-foreground'>
                    {ob.open ? 'still open' : 'closed'}
                    {ob.due_at && (
                      <span data-tip={exactTime(ob.due_at)}>
                        {' '}
                        · due {new Date(ob.due_at).toLocaleString()}
                      </span>
                    )}
                  </span>
                </span>
              ) : (
                <span className='text-muted-foreground'>None recorded for this push</span>
              )}
            </Fact>
            {d.partner.owner && <Fact label='Partner owner'>{d.partner.owner.name}</Fact>}
          </dl>
        </Section>

        {/* 6. What the partner call log saw. */}
        <Section name='calls' title='Call log'>
          {d.call_logs.length === 0 ? (
            <p className='text-[12px] text-muted-foreground'>
              No partner calls matched this push — the writer that sent it does not log its calls.
            </p>
          ) : (
            <ul className='divide-y divide-border rounded-md border border-border'>
              {d.call_logs.map((l) => {
                const bad = l.error != null || (l.status ?? 0) >= 400
                return (
                  <li
                    key={l.id}
                    data-ic-drill-call={l.id}
                    className='flex flex-wrap items-center gap-x-2.5 gap-y-0.5 px-2.5 py-1.5 text-[11.5px]'
                  >
                    <span
                      className='tabular-nums text-muted-foreground'
                      data-tip={exactTime(l.created_at)}
                    >
                      {new Date(l.created_at).toLocaleString()}
                    </span>
                    <span className='font-mono text-foreground'>{l.method ?? '—'}</span>
                    <span
                      className={cn(
                        'font-mono font-medium',
                        bad ? TONE_TEXT.negative : TONE_TEXT.positive
                      )}
                    >
                      {l.status ?? 'no response'}
                    </span>
                    {l.duration_ms != null && (
                      <span className='tabular-nums text-muted-foreground'>{l.duration_ms} ms</span>
                    )}
                    {l.user && <span className='text-muted-foreground'>· {l.user.name}</span>}
                    {l.triggered_by && (
                      <span className='ml-auto truncate font-mono text-[11px] text-muted-foreground'>
                        {l.triggered_by}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {callLogsUrl && (
            <button
              type='button'
              data-ic-drill-call-logs
              onClick={() => openPath(nav, callLogsUrl)}
              className='mt-1.5 inline-flex items-center gap-1 text-[12px] font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
            >
              Open in Call Logs
              <ExternalLink className='h-3 w-3 opacity-60' aria-hidden />
            </button>
          )}
        </Section>
      </div>

      {/* 7. What can be done. */}
      <div
        data-ic-drill-section='actions'
        className='flex flex-wrap items-center gap-2 border-t border-border pt-3'
      >
        <button
          type='button'
          data-ic-drill-retry
          disabled={!d.retry.eligible || retryBusy}
          onClick={onRetry}
          className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          {retryBusy ? (
            <Loader2 className='h-3 w-3 animate-spin' aria-hidden />
          ) : (
            <RefreshCw className='h-3 w-3' aria-hidden />
          )}
          Retry
        </button>
        {onOpenRecord && (
          <button
            type='button'
            onClick={() => onOpenRecord(s.collection, s.item)}
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          >
            Open record
          </button>
        )}
        {!d.retry.eligible && d.retry.reason && (
          <span className='text-[12px] text-muted-foreground' data-ic-drill-retry-reason>
            {d.retry.reason}
          </span>
        )}
        {d.retry.eligible && d.retry.warning && (
          <span className={cn('text-[12px]', TONE_TEXT.warning)}>{d.retry.warning}</span>
        )}
        {retryError && <span className={cn('text-[12px]', TONE_TEXT.negative)}>{retryError}</span>}
      </div>
    </div>
  )
}
