import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'

/**
 * Owner matrix versions (#833) — the dimensions, owner groups (filters,
 * priority, WIP limits), members and team links of this template, captured
 * before every owner change. Diff any version against the live matrix cell by
 * cell, and restore it (the current matrix is captured first, so a restore is
 * itself one restore away from undone).
 */

interface MatrixVersionRow {
  id: number
  version: number
  note: string | null
  created_at: string
  created_by_name: string | null
  bytes: number | null
  group_count: number | null
  member_count: number | null
}

interface FieldChange {
  field: string
  from: unknown
  to: unknown
}

interface GroupDiffEntry {
  id: string
  state: string
  name: string | null
  filters: unknown
  fields: FieldChange[]
  members_added: string[]
  members_removed: string[]
  teams_added: number[]
  teams_removed: number[]
}

interface MatrixDiffResponse {
  from_version: number
  to: string
  diff: {
    groups: { added: GroupDiffEntry[]; removed: GroupDiffEntry[]; changed: GroupDiffEntry[] }
    dimensions: {
      added: Array<Record<string, unknown>>
      removed: Array<Record<string, unknown>>
      changed: Array<{ id: unknown; label: string; fields: FieldChange[] }>
    }
    totals: Record<string, number>
    truncated: boolean
  }
  names: {
    users: Record<string, string | null>
    teams: Record<string, string>
    states: Record<string, string>
  }
}

interface RestoreResult {
  groups: { inserted: number; updated: number; deleted: number; skipped_missing_state: number }
  members: { inserted: number; deleted: number; skipped_missing_user: number }
  teams: { inserted: number; deleted: number; skipped_missing_team: number }
  dimensions: {
    inserted: number
    updated: number
    deleted: number
    skipped_missing_binding: number
  }
}

function fmtVal(v: unknown): string {
  if (v == null || v === '') return '(empty)'
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > 90 ? `${s.slice(0, 90)}…` : s
}

/** "Region eq BLT · Zone in 1,2" — a cell named by its filters when it has no name. */
function describeFilters(filters: unknown): string {
  const list = Array.isArray(filters)
    ? (filters as Array<{ field?: string; op?: string; value?: unknown }>)
    : filters && typeof filters === 'object'
      ? Object.entries(filters as Record<string, unknown>).map(([field, value]) => ({
          field,
          op: 'eq',
          value
        }))
      : []
  if (list.length === 0) return 'Default (no filters)'
  return list
    .map(
      (f) =>
        `${f.field ?? '?'} ${f.op ?? 'eq'} ${Array.isArray(f.value) ? f.value.join(', ') : String(f.value ?? '')}`
    )
    .join(' · ')
}

function kb(bytes: number | null): string {
  if (!bytes) return ''
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}

