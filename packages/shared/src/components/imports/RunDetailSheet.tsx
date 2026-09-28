import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FileSpreadsheet,
  Loader2,
  RotateCcw,
  Search,
  Undo2
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { useApiFetchConfig, useItemNavigation, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { get, post } from '../../lib/commands'
import { type ImportLogError, type ImportLogLine, parseImportLog } from '../../lib/import-log'
import { cn, formatDateTime, formatFileSize, formatNumber, titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'
import { LIVE_POLL_MS, StatusPill, useElapsed } from './run-parts'
import {
  formatDuration,
  type ImportRevertPreview,
  type ImportRun,
  type ImportRunItem,
  type ImportRunItemKind,
  type ImportRunReport,
  type ImportRunUnmatched,
  runMode,
  runnerName
} from './types'

/**
 * One import run, read top to bottom in the order an operator asks:
 * what happened → what needs a look → which records → where the time went.
 *
 * A run of an items-service import keeps a report and one item per record it
 * touched (migration 359). A run of a stored procedure keeps neither — the
 * procedure writes straight to the tables — and shows its timings and log.
 */

const PAGE = 50

// Explicit pairs: a host theme may re-point the slate scale, and these carry
// meaning. Each is ≥4.5:1 on its surface in both themes.
const KIND: Record<
  ImportRunItemKind | 'unchanged',
  { label: string; one: string; text: string; bar: string; dot: string }
> = {
  created: {
    label: 'Created',
    one: 'created',
    text: 'text-[#047857] dark:text-[#6ee7b7]',
    bar: 'bg-[#10b981]',
    dot: 'bg-[#10b981]'
  },
  updated: {
    label: 'Updated',
    one: 'updated',
    text: 'text-[#0369a1] dark:text-[#7dd3fc]',
    bar: 'bg-[#0ea5e9]',
    dot: 'bg-[#0ea5e9]'
  },
  unchanged: {
    label: 'Unchanged',
    one: 'unchanged',
    text: 'text-[#475569] dark:text-[#cbd5e1]',
    bar: 'bg-[#cbd5e1] dark:bg-[#475569]',
    dot: 'bg-[#94a3b8]'
  },
  removed: {
    label: 'Removed',
    one: 'removed',
    text: 'text-[#6d28d9] dark:text-[#c4b5fd]',
    bar: 'bg-[#8b5cf6]',
    dot: 'bg-[#8b5cf6]'
  },
  skipped: {
    label: 'Left out',
    one: 'left out',
    text: 'text-[#b45309] dark:text-[#fbbf24]',
    bar: 'bg-[#f59e0b]',
    dot: 'bg-[#f59e0b]'
  },
  failed: {
    label: 'Failed',
    one: 'failed',
    text: 'text-[#b91c1c] dark:text-[#fca5a5]',
    bar: 'bg-[#ef4444]',
    dot: 'bg-[#ef4444]'
  }
}

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0ea5e9]/60 focus-visible:ring-offset-0'

const collectionName = (c: string | null | undefined) =>
  titleCase(
    String(c ?? '')
      .replace(/_junction$/i, ' links')
      .replace(/_/g, ' ')
  )

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** Authenticated file download — a plain link carries no bearer token. */
function useDownload() {
  const { apiBase, authHeaders, credentials } = useApiFetchConfig()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  async function download(path: string, filename: string) {
    setBusy(path)
    setError(null)
    try {
      const res = await fetch(`${apiBase}${path}`, { headers: authHeaders, credentials })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || res.statusText)
      }
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return { download, busy, error }
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className='mb-2 flex items-baseline justify-between gap-3'>
      <h3 className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
        {children}
      </h3>
      {aside && <div className='flex shrink-0 items-center gap-2'>{aside}</div>}
    </div>
  )
}

function TextButton({
  onClick,
  children,
  disabled,
  ...rest
}: {
  onClick: () => void
  children: ReactNode
  disabled?: boolean
} & Record<`data-${string}`, string | number | undefined>) {
  return (
    <button
      type='button'
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-[#0369a1] transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-[#7dd3fc] dark:hover:bg-muted',
        focusRing
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

// ─── Result ─────────────────────────────────────────────────────────────────

function ResultStrip({
  report,
  kind,
  onKind
}: {
  report: ImportRunReport
  kind: ImportRunItemKind | null
  onKind: (k: ImportRunItemKind | null) => void
}) {
  const c = report.counts
  const other = (c.other ?? []).filter((o) => o.count > 0)
  const otherTotal = other.reduce((a, o) => a + o.count, 0)
  const total = c.created + c.updated + c.unchanged + c.skipped + c.failed + otherTotal
  const cells: Array<{ key: ImportRunItemKind | 'unchanged'; n: number }> = [
    { key: 'created', n: c.created },
    { key: 'updated', n: c.updated },
    { key: 'unchanged', n: c.unchanged },
    { key: 'skipped', n: c.skipped },
    { key: 'failed', n: c.failed }
  ]
  return (
    <section data-run-result>
      <div className='grid grid-cols-5 gap-px overflow-hidden rounded-md border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
        {cells.map(({ key, n }) => {
          const k = KIND[key]
          const pickable = key !== 'unchanged' && n > 0
          const active = kind === key
          const body = (
            <>
              <span
                className={cn(
                  'block text-[15px] font-semibold leading-tight tabular-nums',
                  n > 0 ? k.text : 'text-[#64748b] dark:text-[#94a3b8]'
                )}
              >
                {formatNumber(n)}
              </span>
              <span className='mt-0.5 block text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                {k.label}
              </span>
            </>
          )
          return pickable ? (
            <button
              key={key}
              type='button'
              data-run-count={key}
              aria-pressed={active}
              onClick={() => onKind(active ? null : (key as ImportRunItemKind))}
              className={cn(
                'px-3 py-2 text-left transition-colors',
                active
                  ? 'bg-[#f0f9ff] dark:bg-[#0c2a3d]'
                  : 'bg-white hover:bg-slate-50 dark:bg-card dark:hover:bg-muted/40',
                focusRing
              )}
            >
              {body}
            </button>
          ) : (
            <div key={key} data-run-count={key} className='bg-white px-3 py-2 dark:bg-card'>
              {body}
            </div>
          )
        })}
      </div>

      {total > 0 && (
        <div
          className='mt-2 flex h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
          role='img'
          aria-label={cells
            .filter((x) => x.n > 0)
            .map((x) => `${formatNumber(x.n)} ${KIND[x.key].one}`)
            .join(', ')}
        >
          {cells
            .filter((x) => x.n > 0)
            .map((x) => (
              <span
                key={x.key}
                className={KIND[x.key].bar}
                style={{ width: `${Math.max((x.n / total) * 100, 0.6)}%` }}
              />
            ))}
          {otherTotal > 0 && (
            <span
              className='bg-[#a5b4fc] dark:bg-[#4f46e5]'
              style={{ width: `${Math.max((otherTotal / total) * 100, 0.6)}%` }}
            />
          )}
        </div>
      )}

      {other.map((o) => (
        <p
          key={o.label}
          data-run-other
          className='mt-1.5 flex items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'
        >
          <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-[#818cf8]' />
          <span className='font-medium tabular-nums text-slate-900 dark:text-foreground'>
            {formatNumber(o.count)}
          </span>
          {o.label}
        </p>
      ))}
    </section>
  )
}

// ─── Needs a look ───────────────────────────────────────────────────────────

function UnmatchedRow({ u, runId }: { u: ImportRunUnmatched; runId: number }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const more = u.distinct - u.values.length
  return (
    <li className='border-b border-slate-100 last:border-b-0 dark:border-border/60'>
      <button
        type='button'
        data-run-unmatched={u.column}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
          focusRing
        )}
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        )}
        <span className='min-w-0 flex-1 text-[12.5px] text-slate-800 dark:text-foreground'>
          <span className='font-semibold tabular-nums'>{formatNumber(u.distinct)}</span> {u.label}
          {u.distinct === 1 ? '' : 's'} in the file match{u.distinct === 1 ? 'es' : ''} nothing
        </span>
        <span className='shrink-0 text-[11.5px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {formatNumber(u.rows)} row{u.rows === 1 ? '' : 's'}
        </span>
      </button>
      {open && (
        <div className='space-y-2 px-3 pb-3 pl-8'>
          <p className='max-w-[70ch] text-[12px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
            {u.effect}
          </p>
          <ul className='flex flex-wrap gap-1'>
            {u.values.map((v) => (
              <li
                key={v}
                className='rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
              >
                {v}
              </li>
            ))}
            {more > 0 && (
              <li className='px-1 py-0.5 text-[11px] text-slate-500 dark:text-muted-foreground'>
                and {formatNumber(more)} more
              </li>
            )}
          </ul>
          <TextButton
            data-run-unmatched-copy={u.column}
            onClick={() => {
              void navigator.clipboard?.writeText(u.values.join('\n')).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              })
            }}
          >
            {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
            {copied
              ? 'Copied'
              : `Copy ${u.values.length === u.distinct ? 'all' : `the first ${u.values.length}`}`}
          </TextButton>
          <span className='sr-only'>Run {runId}</span>
        </div>
      )}
    </li>
  )
}

