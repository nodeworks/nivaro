import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Send } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import {
  type ObligationFilterState,
  obligationQueryParams,
  toneForOutcome
} from '../../lib/obligation-filters'
import { cn, formatRelative, humanHours } from '../../lib/utils'
import { EmptyState } from '../EmptyState'
import { ErrorSurface } from '../ErrorSurface'
import { colorPair } from '../QueryTable'
import { TipLayer } from '../TipLayer'
import { SimpleSelectXs } from '../ui/SimpleSelect'

/**
 * The obligations board: per partner, how many messages they should have had
 * and have not — and for every one, the sentence saying why. Tiles are
 * always all six (overdue/failed/pending/skipped/sent/missing) so the strip
 * keeps a fixed width as the numbers move, exactly as
 * `summariseObligations()` on the server already guarantees.
 *
 * Two independent reads: the per-API tile summary (`/summary`, cheap
 * grouped counts) and the filtered row list (`/`, paged). Clicking a tile
 * scopes the table to that API AND toggles that outcome into the filter;
 * the standalone Outcome filter row does the same toggling without pinning
 * an API, for "show me every overdue send across every partner".
 */

const TILE_LABEL: Record<string, string> = {
  overdue: 'Overdue',
  failed: 'Failed',
  pending: 'Pending',
  skipped: 'Skipped',
  sent: 'Sent',
  missing: 'Missing',
  superseded: 'Superseded'
}

/** The full outcome domain the list route accepts — tile order (what needs a
 *  person first), plus `superseded`, which the summary strip doesn't tile (a
 *  superseded obligation was replaced by a newer one, not a problem) but the
 *  row list can still be filtered to. */
const OUTCOME_OPTIONS = [
  'overdue',
  'failed',
  'pending',
  'skipped',
  'sent',
  'missing',
  'superseded'
] as const

/** Maps a filter tone onto the shared `COLOR_ROLES` name QueryTable's
 *  `colorPair` resolves — `null` for `neutral` renders as a plain card with
 *  no accent, never a bare slate wash. Exported so `IntegrationStatusBanner`
 *  (the record banner, same tone→colorPair idiom) imports this instead of
 *  keeping its own duplicate. */
export function roleForTone(
  tone: ReturnType<typeof toneForOutcome>
): 'negative' | 'warning' | 'positive' | null {
  if (tone === 'danger') return 'negative'
  if (tone === 'warning') return 'warning'
  if (tone === 'positive') return 'positive'
  return null
}

/** "due in 3h" for a future due date (a `pending` row not yet late); else the
 *  usual "Xh ago". `formatRelative` alone reads a future timestamp as "just
 *  now", which says the wrong thing about something that has not come due. */
function dueLabel(dueAt: string): string {
  const diffMs = new Date(dueAt).getTime() - Date.now()
  if (diffMs > 0) return `due in ${humanHours(diffMs / 3_600_000)}`
  return formatRelative(dueAt)
}

/** Send-now on one row of the list. Same two-click posture as the record
 *  banner's copy of this button (armed by a first click, fired by a second,
 *  disarms on its own) — the two are separate small components rather than
 *  one shared export because they invalidate different query shapes (this
 *  one refreshes the tile counts too, the banner refreshes only its own
 *  record's ledger). */
function SendNowButton({ obligationId }: { obligationId: number }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [armed, setArmed] = useState(false)

  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { detail: string } }>(
        post(`/integration-obligations/${obligationId}/send`)
      ),
    onSuccess: (res) => {
      toast.message(res?.data?.detail ?? 'Sent')
      void qc.invalidateQueries({ queryKey: ['integration-obligations', 'summary'] })
      void qc.invalidateQueries({ queryKey: ['integration-obligations', 'list'] })
    },
    onError: (err) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? 'Send now failed', { duration: 8000 })
    },
    onSettled: () => setArmed(false)
  })

  return (
    <button
      type='button'
      data-obligation-send-now
      disabled={send.isPending}
      onClick={(e) => {
        e.stopPropagation()
        if (!armed) {
          setArmed(true)
          return
        }
        send.mutate()
      }}
      className={cn(
        'ml-2 inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors disabled:opacity-60',
        armed
          ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-cyan dark:border-nvr-cyan dark:bg-nvr-cyan/15'
          : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted'
      )}
    >
      {send.isPending ? (
        <Loader2 className='h-3 w-3 animate-spin' />
      ) : (
        <Send className='h-3 w-3' />
      )}
      {armed ? 'Confirm?' : 'Send now'}
    </button>
  )
}

interface ApiSummary {
  api: string
  owner_user: string | null
  tiles: Array<{ outcome: string; count: number }>
  oldest_unmet: string | null
}

