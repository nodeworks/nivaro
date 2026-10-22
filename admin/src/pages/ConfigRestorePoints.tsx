import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History, RotateCcw, Undo2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn, formatFileSize, formatNumber } from '@/lib/utils'

/**
 * #2803 — every stored config snapshot is a restore point. Nightly, manual, before boot
 * migrations, before a deploy and before a restore (the restore's own undo). "Restore config to
 * this point" previews every config table the snapshot carries — per-table add / change / remove
 * counts and the rows themselves — then applies in one transaction, bound to that preview.
 */

export interface StoredSnapshotMeta {
  id: number
  taken_at: string
  version: string | null
  environment: string | null
  tables: number
  rows: number
  content_hash: string
  bytes: number
  trigger: string
  same_as_previous: boolean
  note?: string | null
}

type Op = 'insert' | 'update' | 'delete'

interface RowChange {
  key: string
  op: Op
  label: string | null
  fields: Array<{ field: string; now: unknown; was: unknown }>
}

interface TablePlan {
  table: string
  inserts: number
  updates: number
  deletes: number
  unchanged: number
  skipped_keyless: number
  untracked_only: number
  dropped_columns: string[]
  rows: RowChange[]
  more: number
}

interface RestorePreview {
  snapshot_id: number
  snapshot: {
    taken_at: string
    version: string
    environment: string
    database: string
    restore_point: { trigger: string; note?: string | null } | null
  }
  plan_hash: string
  tables: TablePlan[]
  refused: Array<{ table: string; reason: string }>
  totals: { inserts: number; updates: number; deletes: number; tables: number }
  warnings: string[]
  over_cap: boolean
}

interface RestoreResult {
  snapshot_id: number
  pre_restore_id: number | null
  tables: Array<{ table: string; inserted: number; updated: number; deleted: number }>
  totals: { inserted: number; updated: number; deleted: number }
}

const TRIGGER: Record<string, { label: string; cls: string }> = {
  cron: {
    label: 'Nightly',
    cls: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300'
  },
  manual: { label: 'Manual', cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  'pre-migration': {
    label: 'Before migration',
    cls: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
  },
  'pre-deploy': {
    label: 'Before deploy',
    cls: 'bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
  },
  'pre-restore': {
    label: 'Before restore',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
  }
}

export function TriggerBadge({ trigger, className }: { trigger: string; className?: string }) {
  const t = TRIGGER[trigger] ?? { label: trigger, cls: TRIGGER.cron.cls }
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-medium',
        t.cls,
        className
      )}
      data-config-trigger={trigger}
    >
      {t.label}
    </span>
  )
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

