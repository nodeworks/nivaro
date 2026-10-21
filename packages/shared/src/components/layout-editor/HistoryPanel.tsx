import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { layoutDraftKeys } from './useLayoutDraft'

interface VersionRow {
  id: number
  version: number
  note: string | null
  created_at: string
  created_by_name: string | null
}
interface DiffChange {
  field: string
  from: unknown
  to: unknown
}
interface DiffEntity {
  key: string
  label: string
  changes: DiffChange[]
}
interface DiffDto {
  from: { version: number | null; created_at: string | null; note: string | null }
  layout: DiffChange[]
  groups: { added: string[]; removed: string[]; changed: DiffEntity[] }
  assignments: { added: string[]; removed: string[]; changed: DiffEntity[] }
  warnings: string[]
  total: number
}

/**
 * A version is the state BEFORE the edit its note names ("Move field"), so
 * Restore on it undoes that edit. Server notes already say so ("before
 * settings change"); an editor step label gets the prefix.
 */
export function versionNoteLabel(note: string): string {
  return /^before\b/i.test(note) ? note : `Before: ${note}`
}

/** The versions list; the editor refreshes it after every save. */
const versionsKey = layoutDraftKeys.versions
const bundleKey = layoutDraftKeys.bundle

function fmt(v: unknown): string {
  if (v == null || v === '') return 'empty'
  if (typeof v === 'object') {
    const s = JSON.stringify(v)
    return s.length > 60 ? `${s.slice(0, 57)}…` : s
  }
  return String(v)
}

const changes = (cs: DiffChange[]) => cs.map((c) => `${c.field} ${fmt(c.from)} → ${fmt(c.to)}`)

function diffRows(diff: DiffDto): Array<{ kind: string; text: string }> {
  const rows: Array<{ kind: string; text: string }> = []
  for (const c of diff.layout)
    rows.push({ kind: 'Layout', text: `${c.field}: ${fmt(c.from)} → ${fmt(c.to)}` })
  for (const g of diff.groups.added) rows.push({ kind: 'Group added', text: g })
  for (const g of diff.groups.removed) rows.push({ kind: 'Group removed', text: g })
  for (const g of diff.groups.changed)
    rows.push({ kind: 'Group', text: `${g.label}: ${changes(g.changes).join(' · ')}` })
  for (const a of diff.assignments.added) rows.push({ kind: 'Field added', text: a })
  for (const a of diff.assignments.removed) rows.push({ kind: 'Field removed', text: a })
  for (const a of diff.assignments.changed)
    rows.push({ kind: 'Field', text: `${a.label}: ${changes(a.changes).join(' · ')}` })
  return rows
}