interface KindDef {
  api: string
  kind: string
  collection: string
  label: string
}

interface Row {
  id: number
  api: string
  kind: string
  collection: string
  item: string
  trigger: string
  due_at: string
  outcome: string
  reason: string | null
  submission_id: number | null
}

export interface IntegrationObligationsViewProps {
  /** Pre-select and scope the board to one partner's tiles. Absent (the
   *  admin Integration Health page's usage) shows every registered API. */
  api?: string
  className?: string
}

const PAGE_SIZE = 50

export function IntegrationObligationsView({ api, className }: IntegrationObligationsViewProps) {
  const client = useNivaroClient()
  const nav = useItemNavigation()
  const [filters, setFilters] = useState<ObligationFilterState>({
    api: api ?? null,
    kind: null,
    outcome: ['overdue', 'failed', 'missing'],
    ageHours: null
  })
  const [page, setPage] = useState(1)

  // `filters.api` starts from the `api` prop but is user-editable from
  // there (a tile click or "Clear partner" toggles it) — a stray re-render
  // must never stomp on that. Only re-seed when the CALLER scopes this
  // instance to a different partner, tracked against the last value we
  // seeded from rather than the prop's identity every render.
  const seededApiRef = useRef(api ?? null)
  useEffect(() => {
    const next = api ?? null
    if (next === seededApiRef.current) return
    seededApiRef.current = next
    setFilters((f) => ({ ...f, api: next }))
  }, [api])

  const {
    data: summary,
    isLoading: summaryLoading,
    isError: summaryError
  } = useQuery({
    queryKey: ['integration-obligations', 'summary'],
    queryFn: () =>
      client.request<{
        data: { apis: ApiSummary[]; kinds: KindDef[] }
        remediation_enabled?: boolean
      }>(get('/integration-obligations/summary')),
    staleTime: 30_000
  })
  // Read once, here — never a second probe per row of the list table below.
  // Top-level sibling of `data`, same envelope position IntegrationStatusBanner
  // reads from /record/:c/:i.
  const remediationEnabled = summary?.remediation_enabled === true

  // A filter change makes the current page meaningless — go back to the top
  // of the newly-scoped set rather than showing "page 3" of a filter that
  // may only have one page. Intentional reset trigger: the effect body never
  // reads these values, it only watches for a change.
  const outcomeKey = filters.outcome.join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset trigger
  useEffect(() => {
    setPage(1)
  }, [filters.api, filters.kind, outcomeKey, filters.ageHours])

  const params = useMemo(
    () => ({
      ...obligationQueryParams(filters),
      page: String(page),
      limit: String(PAGE_SIZE)
    }),
    [filters, page]
  )

  const {
    data: list,
    isLoading: listLoading,
    isFetching: listFetching,
    isError: listError
  } = useQuery({
    queryKey: ['integration-obligations', 'list', params],
    queryFn: () =>
      client.request<{ data: Row[]; total: number }>(get('/integration-obligations', params)),
    staleTime: 15_000,
    placeholderData: (prev) => prev
  })

  const allApis = summary?.data.apis ?? []
  const apis = api ? allApis.filter((a) => a.api === api) : allApis
  const kinds = summary?.data.kinds ?? []
  const kindsForFilter = filters.api ? kinds.filter((k) => k.api === filters.api) : kinds
  const kindLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const k of kinds) if (!m.has(k.kind)) m.set(k.kind, k.label)
    return m
  }, [kinds])

  const rows = list?.data ?? []
  const total = list?.total ?? 0

  const toggleOutcome = (outcome: string) =>
    setFilters((f) => ({
      ...f,
      outcome: f.outcome.includes(outcome)
        ? f.outcome.filter((o) => o !== outcome)
        : [...f.outcome, outcome]
    }))

  const toggleApi = (apiName: string) =>
    setFilters((f) => ({ ...f, api: f.api === apiName ? null : apiName }))

  return (
    <div className={cn('space-y-4', className)} data-obligations-board>
      {summaryError ? (
        <ErrorSurface variant='500' detail='Could not load the obligations summary.' />
      ) : summaryLoading ? (
        <div className='grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'>
          {[1, 2, 3].map((i) => (
            <div key={i} className='h-24 animate-pulse rounded-xl bg-[hsl(var(--nvr-skeleton))]' />
          ))}
        </div>
      ) : apis.length === 0 ? (
        <EmptyState
          title='No obligations recorded yet'
          detail='The reconcile sweep runs every 15 minutes — once an integration has a registered obligation kind and a message comes due, it shows up here.'
        />
      ) : (
        <div className='space-y-3'>
          {apis.map((a) => (
            <div
              key={a.api}
              data-obligation-api={a.api}
              className='rounded-xl border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'
            >
              <div className='mb-2 flex flex-wrap items-baseline justify-between gap-2'>
                <button
                  type='button'
                  aria-pressed={filters.api === a.api}
                  onClick={() => toggleApi(a.api)}
                  data-tip={
                    filters.api === a.api
                      ? 'Showing only this partner — click to show all'
                      : undefined
                  }
                  className={cn(
                    'text-[13px] font-semibold hover:underline',
                    filters.api === a.api ? 'text-nvr-cyan' : 'text-slate-800 dark:text-foreground'
                  )}
                >
                  {a.api}
                </button>
                {a.oldest_unmet && (
                  <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
                    oldest unmet {formatRelative(a.oldest_unmet)}
                  </span>
                )}
              </div>
              <div className='flex flex-wrap gap-2'>
                {a.tiles.map((t) => {
                  const role = roleForTone(toneForOutcome(t.outcome))
                  const [accent, accentDark] = role ? colorPair(role) : [null, null]
                  const selected = filters.api === a.api && filters.outcome.includes(t.outcome)
                  return (
                    <button
                      key={t.outcome}
                      type='button'
                      data-obligation-tile={t.outcome}
                      aria-pressed={selected}
                      onClick={() => {
                        setFilters((f) => ({ ...f, api: a.api }))
                        toggleOutcome(t.outcome)
                      }}
                      style={
                        accent
                          ? ({
                              '--obt': accent,
                              '--obtd': accentDark
                            } as unknown as React.CSSProperties)
                          : undefined
                      }
                      className={cn(
                        'min-w-[68px] flex-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-left transition dark:border-border dark:bg-card',
                        accent &&
                          'border-t-2 border-t-[color:var(--obt)] dark:border-t-[color:var(--obtd)]',
                        selected && 'ring-2 ring-nvr-cyan/50'
                      )}
                    >
                      <span
                        data-obligation-tile-count
                        className={cn(
                          'block text-[15px] font-semibold tabular-nums',
                          accent
                            ? 'text-[color:var(--obt)] dark:text-[color:var(--obtd)]'
                            : 'text-slate-700 dark:text-foreground'
                        )}
                      >
                        {t.count}
                      </span>
                      <span className='block text-[10px] uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
                        {TILE_LABEL[t.outcome] ?? t.outcome}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className='flex flex-wrap items-center gap-3'>
        <div data-obligation-filter='kind' className='flex items-center gap-1.5'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>Kind</span>
          <SimpleSelectXs
            ariaLabel='Filter by obligation kind'
            value={filters.kind ?? ''}
            onChange={(v) => setFilters((f) => ({ ...f, kind: v || null }))}
            options={[
              { value: '', label: 'Every kind' },
              ...kindsForFilter.map((k) => ({ value: k.kind, label: k.label }))
            ]}
          />
        </div>
        <div data-obligation-filter='age' className='flex items-center gap-1.5'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>Age</span>
          <SimpleSelectXs
            ariaLabel='Filter by obligation age'
            value={filters.ageHours != null ? String(filters.ageHours) : ''}
            onChange={(v) => setFilters((f) => ({ ...f, ageHours: v ? Number(v) : null }))}
            options={[
              { value: '', label: 'Any age' },
              { value: '1', label: 'Older than 1 hour' },
              { value: '24', label: 'Older than a day' },
              { value: '168', label: 'Older than a week' }
            ]}
          />
        </div>
        <div data-obligation-filter='outcome' className='flex flex-wrap items-center gap-1'>
          <span className='mr-0.5 text-[11px] text-slate-400 dark:text-muted-foreground'>
            Outcome
          </span>
          {OUTCOME_OPTIONS.map((o) => {
            const on = filters.outcome.includes(o)
            return (
              <button
                key={o}
                type='button'
                aria-pressed={on}
                onClick={() => toggleOutcome(o)}
                className={cn(
                  'inline-flex h-6 items-center rounded-full border px-2 text-[10.5px] font-medium transition-colors',
                  on
                    ? 'border-slate-400 bg-slate-100 text-slate-900 dark:border-slate-500 dark:bg-slate-700 dark:text-slate-100'
                    : 'border-transparent text-slate-500 hover:border-slate-300 hover:bg-slate-50 dark:text-muted-foreground dark:hover:border-slate-600 dark:hover:bg-slate-800'
                )}
              >
                {TILE_LABEL[o] ?? o}
              </button>
            )
          })}
        </div>
        {(filters.api || filters.kind || filters.ageHours != null) && (
          <button
            type='button'
            onClick={() =>
              setFilters((f) => ({ api: null, kind: null, ageHours: null, outcome: f.outcome }))
            }
            className='text-[11px] text-slate-400 underline decoration-dotted hover:text-slate-600 dark:text-muted-foreground dark:hover:text-slate-200'
          >
            Clear partner/kind/age
          </button>
        )}
      </div>

      {listError ? (
        <ErrorSurface variant='500' detail='Could not load obligations for this filter.' />
      ) : listLoading ? (
        <div className='h-24 animate-pulse rounded-xl bg-[hsl(var(--nvr-skeleton))]' />
      ) : rows.length === 0 ? (
        <div
          className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'
          data-obligations-empty
        >
          <EmptyState
            title='Nothing outstanding for this filter'
            detail='Every message the partner expects, for this outcome, has landed.'
          />
        </div>
      ) : (
        <div
          className={cn(
            'overflow-x-auto rounded-xl border border-slate-200 dark:border-border',
            listFetching && 'opacity-60 transition-opacity'
          )}
        >
          <table className='w-full text-[12px] tabular-nums'>
            <thead>
              <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted dark:text-muted-foreground'>
                <th className='px-3 py-1.5 font-medium'>Record</th>
                <th className='px-3 py-1.5 font-medium'>Kind</th>
                <th className='px-3 py-1.5 font-medium'>Due</th>
                <th className='px-3 py-1.5 font-medium'>Outcome</th>
                <th className='px-3 py-1.5 font-medium'>Why</th>
                {remediationEnabled && <th className='px-3 py-1.5 font-medium' />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const role = roleForTone(toneForOutcome(r.outcome))
                const [accent, accentDark] = role ? colorPair(role) : [null, null]
                const canSend =
                  remediationEnabled &&
                  (r.outcome === 'failed' || r.outcome === 'missing' || r.outcome === 'overdue')
                return (
                  <tr
                    key={r.id}
                    data-obligation-row={r.id}
                    className='cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50 dark:border-border/60 dark:hover:bg-muted'
                    onClick={() => nav.open({ collection: r.collection, itemId: r.item })}
                  >
                    <td className='px-3 py-1.5 font-medium text-slate-700 dark:text-slate-200'>
                      {r.collection} · {r.item}
                    </td>
                    <td className='px-3 py-1.5 text-slate-600 dark:text-slate-300'>
                      {kindLabel.get(r.kind) ?? r.kind}
                    </td>
                    <td className='px-3 py-1.5 text-slate-500 dark:text-muted-foreground'>
                      {dueLabel(r.due_at)}
                    </td>
                    <td className='px-3 py-1.5' data-obligation-outcome={r.outcome}>
                      <span
                        style={
                          accent
                            ? ({
                                '--obt': accent,
                                '--obtd': accentDark
                              } as unknown as React.CSSProperties)
                            : undefined
                        }
                        className={cn(
                          'inline-flex items-center gap-1 font-medium',
                          accent
                            ? 'text-[color:var(--obt)] dark:text-[color:var(--obtd)]'
                            : 'text-slate-500 dark:text-muted-foreground'
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            accent
                              ? 'bg-[color:var(--obt)] dark:bg-[color:var(--obtd)]'
                              : 'bg-slate-400 dark:bg-slate-600'
                          )}
                        />
                        {TILE_LABEL[r.outcome] ?? r.outcome}
                      </span>
                    </td>
                    <td
                      className='max-w-[38ch] truncate px-3 py-1.5 text-slate-500 dark:text-muted-foreground'
                      data-obligation-reason
                      data-tip={r.reason ?? undefined}
                    >
                      {r.reason ?? '—'}
                      {r.submission_id != null && (
                        <span className='ml-1 text-slate-300 dark:text-slate-600'>
                          · submission #{r.submission_id}
                        </span>
                      )}
                    </td>
                    {remediationEnabled && (
                      <td className='px-3 py-1.5 text-right'>
                        {canSend && <SendNowButton obligationId={r.id} />}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
          {total > PAGE_SIZE && (
            <div className='flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-[11px] text-slate-400 dark:border-border dark:text-muted-foreground'>
              <span>
                {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className='flex items-center gap-2'>
                <button
                  type='button'
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className='rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border'
                >
                  Prev
                </button>
                <button
                  type='button'
                  disabled={page * PAGE_SIZE >= total}
                  onClick={() => setPage((p) => p + 1)}
                  className='rounded border border-slate-200 px-2 py-0.5 disabled:opacity-40 dark:border-border'
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <TipLayer />
    </div>
  )
}
