import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Clock, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Revision } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

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

// ─── Side-by-side diff view ───────────────────────────────────────────────────

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

const TRUNCATE_AT = 120

function ValueCell({ value, tone }: { value: unknown; tone: 'before' | 'after' }) {
  const [expanded, setExpanded] = useState(false)
  const str = stringifyValue(value)
  if (value === null || value === undefined || str === '') {
    return <span className='text-slate-300 dark:text-slate-600 italic text-[11px]'>—</span>
  }
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
  if (fields.length === 0) {
    return <p className='text-[12px] text-slate-400'>No snapshot data available.</p>
  }
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
          </div>
        )
      })}
    </div>
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
  onRollback
}: {
  revision: Revision
  /** Full snapshot of the next-oldest revision — the "before" state of this one. */
  previousData: Record<string, unknown> | null
  onRollback?: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [view, setView] = useState<'delta' | 'side'>('delta')
  const isUpdate = revision.action === 'update'
  const isCreate = revision.action === 'create'
  const isDelete = revision.action === 'delete'

  // Side-by-side states: create → nothing before; delete → snapshot is the before state
  const sideBefore: Record<string, unknown> = isDelete
    ? (revision.data ?? {})
    : isCreate
      ? {}
      : (previousData ?? {})
  const sideAfter: Record<string, unknown> = isDelete ? {} : (revision.data ?? {})
  const deltaCount = revision.delta ? Object.keys(revision.delta).length : 0
  const canRollback = isUpdate || isCreate

  const rollbackMut = useMutation({
    mutationFn: () => api.post(`/revisions/${revision.id}/rollback`),
    onSuccess: () => {
      setConfirmRollback(false)
      toast.success('Rolled back to this revision')
      onRollback?.()
    },
    onError: () => toast.error('Failed to rollback')
  })

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
        </div>
      )}
    </div>
  )
}

const SKELETON_ROWS = [1, 2, 3, 4]

function RevisionsList({
  collection,
  item,
  onRollback
}: {
  collection: string
  item: string
  onRollback?: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['revisions', collection, item],
    queryFn: () =>
      api
        .get('/revisions', { params: { collection, item } })
        .then((r) => (r.data.data ?? []) as Revision[]),
    staleTime: 30 * 1000
  })

  const count = data?.length ?? 0

  if (isLoading) {
    return (
      <div className='space-y-2 pt-2'>
        {SKELETON_ROWS.map((i) => (
          <Skeleton key={i} className='h-10 rounded' />
        ))}
      </div>
    )
  }

  if (count === 0) {
    return <p className='text-[13px] text-slate-400 pt-4'>No revisions recorded yet.</p>
  }

  // Newest first — the "before" snapshot of a revision is the next (older) entry's data
  return (
    <div className='pt-2'>
      {(data ?? []).map((rev, i) => (
        <RevisionRow
          key={rev.id}
          revision={rev}
          previousData={data?.[i + 1]?.data ?? null}
          onRollback={onRollback}
        />
      ))}
    </div>
  )
}

export function RevisionsPanel({
  collection,
  item,
  onRollback,
  triggerClassName
}: {
  collection: string
  item: string
  onRollback?: () => void
  triggerClassName?: string
}) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant='outline' size='sm' className={triggerClassName ?? 'gap-1.5'}>
          <Clock className='h-3.5 w-3.5' />
          History
        </Button>
      </SheetTrigger>
      <SheetContent className='w-[420px] sm:max-w-[420px] overflow-y-auto'>
        <SheetHeader>
          <SheetTitle className='flex items-center gap-2 text-base'>
            <Clock className='h-4 w-4 text-slate-400' />
            Revision History
          </SheetTitle>
        </SheetHeader>
        <RevisionsList collection={collection} item={item} onRollback={onRollback} />
      </SheetContent>
    </Sheet>
  )
}