function DiffBody({ diff }: { diff: DiffDto }) {
  const [showAll, setShowAll] = useState(false)
  if (diff.total === 0) {
    return (
      <p className='mt-1 text-[12px] text-slate-500 dark:text-slate-400'>
        Nothing differs from that version. The layout is exactly as it was saved.
      </p>
    )
  }
  const rows = diffRows(diff)
  const shown = showAll ? rows : rows.slice(0, 12)
  return (
    <div className='mt-1'>
      {diff.warnings.map((w) => (
        <p
          key={w}
          data-layout-diff-warning
          className='mb-1 rounded bg-[#fae6eb] px-1.5 py-1 text-[12px] text-[#9c2f47] dark:bg-[#3d1621] dark:text-[#f08aa1]'
        >
          {w}
        </p>
      ))}
      <p className='text-[12px] text-slate-500 dark:text-slate-400'>
        {diff.total} change{diff.total === 1 ? '' : 's'}
        {diff.from.created_at ? ` since ${new Date(diff.from.created_at).toLocaleString()}` : ''}
      </p>
      <ul className='mt-1 space-y-0.5'>
        {shown.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: ordered diff rows
          <li key={i} className='flex gap-2 text-[12px]'>
            <span className='w-24 shrink-0 text-[11px] text-slate-500 dark:text-slate-400'>
              {r.kind}
            </span>
            <span className='min-w-0 break-words text-slate-700 dark:text-slate-200'>{r.text}</span>
          </li>
        ))}
      </ul>
      {rows.length > 12 && (
        <button
          type='button'
          onClick={() => setShowAll((v) => !v)}
          className='mt-1 text-[11px] text-slate-500 underline dark:text-slate-400'
        >
          {showAll ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

export function HistoryPanel({
  layoutId,
  onRestored,
  unsavedCount = 0,
  onDiscardUnsaved
}: {
  layoutId: number
  onRestored?: () => void
  /** Unsaved editor changes: a restore drops them (they were made on the old layout). */
  unsavedCount?: number
  onDiscardUnsaved?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [diffFor, setDiffFor] = useState<number | null>(null)
  const [confirming, setConfirming] = useState<number | null>(null)

  const { data: versions = [], isLoading } = useQuery({
    queryKey: versionsKey(layoutId),
    queryFn: () =>
      client
        .request<{ data: VersionRow[] }>(get(`/collection-layouts/${layoutId}/versions`))
        .then((r) => r.data ?? []),
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const diffId: number | 'newest' | null = diffFor ?? (versions.length > 0 ? 'newest' : null)
  const { data: diff, isLoading: diffLoading } = useQuery({
    queryKey: ['layout-editor', 'version-diff', layoutId, diffId],
    queryFn: () =>
      client
        .request<{ data: DiffDto }>(
          get(`/collection-layouts/${layoutId}/versions/${diffId}/diff`, { against: 'current' })
        )
        .then((r) => r.data),
    enabled: diffId != null,
    staleTime: 0,
    refetchOnMount: 'always'
  })

  const restore = useMutation({
    mutationFn: (versionId: number) =>
      client.request(post(`/collection-layouts/${layoutId}/versions/${versionId}/restore`)),
    onSuccess: () => {
      setConfirming(null)
      // Before the refetch: the draft never takes a fetched layout over unsaved changes.
      onDiscardUnsaved?.()
      void qc.invalidateQueries({ queryKey: bundleKey(layoutId) })
      void qc.invalidateQueries({ queryKey: versionsKey(layoutId) })
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'version-diff', layoutId] })
      onRestored?.()
    }
  })

  const diffVersion = versions.find((v) => v.id === diffFor)
  const btn =
    'rounded border border-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-slate-50 dark:border-border dark:hover:bg-muted'

  return (
    <div className='flex flex-col gap-2 text-[12px]' data-layout-history>
      {versions.length > 0 && (
        <div className='rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-border dark:bg-muted/40'>
          <div className='flex items-center justify-between gap-2'>
            <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
              {diffFor == null
                ? 'What the last save changed'
                : `Version ${diffVersion?.version ?? '?'} compared with now`}
            </p>
            {diffFor != null && (
              <button
                type='button'
                onClick={() => setDiffFor(null)}
                className='text-[11px] text-slate-500 underline dark:text-slate-400'
              >
                Show last save
              </button>
            )}
          </div>
          {diffLoading && <p className='mt-1 text-slate-500'>Comparing…</p>}
          {diff && <DiffBody diff={diff} />}
        </div>
      )}
      {restore.isError && (
        <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>
          Restore failed. Nothing was changed.
        </p>
      )}
      {isLoading ? (
        <p className='text-slate-500'>Loading history…</p>
      ) : versions.length === 0 ? (
        <p className='text-slate-500 dark:text-slate-400'>
          No versions yet. One is saved before every change.
        </p>
      ) : (
        <ul className='max-h-48 space-y-1 overflow-y-auto'>
          {versions.map((v) => (
            <li
              key={v.id}
              className='flex items-center justify-between gap-2 rounded border border-slate-100 px-2 py-1 dark:border-border/60'
            >
              <span className='min-w-0'>
                <span className='font-medium'>v{v.version}</span>{' '}
                <span className='text-slate-500 dark:text-slate-400'>
                  {v.note ? `${versionNoteLabel(v.note)} · ` : ''}
                  {new Date(v.created_at).toLocaleString()}
                  {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                </span>
              </span>
              <span className='flex shrink-0 items-center gap-1'>
                <button
                  type='button'
                  data-tip='See what differs from the layout now'
                  data-version-diff={v.version}
                  data-setting='tool.version_diff'
                  onClick={() => setDiffFor(v.id)}
                  className={`${btn} ${diffFor === v.id ? 'border-nvr-cyan text-nvr-navy dark:text-nvr-cyan' : ''}`}
                >
                  Compare
                </button>
                {confirming === v.id ? (
                  <>
                    <button
                      type='button'
                      data-restore-confirm={v.id}
                      disabled={restore.isPending}
                      onClick={() => restore.mutate(v.id)}
                      data-tip={
                        unsavedCount > 0
                          ? `Your ${unsavedCount} unsaved ${unsavedCount === 1 ? 'change is' : 'changes are'} dropped`
                          : undefined
                      }
                      className='rounded bg-nvr-cyan px-1.5 py-0.5 text-[11px] text-white disabled:opacity-60'
                    >
                      {restore.isPending
                        ? 'Restoring…'
                        : unsavedCount > 0
                          ? 'Restore, drop unsaved'
                          : 'Yes, restore'}
                    </button>
                    <button type='button' onClick={() => setConfirming(null)} className={btn}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type='button'
                    data-restore={v.id}
                    data-setting='tool.version_restore'
                    data-tip='Replace the layout with this version. The current one is kept as a version first.'
                    onClick={() => setConfirming(v.id)}
                    className={btn}
                  >
                    Restore
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
