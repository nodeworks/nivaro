import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Clock, RotateCcw } from 'lucide-react'
import { useState, useMemo } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, formatRelative } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../ui/sheet'
import { Skeleton } from '../ui/skeleton'

export interface O2MFieldInfo {
  field: string
  label: string
  relatedCollection: string
  manyField: string
  parentId: string
}

interface Revision {
  id: string
  collection: string
  item: string
  action: string | null
  data: Record<string, unknown>
  delta: Record<string, unknown> | null
  timestamp: string | null
  user_id: string | null
  user_email: string | null
  first_name: string | null
  last_name: string | null
}

const ACTION_VARIANTS: Record<string, 'default' | 'success' | 'destructive' | 'secondary'> = {
  create: 'success',
  update: 'default',
  delete: 'destructive'
}

function revisionUserName(rev: Revision): string {
  if (rev.first_name || rev.last_name)
    return [rev.first_name, rev.last_name].filter(Boolean).join(' ')
  return rev.user_email ?? rev.user_id?.slice(0, 8) ?? 'System'
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const TRUNCATE_AT = 120

function ValueCell({ value, tone }: { value: unknown; tone: 'before' | 'after' }) {
  const [expanded, setExpanded] = useState(false)
  const str = stringifyValue(value)
  if (value === null || value === undefined || str === '')
    return <span className='text-slate-300 dark:text-slate-600 italic text-[11px]'>—</span>
  const isLong = str.length > TRUNCATE_AT
  const shown = expanded || !isLong ? str : `${str.slice(0, TRUNCATE_AT)}…`
  return (
    <span className='break-all text-[11px] text-slate-700 dark:text-slate-300'>
      {typeof value === 'object' ? <span className='font-mono text-[10.5px]'>{shown}</span> : shown}
      {isLong && (
        <button
          type='button'
          onClick={() => setExpanded((e) => !e)}
          className={cn(
            'ml-1 text-[10px] font-medium hover:underline',
            tone === 'before' ? 'text-rose-500' : 'text-emerald-600'
          )}
        >
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </span>
  )
}

// ─── Structured JSON diffs (#73) ─────────────────────────────────────────────
// A changed JSON column (filters, config blobs) renders as a per-key diff
// instead of two unreadable blobs. Only plain objects qualify — arrays and
// scalars keep the raw cells.
function parseJsonObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(v)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      return null
    }
  }
  return null
}

function JsonKeyDiff({
  before,
  after
}: {
  before: Record<string, unknown>
  after: Record<string, unknown>
}) {
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  const rows = keys
    .map((k) => {
      const b = k in before ? JSON.stringify(before[k]) : undefined
      const a = k in after ? JSON.stringify(after[k]) : undefined
      if (b === a) return null
      return { k, b, a }
    })
    .filter(Boolean) as Array<{ k: string; b?: string; a?: string }>
  if (rows.length === 0)
    return <span className='text-[11px] italic text-slate-400'>keys reordered only</span>
  const clip = (x?: string) => (x == null ? undefined : x.length > 60 ? `${x.slice(0, 60)}…` : x)
  return (
    <div className='space-y-0.5' data-json-diff>
      {rows.map(({ k, b, a }) => (
        <p key={k} className='text-[11px]'>
          <span className='font-mono text-[10.5px] text-slate-500'>{k}</span>:{' '}
          {b !== undefined && (
            <span className='text-rose-600 line-through dark:text-rose-400'>{clip(b)}</span>
          )}
          {b !== undefined && a !== undefined && ' → '}
          {a !== undefined ? (
            <span className='text-emerald-700 dark:text-emerald-400'>{clip(a)}</span>
          ) : (
            <span className='italic text-slate-400'> (removed)</span>
          )}
        </p>
      ))}
    </div>
  )
}

type FieldStatus = 'added' | 'removed' | 'changed' | 'unchanged'
const STATUS_ROW_CLS: Record<FieldStatus, string> = {
  added: 'bg-emerald-50/70 dark:bg-emerald-950/20',
  removed: 'bg-red-50/70 dark:bg-red-950/20',
  changed: 'bg-amber-50/70 dark:bg-amber-950/20',
  unchanged: ''
}