function NeedsALook({
  report,
  runId,
  isAdmin,
  onKind
}: {
  report: ImportRunReport
  runId: number
  isAdmin: boolean
  onKind: (k: ImportRunItemKind) => void
}) {
  const { download, busy } = useDownload()
  const reasons = Object.entries(report.skipped).filter(([, n]) => n > 0)
  if (report.unmatched.length === 0 && reasons.length === 0 && report.counts.failed === 0)
    return null
  return (
    <section data-run-attention>
      <SectionTitle
        aside={
          isAdmin && report.unmatched.length > 0 ? (
            <TextButton
              data-run-unmatched-download
              disabled={busy != null}
              onClick={() =>
                download(
                  `/staged-imports/${runId}/unmatched.csv`,
                  `import-run-${runId}-unmatched.csv`
                )
              }
            >
              <Download className='h-3 w-3' /> Values as CSV
            </TextButton>
          ) : null
        }
      >
        Needs a look
      </SectionTitle>
      <ul className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
        {report.counts.failed > 0 && (
          <li className='border-b border-slate-100 last:border-b-0 dark:border-border/60'>
            <button
              type='button'
              onClick={() => onKind('failed')}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
                focusRing
              )}
            >
              <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-[#dc2626] dark:text-[#fca5a5]' />
              <span className='min-w-0 flex-1 text-[12.5px] text-slate-800 dark:text-foreground'>
                <span className='font-semibold tabular-nums'>
                  {formatNumber(report.counts.failed)}
                </span>{' '}
                could not be written
              </span>
              <span className='shrink-0 text-[11.5px] text-[#0369a1] dark:text-[#7dd3fc]'>
                Show them
              </span>
            </button>
          </li>
        )}
        {reasons.map(([reason, n]) => (
          <li
            key={reason}
            className='border-b border-slate-100 last:border-b-0 dark:border-border/60'
          >
            <button
              type='button'
              onClick={() => onKind('skipped')}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
                focusRing
              )}
            >
              <span className='ml-[3px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#f59e0b]' />
              <span className='ml-[5px] min-w-0 flex-1 text-[12.5px] text-slate-800 dark:text-foreground'>
                <span className='font-semibold tabular-nums'>{formatNumber(n)}</span> row
                {n === 1 ? '' : 's'} left out: {reason}
              </span>
              <span className='shrink-0 text-[11.5px] text-[#0369a1] dark:text-[#7dd3fc]'>
                Show them
              </span>
            </button>
          </li>
        ))}
        {report.unmatched.map((u) => (
          <UnmatchedRow key={u.column} u={u} runId={runId} />
        ))}
      </ul>
    </section>
  )
}

// ─── Records ────────────────────────────────────────────────────────────────

function ChangeTable({ item }: { item: ImportRunItem }) {
  if (item.changes.length === 0) return null
  const created = item.kind === 'created'
  const anyBefore = item.changes.some((c) => c.from_known)
  return (
    <table className='w-full border-collapse text-[12px]' data-run-changes>
      <thead>
        <tr className='text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
          <th className='w-[34%] pb-1 pr-3 font-medium'>Field</th>
          {!created && <th className='w-[33%] pb-1 pr-3 font-medium'>Before</th>}
          <th className='pb-1 font-medium'>{created ? 'Value' : 'After'}</th>
        </tr>
      </thead>
      <tbody>
        {item.changes.map((c) => (
          <tr key={c.field} className='border-t border-slate-100 align-top dark:border-border/60'>
            <td className='py-1 pr-3 text-slate-600 dark:text-muted-foreground'>{c.label}</td>
            {!created && (
              <td className='break-words py-1 pr-3 tabular-nums text-slate-500 dark:text-muted-foreground'>
                {!c.from_known ? (
                  <span className='italic'>not kept</span>
                ) : c.from ? (
                  <span className='line-through decoration-slate-300 dark:decoration-slate-600'>
                    {c.from}
                  </span>
                ) : (
                  <span className='italic'>empty</span>
                )}
              </td>
            )}
            <td className='break-words py-1 font-medium tabular-nums text-slate-900 dark:text-foreground'>
              {c.to || <span className='font-normal italic text-slate-500'>empty</span>}
            </td>
          </tr>
        ))}
      </tbody>
      {!created && !anyBefore && (
        <caption className='caption-bottom pt-1.5 text-left text-[11px] text-slate-500 dark:text-muted-foreground'>
          This run was read back from recorded changes, which keep the new value only.
        </caption>
      )}
    </table>
  )
}

