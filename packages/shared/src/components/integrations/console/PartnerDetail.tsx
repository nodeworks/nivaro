import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet'
import { IntegrationObligationsView } from '../IntegrationObligationsView'
import { usePartner } from './api'
import { fmtMs, fmtPct, HealthPill, HourlyBars, PartnerFlags } from './PartnerBits'
import { type ErpSubmission, SubmissionRow } from './SubmissionRow'
import { agoText, exactTime, TONE_SOFT, TONE_TEXT } from './tone'
import type { PartnerCall, PartnerDetailData } from './types'

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

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        className='flex flex-col gap-0 overflow-hidden p-0'
        style={{ width: 1040, maxWidth: '94vw' }}
        data-ic-partner-detail={apiId}
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
          {data && tab === 'calls' && <CallsTab calls={data.calls} />}
          {data && tab === 'submissions' && <SubmissionsTab apiId={apiId} />}
          {data && tab === 'obligations' && <IntegrationObligationsView api={data.card.name} />}
          {data && tab === 'contracts' && <ContractsTab apiId={apiId} data={data} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CallsTab({ calls }: { calls: PartnerCall[] }) {
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
        <div className='overflow-hidden rounded-lg border border-border bg-card'>
          <table className='w-full text-[12px]' data-ic-calls>
            <thead>
              <tr className='border-b border-border text-left text-[11px] font-medium text-muted-foreground'>
                <th className='px-3 py-2 font-medium'>When</th>
                <th className='px-3 py-2 font-medium'>Request</th>
                <th className='px-3 py-2 text-right font-medium'>Status</th>
                <th className='px-3 py-2 text-right font-medium'>Took</th>
                <th className='px-3 py-2 font-medium'>Error</th>
              </tr>
            </thead>
            <tbody className='divide-y divide-border'>
              {rows.map((c) => (
                <tr key={c.id} data-ic-call={c.ok ? 'ok' : 'failed'}>
                  <td className='whitespace-nowrap px-3 py-1.5 text-muted-foreground'>
                    <span data-tip={exactTime(c.created_at)}>{agoText(c.created_at)}</span>
                  </td>
                  <td className='max-w-[360px] truncate px-3 py-1.5 font-mono text-[11.5px] text-foreground'>
                    <span className='text-muted-foreground'>{c.method ?? ''}</span> {c.path ?? '—'}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-1.5 text-right font-medium tabular-nums',
                      c.ok ? TONE_TEXT.positive : TONE_TEXT.negative
                    )}
                  >
                    {c.status ?? (c.ok ? 'ok' : 'none')}
                  </td>
                  <td className='px-3 py-1.5 text-right tabular-nums text-muted-foreground'>
                    {fmtMs(c.duration_ms)}
                  </td>
                  <td
                    className={cn('max-w-[320px] truncate px-3 py-1.5', TONE_TEXT.negative)}
                    data-tip={c.error && c.error.length > 50 ? c.error.slice(0, 900) : undefined}
                  >
                    {c.error ?? ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
