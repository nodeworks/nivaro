import { toastError } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Download,
  GitBranch,
  RefreshCw,
  RotateCcw,
  ShieldAlert
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatDateTime, formatRelative } from '@/lib/utils'
import { type StoredSnapshotMeta, TriggerBadge } from './ConfigRestorePoints'

/**
 * Environments → Changed here (services/config-drift): configuration changed on this instance that
 * did not come from promotion — what, who, when and the field diff against what the last
 * promotion delivered. "Copy to dev" downloads a config file dev applies through its own Config
 * diff page (nothing is written across environments from here); "Mark as intended" stops it
 * nagging until the row changes again.
 */

type Kind = 'added' | 'changed' | 'removed'

interface DriftItem {
  id: string
  table: string
  key: string
  area: string
  label: string | null
  kind: Kind
  fields: Array<{ field: string; promoted: unknown; here: unknown }>
  who: { user_id: string | null; name: string | null } | null
  at: string | null
  evidence: 'activity' | 'row' | 'stamp' | 'apply' | 'none'
  evidence_note: string
  intended: { note: string | null; by: string | null; by_name: string | null; at: string } | null
}

interface DriftReport {
  environment: string
  active: boolean
  settings: { refuse_overwrite: boolean; baseline_snapshot_id: number | null; track_here: boolean }
  baseline: {
    snapshot_id: number
    taken_at: string
    trigger: string
    version: string | null
    pinned: boolean
  } | null
  items: DriftItem[]
  totals: { open: number; intended: number; tables: number }
  skipped: {
    personal: number
    local: number
    volatile_only: number
    tables_not_in_baseline: string[]
  }
  errors: Record<string, string>
  generated_at: string
}

const KIND: Record<Kind, { label: string; cls: string }> = {
  added: {
    label: 'Added here',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
  },
  changed: {
    label: 'Changed here',
    cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300'
  },
  removed: {
    label: 'Removed here',
    cls: 'bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300'
  }
}