function MatrixDiffView({ data }: { data: MatrixDiffResponse }) {
  const { diff, names } = data
  const user = (id: string) => names.users[id.toUpperCase()] ?? id.slice(0, 8)
  const team = (id: number) => names.teams[String(id)] ?? `team ${id}`
  const state = (id: string) => names.states[id.toUpperCase()] ?? 'unknown state'
  const cellLabel = (g: GroupDiffEntry) => g.name || describeFilters(g.filters)
  const t = diff.totals
  const empty =
    diff.groups.added.length + diff.groups.removed.length + diff.groups.changed.length === 0 &&
    (t.dimensions_changed ?? 0) === 0

  const people = (g: GroupDiffEntry) => (
    <>
      {g.members_added.length > 0 && (
        <p className='pl-3 text-[11px] text-emerald-700 dark:text-emerald-400'>
          + {g.members_added.map(user).join(', ')}
        </p>
      )}
      {g.members_removed.length > 0 && (
        <p className='pl-3 text-[11px] text-red-600 dark:text-red-400'>
          − {g.members_removed.map(user).join(', ')}
        </p>
      )}
      {g.teams_added.length > 0 && (
        <p className='pl-3 text-[11px] text-emerald-700 dark:text-emerald-400'>
          + team {g.teams_added.map(team).join(', ')}
        </p>
      )}
      {g.teams_removed.length > 0 && (
        <p className='pl-3 text-[11px] text-red-600 dark:text-red-400'>
          − team {g.teams_removed.map(team).join(', ')}
        </p>
      )}
    </>
  )

  return (
    <div className='space-y-2.5' data-matrix-diff>
      <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400'>
        v{data.from_version} → {data.to}
      </p>
      {empty ? (
        <p className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          No differences — the matrix is identical.
        </p>
      ) : (
        <p className='text-[11.5px] text-slate-600 dark:text-slate-300' data-matrix-diff-totals>
          {t.groups_changed} cell(s) changed · {t.groups_added} only in {data.to} ·{' '}
          {t.groups_removed} only in v{data.from_version} · members +{t.members_added} / −
          {t.members_removed}
          {t.teams_added + t.teams_removed > 0 &&
            ` · teams +${t.teams_added} / −${t.teams_removed}`}
          {diff.truncated && ' · showing the first 300 of each list'}
        </p>
      )}
      {diff.groups.changed.length > 0 && (
        <div>
          <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-200'>
            Changed cells
          </p>
          {diff.groups.changed.map((g) => (
            <div key={g.id} className='mt-1' data-matrix-diff-cell={g.id}>
              <p className='text-[11px] font-medium text-slate-700 dark:text-slate-200'>
                {state(g.state)} · {cellLabel(g)}
              </p>
              {g.fields.map((f) => (
                <p key={f.field} className='pl-3 text-[11px] text-slate-500 dark:text-slate-400'>
                  <span className='font-mono'>{f.field}</span>:{' '}
                  <span className='text-red-600 line-through dark:text-red-400'>
                    {f.field === 'filters' ? describeFilters(f.from) : fmtVal(f.from)}
                  </span>{' '}
                  →{' '}
                  <span className='text-emerald-700 dark:text-emerald-400'>
                    {f.field === 'filters' ? describeFilters(f.to) : fmtVal(f.to)}
                  </span>
                </p>
              ))}
              {people(g)}
            </div>
          ))}
        </div>
      )}
      {diff.groups.added.length > 0 && (
        <div>
          <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-200'>
            Only in {data.to}
          </p>
          {diff.groups.added.map((g) => (
            <p key={g.id} className='mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400'>
              + {state(g.state)} · {cellLabel(g)} ({g.members_added.length} member(s))
            </p>
          ))}
        </div>
      )}
      {diff.groups.removed.length > 0 && (
        <div>
          <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-200'>
            Only in v{data.from_version}
          </p>
          {diff.groups.removed.map((g) => (
            <p key={g.id} className='mt-0.5 text-[11px] text-red-600 dark:text-red-400'>
              − {state(g.state)} · {cellLabel(g)} ({g.members_removed.length} member(s))
            </p>
          ))}
        </div>
      )}
      {(t.dimensions_changed ?? 0) > 0 && (
        <div>
          <p className='text-[11px] font-semibold text-slate-600 dark:text-slate-200'>Dimensions</p>
          {diff.dimensions.added.map((d) => (
            <p
              key={String(d.id)}
              className='mt-0.5 text-[11px] text-emerald-700 dark:text-emerald-400'
            >
              + {String(d.label ?? d.field)}
            </p>
          ))}
          {diff.dimensions.removed.map((d) => (
            <p key={String(d.id)} className='mt-0.5 text-[11px] text-red-600 dark:text-red-400'>
              − {String(d.label ?? d.field)}
            </p>
          ))}
          {diff.dimensions.changed.map((d) => (
            <p key={String(d.id)} className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
              {d.label}:{' '}
              {d.fields.map((f) => `${f.field} ${fmtVal(f.from)} → ${fmtVal(f.to)}`).join(', ')}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

export function OwnerMatrixVersionsCard({ templateId }: { templateId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [diffId, setDiffId] = useState<number | null>(null)

  const { data: versions, isLoading } = useQuery({
    queryKey: ['owner-matrix-versions', templateId],
    queryFn: () =>
      client
        .request<{ data: MatrixVersionRow[] }>(
          get(`/pipelines/${templateId}/owner-matrix/versions`)
        )
        .then((r) => r.data)
  })

  const { data: diff, isFetching: diffLoading } = useQuery({
    queryKey: ['owner-matrix-version-diff', templateId, diffId],
    queryFn: () =>
      client
        .request<{ data: MatrixDiffResponse }>(
          get(`/pipelines/${templateId}/owner-matrix/versions/${diffId}/diff`)
        )
        .then((r) => r.data),
    enabled: diffId != null
  })

  const checkpoint = useMutation({
    mutationFn: () =>
      client.request<{ data: { version: number | null; unchanged: boolean } }>(
        post(`/pipelines/${templateId}/owner-matrix/versions`, { note: 'checkpoint' })
      ),
    onSuccess: (r) => {
      toast.success(
        r.data.unchanged ? 'Nothing changed since the last version' : `Saved as v${r.data.version}`
      )
      void qc.invalidateQueries({ queryKey: ['owner-matrix-versions', templateId] })
    },
    onError: () => toast.error('Could not save a version')
  })

  const restore = useMutation({
    mutationFn: (versionId: number) =>
      client.request<{ data: RestoreResult }>(
        post(`/pipelines/${templateId}/owner-matrix/versions/${versionId}/restore`)
      ),
    onSuccess: (r) => {
      setConfirmId(null)
      setDiffId(null)
      const g = r.data.groups
      const m = r.data.members
      const skipped =
        g.skipped_missing_state + m.skipped_missing_user + r.data.teams.skipped_missing_team
      toast.success(
        `Matrix restored — ${g.updated + g.inserted + g.deleted} cell change(s), members +${m.inserted} / −${m.deleted}` +
          (skipped > 0 ? ` · ${skipped} skipped (state, person or team no longer exists)` : '')
      )
      // Everything about this template's owners is stale now.
      void qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey.includes(templateId) ||
          String(q.queryKey[0] ?? '').includes('dimension') ||
          String(q.queryKey[0] ?? '').includes('owner')
      })
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { error?: string } })?.response?.error ?? 'Could not restore the matrix'
      )
  })

  return (
    <div
      className='space-y-3 rounded-xl border border-slate-200 bg-white p-6 dark:border-border dark:bg-card'
      data-owner-matrix-versions
    >
      <div className='flex items-center gap-2'>
        <Users className='h-4 w-4 text-slate-400' />
        <h2 className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
          Owner matrix versions
        </h2>
        {versions && versions.length > 0 && (
          <span className='rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
            {versions.length}
          </span>
        )}
        <Button
          size='sm'
          variant='outline'
          className='ml-auto h-6 px-2 text-[11px]'
          disabled={checkpoint.isPending}
          onClick={() => checkpoint.mutate()}
          data-owner-matrix-checkpoint
        >
          {checkpoint.isPending ? 'Saving…' : 'Save a version now'}
        </Button>
      </div>
      {isLoading ? (
        <div className='space-y-2'>
          <Skeleton className='h-8 rounded' />
          <Skeleton className='h-8 rounded' />
        </div>
      ) : !versions || versions.length === 0 ? (
        <p className='text-[12px] text-slate-500 dark:text-slate-400'>
          No versions yet. The dimensions, owner groups, members and team links are captured
          automatically before every owner change.
        </p>
      ) : (
        <div className='max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-border'>
          {versions.map((v) => (
            <div
              key={v.id}
              className='flex items-center gap-2 py-1.5'
              data-owner-matrix-version={v.version}
            >
              <span className='shrink-0 font-mono text-[11px] font-semibold text-slate-700 dark:text-foreground'>
                v{v.version}
              </span>
              <span className='min-w-0 flex-1 truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {v.note ?? '—'}
                {v.created_by_name?.trim() ? ` · ${v.created_by_name}` : ''}
                {v.group_count != null &&
                  ` · ${v.group_count} cells, ${v.member_count ?? 0} members`}
                {v.bytes ? ` · ${kb(v.bytes)}` : ''}
              </span>
              <span className='shrink-0 text-[10.5px] text-slate-400'>
                {formatRelative(v.created_at)}
              </span>
              {confirmId === v.id ? (
                <span className='flex shrink-0 items-center gap-1.5'>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-5 px-2 text-[10.5px]'
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(v.id)}
                    data-owner-matrix-restore-confirm
                  >
                    {restore.isPending ? 'Restoring…' : 'Yes, restore'}
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-5 px-2 text-[10.5px]'
                    onClick={() => setConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <span className='flex shrink-0 items-center gap-0.5'>
                  <button
                    type='button'
                    onClick={() => setDiffId((d) => (d === v.id ? null : v.id))}
                    className='rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                    data-owner-matrix-diff={v.version}
                  >
                    {diffId === v.id ? 'Hide diff' : 'Diff'}
                  </button>
                  <button
                    type='button'
                    onClick={() => setConfirmId(v.id)}
                    className='rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                    data-owner-matrix-restore={v.version}
                  >
                    Restore
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {diffId != null && (
        <div className='max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-muted/30'>
          {diffLoading ? (
            <p className='text-[11.5px] text-slate-500'>Comparing…</p>
          ) : diff ? (
            <MatrixDiffView data={diff} />
          ) : (
            <p className='text-[11.5px] text-slate-500'>Could not load the diff.</p>
          )}
        </div>
      )}
      <p className='text-[10.5px] text-slate-500 dark:text-slate-400'>
        Edits made in quick succession by one person share a version — it holds the matrix from
        before the burst. Restore captures the current matrix first, keeps every owner group's id,
        and skips cells whose state, person or team no longer exists. The newest 30 are kept.
      </p>
    </div>
  )
}