function short(v: unknown): string {
  if (v === null || v === undefined) return '—'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

function errText(e: unknown, fallback: string): string {
  return (
    (e as { response?: { data?: { error?: string } } }).response?.data?.error ??
    (e instanceof Error ? e.message : fallback)
  )
}

const OP: Record<Op, { label: string; cls: string }> = {
  insert: { label: 'Add back', cls: 'text-green-700 dark:text-green-400' },
  update: { label: 'Change back', cls: 'text-amber-700 dark:text-amber-400' },
  delete: { label: 'Remove', cls: 'text-red-700 dark:text-red-400' }
}

function PlanTableRow({
  plan,
  included,
  onToggle
}: {
  plan: TablePlan
  included: boolean
  onToggle: (on: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div
      className='border-b border-slate-200 last:border-0 dark:border-border'
      data-config-restore-table={plan.table}
    >
      <div className='flex items-center gap-2 px-3 py-2 hover:bg-muted'>
        <Checkbox
          checked={included}
          onCheckedChange={(v) => onToggle(v === true)}
          aria-label={`Restore ${plan.table}`}
          data-tip={included ? 'Leave this table as it is' : 'Restore this table too'}
        />
        <button
          type='button'
          onClick={() => setOpen((v) => !v)}
          className='flex min-w-0 flex-1 items-center gap-2 text-left'
        >
          <Chevron className='h-3.5 w-3.5 shrink-0 text-muted-foreground' />
          <span
            className={cn(
              'min-w-0 flex-1 truncate font-mono text-[12px]',
              !included && 'text-muted-foreground line-through'
            )}
          >
            {plan.table}
          </span>
          <span className='w-14 shrink-0 text-right text-[12px] tabular-nums text-green-600 dark:text-green-400'>
            {plan.inserts ? `+${plan.inserts}` : ''}
          </span>
          <span className='w-14 shrink-0 text-right text-[12px] tabular-nums text-amber-600 dark:text-amber-400'>
            {plan.updates ? `~${plan.updates}` : ''}
          </span>
          <span className='w-14 shrink-0 text-right text-[12px] tabular-nums text-red-600 dark:text-red-400'>
            {plan.deletes ? `−${plan.deletes}` : ''}
          </span>
          <span className='hidden w-24 shrink-0 text-right text-[11px] text-muted-foreground sm:block'>
            {formatNumber(plan.unchanged)} same
          </span>
        </button>
      </div>
      {open && (
        <div className='space-y-2 bg-slate-50 px-3 py-3 dark:bg-background'>
          {(plan.skipped_keyless > 0 ||
            plan.untracked_only > 0 ||
            plan.dropped_columns.length > 0) && (
            <p className='text-[11px] text-muted-foreground'>
              {plan.skipped_keyless > 0 &&
                `${plan.skipped_keyless} row(s) without an id are left as they are. `}
              {plan.untracked_only > 0 &&
                `${plan.untracked_only} row(s) differ only in columns added after this snapshot — nothing to put back. `}
              {plan.dropped_columns.length > 0 &&
                `Columns no longer on this table are not written: ${plan.dropped_columns.join(', ')}.`}
            </p>
          )}
          {plan.rows.map((row) => (
            <div
              key={`${row.op}:${row.key}`}
              className='rounded border border-slate-200 bg-white p-2 dark:border-border dark:bg-card'
            >
              <p className='mb-1 flex flex-wrap items-baseline gap-2 text-[11px]'>
                <span className={cn('font-semibold', OP[row.op].cls)}>{OP[row.op].label}</span>
                <span className='font-mono text-muted-foreground'>#{row.key}</span>
                {row.label && <span className='truncate'>{row.label}</span>}
              </p>
              {row.fields.length > 0 && (
                <div className='grid grid-cols-[minmax(90px,140px)_1fr_1fr] gap-x-2 gap-y-0.5'>
                  <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>
                    Field
                  </span>
                  <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>
                    Now
                  </span>
                  <span className='text-[10px] uppercase tracking-wide text-muted-foreground'>
                    After restore
                  </span>
                  {row.fields.map((f) => (
                    <div key={f.field} className='contents'>
                      <span className='truncate font-mono text-[10.5px]'>{f.field}</span>
                      <span className='break-all text-[10.5px] text-slate-600 dark:text-slate-300'>
                        {short(f.now)}
                      </span>
                      <span className='break-all text-[10.5px] text-slate-900 dark:text-slate-100'>
                        {short(f.was)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {plan.more > 0 && (
            <p className='text-[11px] text-muted-foreground'>
              +{formatNumber(plan.more)} more rows in this table — the counts above are exact.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function MetaCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className='bg-white px-3 py-2 dark:bg-card'>
      <p className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={cn('text-[16px] font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}

function RestorePanel({
  point,
  onClose,
  onRestored
}: {
  point: StoredSnapshotMeta
  onClose: () => void
  onRestored: (r: RestoreResult) => void
}) {
  // null = every table the preview plans; otherwise the tables the person kept ticked.
  const [scope, setScope] = useState<string[] | null>(null)
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stale, setStale] = useState(false)
  const [fresh, setFresh] = useState<RestorePreview | null>(null)
  const [showRefused, setShowRefused] = useState(false)

  const q = useQuery<RestorePreview>({
    queryKey: ['config-restore-preview', point.id, scope],
    queryFn: () =>
      api
        .post<{ data: RestorePreview }>(`/config-diff/history/${point.id}/restore`, {
          mode: 'preview',
          ...(scope ? { tables: scope } : {})
        })
        .then((r) => r.data.data),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false
  })
  const preview = fresh ?? q.data
  const planned = preview
    ? preview.totals.inserts + preview.totals.updates + preview.totals.deletes
    : 0
  const selectionChanged = excluded.size > 0

  async function apply() {
    if (!preview) return
    setBusy(true)
    setErr(null)
    setStale(false)
    try {
      const r = await api.post<{ data: RestoreResult }>(
        `/config-diff/history/${point.id}/restore`,
        {
          mode: 'apply',
          plan_hash: preview.plan_hash,
          ...(scope ? { tables: scope } : {})
        }
      )
      setConfirming(false)
      onRestored(r.data.data)
    } catch (e) {
      const data = (
        e as { response?: { status?: number; data?: { code?: string; preview?: RestorePreview } } }
      ).response
      if (data?.status === 409 && data.data?.code === 'STALE' && data.data.preview) {
        setFresh(data.data.preview)
        setStale(true)
      } else setErr(errText(e, 'Restore failed'))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  function previewAgain() {
    if (!preview) return
    const keep = preview.tables.map((t) => t.table).filter((t) => !excluded.has(t))
    setExcluded(new Set())
    setFresh(null)
    setStale(false)
    setConfirming(false)
    setScope(keep)
  }

  return (
    <div
      className='mt-3 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-config-restore-panel
    >
      <div className='flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-border'>
        <RotateCcw className='mt-0.5 h-4 w-4 shrink-0 text-muted-foreground' />
        <div className='min-w-0 flex-1'>
          <p className='flex flex-wrap items-center gap-2 text-[13px] font-semibold'>
            Restore config to {when(point.taken_at)}
            <TriggerBadge trigger={point.trigger} />
          </p>
          <p className='text-[11.5px] text-muted-foreground'>
            Configuration tables only — records are never touched. Rows added since are removed,
            changed rows are put back, removed rows come back with their ids.
          </p>
        </div>
        <button
          type='button'
          onClick={onClose}
          className='rounded p-1 text-muted-foreground hover:bg-muted'
          aria-label='Close'
          data-tip='Close'
        >
          <X className='h-4 w-4' />
        </button>
      </div>

      <div className='space-y-3 p-4'>
        {q.isFetching && !fresh && (
          <div className='space-y-2' data-config-restore-loading>
            <p className='text-[12px] text-muted-foreground'>
              Comparing every config table with this snapshot — this reads the whole configuration
              layer and can take half a minute…
            </p>
            <Skeleton className='h-14 w-full' />
            <Skeleton className='h-8 w-full' />
            <Skeleton className='h-8 w-full' />
          </div>
        )}
        {q.isError && !fresh && (
          <p className='text-[12px] text-red-600 dark:text-red-400'>
            {errText(q.error, 'Preview failed')}
          </p>
        )}

        {preview && !(q.isFetching && !fresh) && (
          <>
            {stale && (
              <div className='rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'>
                Configuration changed since you previewed — nothing was written. This is the new
                preview; check it and restore again.
              </div>
            )}
            {preview.warnings.map((w) => (
              <div
                key={w}
                className='rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
              >
                {w}
              </div>
            ))}

            <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 sm:grid-cols-4 dark:border-border dark:bg-border'>
              <MetaCell
                label='Add back'
                value={formatNumber(preview.totals.inserts)}
                tone='text-green-600 dark:text-green-400'
              />
              <MetaCell
                label='Change back'
                value={formatNumber(preview.totals.updates)}
                tone='text-amber-600 dark:text-amber-400'
              />
              <MetaCell
                label='Remove'
                value={formatNumber(preview.totals.deletes)}
                tone='text-red-600 dark:text-red-400'
              />
              <MetaCell label='Tables' value={String(preview.totals.tables)} />
            </div>

            {preview.tables.length === 0 ? (
              <p
                className='text-[12px] text-green-700 dark:text-green-400'
                data-config-restore-nothing
              >
                The configuration already matches this snapshot — nothing to restore.
              </p>
            ) : (
              <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
                <div className='flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-border dark:bg-background'>
                  <span className='flex-1 pl-6 text-[11px] font-medium'>Table</span>
                  <span className='w-14 text-right text-[10px] uppercase tracking-wide text-muted-foreground'>
                    add
                  </span>
                  <span className='w-14 text-right text-[10px] uppercase tracking-wide text-muted-foreground'>
                    change
                  </span>
                  <span className='w-14 text-right text-[10px] uppercase tracking-wide text-muted-foreground'>
                    remove
                  </span>
                  <span className='hidden w-24 sm:block' />
                </div>
                {preview.tables.map((t) => (
                  <PlanTableRow
                    key={t.table}
                    plan={t}
                    included={!excluded.has(t.table)}
                    onToggle={(on) => {
                      setConfirming(false)
                      setExcluded((prev) => {
                        const next = new Set(prev)
                        if (on) next.delete(t.table)
                        else next.add(t.table)
                        return next
                      })
                    }}
                  />
                ))}
              </div>
            )}

            {preview.refused.length > 0 && (
              <div>
                <button
                  type='button'
                  onClick={() => setShowRefused((v) => !v)}
                  className='flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground'
                >
                  {showRefused ? (
                    <ChevronDown className='h-3.5 w-3.5' />
                  ) : (
                    <ChevronRight className='h-3.5 w-3.5' />
                  )}
                  {preview.refused.length} table{preview.refused.length === 1 ? '' : 's'} in the
                  snapshot are never restored
                </button>
                {showRefused && (
                  <ul className='mt-1 space-y-0.5 pl-5'>
                    {preview.refused.map((r) => (
                      <li key={r.table} className='text-[11px] text-muted-foreground'>
                        <span className='font-mono text-foreground'>{r.table}</span> — {r.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {preview.over_cap && (
              <p className='text-[12px] text-red-600 dark:text-red-400'>
                Too many rows would change in one restore — untick tables and preview again.
              </p>
            )}
            {err && <p className='text-[12px] text-red-600 dark:text-red-400'>{err}</p>}

            {preview.tables.length > 0 && (
              <div className='flex flex-wrap items-center gap-2'>
                {selectionChanged ? (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-8 text-[12px]'
                    disabled={excluded.size >= preview.tables.length}
                    onClick={previewAgain}
                    data-config-restore-repreview
                  >
                    Preview again with {preview.tables.length - excluded.size} table
                    {preview.tables.length - excluded.size === 1 ? '' : 's'}
                  </Button>
                ) : !confirming ? (
                  <Button
                    size='sm'
                    className='h-8 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:opacity-90'
                    disabled={preview.over_cap || planned === 0}
                    onClick={() => setConfirming(true)}
                    data-config-restore-apply
                  >
                    <RotateCcw className='h-3.5 w-3.5' />
                    Restore {formatNumber(planned)} change{planned === 1 ? '' : 's'}…
                  </Button>
                ) : (
                  <span
                    className='flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[12px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300'
                    data-config-restore-confirm
                  >
                    Writes {formatNumber(planned)} rows across {preview.totals.tables} table
                    {preview.totals.tables === 1 ? '' : 's'}, all or nothing. A restore point of
                    these tables is stored first, so this can be undone.
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => void apply()}
                      className='font-semibold underline disabled:opacity-50'
                    >
                      {busy ? 'Restoring…' : 'Yes, restore'}
                    </button>
                    <button
                      type='button'
                      disabled={busy}
                      onClick={() => setConfirming(false)}
                      className='underline disabled:opacity-50'
                    >
                      Cancel
                    </button>
                  </span>
                )}
                {selectionChanged && (
                  <span className='text-[11.5px] text-muted-foreground'>
                    The restore is bound to the preview — preview the narrower set before restoring.
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ResultPanel({
  result,
  onUndo,
  onClose
}: {
  result: RestoreResult
  onUndo: (id: number) => void
  onClose: () => void
}) {
  return (
    <div
      className='mt-3 rounded-lg border border-green-300 bg-white p-4 dark:border-green-500/40 dark:bg-card'
      data-config-restore-result
    >
      <div className='flex items-start gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px] font-semibold text-green-700 dark:text-green-400'>
            Config restored to snapshot #{result.snapshot_id}
          </p>
          <p className='text-[12px] text-muted-foreground'>
            {formatNumber(result.totals.inserted)} added back, {formatNumber(result.totals.updated)}{' '}
            changed back, {formatNumber(result.totals.deleted)} removed across{' '}
            {result.tables.length} table
            {result.tables.length === 1 ? '' : 's'}. Open forms pick up the change.
          </p>
        </div>
        <button
          type='button'
          onClick={onClose}
          className='rounded p-1 text-muted-foreground hover:bg-muted'
          aria-label='Close'
        >
          <X className='h-4 w-4' />
        </button>
      </div>
      {result.tables.length > 0 && (
        <ul className='mt-2 grid gap-x-4 gap-y-0.5 sm:grid-cols-2'>
          {result.tables.map((t) => (
            <li key={t.table} className='flex gap-2 text-[11.5px]'>
              <span className='min-w-0 flex-1 truncate font-mono'>{t.table}</span>
              <span className='tabular-nums text-muted-foreground'>
                +{t.inserted} ~{t.updated} −{t.deleted}
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.pre_restore_id && (
        <Button
          size='sm'
          variant='outline'
          className='mt-3 h-8 gap-1.5 text-[12px]'
          onClick={() => onUndo(result.pre_restore_id as number)}
          data-config-restore-undo
        >
          <Undo2 className='h-3.5 w-3.5' />
          Undo this restore (restore point #{result.pre_restore_id})
        </Button>
      )}
    </div>
  )
}

const VISIBLE = 12

export function RestorePointsPanel() {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<number | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [showAll, setShowAll] = useState(false)
  const { data: history = [], isLoading } = useQuery<StoredSnapshotMeta[]>({
    queryKey: ['config-snapshots'],
    queryFn: () =>
      api.get<{ data: StoredSnapshotMeta[] }>('/config-diff/history').then((r) => r.data.data)
  })
  const shown = showAll ? history : history.slice(0, VISIBLE)
  const open = useMemo(() => history.find((h) => h.id === openId) ?? null, [history, openId])

  return (
    <section
      className='mb-6 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
      data-config-restore-points
    >
      <div className='flex items-start gap-2.5'>
        <History className='mt-0.5 h-4 w-4 shrink-0 text-muted-foreground' />
        <div className='min-w-0 flex-1'>
          <h2 className='text-[13px] font-semibold'>Restore points</h2>
          <p className='text-[12px] text-muted-foreground'>
            Every stored snapshot can put the configuration back — layouts, pipelines, roles and
            policies, queues, settings — without touching records. One is stored each night, before
            migrations run at boot, before each deploy and before every restore.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className='mt-3 space-y-1.5'>
          <Skeleton className='h-7 w-full' />
          <Skeleton className='h-7 w-full' />
          <Skeleton className='h-7 w-full' />
        </div>
      ) : history.length === 0 ? (
        <p className='mt-3 text-[12px] text-muted-foreground'>
          No restore points yet — the first lands tonight, or store a snapshot now.
        </p>
      ) : (
        <div className='mt-3 overflow-x-auto rounded-lg border border-slate-200 dark:border-border'>
          <table className='w-full text-[12px]'>
            <thead>
              <tr className='border-b border-slate-200 bg-slate-50 text-left text-[10.5px] uppercase tracking-wide text-muted-foreground dark:border-border dark:bg-background'>
                <th className='px-3 py-1.5 font-medium'>Taken</th>
                <th className='px-3 py-1.5 font-medium'>Kind</th>
                <th className='px-3 py-1.5 font-medium'>Version</th>
                <th className='px-3 py-1.5 font-medium'>Why</th>
                <th className='px-3 py-1.5 text-right font-medium'>Size</th>
                <th className='px-3 py-1.5' />
              </tr>
            </thead>
            <tbody>
              {shown.map((h) => (
                <tr
                  key={h.id}
                  className={cn(
                    'border-b border-slate-100 last:border-0 dark:border-border',
                    h.id === openId && 'bg-nvr-cyan/5 dark:bg-nvr-cyan/10'
                  )}
                  data-config-restore-point={h.id}
                >
                  <td className='whitespace-nowrap px-3 py-1.5 tabular-nums'>
                    {when(h.taken_at)}
                    <span className='ml-1.5 text-[10.5px] text-muted-foreground'>#{h.id}</span>
                  </td>
                  <td className='px-3 py-1.5'>
                    <TriggerBadge trigger={h.trigger} />
                  </td>
                  <td className='whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground'>
                    {h.version ?? '—'}
                  </td>
                  <td className='max-w-[420px] px-3 py-1.5'>
                    <span
                      className='line-clamp-1 text-muted-foreground'
                      data-tip={h.note ?? undefined}
                    >
                      {h.note ?? (h.same_as_previous ? 'Identical to the one before' : '—')}
                    </span>
                  </td>
                  <td
                    className='whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted-foreground'
                    data-tip={`${h.tables} tables · ${h.rows.toLocaleString()} rows`}
                  >
                    {h.tables} tables · {formatFileSize(h.bytes)}
                  </td>
                  <td className='whitespace-nowrap px-3 py-1.5 text-right'>
                    <button
                      type='button'
                      onClick={() => {
                        setResult(null)
                        setOpenId(h.id === openId ? null : h.id)
                      }}
                      className='rounded-md border border-slate-300 px-2 py-0.5 text-[11.5px] font-medium hover:bg-muted dark:border-border'
                      data-config-restore-open={h.id}
                    >
                      {h.id === openId ? 'Close' : 'Restore config to this point'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history.length > VISIBLE && (
            <button
              type='button'
              onClick={() => setShowAll((v) => !v)}
              className='w-full border-t border-slate-200 px-3 py-1.5 text-[11.5px] text-muted-foreground hover:bg-muted dark:border-border'
            >
              {showAll ? 'Show fewer' : `Show all ${history.length}`}
            </button>
          )}
        </div>
      )}

      {result && (
        <ResultPanel
          result={result}
          onClose={() => setResult(null)}
          onUndo={(id) => {
            setResult(null)
            setOpenId(id)
          }}
        />
      )}
      {open && !result && (
        <RestorePanel
          key={open.id}
          point={open}
          onClose={() => setOpenId(null)}
          onRestored={(r) => {
            setOpenId(null)
            setResult(r)
            void qc.invalidateQueries({ queryKey: ['config-snapshots'] })
            void qc.invalidateQueries({ queryKey: ['config-since'] })
            void qc.invalidateQueries({ queryKey: ['config-inventory'] })
          }}
        />
      )}
    </section>
  )
}
