import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Loader2, Play, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet'
import { IntegrationObligationsView } from '../IntegrationObligationsView'
import { useCallDetail, usePartner } from './api'
import {
  CodeBlock,
  describeCallTrigger,
  HeaderTable,
  HttpStatusChip,
  isTruncatedBody,
  pretty,
  TriggerChip
} from './drill'
import { fmtMs, fmtPct, HealthPill, HourlyBars, PartnerFlags } from './PartnerBits'
import { type ErpSubmission, SubmissionRow } from './SubmissionRow'
import { agoText, exactTime, TONE_SOFT, TONE_TEXT } from './tone'
import type { PartnerCall, PartnerDetailData } from './types'

function httpOk(status: number | null): boolean {
  return status != null && status >= 200 && status < 300
}

type DetailTab = 'calls' | 'submissions' | 'obligations' | 'contracts'

const TABS: Array<{ key: DetailTab; label: string }> = [
  { key: 'calls', label: 'Recent calls' },
  { key: 'submissions', label: 'Submissions' },
  { key: 'obligations', label: 'Obligations' },
  { key: 'contracts', label: 'Contracts' }
]

export interface PartnerDetailProps {
  apiId: number
  onClose: () => void
  initialTab?: DetailTab
}

export function PartnerDetail({ apiId, onClose, initialTab = 'calls' }: PartnerDetailProps) {
  const { data, isLoading, isError } = usePartner(apiId)
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const card = data?.card

  // A call row's own Escape closes JUST that row (see CallRow) — but Radix's
  // Escape-to-dismiss runs in a CAPTURE-phase document listener, ahead of any
  // bubble-phase handler a nested row could ever install, so stopPropagation
  // down there can't defeat it. This is the sheet's half of that same fix:
  // while any row is expanded, swallow the dismiss via the one escape hatch
  // Radix's own dismissable layer checks (`event.preventDefault()` inside
  // `onEscapeKeyDown`) — the row's handler still runs afterward and collapses.
  const openCallCount = useRef(0)
  const onCallOpenChange = (open: boolean) => {
    openCallCount.current += open ? 1 : -1
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className='flex flex-col gap-0 overflow-hidden p-0'
        style={{ width: 1040, maxWidth: '94vw' }}
        data-ic-partner-detail={apiId}
        onEscapeKeyDown={(e) => {
          if (openCallCount.current > 0) e.preventDefault()
        }}
      >
        <div className='shrink-0 border-b border-border px-6 pb-0 pt-5'>
          {isLoading || !card ? (
            <div className='space-y-2 pb-4'>
              <SheetTitle className='sr-only'>Partner</SheetTitle>
              <SheetDescription className='sr-only'>Loading partner detail</SheetDescription>
              <div className='h-5 w-48 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
              <div className='h-4 w-80 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
              {isError && (
                <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>
                  Couldn't load this partner.
                </p>
              )}
            </div>
          ) : (
            <>
              <div className='flex flex-wrap items-center gap-2.5 pr-8'>
                <SheetTitle className='text-[17px] font-semibold'>{card.name}</SheetTitle>
                <HealthPill health={card.health} />
                <PartnerFlags card={card} />
              </div>
              <SheetDescription className='mt-1 text-[12.5px] text-muted-foreground'>
                {card.calls24} call{card.calls24 === 1 ? '' : 's'} in the last 24 hours ·{' '}
                {fmtPct(card.success_pct24)} succeeded · typically {fmtMs(card.p50_ms)}, slowest{' '}
                {fmtMs(card.p95_ms)}
                {card.owner ? ` · owner ${card.owner.name}` : ''}
              </SheetDescription>
              <HourlyBars hourly={card.hourly} className='mt-3 max-w-[720px]' />
              <div role='tablist' aria-label='Partner detail' className='-mb-px mt-3 flex gap-5'>
                {TABS.map((t) => (
                  <button
                    key={t.key}
                    type='button'
                    role='tab'
                    aria-selected={tab === t.key}
                    data-ic-detail-tab={t.key}
                    onClick={() => setTab(t.key)}
                    className={cn(
                      'border-b-2 pb-2 pt-1 text-[12.5px] font-medium transition-colors',
                      tab === t.key
                        ? 'border-nvr-cyan text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto bg-muted/30 px-6 py-5'>
          {data && tab === 'calls' && (
            <CallsTab apiId={apiId} calls={data.calls} onCallOpenChange={onCallOpenChange} />
          )}
          {data && tab === 'submissions' && <SubmissionsTab apiId={apiId} />}
          {data && tab === 'obligations' && <IntegrationObligationsView api={data.card.name} />}
          {data && tab === 'contracts' && <ContractsTab apiId={apiId} data={data} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CallsTab({
  apiId,
  calls,
  onCallOpenChange
}: {
  apiId: number
  calls: PartnerCall[]
  onCallOpenChange: (open: boolean) => void
}) {
  const [failuresOnly, setFailuresOnly] = useState(false)
  const failures = calls.filter((c) => !c.ok).length
  const rows = failuresOnly ? calls.filter((c) => !c.ok) : calls
  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-3'>
        <p className='text-[12.5px] text-muted-foreground'>
          The latest {calls.length} call{calls.length === 1 ? '' : 's'} made to this partner.
        </p>
        <label className='ml-auto inline-flex cursor-pointer items-center gap-2 text-[12.5px] text-foreground'>
          <input
            type='checkbox'
            checked={failuresOnly}
            onChange={(e) => setFailuresOnly(e.target.checked)}
            data-ic-failures-only
            className='h-3.5 w-3.5 accent-[rgb(var(--nvr-cyan-rgb))]'
          />
          Failures only
          <span className='tabular-nums text-muted-foreground'>({failures})</span>
        </label>
      </div>
      {rows.length === 0 ? (
        <p className='rounded-lg border border-border bg-card px-4 py-5 text-[12.5px] text-muted-foreground'>
          {failuresOnly
            ? 'No failed calls in this window.'
            : 'No calls recorded in the last 14 days.'}
        </p>
      ) : (
        <ul
          className='divide-y divide-border overflow-hidden rounded-lg border border-border bg-card'
          data-ic-calls
        >
          {rows.map((c) => (
            <CallRow key={c.key} apiId={apiId} call={c} onOpenChange={onCallOpenChange} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One call — expands in place to its full request/response (Enter/Space on
 * the toggle, Esc from anywhere inside collapses and returns focus to it).
 * An `outbound`-sourced row (the always-on counter with no call-log entry)
 * says so instead of fetching — there is nothing under this id to open.
 */
function CallRow({
  apiId,
  call,
  onOpenChange
}: {
  apiId: number
  call: PartnerCall
  /** Tells the hosting sheet whether ANY row is expanded, so it can swallow
   *  Escape at the Radix layer (see PartnerDetail's `onEscapeKeyDown`). */
  onOpenChange: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const trigger = describeCallTrigger(call.triggered_by, call.user)
  const collapse = () => {
    setOpen(false)
    toggleRef.current?.focus()
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: onOpenChange only mutates a ref in the parent — depending on it would double-count on every unrelated re-render
  useEffect(() => {
    if (!open) return
    onOpenChange(true)
    return () => onOpenChange(false)
  }, [open])
  return (
    <li
      data-ic-call={call.id}
      data-ic-call-source={call.source}
      className={cn(open && 'bg-muted/30')}
    >
      <button
        ref={toggleRef}
        type='button'
        aria-expanded={open}
        data-ic-call-toggle={call.id}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            // Focus never leaves the toggle in this case — nothing to
            // refocus — but stop the sheet hosting this list from ALSO
            // reacting to the same Escape.
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }
        }}
        className='flex w-full items-center gap-3 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring'
      >
        <span
          className='w-16 shrink-0 text-[11.5px] text-muted-foreground'
          data-tip={exactTime(call.created_at)}
        >
          {agoText(call.created_at)}
        </span>
        <span className='min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground'>
          <span className='text-muted-foreground'>{call.method ?? ''}</span> {call.path ?? '—'}
        </span>
        <span
          className={cn(
            'w-10 shrink-0 text-right text-[11.5px] font-medium tabular-nums',
            call.ok ? TONE_TEXT.positive : TONE_TEXT.negative
          )}
        >
          {call.status ?? (call.ok ? 'ok' : 'none')}
        </span>
        <span className='w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground'>
          {fmtMs(call.duration_ms)}
        </span>
        {call.error && (
          <span
            className={cn(
              'min-w-0 max-w-[200px] shrink truncate text-[11.5px]',
              TONE_TEXT.negative
            )}
            data-tip={call.error.length > 50 ? call.error.slice(0, 900) : undefined}
          >
            {call.error}
          </span>
        )}
        <span
          className='min-w-0 max-w-[160px] shrink truncate text-[11px] text-muted-foreground'
          data-tip={call.user?.email ?? undefined}
        >
          {trigger.label}
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {open && (
        // Esc anywhere inside the open detail (a copy button, a folded
        // body) collapses it and returns focus to the row's own toggle.
        // `defaultPrevented` is NOT a "someone already handled this" signal
        // here — the sheet's own onEscapeKeyDown (above, in PartnerDetail)
        // sets it on EVERY Escape while a row is open, purely to stop Radix's
        // capture-phase listener from also closing the whole sheet — so this
        // handler must act regardless of that flag.
        <section
          aria-label={`Call detail — ${call.method ?? ''} ${call.path ?? ''}`.trim()}
          data-ic-call-open={call.id}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              collapse()
            }
          }}
          className='border-t border-border px-3 py-3'
        >
          {call.source === 'outbound' ? (
            <p className='text-[12px] italic text-muted-foreground' data-ic-call-empty>
              No request/response recorded for this call.
            </p>
          ) : (
            <CallDetailBody apiId={apiId} callId={call.id} />
          )}
        </section>
      )}
    </li>
  )
}

function CallDetailBody({ apiId, callId }: { apiId: number; callId: number }) {
  const { data, isLoading, isError } = useCallDetail(apiId, callId)
  if (isLoading) {
    return (
      <div className='space-y-2'>
        <div className='h-4 w-40 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        <div className='grid gap-3 lg:grid-cols-2'>
          <div className='h-28 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
          <div className='h-28 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        </div>
      </div>
    )
  }
  if (isError || !data) {
    return <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>Couldn't load this call.</p>
  }
  return (
    <div className='space-y-3'>
      <div className='flex flex-wrap items-center gap-2' data-ic-call-section='trigger'>
        <span className='text-[11.5px] font-semibold text-muted-foreground'>Triggered by</span>
        <TriggerChip triggeredBy={data.triggered_by} user={data.user} />
      </div>
      <div className='grid gap-3 lg:grid-cols-2'>
        <div className='min-w-0 space-y-2' data-ic-call-section='request'>
          <p className='text-[11.5px] font-semibold text-muted-foreground'>Request</p>
          <p
            className='truncate font-mono text-[11.5px] text-foreground'
            data-tip={data.url ?? undefined}
          >
            <span className='font-semibold text-muted-foreground'>{data.method ?? '—'}</span>{' '}
            {data.url ?? '—'}
          </p>
          <HeaderTable headers={data.request_headers} />
          <CodeBlock
            label='Body'
            value={pretty(data.request_body)}
            fold
            truncated={isTruncatedBody(data.request_body)}
          />
        </div>
        <div className='min-w-0 space-y-2' data-ic-call-section='response'>
          <p className='text-[11.5px] font-semibold text-muted-foreground'>Response</p>
          <div className='flex items-center gap-2'>
            <HttpStatusChip status={data.response_status} ok={httpOk(data.response_status)} />
            <span className='text-[11.5px] tabular-nums text-muted-foreground'>
              {fmtMs(data.duration_ms)}
            </span>
          </div>
          {data.error && (
            <p
              className={cn(
                'rounded px-2 py-1.5 text-[11.5px]',
                TONE_SOFT.negative,
                TONE_TEXT.negative
              )}
            >
              {data.error}
            </p>
          )}
          <HeaderTable headers={data.response_headers} />
          <CodeBlock
            label='Body'
            value={pretty(data.response_body)}
            fold
            truncated={isTruncatedBody(data.response_body)}
          />
        </div>
      </div>
    </div>
  )
}

/**
 * The only submissions listing is the payload search route, which needs a
 * term of at least two characters. With nothing typed it searches for
 * "endpoint_path" — a key every stored payload carries — so the default view
 * is simply the newest submissions to this partner.
 */
const ALL_SUBMISSIONS_TERM = 'endpoint_path'

function SubmissionsTab({ apiId }: { apiId: number }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 350)
    return () => clearTimeout(t)
  }, [text])
  const q = term.length >= 2 ? term : ALL_SUBMISSIONS_TERM
  const { data, isLoading, isError } = useQuery({
    queryKey: ['erp-submissions', 'partner', apiId, q],
    queryFn: () =>
      client
        .request<{ data: ErpSubmission[] }>(
          get('/erp-submissions/search', { external_api: apiId, q, limit: 50 })
        )
        .then((r) => r.data)
  })
  const retry = useMutation({
    mutationFn: (id: number) => client.request(post(`/erp-submissions/${id}/retry`)),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['erp-submissions'] })
      void qc.invalidateQueries({ queryKey: ['erp-submission-attempts'] })
      void qc.invalidateQueries({ queryKey: ['integration-partner', apiId] })
    }
  })
  const subs = data ?? []
  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-3'>
        <div className='relative w-full max-w-[420px]'>
          <Search className='pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground' />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Find a reference, record id or error text'
            data-ic-submission-search
            className='h-8 w-full rounded-md border border-border bg-card pl-8 pr-2.5 text-[12.5px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          />
        </div>
        <p className='text-[12px] text-muted-foreground'>
          {term.length >= 2 ? `Matching “${term}”` : 'Newest 50 from the last 90 days'}
        </p>
      </div>
      {isLoading ? (
        <div className='space-y-2'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='h-10 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : isError ? (
        <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>Couldn't load submissions.</p>
      ) : subs.length === 0 ? (
        <p className='rounded-lg border border-border bg-card px-4 py-5 text-[12.5px] text-muted-foreground'>
          {term.length >= 2
            ? 'Nothing sent to this partner matches that.'
            : 'Nothing has been sent to this partner in the last 90 days.'}
        </p>
      ) : (
        <div className='space-y-2' data-ic-submissions>
          {subs.map((s) => (
            <div key={s.id} className='bg-card'>
              <SubmissionRow
                sub={s}
                onRetry={(id) => retry.mutate(id)}
                retrying={retry.isPending && retry.variables === s.id}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ContractsTab({ apiId, data }: { apiId: number; data: PartnerDetailData }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const run = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { results: unknown[]; failed: number } }>(
          post(`/external-apis/${apiId}/contracts/run`)
        )
        .then((r) => r.data),
    onSettled: () => qc.invalidateQueries({ queryKey: ['integration-partner', apiId] })
  })
  const contracts = data.contracts
  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-3'>
        <p className='max-w-[70ch] text-[12.5px] text-muted-foreground'>
          A contract is a saved check that an endpoint still answers the way this system expects.
          Running them calls the partner's read-only endpoints now.
        </p>
        <button
          type='button'
          disabled={run.isPending || contracts.length === 0}
          onClick={() => run.mutate()}
          data-ic-run-contracts
          className='ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-3 text-[12.5px] font-medium text-foreground hover:bg-muted disabled:opacity-60'
        >
          {run.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Play className='h-3.5 w-3.5' />
          )}
          Run contracts
        </button>
      </div>
      {run.data && (
        <p
          role='status'
          className={cn(
            'rounded-md px-3 py-2 text-[12.5px] font-medium',
            run.data.failed > 0 ? TONE_SOFT.negative : TONE_SOFT.positive,
            run.data.failed > 0 ? TONE_TEXT.negative : TONE_TEXT.positive
          )}
        >
          {run.data.failed > 0
            ? `${run.data.failed} of ${run.data.results.length} failing`
            : `All ${run.data.results.length} passed`}
        </p>
      )}
      {run.isError && (
        <p className={cn('text-[12.5px]', TONE_TEXT.negative)}>The contracts couldn't run.</p>
      )}
      {contracts.length === 0 ? (
        <p className='rounded-lg border border-border bg-card px-4 py-5 text-[12.5px] text-muted-foreground'>
          No contracts on this partner's endpoints yet. Add one from the endpoint's settings on the
          external API page.
        </p>
      ) : (
        <ul className='divide-y divide-border overflow-hidden rounded-lg border border-border bg-card'>
          {contracts.map((c) => {
            const state = c.last_run == null ? 'never' : c.ok ? 'ok' : 'failed'
            return (
              <li key={c.endpoint_id} data-ic-contract={state} className='flex gap-3 px-4 py-2.5'>
                <span
                  className={cn(
                    'mt-0.5 shrink-0 rounded px-1.5 py-px text-[11px] font-semibold',
                    state === 'ok'
                      ? cn(TONE_SOFT.positive, TONE_TEXT.positive)
                      : state === 'failed'
                        ? cn(TONE_SOFT.negative, TONE_TEXT.negative)
                        : 'bg-muted text-muted-foreground'
                  )}
                >
                  {state === 'ok' ? 'Passing' : state === 'failed' ? 'Failing' : 'Not run'}
                </span>
                <div className='min-w-0 flex-1'>
                  <p className='text-[12.5px] font-medium text-foreground'>{c.name}</p>
                  {c.detail && (
                    <p className='mt-0.5 line-clamp-2 text-[12px] text-muted-foreground'>
                      {c.detail}
                    </p>
                  )}
                </div>
                <span
                  className='shrink-0 text-[12px] text-muted-foreground'
                  data-tip={exactTime(c.last_run)}
                >
                  {c.last_run ? agoText(c.last_run) : ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