function ItemRow({
  item,
  manyCollections,
  isAdmin,
  onRevert,
  reverting
}: {
  item: ImportRunItem
  manyCollections: boolean
  isAdmin: boolean
  onRevert: (item: ImportRunItem) => void
  reverting: boolean
}) {
  const [open, setOpen] = useState(false)
  const { urlFor, open: openItem } = useItemNavigation()
  const k = KIND[item.kind]
  // a removed record is in the trash: nothing to open
  const hasRecord =
    !!item.collection && !!item.item_id && item.kind !== 'failed' && item.kind !== 'removed'
  const summary =
    item.kind === 'skipped' || item.kind === 'failed' || item.kind === 'removed'
      ? (item.message ?? '')
      : item.kind === 'created'
        ? `${item.changes.length} field${item.changes.length === 1 ? '' : 's'}`
        : item.changes
            .slice(0, 3)
            .map((c) => c.label)
            .join(', ') + (item.changes.length > 3 ? ` +${item.changes.length - 3}` : '')
  const revertable =
    isAdmin &&
    !item.reverted_at &&
    (item.kind === 'created' || item.kind === 'updated') &&
    hasRecord

  return (
    <li
      data-run-item={item.id}
      data-run-item-kind={item.kind}
      className='border-b border-slate-100 last:border-b-0 dark:border-border/60'
    >
      <button
        type='button'
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'grid w-full grid-cols-[14px_minmax(0,1.2fr)_minmax(0,1.3fr)_72px] items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/40',
          open && 'bg-slate-50 dark:bg-muted/30',
          focusRing
        )}
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
        )}
        <span className='flex min-w-0 items-center gap-2'>
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', k.dot)} aria-hidden />
          <span className='sr-only'>{k.label}:</span>
          <span
            className={cn(
              'truncate text-[12.5px] font-medium text-slate-900 dark:text-foreground',
              item.reverted_at && 'text-slate-500 line-through dark:text-muted-foreground'
            )}
          >
            {item.label}
          </span>
          {manyCollections && item.collection && (
            <span className='shrink-0 rounded bg-slate-100 px-1 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              {collectionName(item.collection)}
            </span>
          )}
          {item.reverted_at && (
            <span className='shrink-0 rounded bg-slate-100 px-1 py-px text-[10.5px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
              Reverted
            </span>
          )}
        </span>
        <span className='truncate text-[12px] text-slate-600 dark:text-muted-foreground'>
          <span className={cn('font-medium', k.text)}>{k.label}</span>
          {summary && <> · {summary}</>}
        </span>
        <span className='shrink-0 text-right font-mono text-[11px] tabular-nums text-slate-500 dark:text-muted-foreground'>
          {item.row != null ? `row ${formatNumber(item.row)}` : ''}
        </span>
      </button>

      {open && (
        <div className='space-y-2.5 bg-slate-50 px-3 pb-3 pl-[34px] pt-1 dark:bg-muted/30'>
          {item.message && (
            <p
              className={cn(
                'max-w-[78ch] text-[12px] leading-relaxed',
                item.kind === 'failed'
                  ? 'text-[#b91c1c] dark:text-[#fca5a5]'
                  : 'text-slate-700 dark:text-foreground'
              )}
            >
              {item.message}
            </p>
          )}
          <ChangeTable item={item} />
          {item.revert_note && (
            <p className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              Revert: {item.revert_note}
            </p>
          )}
          {(hasRecord || revertable) && (
            <div className='flex flex-wrap items-center gap-1'>
              {hasRecord && (
                <a
                  href={urlFor({
                    collection: item.collection as string,
                    itemId: item.item_id as string
                  })}
                  data-run-item-open
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey) return
                    e.preventDefault()
                    openItem({
                      collection: item.collection as string,
                      itemId: item.item_id as string
                    })
                  }}
                  className={cn(
                    'inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-[#0369a1] hover:bg-slate-100 dark:text-[#7dd3fc] dark:hover:bg-muted',
                    focusRing
                  )}
                >
                  <ExternalLink className='h-3 w-3' /> Open the record
                </a>
              )}
              {revertable && (
                <TextButton
                  data-run-item-revert
                  disabled={reverting}
                  onClick={() => onRevert(item)}
                >
                  {reverting ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : (
                    <Undo2 className='h-3 w-3' />
                  )}
                  {item.kind === 'created' ? 'Remove this record' : 'Put this record back'}
                </TextButton>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  )
}

function Records({
  runId,
  report,
  kind,
  onKind,
  isAdmin,
  live
}: {
  runId: number
  report: ImportRunReport
  kind: ImportRunItemKind | null
  onKind: (k: ImportRunItemKind | null) => void
  isAdmin: boolean
  live: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { download, busy, error: downloadError } = useDownload()
  const [search, setSearch] = useState('')
  const [collection, setCollection] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [message, setMessage] = useState<string | null>(null)
  const term = useDebounced(search, 300)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new filter starts at page one
  useEffect(() => setPage(1), [kind, collection, term, runId])

  const params = { kind: kind ?? '', collection: collection ?? '', search: term, page, limit: PAGE }
  const items = useQuery({
    queryKey: ['staged-import-run-items', runId, params],
    queryFn: () =>
      client.request(
        get<{
          data: ImportRunItem[]
          total: number
          facets: { kind?: Record<string, number>; collection?: Record<string, number> }
        }>(`/staged-imports/${runId}/items`, params)
      ),
    placeholderData: (prev) => prev,
    refetchInterval: live ? LIVE_POLL_MS : false
  })

  const revertOne = useMutation({
    mutationFn: (item: ImportRunItem) =>
      client.request(
        post<{
          data: {
            removed: number
            restored: number
            left_alone: number
            failed: number
            failures: string[]
          }
        }>(`/staged-imports/${runId}/revert`, { item_ids: [item.id] })
      ),
    onSuccess: (res) => {
      const d = res.data
      setMessage(
        d.failed
          ? `Could not be reverted: ${d.failures[0] ?? 'unknown reason'}`
          : d.removed
            ? 'Removed. The record is in the trash.'
            : d.restored
              ? 'Put back to the values it held before the import.'
              : 'Left as it is: it changed again after the import.'
      )
      void qc.invalidateQueries({ queryKey: ['staged-import-run-items', runId] })
      void qc.invalidateQueries({ queryKey: ['staged-import-run', runId] })
    },
    onError: (err: Error & { response?: { error?: string } }) =>
      setMessage(err.response?.error ?? err.message)
  })

  const facets = items.data?.facets ?? {}
  const collections = Object.keys(facets.collection ?? report.collections ?? {})
  const total = items.data?.total ?? 0
  const rows = items.data?.data ?? []
  const stored = report.items_stored ?? 0
  const tabs: Array<{ key: ImportRunItemKind | null; label: string; n: number }> = [
    { key: null, label: 'All', n: Object.values(facets.kind ?? {}).reduce((a, b) => a + b, 0) },
    ...(['created', 'updated', 'removed', 'skipped', 'failed'] as ImportRunItemKind[])
      .map((key) => ({ key, label: KIND[key].label, n: facets.kind?.[key] ?? 0 }))
      .filter((t) => t.n > 0 || t.key === kind)
  ]

  if (stored === 0 && !items.isLoading && total === 0 && !term && !kind) {
    return (
      <section data-run-records>
        <SectionTitle>Records</SectionTitle>
        <p className='rounded-md border border-dashed border-slate-200 px-3 py-4 text-[12.5px] text-slate-600 dark:border-border dark:text-muted-foreground'>
          This run changed no records and left no rows out. Every row in the file already matched
          what is stored.
        </p>
      </section>
    )
  }

  return (
    <section data-run-records>
      <SectionTitle
        aside={
          isAdmin ? (
            <TextButton
              data-run-items-download
              disabled={busy != null || total === 0}
              onClick={() =>
                download(
                  `/staged-imports/${runId}/items.csv?kind=${kind ?? ''}&collection=${collection ?? ''}&search=${encodeURIComponent(term)}`,
                  `import-run-${runId}${kind ? `-${kind}` : ''}.csv`
                )
              }
            >
              {busy ? (
                <Loader2 className='h-3 w-3 animate-spin' />
              ) : (
                <Download className='h-3 w-3' />
              )}
              {kind ? `${KIND[kind].label} as CSV` : 'All as CSV'}
            </TextButton>
          ) : null
        }
      >
        Records
      </SectionTitle>

      <div className='mb-2 flex flex-wrap items-center gap-x-3 gap-y-2'>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and legend this strip does not want */}
        <div
          role='group'
          aria-label='Show'
          className='flex overflow-hidden rounded-md border border-slate-200 dark:border-border'
        >
          {tabs.map((t) => (
            <button
              key={t.key ?? 'all'}
              type='button'
              data-run-kind={t.key ?? 'all'}
              aria-pressed={kind === t.key}
              onClick={() => onKind(t.key)}
              className={cn(
                'border-r border-slate-200 px-2.5 py-1 text-[12px] transition-colors last:border-r-0 dark:border-border',
                kind === t.key
                  ? 'bg-[#0f172a] font-medium text-[#ffffff] dark:bg-[#e2e8f0] dark:text-[#0f172a]'
                  : 'bg-white text-slate-700 hover:bg-slate-50 dark:bg-card dark:text-foreground dark:hover:bg-muted/40',
                focusRing
              )}
            >
              {t.label} <span className='tabular-nums opacity-75'>{formatNumber(t.n)}</span>
            </button>
          ))}
        </div>

        {collections.length > 1 && (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset brings a border and legend this strip does not want
          <div
            role='group'
            aria-label='Collection'
            className='flex flex-wrap items-center gap-1 text-[12px]'
          >
            {[null, ...collections].map((c) => (
              <button
                key={c ?? 'every'}
                type='button'
                data-run-collection={c ?? 'every'}
                aria-pressed={collection === c}
                onClick={() => setCollection(c)}
                className={cn(
                  'rounded-full border px-2 py-0.5 transition-colors',
                  collection === c
                    ? 'border-[#0ea5e9] bg-[#f0f9ff] text-[#0369a1] dark:bg-[#0c2a3d] dark:text-[#7dd3fc]'
                    : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-border dark:text-muted-foreground dark:hover:bg-muted/40',
                  focusRing
                )}
              >
                {c ? collectionName(c) : 'Every collection'}
              </button>
            ))}
          </div>
        )}

        <div className='relative ml-auto w-[220px] max-w-full'>
          <Search className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Find a record or a value'
            aria-label='Find a record or a value'
            data-run-search
            className='h-7 pl-7 text-[12px]'
          />
        </div>
      </div>

      {(message || downloadError) && (
        <p
          role='status'
          className='mb-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'
        >
          {message ?? downloadError}
        </p>
      )}

      <div
        className={cn(
          'overflow-hidden rounded-md border border-slate-200 transition-opacity dark:border-border',
          items.isFetching && !items.isLoading && 'opacity-70'
        )}
      >
        {items.isLoading ? (
          <div className='space-y-1.5 p-3'>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <Skeleton key={i} className='h-5 w-full' />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <p className='px-3 py-6 text-center text-[12.5px] text-slate-600 dark:text-muted-foreground'>
            {term ? `Nothing in this run matches “${term}”.` : 'Nothing to show for this choice.'}
          </p>
        ) : (
          <ul>
            {rows.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                manyCollections={collections.length > 1}
                isAdmin={isAdmin}
                onRevert={(it) => {
                  setMessage(null)
                  revertOne.mutate(it)
                }}
                reverting={revertOne.isPending && revertOne.variables?.id === item.id}
              />
            ))}
          </ul>
        )}
      </div>

      {total > PAGE && (
        <div className='mt-2 flex items-center justify-between text-[11.5px] text-slate-600 dark:text-muted-foreground'>
          <span className='tabular-nums'>
            {formatNumber((page - 1) * PAGE + 1)}–{formatNumber(Math.min(page * PAGE, total))} of{' '}
            {formatNumber(total)}
          </span>
          <span className='flex items-center gap-1'>
            <Button
              variant='outline'
              size='sm'
              className='h-6 px-2 text-[11.5px]'
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant='outline'
              size='sm'
              className='h-6 px-2 text-[11.5px]'
              disabled={page * PAGE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </span>
        </div>
      )}
      {report.items_truncated && (
        <p className='mt-2 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
          This run touched more records than are kept per run. The first{' '}
          {formatNumber(report.items_stored ?? 0)} are listed; the counts above cover all of them.
        </p>
      )}
    </section>
  )
}