function SideBySideView({
  before,
  after
}: {
  before: Record<string, unknown>
  after: Record<string, unknown>
}) {
  const fields = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  if (fields.length === 0)
    return <p className='text-[12px] text-slate-400'>No snapshot data available.</p>
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
      <div className='grid grid-cols-[1fr_1fr] border-b border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'>
        <div className='px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400'>
          Before
        </div>
        <div className='border-l border-slate-200 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:border-border'>
          After
        </div>
      </div>
      {fields.map((field) => {
        const inBefore = field in before && before[field] !== undefined
        const inAfter = field in after && after[field] !== undefined
        const status: FieldStatus = !inBefore
          ? 'added'
          : !inAfter
            ? 'removed'
            : stringifyValue(before[field]) !== stringifyValue(after[field])
              ? 'changed'
              : 'unchanged'
        return (
          <div
            key={field}
            className={cn(
              'border-b border-slate-100 last:border-0 dark:border-border/60',
              STATUS_ROW_CLS[status]
            )}
          >
            <div className='flex items-center gap-1.5 px-2.5 pt-1.5'>
              <span className='font-mono text-[10.5px] text-slate-500'>{field}</span>
              {status !== 'unchanged' && (
                <span
                  className={cn(
                    'rounded px-1 py-px text-[9px] font-semibold uppercase',
                    status === 'added' &&
                      'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400',
                    status === 'removed' &&
                      'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
                    status === 'changed' &&
                      'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                  )}
                >
                  {status}
                </span>
              )}
            </div>
            {status === 'changed' && (isRichText(before[field]) || isRichText(after[field])) ? (
              <div className='px-2.5 py-1.5' data-richtext-diff>
                <WordDiff before={before[field]} after={after[field]} />
              </div>
            ) : status === 'changed' &&
              parseJsonObject(before[field]) &&
              parseJsonObject(after[field]) ? (
              <div className='px-2.5 py-1.5'>
                <JsonKeyDiff
                  before={parseJsonObject(before[field]) as Record<string, unknown>}
                  after={parseJsonObject(after[field]) as Record<string, unknown>}
                />
              </div>
            ) : (
              <div className='grid grid-cols-[1fr_1fr]'>
                <div className='px-2.5 py-1.5'>
                  {inBefore ? (
                    <ValueCell value={before[field]} tone='before' />
                  ) : (
                    <span className='text-[11px] italic text-slate-300 dark:text-slate-600'>
                      not set
                    </span>
                  )}
                </div>
                <div className='border-l border-slate-100 px-2.5 py-1.5 dark:border-border/60'>
                  {inAfter ? (
                    <ValueCell value={after[field]} tone='after' />
                  ) : (
                    <span className='text-[11px] italic text-slate-300 dark:text-slate-600'>
                      removed
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Rich-text word diff (#45) ───────────────────────────────────────────────
// A changed rich-text field renders as ONE word-level inline diff (green/red)
// instead of two HTML blobs nobody can compare by eye.

function isRichText(v: unknown): boolean {
  return typeof v === 'string' && /<[a-z][^>]*>/i.test(v)
}

function stripToWords(v: unknown): string[] {
  return String(v ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .split(/\s+/)
    .filter(Boolean)
}

type DiffSeg = { text: string; type: 'same' | 'del' | 'ins' }

/** Word-level LCS diff, capped — past the cap the tail is compared blockwise
 *  rather than blowing up the DP table. */
function diffWords(aRaw: unknown, bRaw: unknown): DiffSeg[] {
  const CAP = 600
  const a = stripToWords(aRaw).slice(0, CAP)
  const b = stripToWords(bRaw).slice(0, CAP)
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const segs: DiffSeg[] = []
  const pushSeg = (type: DiffSeg['type'], word: string) => {
    const last = segs[segs.length - 1]
    if (last && last.type === type) last.text += ` ${word}`
    else segs.push({ text: word, type })
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pushSeg('same', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      pushSeg('del', a[i])
      i++
    } else {
      pushSeg('ins', b[j])
      j++
    }
  }
  while (i < n) pushSeg('del', a[i++])
  while (j < m) pushSeg('ins', b[j++])
  return segs
}

function WordDiff({ before, after }: { before: unknown; after: unknown }) {
  const segs = diffWords(before, after)
  return (
    <p className='whitespace-pre-wrap break-words text-[11.5px] leading-relaxed text-slate-700 dark:text-slate-300'>
      {segs.map((seg, i) =>
        seg.type === 'same' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <span key={i}>{seg.text} </span>
        ) : seg.type === 'del' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <del key={i} className='rounded bg-red-100 px-0.5 text-red-700 no-underline line-through dark:bg-red-900/40 dark:text-red-400'>
            {seg.text}{' '}
          </del>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static segment list
          <ins key={i} className='rounded bg-emerald-100 px-0.5 text-emerald-700 no-underline dark:bg-emerald-900/40 dark:text-emerald-400'>
            {seg.text}{' '}
          </ins>
        )
      )}
    </p>
  )
}

function DeltaView({ delta }: { delta: Record<string, unknown> }) {
  const entries = Object.entries(delta)
  if (entries.length === 0) return <p className='text-[12px] text-slate-400'>No changes recorded</p>
  return (
    <table className='w-full text-[12px]'>
      <thead>
        <tr className='text-left text-slate-400'>
          <th className='pr-4 pb-1 font-medium w-2/5'>Field</th>
          <th className='pb-1 font-medium'>New value</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([field, value]) => (
          <tr key={field} className='border-t border-slate-100'>
            <td className='pr-4 py-1.5 font-mono text-slate-500 align-top'>{field}</td>
            <td className='py-1.5 text-slate-700 break-all align-top'>
              {value === null || value === undefined ? (
                <span className='text-slate-400 italic'>null</span>
              ) : typeof value === 'object' ? (
                <span className='font-mono text-[11px] text-slate-500'>
                  {JSON.stringify(value)}
                </span>
              ) : isRichText(value) ? (
                <span className='whitespace-pre-wrap'>
                  {stripToWords(value).join(' ').slice(0, 600)}
                </span>
              ) : (
                String(value)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function SnapshotDataView({ data }: { data: Record<string, unknown> }) {
  return (
    <pre className='text-[11px] font-mono text-slate-600 bg-slate-50 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all max-h-64'>
      {JSON.stringify(data, null, 2)}
    </pre>
  )
}

function RevisionRow({
  revision,
  previousData,
  onRollback,
  inlineTableFields
}: {
  revision: Revision
  previousData: Record<string, unknown> | null
  onRollback?: () => void
  inlineTableFields?: O2MFieldInfo[]
}) {
  const client = useNivaroClient()
  const [expanded, setExpanded] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [view, setView] = useState<'delta' | 'side'>('side')
  const [o2mRestoring, setO2MRestoring] = useState<string | null>(null)
  const isUpdate = revision.action === 'update'
  const isCreate = revision.action === 'create'
  const isDelete = revision.action === 'delete'
  const sideBefore: Record<string, unknown> = isDelete
    ? (revision.data ?? {})
    : isCreate
      ? {}
      : (previousData ?? {})
  const sideAfter: Record<string, unknown> = isDelete ? {} : (revision.data ?? {})
  const deltaCount = revision.delta ? Object.keys(revision.delta).length : 0
  const canRollback = isUpdate || isCreate

  const [rolledBackAt, setRolledBackAt] = useState<string | null>(null)

  const rollbackMut = useMutation({
    mutationFn: () => client.request(post(`/revisions/${revision.id}/rollback`, {})),
    onSuccess: () => {
      setConfirmRollback(false)
      toast.success('Rolled back to this revision')
      if (inlineTableFields?.length && revision.timestamp) setRolledBackAt(revision.timestamp)
      onRollback?.()
    },
    onError: () => toast.error('Failed to rollback')
  })

  async function restoreO2MField(f: O2MFieldInfo) {
    if (!rolledBackAt) return
    setO2MRestoring(f.field)
    try {
      await client.request(post('/revisions/o2m-restore', {
        collection: f.relatedCollection,
        many_field: f.manyField,
        parent_id: f.parentId,
        target_timestamp: rolledBackAt
      }))
      toast.success(`Restored ${f.label}`)
    } catch {
      toast.error(`Failed to restore ${f.label}`)
    } finally {
      setO2MRestoring(null)
    }
  }

  return (
    <div className='border-b last:border-0 border-slate-100'>
      <button
        type='button'
        onClick={() => setExpanded((e) => !e)}
        className='w-full flex items-center gap-2.5 py-3 text-left hover:bg-slate-50 transition-colors px-1 rounded'
      >
        {expanded ? (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400 shrink-0' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400 shrink-0' />
        )}
        <Badge
          variant={ACTION_VARIANTS[revision.action ?? ''] ?? 'secondary'}
          className='text-[10px] capitalize w-14 justify-center shrink-0'
        >
          {revision.action ?? '—'}
        </Badge>
        <span className='text-[12px] text-slate-700 flex-1 truncate'>
          {revisionUserName(revision)}
        </span>
        <div className='flex flex-col items-end gap-0.5 shrink-0'>
          {isUpdate && deltaCount > 0 && (
            <span className='text-[10px] text-slate-400'>
              {deltaCount} field{deltaCount !== 1 ? 's' : ''}
            </span>
          )}
          <span className='text-[11px] text-slate-400'>
            {revision.timestamp ? formatRelative(revision.timestamp) : '—'}
          </span>
        </div>
      </button>
      {expanded && (
        <div className='px-6 pb-3 space-y-2'>
          <div className='flex items-center justify-between'>
            <p className='text-[10px] font-medium text-slate-500'>
              {view === 'side'
                ? 'Before / After'
                : isUpdate && revision.delta
                  ? 'Changes'
                  : 'Snapshot'}
            </p>
            <div className='flex items-center overflow-hidden rounded border border-slate-200 dark:border-border'>
              {(['delta', 'side'] as const).map((v) => (
                <button
                  key={v}
                  type='button'
                  onClick={() => setView(v)}
                  className={
                    view === v
                      ? 'bg-nvr-cyan/10 px-2 py-0.5 text-[10px] font-medium text-nvr-navy dark:text-nvr-cyan'
                      : 'px-2 py-0.5 text-[10px] text-slate-400 transition-colors hover:text-slate-600'
                  }
                >
                  {v === 'delta' ? 'Delta' : 'Side-by-side'}
                </button>
              ))}
            </div>
          </div>
          {view === 'side' ? (
            <SideBySideView before={sideBefore} after={sideAfter} />
          ) : isUpdate && revision.delta ? (
            <DeltaView delta={revision.delta} />
          ) : (
            <SnapshotDataView data={revision.data} />
          )}
          {canRollback && (
            <div className='flex items-center justify-end gap-2 pt-1'>
              {confirmRollback ? (
                <>
                  <span className='text-[11px] text-slate-500'>Restore this revision?</span>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-6 text-[11px]'
                    disabled={rollbackMut.isPending}
                    onClick={() => rollbackMut.mutate()}
                  >
                    Yes, restore
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 text-[11px]'
                    onClick={() => setConfirmRollback(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size='sm'
                  variant='outline'
                  className='h-6 text-[11px]'
                  disabled={rollbackMut.isPending}
                  onClick={() => setConfirmRollback(true)}
                >
                  <RotateCcw className='mr-1 h-3 w-3' />
                  Rollback
                </Button>
              )}
            </div>
          )}
          {rolledBackAt && inlineTableFields && inlineTableFields.length > 0 && (
            <div className='mt-2 rounded border border-slate-100 bg-slate-50 p-2 space-y-1.5'>
              <p className='text-[10px] font-medium text-slate-500'>Also restore related rows?</p>
              {inlineTableFields.map(f => (
                <div key={f.field} className='flex items-center justify-between gap-2'>
                  <span className='text-[11px] text-slate-600'>{f.label}</span>
                  <button
                    type='button'
                    disabled={o2mRestoring === f.field}
                    onClick={() => restoreO2MField(f)}
                    className='rounded border border-[#00ceff]/40 px-2 py-0.5 text-[10px] font-medium text-[#00ceff] hover:bg-[#00ceff]/10 disabled:opacity-40'
                  >
                    {o2mRestoring === f.field ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RevisionsList({
  collection,
  item,
  onRollback,
  inlineTableFields
}: {
  collection: string
  item: string
  onRollback?: () => void
  inlineTableFields?: O2MFieldInfo[]
}) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['revisions', collection, item],
    queryFn: () =>
      client
        .request<{ data: Revision[] }>(get('/revisions', { collection, item }))
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })
  const count = data?.length ?? 0
  // Time travel: pick a date, see the record as it was then — the latest
  // snapshot at or before that moment. Every revision already carries the
  // FULL post-change snapshot, so this is a lookup, not a reconstruction.
  const [asOf, setAsOf] = useState('')
  // Between-dates diff (#60): two dates → field-level diff of what changed in
  // the window, each field attributed to whoever changed it LAST inside the
  // window (walked from the revision deltas — attribution is exact, not
  // inferred from the endpoint snapshots).
  const [diffFrom, setDiffFrom] = useState('')
  const [diffTo, setDiffTo] = useState('')
  const betweenDiff = useMemo<
    | { error: string; fields?: undefined }
    | {
        error?: undefined
        fields: Array<{
          field: string
          from: unknown
          to: unknown
          by: { name: string; when: string | null } | null
        }>
      }
    | null
  >(() => {
    if (!diffFrom || !diffTo || !data) return null
    const fromCut = new Date(`${diffFrom}T23:59:59`).getTime()
    const toCut = new Date(`${diffTo}T23:59:59`).getTime()
    if (toCut <= fromCut) return { error: 'The second date must be after the first' }
    const at = (cut: number) =>
      data.find((r) => r.timestamp && new Date(r.timestamp).getTime() <= cut) ?? null
    const base = at(fromCut)
    const end = at(toCut)
    if (!end) return { error: 'No snapshot exists at or before the second date' }
    const baseData = base?.data ?? {}
    const endData = end.data ?? {}
    // Who touched each field in the window — newest revision wins per field.
    const who = new Map<string, { name: string; when: string | null }>()
    for (const r of [...data].reverse()) {
      const t = r.timestamp ? new Date(r.timestamp).getTime() : 0
      if (t <= fromCut || t > toCut || !r.delta) continue
      for (const f of Object.keys(r.delta)) {
        who.set(f, { name: revisionUserName(r), when: r.timestamp })
      }
    }
    const fields = [...new Set([...Object.keys(baseData), ...Object.keys(endData)])]
      .filter((f) => String(baseData[f] ?? '') !== String(endData[f] ?? ''))
      .map((f) => ({
        field: f,
        from: baseData[f],
        to: endData[f],
        by: who.get(f) ?? null
      }))
    return { fields }
  }, [diffFrom, diffTo, data])
  const asOfRevision = useMemo(() => {
    if (!asOf || !data) return null
    const cutoff = new Date(`${asOf}T23:59:59`).getTime()
    // data is newest-first — first row at/before the cutoff wins.
    return (
      data.find((r) => r.timestamp && new Date(r.timestamp).getTime() <= cutoff) ?? null
    )
  }, [asOf, data])
  if (isLoading)
    return (
      <div className='space-y-2 pt-2'>
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className='h-10 rounded' />
        ))}
      </div>
    )
  if (count === 0)
    return <p className='text-[13px] text-slate-400 pt-4'>No revisions recorded yet.</p>
  return (
    <div className='pt-2'>
      <div className='mb-2 flex items-center gap-2'>
        <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
          View record as of
        </span>
        <input
          type='date'
          value={asOf}
          onChange={(e) => setAsOf(e.target.value)}
          className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
          aria-label='View record as of date'
          data-as-of
        />
        {asOf && (
          <button
            type='button'
            onClick={() => setAsOf('')}
            className='text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          >
            Clear
          </button>
        )}
      </div>
      {asOf && !asOfRevision && (
        <p className='mb-2 text-[12px] text-slate-400'>
          No snapshot exists at or before that date — the record is newer.
        </p>
      )}
      {asOfRevision && (
        <div className='mb-3 overflow-hidden rounded-lg border border-nvr-cyan/40'>
          <div className='flex items-center gap-2 border-b border-slate-200 bg-[#f0fbff] px-2.5 py-1.5 dark:border-border dark:bg-nvr-cyan/10'>
            <span className='text-[11px] font-semibold text-slate-700 dark:text-slate-200'>
              Record as of{' '}
              {asOfRevision.timestamp ? new Date(asOfRevision.timestamp).toLocaleString() : asOf}
            </span>
          </div>
          <div className='max-h-80 overflow-y-auto'>
            {Object.entries(asOfRevision.data ?? {})
              .filter(([, v]) => v !== null && v !== undefined && v !== '')
              .map(([k, v]) => (
                <div
                  key={k}
                  className='flex items-start gap-2 border-b border-slate-100 px-2.5 py-1 last:border-0 dark:border-border/60'
                >
                  <span className='w-[38%] shrink-0 break-all font-mono text-[10.5px] text-slate-500'>
                    {k}
                  </span>
                  <span className='break-all text-[11px] text-slate-700 dark:text-slate-300'>
                    {typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 200)}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
      <div className='mb-2 flex flex-wrap items-center gap-2'>
        <span className='text-[11px] font-medium text-slate-500 dark:text-slate-400'>
          Compare between
        </span>
        <input
          type='date'
          value={diffFrom}
          onChange={(e) => setDiffFrom(e.target.value)}
          className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
          aria-label='Compare from date'
          data-diff-from
        />
        <span className='text-[11px] text-slate-400'>and</span>
        <input
          type='date'
          value={diffTo}
          onChange={(e) => setDiffTo(e.target.value)}
          className='h-7 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
          aria-label='Compare to date'
          data-diff-to
        />
        {(diffFrom || diffTo) && (
          <button
            type='button'
            onClick={() => {
              setDiffFrom('')
              setDiffTo('')
            }}
            className='text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          >
            Clear
          </button>
        )}
      </div>
      {betweenDiff?.error != null && (
        <p className='mb-2 text-[12px] text-amber-600 dark:text-amber-400'>{betweenDiff?.error}</p>
      )}
      {betweenDiff?.fields != null && (
        <div className='mb-3 overflow-hidden rounded-lg border border-nvr-cyan/40' data-between-diff>
          <div className='border-b border-slate-200 bg-[#f0fbff] px-2.5 py-1.5 dark:border-border dark:bg-nvr-cyan/10'>
            <span className='text-[11px] font-semibold text-slate-700 dark:text-slate-200'>
              {betweenDiff.fields.length} field{betweenDiff.fields.length === 1 ? '' : 's'} changed
              between {diffFrom} and {diffTo}
            </span>
          </div>
          {betweenDiff.fields.length === 0 ? (
            <p className='px-2.5 py-3 text-[12px] text-slate-400'>
              Nothing changed in that window.
            </p>
          ) : (
            <div className='max-h-80 overflow-y-auto'>
              {betweenDiff.fields.map((f) => (
                <div
                  key={f.field}
                  className='border-b border-slate-100 px-2.5 py-1.5 last:border-0 dark:border-border/60'
                >
                  <div className='flex items-baseline justify-between gap-2'>
                    <span className='break-all font-mono text-[10.5px] text-slate-500'>
                      {f.field}
                    </span>
                    {f.by && (
                      <span className='shrink-0 text-[10px] text-slate-400'>
                        {f.by.name}
                        {f.by.when ? ` · ${new Date(f.by.when).toLocaleDateString()}` : ''}
                      </span>
                    )}
                  </div>
                  <p className='mt-0.5 break-all text-[11px]'>
                    <span className='text-red-500 line-through dark:text-red-400'>
                      {f.from == null || f.from === '' ? '—' : String(f.from).slice(0, 120)}
                    </span>{' '}
                    <span className='text-emerald-600 dark:text-emerald-400'>
                      {f.to == null || f.to === '' ? '—' : String(f.to).slice(0, 120)}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {(data ?? []).map((rev, i) => (
        <RevisionRow
          key={rev.id}
          revision={rev}
          previousData={data?.[i + 1]?.data ?? null}
          onRollback={onRollback}
          inlineTableFields={inlineTableFields}
        />
      ))}
    </div>
  )
}

export function RevisionsPanel({
  collection,
  item,
  onRollback,
  triggerClassName,
  inlineTableFields,
  open,
  onOpenChange
}: {
  collection: string
  item: string
  onRollback?: () => void
  triggerClassName?: string
  inlineTableFields?: O2MFieldInfo[]
  /** Controlled mode (no trigger button) — open the sheet programmatically,
   *  e.g. from a row Actions menu. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const controlled = open !== undefined
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {!controlled && (
        <SheetTrigger asChild>
          <Button variant='outline' size='sm' className={triggerClassName ?? 'gap-1.5'}>
            <Clock className='h-3.5 w-3.5' />
            History
          </Button>
        </SheetTrigger>
      )}
      <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-base'>
            <Clock className='h-4 w-4 text-slate-400' />
            Revision History
          </SheetTitle>
        </SheetHeader>
        <RevisionsList collection={collection} item={item} onRollback={onRollback} inlineTableFields={inlineTableFields} />
      </SheetContent>
    </Sheet>
  )
}
