import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Zap
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, formatDateTime, formatRelative } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * What the record form says about partner pushes BEFORE anything is sent.
 *
 *   PushReadinessChip (#616) — beside a transition that pushes, or an item
 *     action that can pre-flight: "Ready", or what would stop it ("2 lines
 *     missing Sales order"), each issue jumping to the field or the line.
 *   OutboundPreviewSection (#615) — inside the Integrations dialog: per
 *     partner, what the next push would change compared with what it last
 *     received, and which step sends it (and when).
 */

// ─── Shared types (mirror api services/integration-preview.ts) ─────────────

export interface PreflightIssue {
  severity: 'block' | 'warn'
  message: string
  field?: string
  collection?: string
  fk_field?: string
  rows?: Array<{ id: string; label: string }>
}

export interface PreflightResult {
  ready: boolean
  issues: PreflightIssue[]
  /** Transition pre-flights: each push the step carries and what it would do. */
  pushes?: Array<{ api_name: string; status: string; reason: string | null }>
  /** Item actions: false when the action has no pre-flight of its own. */
  supported?: boolean
  error?: string
}

/** Bring a field or a child row of the open record into view (ItemEditForm
 *  listens for 'nvr:record-focus'). */
export function focusRecordTarget(target: {
  collection: string
  item: string
  field?: string
  childCollection?: string
  rowId?: string
}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('nvr:record-focus', { detail: target }))
}

function PreflightIssueList({
  issues,
  collection,
  itemId,
  onJump
}: {
  issues: PreflightIssue[]
  collection: string
  itemId: string
  onJump?: () => void
}) {
  return (
    <ul className='space-y-1.5' data-preflight-issues>
      {issues.map((issue, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: issues are a fixed, ordered list
          key={i}
          data-preflight-issue={issue.severity}
          className='flex items-start gap-2 text-[12px]'
        >
          <AlertTriangle
            className={cn(
              'mt-0.5 h-3.5 w-3.5 shrink-0',
              issue.severity === 'block'
                ? 'text-red-600 dark:text-red-400'
                : 'text-amber-600 dark:text-amber-400'
            )}
          />
          <div className='min-w-0 flex-1'>
            <p className='text-slate-700 dark:text-slate-200'>{issue.message}</p>
            {issue.rows && issue.rows.length > 0 && issue.collection && (
              <div className='mt-1 flex flex-wrap gap-1'>
                {issue.rows.slice(0, 8).map((r) => (
                  <button
                    key={r.id}
                    type='button'
                    data-preflight-jump-row={r.id}
                    onClick={() => {
                      onJump?.()
                      focusRecordTarget({
                        collection,
                        item: itemId,
                        childCollection: issue.collection,
                        rowId: r.id
                      })
                    }}
                    className='max-w-[180px] truncate rounded border border-slate-200 px-1.5 py-px text-[10.5px] text-slate-600 hover:border-nvr-cyan hover:text-slate-900 dark:border-border dark:text-slate-300 dark:hover:text-white'
                    data-tip={`Open ${r.label}`}
                  >
                    {r.label}
                  </button>
                ))}
                {issue.rows.length > 8 && (
                  <span className='px-1 text-[10.5px] text-slate-400'>
                    +{issue.rows.length - 8} more
                  </span>
                )}
              </div>
            )}
            {issue.field && !issue.rows?.length && (
              <button
                type='button'
                data-preflight-jump-field={issue.field}
                onClick={() => {
                  onJump?.()
                  focusRecordTarget({ collection, item: itemId, field: issue.field })
                }}
                className='mt-0.5 text-[11px] text-nvr-navy underline-offset-2 hover:underline dark:text-nvr-cyan'
              >
                Go to the field
              </button>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Re-check when this record's data lands again (a save, a grid write). */
function useRecheckOnRecordWrites(collection: string, itemId: string) {
  const qc = useQueryClient()
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = qc.getQueryCache().subscribe((ev) => {
      if (ev.type !== 'updated' || ev.action?.type !== 'success') return
      if (ev.query.state.dataUpdateCount <= 1) return
      const key = ev.query.queryKey
      const head = key?.[0]
      const ours =
        (head === 'item' && key[1] === collection && String(key[2]) === String(itemId)) ||
        (typeof head === 'string' && head.startsWith('o2m-rows') && String(key[3]) === itemId) ||
        (head === 'erp-submissions' && key[1] === collection && String(key[2]) === itemId)
      if (!ours) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['push-preflight', collection, itemId] })
        void qc.invalidateQueries({ queryKey: ['outbound-preview', collection, itemId] })
      }, 600)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [qc, collection, itemId])
}

/**
 * "Ready" / "2 lines missing Sales order" for a button that sends something
 * to a partner. Give it a transition id (the pipeline pre-flight) or an item
 * action id (the extension's own pre-flight).
 *
 * `compact` renders a corner badge pinned to the button's top-right edge, so
 * a header row of buttons keeps its rhythm: the parent must be `relative`.
 * The full chip is for lists with room to read.
 */
/** Corner-badge placement over the button it describes (parent is `relative`). */
const BADGE_POS =
  'absolute -right-1.5 -top-1.5 z-[1] inline-flex items-center justify-center rounded-full ring-2 ring-white dark:ring-card'

export function PushReadinessChip({
  collection,
  itemId,
  transitionId,
  itemActionId,
  label,
  compact = false,
  onJump
}: {
  collection: string
  itemId: string
  transitionId?: string
  itemActionId?: string
  /** What the button does — "Submit to Warehouse". */
  label: string
  /** Header use: a dot + a short word; the popover says the rest. */
  compact?: boolean
  /** Called before a jump — a hosting dialog closes so the line shows. */
  onJump?: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  useRecheckOnRecordWrites(collection, itemId)
  const kind = transitionId ? 't' : 'a'
  const id = transitionId ?? itemActionId ?? ''
  const { data, isLoading, isError } = useQuery({
    queryKey: ['push-preflight', collection, itemId, kind, id],
    queryFn: () =>
      client
        .request<{ data: PreflightResult }>(
          transitionId
            ? get(`/integration-preview/${collection}/${encodeURIComponent(itemId)}/preflight`, {
                transition_id: transitionId
              })
            : get(`/item-actions/${encodeURIComponent(id)}/preflight`, {
                collection,
                item: itemId
              })
        )
        .then((r) => r.data),
    enabled: !!id && !!itemId && itemId !== 'new',
    staleTime: 20_000
  })
  if (!id || itemId === 'new') return null
  if (isLoading)
    return compact ? (
      <span
        data-push-readiness='loading'
        role='status'
        className={cn(BADGE_POS, 'h-2.5 w-2.5 animate-pulse bg-slate-300 dark:bg-slate-600')}
        aria-label='Checking whether this can be sent'
      />
    ) : (
      <span
        data-push-readiness='loading'
        role='status'
        className='inline-flex items-center self-center'
        aria-label='Checking whether this can be sent'
      >
        <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
      </span>
    )
  if (data?.supported === false) return null
  const failed = isError || !!data?.error
  const issues = data?.issues ?? []
  const blocking = issues.filter((i) => i.severity === 'block')
  const state: 'ready' | 'block' | 'warn' | 'error' = failed
    ? 'error'
    : blocking.length > 0
      ? 'block'
      : issues.length > 0
        ? 'warn'
        : 'ready'
  const headline =
    state === 'ready'
      ? 'Ready'
      : state === 'error'
        ? 'Could not check'
        : (blocking[0] ?? issues[0]).message
  const more = issues.length > 1 ? ` +${issues.length - 1}` : ''
  const tip =
    state === 'ready'
      ? `${label}: ready to send`
      : `${label}: ${headline}${more ? ` (and ${issues.length - 1} more)` : ''}`
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            type='button'
            data-push-readiness={state}
            data-push-readiness-for={id}
            aria-label={tip}
            data-tip={tip}
            className={cn(
              BADGE_POS,
              // A larger invisible hit area than the 14–16px disc.
              "after:absolute after:-inset-1.5 after:content-['']",
              'text-white transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-90',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              state === 'ready'
                ? 'h-3.5 w-3.5 bg-[#047857]'
                : state === 'block'
                  ? 'h-4 min-w-4 px-1 bg-[#dc2626]'
                  : 'h-4 min-w-4 px-1 bg-[#b45309]'
            )}
          >
            {state === 'ready' ? (
              <Check className='h-2.5 w-2.5' strokeWidth={3.5} />
            ) : issues.length > 0 ? (
              <span className='text-[10px] font-semibold leading-none tabular-nums'>
                {issues.length > 9 ? '9+' : issues.length}
              </span>
            ) : (
              <span className='text-[10px] font-bold leading-none'>!</span>
            )}
          </button>
        ) : (
          <button
            type='button'
            data-push-readiness={state}
            data-push-readiness-for={id}
            className={cn(
              'inline-flex max-w-[260px] shrink-0 items-center gap-1 self-center rounded-full border px-1.5 py-px text-[10.5px] font-medium transition-colors',
              state === 'ready'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
                : state === 'block'
                  ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                  : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300'
            )}
            data-tip={tip}
          >
            {state === 'ready' ? (
              <CheckCircle2 className='h-3 w-3 shrink-0' />
            ) : (
              <AlertTriangle className='h-3 w-3 shrink-0' />
            )}
            <span className='truncate'>{headline}</span>
            {more && <span className='shrink-0 opacity-70'>{more}</span>}
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[380px] max-w-[92vw] p-3'>
        <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
          Before “{label}”
        </p>
        {state === 'error' ? (
          <p className='mt-2 text-[12px] text-slate-600 dark:text-slate-300'>
            {data?.error ?? 'The check could not run.'} Nothing is assumed ready.
          </p>
        ) : issues.length === 0 ? (
          <p className='mt-2 flex items-center gap-1.5 text-[12px] text-emerald-800 dark:text-emerald-300'>
            <CheckCircle2 className='h-3.5 w-3.5' />
            Everything it needs is filled in.
          </p>
        ) : (
          <div className='mt-2'>
            <PreflightIssueList
              issues={issues}
              collection={collection}
              itemId={itemId}
              onJump={() => {
                setOpen(false)
                onJump?.()
              }}
            />
          </div>
        )}
        {data?.pushes && data.pushes.length > 0 && (
          <div className='mt-3 border-t border-slate-100 pt-2 dark:border-border'>
            <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
              What it sends
            </p>
            <ul className='mt-1 space-y-0.5 text-[11.5px]'>
              {data.pushes.map((p, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: two pushes may share a partner
                  key={i}
                  className='flex items-baseline gap-1.5 text-slate-600 dark:text-slate-300'
                  data-preflight-push={p.status}
                >
                  <span className='font-medium text-slate-800 dark:text-slate-100'>
                    {p.api_name}
                  </span>
                  <span className='text-slate-500 dark:text-slate-400'>
                    {p.status === 'would_push'
                      ? 'will be sent'
                      : p.status === 'unchanged'
                        ? 'held back — nothing it watches changed'
                        : p.status === 'not_applicable'
                          ? 'does not apply to this record'
                          : (p.reason ?? 'will not be sent')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ─── #615 ───────────────────────────────────────────────────────────────────

interface OutboundTrigger {
  transition_id: string
  transition_label: string
  to_state_label: string | null
  auto: boolean
  available: boolean
  when: string
  status: string
  reason: string | null
  changes: string[]
}
interface OutboundIntegration {
  api_id: number
  api_name: string
  endpoint_path: string
  method: string
  first_push: boolean
  last: { submission_id: number; status: string; at: string } | null
  summary: string[]
  changes: Array<{ path: string; top: string; label: string; from: unknown; to: unknown }>
  truncated: boolean
  triggers: OutboundTrigger[]
}

function showValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  const s = String(v)
  return s.length > 80 ? `${s.slice(0, 80)}…` : s
}

function OutboundCard({
  integration,
  collection,
  itemId,
  onShowRequest,
  onJump
}: {
  integration: OutboundIntegration
  collection: string
  itemId: string
  onShowRequest?: (submissionId: number) => void
  onJump?: () => void
}) {
  const [open, setOpen] = useState(false)
  const g = integration
  const nothing = !g.first_push && g.changes.length === 0
  return (
    <div
      className='rounded-lg border border-slate-200 bg-white p-2.5 dark:border-border dark:bg-card'
      data-outbound-preview={g.api_name}
      data-outbound-changes={g.changes.length}
    >
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-0.5'>
        <span className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          {g.api_name}
        </span>
        <span className='text-[12px] text-slate-600 dark:text-slate-300'>
          {g.first_push ? (
            'has not received anything from this record yet — the next push is its first'
          ) : nothing ? (
            'already has everything the next push would send'
          ) : (
            <>
              will receive on next push:{' '}
              <span className='font-medium text-slate-800 dark:text-slate-100'>
                {g.summary.join(', ')}
              </span>
            </>
          )}
        </span>
        {g.last && (
          <button
            type='button'
            onClick={() => onShowRequest?.(g.last!.submission_id)}
            className='ml-auto text-[11px] text-slate-500 hover:underline dark:text-slate-400'
            data-tip={`Compared with the push that landed ${formatDateTime(g.last.at)}`}
          >
            vs. last sent {formatRelative(g.last.at)}
          </button>
        )}
      </div>
      <ul className='mt-1.5 space-y-0.5'>
        {g.triggers.map((t) => (
          <li
            key={t.transition_id}
            data-outbound-trigger={t.transition_id}
            className={cn(
              'flex flex-wrap items-center gap-x-1.5 text-[11.5px]',
              t.available
                ? 'text-slate-600 dark:text-slate-300'
                : 'text-slate-400 dark:text-slate-500'
            )}
          >
            {t.auto ? (
              <Zap className='h-3 w-3 text-nvr-cyan' aria-label='Automatic' />
            ) : (
              <span className='h-1 w-1 rounded-full bg-slate-400' aria-hidden />
            )}
            <span className='font-medium'>
              {t.auto ? 'Automatically on' : 'On'} “{t.transition_label}”
              {t.to_state_label ? ` → ${t.to_state_label}` : ''}
            </span>
            <span>· {t.when}</span>
            {t.status === 'unchanged' && <span>· would be held back (no change)</span>}
            {t.status === 'guard' && <span>· would be skipped: {t.reason}</span>}
            {(t.status === 'template_error' || t.status === 'not_configured') && (
              <span className='text-red-700 dark:text-red-400'>· {t.reason}</span>
            )}
            {!t.available && <span>· not available yet (its conditions are not met)</span>}
            {!t.auto && t.available && (
              <span className='ml-auto'>
                <PushReadinessChip
                  collection={collection}
                  itemId={itemId}
                  transitionId={t.transition_id}
                  label={t.transition_label}
                  onJump={onJump}
                />
              </span>
            )}
          </li>
        ))}
      </ul>
      {g.changes.length > 0 && (
        <div className='mt-1.5'>
          <button
            type='button'
            onClick={() => setOpen((o) => !o)}
            data-outbound-toggle
            className='inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
          >
            {open ? <ChevronDown className='h-3 w-3' /> : <ChevronRight className='h-3 w-3' />}
            {g.changes.length}
            {g.truncated ? '+' : ''} value{g.changes.length === 1 ? '' : 's'} would change
          </button>
          {open && (
            <div className='mt-1 max-h-60 overflow-auto rounded-md border border-slate-100 dark:border-border'>
              <table className='w-full table-fixed text-[11px]'>
                <thead>
                  <tr className='bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500 dark:bg-muted/40 dark:text-slate-400'>
                    <th className='w-[40%] px-2 py-1 font-medium'>In the payload</th>
                    <th className='px-2 py-1 font-medium'>Last sent</th>
                    <th className='px-2 py-1 font-medium'>Next push</th>
                  </tr>
                </thead>
                <tbody>
                  {g.changes.map((c) => (
                    <tr
                      key={c.path}
                      className='border-t border-slate-100 dark:border-border'
                      data-outbound-change={c.path}
                    >
                      <td className='truncate px-2 py-1 font-mono text-slate-600 dark:text-slate-300'>
                        <span data-tip={c.path}>{c.path}</span>
                      </td>
                      <td className='truncate px-2 py-1 text-slate-500 line-through decoration-slate-300 dark:text-slate-400 dark:decoration-slate-600'>
                        {showValue(c.from)}
                      </td>
                      <td className='truncate px-2 py-1 font-medium text-slate-800 dark:text-slate-100'>
                        {showValue(c.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** #615 — the Integrations dialog's "What goes out next" block. */
export function OutboundPreviewSection({
  collection,
  itemId,
  onShowRequest,
  onJump
}: {
  collection: string
  itemId: string
  /** Open the request log row a comparison was made against. */
  onShowRequest?: (submissionId: number) => void
  /** A readiness issue jumps to a line — the hosting dialog closes first. */
  onJump?: () => void
}) {
  const client = useNivaroClient()
  useRecheckOnRecordWrites(collection, itemId)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['outbound-preview', collection, itemId],
    queryFn: () =>
      client
        .request<{
          data: {
            state: { key: string; label: string } | null
            integrations: OutboundIntegration[]
          }
        }>(get(`/integration-preview/${collection}/${encodeURIComponent(itemId)}/outbound`))
        .then((r) => r.data),
    enabled: !!itemId && itemId !== 'new',
    staleTime: 20_000
  })
  if (isLoading)
    return (
      <div className='space-y-1.5 pb-2' data-outbound-preview-section='loading'>
        <div className='h-3 w-40 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))]' />
        <div className='h-14 animate-pulse rounded-lg bg-[hsl(var(--nvr-skeleton))]' />
      </div>
    )
  if (isError)
    return (
      <p className='pb-2 text-[12px] text-red-700 dark:text-red-400'>
        Could not work out what the next push would send.
      </p>
    )
  const list = data?.integrations ?? []
  if (list.length === 0) return null
  return (
    <div className='space-y-1.5 pb-2' data-outbound-preview-section>
      <p className='text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
        What goes out next
        {data?.state && (
          <span className='ml-1 font-normal normal-case tracking-normal'>
            · from “{data.state.label}”
          </span>
        )}
      </p>
      {list.map((g) => (
        <OutboundCard
          key={`${g.api_id}|${g.endpoint_path}`}
          integration={g}
          collection={collection}
          itemId={itemId}
          onShowRequest={onShowRequest}
          onJump={onJump}
        />
      ))}
    </div>
  )
}