// ─── Where the time went ────────────────────────────────────────────────────

function Phases({ report }: { report: ImportRunReport }) {
  const phases = report.phases.filter((p) => p.ms > 0 || (p.count ?? 0) > 0)
  if (phases.length === 0) return null
  const longest = Math.max(...phases.map((p) => p.ms), 1)
  const total = phases.reduce((a, p) => a + p.ms, 0)
  return (
    <section data-run-phases>
      <SectionTitle
        aside={
          <span className='text-[11.5px] tabular-nums text-slate-600 dark:text-muted-foreground'>
            {fmtMs(total)} in all
          </span>
        }
      >
        Where the time went
      </SectionTitle>
      <ol className='space-y-1'>
        {phases.map((p) => (
          <li
            key={p.key}
            data-run-phase={p.key}
            className='grid grid-cols-[minmax(0,1fr)_minmax(60px,32%)_64px] items-center gap-3 text-[12px]'
          >
            <span className='min-w-0 truncate text-slate-800 dark:text-foreground'>
              {p.label}
              {p.count != null && p.count > 0 && (
                <span className='text-slate-500 dark:text-muted-foreground'>
                  {' '}
                  · {formatNumber(p.count)}
                </span>
              )}
              {(p.failed ?? 0) > 0 && (
                <span className='text-[#b91c1c] dark:text-[#fca5a5]'>
                  {' '}
                  · {formatNumber(p.failed ?? 0)} failed
                </span>
              )}
            </span>
            <span
              className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'
              aria-hidden
            >
              <span
                className='block h-full rounded-full bg-[#64748b] dark:bg-[#94a3b8]'
                style={{ width: `${Math.max((p.ms / longest) * 100, 1.5)}%` }}
              />
            </span>
            <span className='text-right font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-foreground'>
              {fmtMs(p.ms)}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

// ─── Reverting a run ────────────────────────────────────────────────────────

function RevertPanel({
  runId,
  onDone,
  onClose
}: {
  runId: number
  onDone: () => void
  onClose: () => void
}) {
  const client = useNivaroClient()
  const preview = useQuery({
    queryKey: ['staged-import-revert-preview', runId],
    queryFn: () =>
      client.request(
        post<{ data: ImportRevertPreview }>(`/staged-imports/${runId}/revert/preview`, {})
      ),
    staleTime: 0,
    gcTime: 0
  })
  const [result, setResult] = useState<string | null>(null)
  const run = useMutation({
    mutationFn: () =>
      client.request(
        post<{
          data: {
            done: boolean
            queued?: number
            removed?: number
            restored?: number
            left_alone?: number
            failed?: number
          }
        }>(`/staged-imports/${runId}/revert`, {})
      ),
    onSuccess: (res) => {
      const d = res.data
      setResult(
        d.done
          ? `${formatNumber(d.removed ?? 0)} removed, ${formatNumber(d.restored ?? 0)} put back, ${formatNumber(d.left_alone ?? 0)} left as they are${d.failed ? `, ${formatNumber(d.failed)} failed` : ''}.`
          : `Reverting ${formatNumber(d.queued ?? 0)} records in the background. Rows here turn to Reverted as they land; Background Jobs shows the progress.`
      )
      onDone()
    },
    onError: (err: Error & { response?: { error?: string } }) =>
      setResult(err.response?.error ?? err.message)
  })

  const p = preview.data?.data
  const work = p ? p.remove + p.restore + p.partly : 0
  return (
    <div
      data-run-revert
      className='shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3 dark:border-border dark:bg-muted/30'
    >
      <h3 className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
        Revert this run
      </h3>
      {preview.isLoading ? (
        <p className='mt-1.5 flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' /> Checking each record against what is
          stored now…
        </p>
      ) : preview.isError || !p ? (
        <p className='mt-1.5 text-[12px] text-[#b91c1c] dark:text-[#fca5a5]'>
          {(preview.error as Error | null)?.message ?? 'The preview could not be read.'}
        </p>
      ) : result ? (
        <p
          role='status'
          className='mt-1.5 max-w-[78ch] text-[12px] text-slate-700 dark:text-foreground'
        >
          {result}
        </p>
      ) : (
        <>
          <ul className='mt-1.5 space-y-0.5 text-[12px] text-slate-700 dark:text-foreground'>
            <li data-revert-restore>
              <span className='font-semibold tabular-nums'>
                {formatNumber(p.restore + p.partly)}
              </span>{' '}
              changed record{p.restore + p.partly === 1 ? '' : 's'} return to the values held before
              the import
              {p.partly > 0 && ` (${formatNumber(p.partly)} of them in part)`}
            </li>
            <li data-revert-remove>
              <span className='font-semibold tabular-nums'>{formatNumber(p.remove)}</span> created
              record{p.remove === 1 ? '' : 's'} go to the trash
            </li>
            {p.left_alone > 0 && (
              <li data-revert-left>
                <span className='font-semibold tabular-nums'>{formatNumber(p.left_alone)}</span>{' '}
                stay as they are, because they changed after the import or kept no earlier values
              </li>
            )}
            {p.already_reverted > 0 && (
              <li>
                <span className='font-semibold tabular-nums'>
                  {formatNumber(p.already_reverted)}
                </span>{' '}
                were reverted already
              </li>
            )}
          </ul>
          {p.left.length > 0 && (
            <details className='mt-1.5 text-[11.5px] text-slate-600 dark:text-muted-foreground'>
              <summary className='cursor-pointer select-none'>Which records stay, and why</summary>
              <ul className='mt-1 max-h-32 space-y-0.5 overflow-y-auto'>
                {p.left.map((l) => (
                  <li key={l.id}>
                    <span className='font-medium text-slate-800 dark:text-foreground'>
                      {l.label || `#${l.item_id}`}
                    </span>{' '}
                    · {l.note}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p className='mt-1.5 max-w-[78ch] text-[11.5px] text-slate-600 dark:text-muted-foreground'>
            Each change is written under your name and can be seen in the record's history. Work the
            run did outside the records listed here is not undone.
          </p>
        </>
      )}
      <div className='mt-2.5 flex items-center gap-2'>
        {!result && p && (
          <Button
            size='sm'
            variant='destructive'
            data-run-revert-confirm
            disabled={work === 0 || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Undo2 className='h-3.5 w-3.5' />
            )}
            {work === 0
              ? 'Nothing to revert'
              : `Revert ${formatNumber(work)} record${work === 1 ? '' : 's'}`}
          </Button>
        )}
        <Button size='sm' variant='ghost' onClick={onClose}>
          {result ? 'Close' : 'Keep the run as it is'}
        </Button>
      </div>
    </div>
  )
}

// ─── The sheet ──────────────────────────────────────────────────────────────

function WhatRan({ run }: { run: ImportRun }) {
  const { mode, name } = runMode(run)
  if (mode === 'processor' || mode === 'service') {
    return (
      <span data-run-mode={mode}>
        Items service
        {name && <span className='font-mono text-[11px]'> · {name}</span>}
      </span>
    )
  }
  return (
    <span
      data-run-mode={mode}
      className='inline-flex flex-wrap items-center gap-1 font-mono text-[11px]'
    >
      {run.staging_table || `staging_${run.import_key}`}
      {mode === 'procedure' ? (
        <>
          <ArrowRight className='h-3 w-3 text-slate-400' />
          {name}
        </>
      ) : (
        <span className='font-sans'>· load only</span>
      )}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='min-w-0'>
      <dt className='text-[11px] text-slate-500 dark:text-muted-foreground'>{label}</dt>
      <dd className='truncate text-[12.5px] text-slate-900 dark:text-foreground'>{children}</dd>
    </div>
  )
}

export function RunDetailSheet({
  run: cached,
  runId,
  stage,
  isAdmin,
  onClose,
  onRequeue,
  onCancel
}: {
  /** The list row, shown immediately; the fetch below fills in the rest. */
  run: ImportRun | undefined
  runId: number | null
  stage: string | null
  isAdmin: boolean
  onClose: () => void
  onRequeue: (id: number) => void
  onCancel: (id: number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const detail = useQuery({
    queryKey: ['staged-import-run', runId],
    queryFn: () => client.request(get<{ data: ImportRun }>(`/staged-imports/${runId}`)),
    enabled: runId != null,
    refetchInterval: (q) =>
      q.state.data?.data?.status === 'running' || q.state.data?.data?.status === 'queued'
        ? LIVE_POLL_MS
        : false
  })

  const run = detail.data?.data ?? cached
  const report = detail.data?.data?.report ?? null
  const elapsed = useElapsed(run?.started_at ?? run?.created_at, run?.status === 'running')
  const fileHref = run?.file ? client.fileUrl(run.file) : null
  const [kind, setKind] = useState<ImportRunItemKind | null>(null)
  const [reverting, setReverting] = useState(false)
  const [recentRevert, setRecentRevert] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a different run starts clean
  useEffect(() => {
    setKind(null)
    setReverting(false)
    setRecentRevert(false)
  }, [runId])

  const rebuild = useMutation({
    mutationFn: () =>
      client.request(
        post<{ data: { items: number } }>(`/staged-imports/${runId}/report/rebuild`, {})
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['staged-import-run', runId] })
  })

  const mode = run ? runMode(run).mode : null
  const finished = run?.status === 'completed' || run?.status === 'error'
  const canRevert =
    isAdmin && !!report && finished && (report.counts.created > 0 || report.counts.updated > 0)
  const wide = !!report

  const facts = useMemo(() => {
    if (!run) return null
    return (
      <dl className='mt-3 grid grid-cols-2 gap-x-5 gap-y-2 sm:grid-cols-4'>
        <Fact label='Queued by'>{runnerName(run) ?? '—'}</Fact>
        <Fact label={run.finished_at ? 'Finished' : run.started_at ? 'Started' : 'Queued'}>
          {formatDateTime(run.finished_at ?? run.started_at ?? run.created_at ?? new Date())}
        </Fact>
        <Fact label='Took'>
          <span className='tabular-nums'>{formatDuration(run.duration)}</span>
        </Fact>
        <Fact label='Rows in the file'>
          <span className='tabular-nums'>
            {run.row_count == null ? '—' : formatNumber(run.row_count)}
          </span>
        </Fact>
      </dl>
    )
  }, [run])

  return (
    <Sheet open={runId != null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side='right'
        className={cn('p-0 sm:max-w-none', wide ? 'w-[min(860px,96vw)]' : 'w-[min(560px,94vw)]')}
      >
        <SheetTitle className='sr-only'>
          {run
            ? `Import run ${run.id}: ${run.definition_label?.trim() || run.import_key}`
            : 'Import run'}
        </SheetTitle>
        <SheetDescription className='sr-only'>
          What the run did, what needs a look, the records it touched and its log.
        </SheetDescription>
        {!run ? (
          <div className='space-y-3 p-5'>
            <Skeleton className='h-4 w-40' />
            <Skeleton className='h-6 w-64' />
            <Skeleton className='h-24 w-full' />
          </div>
        ) : (
          <div className='flex h-full flex-col' data-run-sheet={run.id}>
            <header className='shrink-0 border-b border-slate-200 px-5 py-4 pr-12 dark:border-border'>
              <div className='flex flex-wrap items-center gap-2.5'>
                <StatusPill status={run.status} />
                <span className='font-mono text-[12px] text-slate-500 dark:text-muted-foreground'>
                  #{run.id}
                </span>
                {run.reverted_at && (
                  <span
                    data-run-reverted
                    className='rounded bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-700 dark:bg-muted dark:text-foreground'
                  >
                    Reverted {formatDateTime(run.reverted_at)}
                  </span>
                )}
              </div>
              <h2 className='mt-1.5 text-[16px] font-semibold text-slate-900 dark:text-foreground'>
                {run.definition_label?.trim() || run.import_key}
              </h2>
              <p className='mt-0.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
                <WhatRan run={run} />
              </p>
              {stage && run.status === 'running' && (
                <p className='mt-2 text-[12px] text-[#0284a8] dark:text-nvr-cyan'>
                  {stage}
                  {elapsed != null && ` · ${formatDuration(elapsed)} elapsed`}
                </p>
              )}
              {facts}
            </header>

            <div className='min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-4'>
              {report ? (
                <>
                  <ResultStrip report={report} kind={kind} onKind={setKind} />
                  <NeedsALook
                    report={report}
                    runId={run.id}
                    isAdmin={isAdmin}
                    onKind={(k) => {
                      setKind(k)
                      document
                        .querySelector('[data-run-records]')
                        ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                    }}
                  />
                  <Records
                    runId={run.id}
                    report={report}
                    kind={kind}
                    onKind={setKind}
                    isAdmin={isAdmin}
                    live={recentRevert}
                  />
                  <Phases report={report} />
                  {report.notes.length > 0 && (
                    <section data-run-notes>
                      <SectionTitle>Worth knowing</SectionTitle>
                      <ul className='max-w-[78ch] space-y-1.5 text-[12px] leading-relaxed text-slate-700 dark:text-foreground'>
                        {report.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              ) : (
                finished && (
                  <section data-run-no-report>
                    <p className='max-w-[64ch] rounded-md border border-dashed border-slate-200 px-3 py-3 text-[12.5px] leading-relaxed text-slate-600 dark:border-border dark:text-muted-foreground'>
                      {mode === 'procedure' || mode === 'load'
                        ? 'This run went through a stored procedure, which writes straight to the tables. It kept its timings and its log, and no record-by-record detail.'
                        : 'This run finished before record-by-record detail was kept.'}
                      {isAdmin && (
                        <>
                          {' '}
                          <button
                            type='button'
                            data-run-rebuild
                            disabled={rebuild.isPending}
                            onClick={() => rebuild.mutate()}
                            className={cn(
                              'font-medium text-[#0369a1] underline-offset-2 hover:underline disabled:opacity-60 dark:text-[#7dd3fc]',
                              focusRing
                            )}
                          >
                            {rebuild.isPending ? 'Reading…' : 'Read it back from recorded changes'}
                          </button>
                        </>
                      )}
                    </p>
                    {rebuild.isError && (
                      <p className='mt-1.5 max-w-[64ch] text-[12px] text-slate-700 dark:text-foreground'>
                        {(rebuild.error as Error & { response?: { error?: string } }).response
                          ?.error ?? (rebuild.error as Error).message}
                      </p>
                    )}
                  </section>
                )
              )}

              <section data-run-file>
                <SectionTitle>File</SectionTitle>
                {run.file_name || run.file ? (
                  <div className='flex items-center gap-2.5 rounded-md border border-slate-200 px-3 py-2 dark:border-border'>
                    <FileSpreadsheet className='h-4 w-4 shrink-0 text-slate-400' />
                    <div className='min-w-0 flex-1'>
                      <p className='truncate font-mono text-[11.5px] text-slate-800 dark:text-foreground'>
                        {run.file_name ?? run.file}
                      </p>
                      {run.file_size != null && (
                        <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                          {formatFileSize(Number(run.file_size))}
                        </p>
                      )}
                    </div>
                    {fileHref && (
                      <a
                        href={fileHref}
                        target='_blank'
                        rel='noreferrer'
                        className={cn(
                          'rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-muted',
                          focusRing
                        )}
                        aria-label='Download the source file'
                      >
                        <Download className='h-3.5 w-3.5' />
                      </a>
                    )}
                  </div>
                ) : (
                  <p className='text-[12px] text-slate-600 dark:text-muted-foreground'>
                    No file is attached, so this run cannot be queued again.
                  </p>
                )}
              </section>

              <section data-run-log>
                {report ? (
                  <details>
                    <summary className='cursor-pointer select-none text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                      The run's own log
                    </summary>
                    <RunLog run={run} />
                  </details>
                ) : (
                  <>
                    <SectionTitle>Log</SectionTitle>
                    <RunLog run={run} />
                  </>
                )}
              </section>
            </div>

            {reverting && canRevert && (
              <RevertPanel
                runId={run.id}
                onClose={() => setReverting(false)}
                onDone={() => {
                  setRecentRevert(true)
                  void qc.invalidateQueries({ queryKey: ['staged-import-run', run.id] })
                  void qc.invalidateQueries({ queryKey: ['staged-import-run-items', run.id] })
                }}
              />
            )}

            {isAdmin && (
              <footer className='flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-200 px-5 py-3 dark:border-border'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={run.status === 'running' || !run.file}
                  onClick={() => onRequeue(run.id)}
                >
                  <RotateCcw className='h-3.5 w-3.5' /> Run the file again
                </Button>
                {canRevert && !reverting && (
                  <Button
                    variant='outline'
                    size='sm'
                    data-run-revert-open
                    onClick={() => setReverting(true)}
                  >
                    <Undo2 className='h-3.5 w-3.5' /> Revert…
                  </Button>
                )}
                {run.status !== 'completed' && (
                  <Button variant='ghost' size='sm' onClick={() => onCancel(run.id)}>
                    <Ban className='h-3.5 w-3.5' /> Cancel
                  </Button>
                )}
              </footer>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

const LOG_VALUE_CAP = 40

const chipClass =
  'rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-foreground'

function LogTools({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <TextButton
      data-run-log-copy
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
    >
      {copied ? <Check className='h-3 w-3' /> : <Copy className='h-3 w-3' />}
      {copied ? 'Copied' : 'Copy'}
    </TextButton>
  )
}

function LogLine({ line }: { line: ImportLogLine }) {
  return (
    <li
      data-run-log-line
      className='grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 px-3 py-2'
    >
      <div className='min-w-0'>
        <p
          className={cn(
            'text-[12px] leading-snug',
            line.problem
              ? 'text-[#b91c1c] dark:text-[#fca5a5]'
              : 'text-slate-800 dark:text-foreground'
          )}
        >
          <span className={cn('font-medium', line.code && 'font-mono text-[11.5px] font-normal')}>
            {line.label}
          </span>
          {line.detail && (
            <span
              className={
                line.problem
                  ? 'text-[#b91c1c] dark:text-[#fca5a5]'
                  : 'text-slate-600 dark:text-muted-foreground'
              }
            >
              {' · '}
              {line.detail}
            </span>
          )}
        </p>
        {line.note && (
          <p className='mt-0.5 max-w-[70ch] text-[11.5px] leading-snug text-slate-600 dark:text-muted-foreground'>
            {capitalFirst(line.note)}
          </p>
        )}
        {line.values.length > 0 && (
          <ul data-run-log-values className='mt-1.5 flex flex-wrap gap-1'>
            {line.values.map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a log may list a value twice and the list never reorders
              <li key={`${v}-${i}`} className={chipClass}>
                {v}
              </li>
            ))}
            {line.more != null && (
              <li className='px-1 py-0.5 text-[11px] text-slate-600 dark:text-muted-foreground'>
                {line.more === 'some' ? 'and more' : `and ${formatNumber(line.more)} more`}
              </li>
            )}
          </ul>
        )}
      </div>
      {line.time ? (
        <span
          data-run-log-time
          className='text-right font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-foreground'
        >
          {line.time}
        </span>
      ) : (
        <span />
      )}
    </li>
  )
}

const capitalFirst = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function LogError({ error }: { error: ImportLogError }) {
  const [all, setAll] = useState(false)
  const shown = all ? error.values : error.values.slice(0, LOG_VALUE_CAP)
  const repeats = error.values.reduce((a, v) => a + v.count, 0)
  return (
    <div
      data-run-log-error
      className='rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2.5 dark:border-[#7f1d1d] dark:bg-[#2a1215]'
    >
      {error.source && (
        <p className='text-[11.5px] text-[#7f1d1d] dark:text-[#fecaca]'>
          Stopped in <span className='font-mono'>{error.source}</span>
        </p>
      )}
      {error.message ? (
        <p
          className={cn(
            'max-w-[75ch] break-words text-[12.5px] leading-relaxed text-[#7f1d1d] dark:text-[#fee2e2]',
            error.source && 'mt-1'
          )}
        >
          {error.message}
        </p>
      ) : error.values.length === 0 ? (
        <p
          className={cn('text-[12.5px] text-[#7f1d1d] dark:text-[#fee2e2]', error.source && 'mt-1')}
        >
          The database gave no reason.
        </p>
      ) : null}
      {error.values.length > 0 && (
        <>
          <p
            className={cn(
              'text-[12.5px] font-medium text-[#7f1d1d] dark:text-[#fee2e2]',
              error.source && 'mt-1'
            )}
          >
            {error.list_label}
            <span className='font-normal tabular-nums'>
              {' · '}
              {formatNumber(error.values.length)} value{error.values.length === 1 ? '' : 's'}
              {repeats > error.values.length && `, ${formatNumber(repeats)} rows`}
            </span>
          </p>
          <ul data-run-log-values className='mt-1.5 flex flex-wrap gap-1'>
            {shown.map((v) => (
              <li
                key={v.value}
                className='rounded border border-[#fecaca] bg-[#ffffff] px-1.5 py-0.5 font-mono text-[11px] text-[#7f1d1d] dark:border-[#7f1d1d] dark:bg-[#1f0d10] dark:text-[#fee2e2]'
              >
                {v.value}
                {v.count > 1 && (
                  <span className='ml-1 font-sans tabular-nums text-[#991b1b] dark:text-[#fca5a5]'>
                    ×{v.count}
                  </span>
                )}
              </li>
            ))}
            {error.values.length > shown.length && (
              <li>
                <button
                  type='button'
                  onClick={() => setAll(true)}
                  className={cn(
                    'rounded px-1 py-0.5 text-[11px] font-medium text-[#7f1d1d] underline decoration-dotted underline-offset-2 dark:text-[#fee2e2]',
                    focusRing
                  )}
                >
                  Show {formatNumber(error.values.length - shown.length)} more
                </button>
              </li>
            )}
          </ul>
          {error.cut_off && (
            <p className='mt-1.5 text-[11.5px] text-[#7f1d1d] dark:text-[#fecaca]'>
              The list is longer than the log keeps. It ends here.
            </p>
          )}
        </>
      )}
      {error.statement && (
        <details className='mt-2'>
          <summary className='cursor-pointer select-none text-[11.5px] text-[#7f1d1d] dark:text-[#fecaca]'>
            The statement that failed
          </summary>
          <p className='mt-1 break-words font-mono text-[11px] leading-relaxed text-[#7f1d1d] dark:text-[#fee2e2]'>
            {error.statement}
          </p>
        </details>
      )}
    </div>
  )
}

function RunLog({ run }: { run: ImportRun }) {
  const [plain, setPlain] = useState(false)
  const log = useMemo(
    () => parseImportLog(run.logs, run.status === 'error'),
    [run.logs, run.status]
  )
  if (!run.logs) {
    return (
      <p className='mt-1.5 text-[12px] text-slate-600 dark:text-muted-foreground'>
        {run.status === 'completed' ? 'Completed with nothing to report.' : 'Nothing logged yet.'}
      </p>
    )
  }
  const failed = run.status === 'error'
  return (
    <div className='mt-2' data-run-log-body={plain ? 'plain' : 'read'}>
      {plain ? (
        <pre
          className={cn(
            'max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-md border px-3 py-2.5 font-mono text-[11.5px] leading-relaxed',
            failed
              ? 'border-[#fecaca] bg-[#fef2f2] text-[#7f1d1d] dark:border-[#7f1d1d] dark:bg-[#2a1215] dark:text-[#fee2e2]'
              : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted/30 dark:text-foreground'
          )}
        >
          {run.logs}
        </pre>
      ) : log.error ? (
        <LogError error={log.error} />
      ) : (
        <div className='overflow-hidden rounded-md border border-slate-200 dark:border-border'>
          <div
            data-run-log-headline
            className='flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-slate-50 px-3 py-2 dark:bg-muted/30'
          >
            {log.headline.map((part, i) => (
              <p
                // biome-ignore lint/suspicious/noArrayIndexKey: the headline is fixed text and never reorders
                key={`${part.label ?? part.text ?? ''}-${i}`}
                className='text-[12px] leading-snug text-slate-700 dark:text-foreground'
              >
                {part.label && (
                  <span className='font-semibold text-slate-900 dark:text-foreground'>
                    {part.label}{' '}
                  </span>
                )}
                {part.text}
                {part.figures.map((f, n) => (
                  <span key={f.word}>
                    {n > 0 && (
                      <span className='text-slate-500 dark:text-muted-foreground'>{' · '}</span>
                    )}
                    <span className='font-medium tabular-nums text-slate-900 dark:text-foreground'>
                      {f.value}
                    </span>{' '}
                    {f.word}
                  </span>
                ))}
              </p>
            ))}
            {log.time && (
              <span
                data-run-log-time
                className='ml-auto font-mono text-[11.5px] tabular-nums text-slate-700 dark:text-foreground'
              >
                {log.time}
              </span>
            )}
          </div>
          {log.lines.length > 0 && (
            <ul className='divide-y divide-slate-100 border-t border-slate-200 dark:divide-border/60 dark:border-border'>
              {log.lines.map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: two lines may read the same and the log never reorders
                <LogLine key={`${line.label}-${i}`} line={line} />
              ))}
            </ul>
          )}
        </div>
      )}
      <div className='mt-1.5 flex items-center gap-1'>
        <LogTools text={run.logs} />
        <TextButton data-run-log-plain onClick={() => setPlain((v) => !v)}>
          {plain ? 'Show as a list' : 'Show as written'}
        </TextButton>
      </div>
    </div>
  )
}