function short(v: unknown): string {
  if (v === null || v === undefined) return '—'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
      <p className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>{label}</p>
      <p className={cn('mt-0.5 text-[17px] font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}

function FieldTable({ item }: { item: DriftItem }) {
  if (item.fields.length === 0) {
    return <p className='px-3 py-2 text-[11.5px] text-muted-foreground'>No field values to show.</p>
  }
  return (
    <table className='w-full text-[11.5px]' data-drift-fields={item.id}>
      <thead>
        <tr className='text-left text-[10.5px] uppercase tracking-wide text-muted-foreground'>
          <th className='w-[22%] px-3 py-1.5 font-medium'>Field</th>
          <th className='w-[39%] px-3 py-1.5 font-medium'>From promotion</th>
          <th className='w-[39%] px-3 py-1.5 font-medium'>Here now</th>
        </tr>
      </thead>
      <tbody>
        {item.fields.map((f) => (
          <tr key={f.field} className='border-t border-slate-100 align-top dark:border-border/60'>
            <td className='px-3 py-1.5 font-mono text-[11px]'>{f.field}</td>
            <td className='break-all px-3 py-1.5 font-mono text-[11px] text-red-700 dark:text-red-300'>
              {short(f.promoted)}
            </td>
            <td className='break-all px-3 py-1.5 font-mono text-[11px] text-emerald-700 dark:text-emerald-300'>
              {short(f.here)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ItemRow({
  item,
  selected,
  onSelect,
  onCopy
}: {
  item: DriftItem
  selected: boolean
  onSelect: (on: boolean) => void
  onCopy: () => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [marking, setMarking] = useState(false)
  const [note, setNote] = useState('')
  const mark = useMutation({
    mutationFn: (body: { ids: string[]; note?: string; reopen?: boolean }) =>
      api.post('/config-drift/mark', body),
    onSuccess: (_r, body) => {
      toast.success(body.reopen ? 'Reopened' : 'Marked as intended')
      setMarking(false)
      setNote('')
      void qc.invalidateQueries({ queryKey: ['config-drift'] })
    },
    onError: (e) => toastError(e, 'Could not save the mark')
  })
  const kind = KIND[item.kind]
  const who = item.who?.name ?? (item.who?.user_id ? 'Someone (no name on file)' : null)

  return (
    <div
      className='border-b border-slate-100 last:border-b-0 dark:border-border/60'
      data-drift-item={item.id}
    >
      <div className='flex flex-wrap items-start gap-2.5 px-3 py-2.5 sm:flex-nowrap'>
        {!item.intended && (
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onSelect(v === true)}
            aria-label={`Select ${item.label ?? item.id}`}
            className='mt-0.5'
          />
        )}
        <button
          type='button'
          onClick={() => setOpen((o) => !o)}
          className='mt-0.5 text-muted-foreground hover:text-foreground'
          aria-label={open ? 'Hide field diff' : 'Show field diff'}
        >
          {open ? <ChevronDown className='h-4 w-4' /> : <ChevronRight className='h-4 w-4' />}
        </button>
        <div className='min-w-0 flex-1 basis-[60%]'>
          <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
            <span
              className={cn(
                'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10.5px] font-medium',
                kind.cls
              )}
            >
              {kind.label}
            </span>
            <button
              type='button'
              onClick={() => setOpen((o) => !o)}
              className='truncate text-left text-[12.5px] font-medium hover:underline'
            >
              {item.label ?? `${item.table} #${item.key}`}
            </button>
            <span className='font-mono text-[11px] text-muted-foreground'>
              {item.table} #{item.key}
            </span>
          </div>
          <p className='mt-0.5 text-[11.5px] text-muted-foreground'>
            <span className='capitalize'>{item.area}</span>
            {' · '}
            {who ? (
              <span className='text-foreground'>{who}</span>
            ) : (
              <span className='italic'>no record of who</span>
            )}
            {item.at && (
              <>
                {' · '}
                <span data-tip={formatDateTime(item.at)}>{formatRelative(item.at)}</span>
              </>
            )}
            {' · '}
            <span data-tip={item.evidence_note} className='underline decoration-dotted'>
              {item.evidence === 'activity'
                ? 'from the activity log'
                : item.evidence === 'row'
                  ? 'from the row'
                  : item.evidence === 'stamp'
                    ? 'probably'
                    : item.evidence === 'apply'
                      ? 'applied from a file here'
                      : 'direct change?'}
            </span>
            {item.fields.length > 0 && item.kind === 'changed' && (
              <>
                {' · '}
                {item.fields.length} field{item.fields.length === 1 ? '' : 's'}:{' '}
                <span className='font-mono'>
                  {item.fields
                    .slice(0, 3)
                    .map((f) => f.field)
                    .join(', ')}
                  {item.fields.length > 3 ? '…' : ''}
                </span>
              </>
            )}
          </p>
          {item.intended && (
            <p className='mt-1 text-[11.5px] text-emerald-700 dark:text-emerald-300'>
              <CircleCheck className='mr-1 inline h-3.5 w-3.5 align-[-2px]' />
              Intended{item.intended.by_name ? ` — ${item.intended.by_name}` : ''},{' '}
              {formatRelative(item.intended.at)}
              {item.intended.note ? `: “${item.intended.note}”` : ''}
            </p>
          )}
          {marking && (
            <div className='mt-2 flex flex-wrap items-center gap-2'>
              <Input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder='Why it stays (e.g. agreed with ops, copy to dev next week)'
                className='h-8 max-w-[440px] flex-1 text-[12px]'
                maxLength={300}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && note.trim()) mark.mutate({ ids: [item.id], note })
                  if (e.key === 'Escape') setMarking(false)
                }}
              />
              <Button
                size='sm'
                className='h-8 text-[12px]'
                disabled={!note.trim() || mark.isPending}
                onClick={() => mark.mutate({ ids: [item.id], note })}
              >
                {mark.isPending ? 'Saving…' : 'Mark as intended'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-[12px]'
                onClick={() => setMarking(false)}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
        <div className='flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto'>
          {item.kind !== 'removed' && (
            <Button
              size='sm'
              variant='outline'
              className='h-7 gap-1 px-2 text-[11.5px]'
              onClick={onCopy}
              data-tip='Download this row as a config file dev can apply'
            >
              <GitBranch className='h-3.5 w-3.5' />
              Copy to dev
            </Button>
          )}
          {item.intended ? (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 gap-1 px-2 text-[11.5px]'
              disabled={mark.isPending}
              onClick={() => mark.mutate({ ids: [item.id], reopen: true })}
            >
              <RotateCcw className='h-3.5 w-3.5' />
              Reopen
            </Button>
          ) : (
            !marking && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 px-2 text-[11.5px]'
                onClick={() => setMarking(true)}
              >
                Mark as intended
              </Button>
            )
          )}
        </div>
      </div>
      {open && (
        <div className='mx-3 mb-3 overflow-hidden rounded-md border border-slate-200 bg-slate-50/60 dark:border-border dark:bg-background'>
          <p className='border-b border-slate-200 px-3 py-1.5 text-[11px] text-muted-foreground dark:border-border'>
            {item.evidence_note}
          </p>
          <FieldTable item={item} />
        </div>
      )}
    </div>
  )
}

export default function ConfigChangedHerePage() {
  const qc = useQueryClient()
  const [view, setView] = useState<'open' | 'intended'>('open')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [fresh, setFresh] = useState(0)

  const { data, isLoading, isFetching, error } = useQuery<DriftReport>({
    queryKey: ['config-drift', fresh],
    queryFn: () =>
      api
        .get<{ data: DriftReport }>('/config-drift', { params: fresh ? { fresh: 1 } : {} })
        .then((r) => r.data.data)
  })
  const { data: history } = useQuery<StoredSnapshotMeta[]>({
    queryKey: ['config-snapshot-history'],
    queryFn: () =>
      api.get<{ data: StoredSnapshotMeta[] }>('/config-diff/history').then((r) => r.data.data)
  })

  const settings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.put('/config-drift/settings', patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['config-drift'] })
    },
    onError: (e) => toastError(e, 'Could not save the setting')
  })

  const copy = useMutation({
    mutationFn: (ids: string[] | null) =>
      api.post<{ data: { instance: { database: string } } }>('/config-drift/bundle', { ids }),
    onSuccess: (r) => {
      const day = new Date().toISOString().slice(0, 10)
      downloadJson(`nivaro-changed-here-${r.data.data.instance.database}-${day}.json`, r.data.data)
      toast.success('Config file downloaded — upload it on dev under Environments → Config diff')
    },
    onError: (e) => toastError(e, 'Could not build the file')
  })

  const items = data?.items ?? []
  const shown = useMemo(
    () => items.filter((i) => (view === 'open' ? !i.intended : !!i.intended)),
    [items, view]
  )
  const openIds = useMemo(() => items.filter((i) => !i.intended).map((i) => i.id), [items])
  const baselineOptions = useMemo(() => {
    const list = (history ?? []).map((h) => ({
      value: String(h.id),
      label: `#${h.id} · ${formatDateTime(h.taken_at)} · ${h.trigger}${h.note ? ` — ${h.note}` : ''}`
    }))
    return [{ value: '', label: 'Newest promotion snapshot' }, ...list]
  }, [history])

  const markSelected = useMutation({
    mutationFn: (note: string) => api.post('/config-drift/mark', { ids: [...selected], note }),
    onSuccess: () => {
      toast.success(`${selected.size} marked as intended`)
      setSelected(new Set())
      void qc.invalidateQueries({ queryKey: ['config-drift'] })
    },
    onError: (e) => toastError(e, 'Could not save the marks')
  })
  const [bulkNote, setBulkNote] = useState('')

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Configuration changed on this instance that did not come from promotion: who changed it, when, and how it differs from what the last promotion delivered.'
        actions={
          <>
            <Button
              size='sm'
              variant='outline'
              className='h-8 gap-1.5 text-[12px]'
              disabled={isFetching}
              onClick={() => setFresh((n) => n + 1)}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <Button
              size='sm'
              className='h-8 gap-1.5 text-[12px]'
              disabled={!data?.totals.open || copy.isPending}
              onClick={() => copy.mutate(selected.size ? [...selected] : null)}
            >
              <Download className='h-3.5 w-3.5' />
              {selected.size ? `Copy ${selected.size} to dev` : 'Copy all to dev'}
            </Button>
          </>
        }
      />

      <div
        className='flex-1 space-y-4 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'
        data-config-drift=''
      >
        {isLoading && (
          <div className='space-y-2'>
            <Skeleton className='h-16 w-full' />
            <Skeleton className='h-40 w-full' />
          </div>
        )}
        {error && (
          <div className='rounded-lg border border-red-300 bg-white p-3 text-[12px] text-red-600 dark:border-red-500/40 dark:bg-card dark:text-red-400'>
            Could not read the changes made here. Try Refresh.
          </div>
        )}

        {data && !data.active && (
          <div className='flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
            <div className='min-w-0 flex-1'>
              <p className='text-[13px] font-medium'>
                Tracked on production — this instance is {data.environment}
              </p>
              <p className='mt-0.5 text-[12px] text-muted-foreground'>
                Production’s config should arrive by promotion. Here, changes made by hand are the
                normal way of working, so nothing is tracked unless you turn it on.
              </p>
            </div>
            <div className='flex items-center gap-2 text-[12px]'>
              <Switch
                id='drift-track-here'
                checked={data.settings.track_here}
                onCheckedChange={(v) => settings.mutate({ track_here: v })}
              />
              <label htmlFor='drift-track-here'>Track here anyway</label>
            </div>
          </div>
        )}

        {data?.active && (
          <>
            <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 lg:grid-cols-4 dark:border-border dark:bg-border'>
              <Stat
                label='Changed here'
                value={String(data.totals.open)}
                tone={data.totals.open ? 'text-amber-600 dark:text-amber-400' : undefined}
              />
              <Stat label='Marked as intended' value={String(data.totals.intended)} />
              <Stat label='Tables' value={String(data.totals.tables)} />
              <div className='bg-white px-3 py-2.5 dark:bg-card'>
                <p className='text-[10.5px] uppercase tracking-wide text-muted-foreground'>
                  Compared with
                </p>
                {data.baseline ? (
                  <p className='mt-1 flex flex-wrap items-center gap-1.5 text-[12px]'>
                    <TriggerBadge trigger={data.baseline.trigger} />
                    <span className='font-medium'>#{data.baseline.snapshot_id}</span>
                    <span className='text-muted-foreground'>
                      {formatDateTime(data.baseline.taken_at)}
                      {data.baseline.pinned ? ' · chosen by hand' : ''}
                    </span>
                  </p>
                ) : (
                  <p className='mt-1 text-[12px] text-amber-700 dark:text-amber-300'>
                    No promotion stored yet
                  </p>
                )}
              </div>
            </div>

            <div className='flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-border dark:bg-card'>
              <div className='flex items-center gap-2 text-[12px]'>
                <Switch
                  id='drift-refuse'
                  checked={data.settings.refuse_overwrite}
                  onCheckedChange={(v) => settings.mutate({ refuse_overwrite: v })}
                />
                <label htmlFor='drift-refuse'>
                  <span className='font-medium'>Refuse promotions</span> that would overwrite an
                  unmarked change (off = warn only)
                </label>
              </div>
              <div className='flex min-w-[280px] flex-1 items-center gap-2 text-[12px]'>
                <span className='shrink-0 text-muted-foreground'>Last promotion</span>
                <SimpleSelect
                  value={
                    data.settings.baseline_snapshot_id
                      ? String(data.settings.baseline_snapshot_id)
                      : ''
                  }
                  onChange={(v) => settings.mutate({ baseline_snapshot_id: v ? Number(v) : null })}
                  options={baselineOptions}
                  ariaLabel='Restore point to compare with'
                  className='h-8 max-w-[440px] text-[12px]'
                />
              </div>
            </div>

            {!data.baseline ? (
              <div className='rounded-lg border border-amber-300 bg-white p-4 dark:border-amber-500/40 dark:bg-card'>
                <p className='flex items-center gap-2 text-[13px] font-medium'>
                  <ShieldAlert className='h-4 w-4 text-amber-600 dark:text-amber-400' />
                  Nothing to compare with yet
                </p>
                <p className='mt-1 max-w-[80ch] text-[12px] text-muted-foreground'>
                  The promote chain stores a snapshot right after it copies config here (POST
                  /api/config-diff/history with trigger “promote”). Until the next promotion, choose
                  the restore point taken right after the last one under Last promotion.
                </p>
              </div>
            ) : (
              <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
                <div className='flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
                  <div className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
                    {(['open', 'intended'] as const).map((v) => (
                      <button
                        key={v}
                        type='button'
                        onClick={() => setView(v)}
                        className={cn(
                          'rounded px-2.5 py-1 text-[11.5px] font-medium',
                          view === v
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-muted'
                        )}
                      >
                        {v === 'open'
                          ? `Changed here (${data.totals.open})`
                          : `Marked as intended (${data.totals.intended})`}
                      </button>
                    ))}
                  </div>
                  {view === 'open' && openIds.length > 0 && (
                    <div className='ml-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground'>
                      <Checkbox
                        id='drift-select-all'
                        checked={selected.size > 0 && selected.size === openIds.length}
                        onCheckedChange={(v) =>
                          setSelected(v === true ? new Set(openIds) : new Set())
                        }
                        aria-label='Select all'
                      />
                      <label htmlFor='drift-select-all'>All</label>
                    </div>
                  )}
                  {selected.size > 0 && (
                    <div className='ml-auto flex flex-wrap items-center gap-2'>
                      <span className='text-[11.5px] text-muted-foreground'>
                        {selected.size} selected
                      </span>
                      <Input
                        value={bulkNote}
                        onChange={(e) => setBulkNote(e.target.value)}
                        placeholder='Why they stay'
                        className='h-7 w-[220px] text-[11.5px]'
                        maxLength={300}
                      />
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-7 px-2 text-[11.5px]'
                        disabled={!bulkNote.trim() || markSelected.isPending}
                        onClick={() => markSelected.mutate(bulkNote)}
                      >
                        Mark as intended
                      </Button>
                    </div>
                  )}
                </div>
                {shown.length === 0 ? (
                  <div className='p-8 text-center'>
                    <p className='text-[13px] font-medium text-emerald-600 dark:text-emerald-400'>
                      {view === 'open'
                        ? 'Matches the last promotion'
                        : 'Nothing marked as intended'}
                    </p>
                    <p className='mt-1 text-[12px] text-muted-foreground'>
                      {view === 'open'
                        ? 'Every config row here is what the promotion delivered (or is marked as intended).'
                        : 'Marks stay while the row stays as it was when marked.'}
                    </p>
                  </div>
                ) : (
                  shown.map((it) => (
                    <ItemRow
                      key={it.id}
                      item={it}
                      selected={selected.has(it.id)}
                      onSelect={(on) =>
                        setSelected((s) => {
                          const n = new Set(s)
                          if (on) n.add(it.id)
                          else n.delete(it.id)
                          return n
                        })
                      }
                      onCopy={() => copy.mutate([it.id])}
                    />
                  ))
                )}
              </div>
            )}

            <div className='space-y-1 text-[11.5px] text-muted-foreground'>
              <p>
                <span className='font-medium text-foreground'>Copy to dev</span> downloads a config
                file. On dev, open Environments → Config diff, choose Compare a snapshot, then Apply
                per table (upsert only — a row removed here has to be removed on dev by hand).
              </p>
              {(data.skipped.personal > 0 ||
                data.skipped.local > 0 ||
                data.skipped.volatile_only > 0) && (
                <p>
                  Not listed: {data.skipped.personal} personal saved view
                  {data.skipped.personal === 1 ? '' : 's'}, {data.skipped.local} rows this instance
                  keeps for itself, {data.skipped.volatile_only} rows that differ only in run stamps
                  or counters.
                </p>
              )}
              {data.skipped.tables_not_in_baseline.length > 0 && (
                <p>
                  Not compared (the promotion snapshot predates them):{' '}
                  <span className='font-mono'>
                    {data.skipped.tables_not_in_baseline.join(', ')}
                  </span>
                </p>
              )}
              {Object.keys(data.errors).length > 0 && (
                <p className='text-red-600 dark:text-red-400'>
                  Could not read: {Object.keys(data.errors).join(', ')}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
