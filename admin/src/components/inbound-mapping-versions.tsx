import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, History, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Version history for one inbound mapping (#1266): every save snapshots the
 * rules, child sets, fixtures, response template and status map; pick a
 * version to see what changed since, and restore it (the restore snapshots
 * the state it replaces first, so it can be undone too).
 */

interface VersionRow {
  id: number
  version: number
  note: string | null
  created_by_name: string | null
  created_at: string
}
interface SetChange {
  added: string[]
  removed: string[]
  changed: Array<{ key: string; fields: string[] }>
}
interface FieldChange {
  field: string
  from: unknown
  to: unknown
}
interface MappingDiff {
  settings: FieldChange[]
  rules: SetChange
  children: SetChange
  fixtures: SetChange
  response_template: { from: string | null; to: string | null } | null
  response_status: FieldChange[]
  total: number
}

const show = (v: unknown) =>
  v == null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)

export function InboundMappingVersions<M>({
  mappingId,
  onRestored
}: {
  mappingId: number
  onRestored: (mapping: M) => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<number | null>(null)

  const { data: versions = [], isLoading } = useQuery<VersionRow[]>({
    queryKey: ['inbound-mapping-versions', mappingId],
    queryFn: () => api.get(`/inbound-mappings/${mappingId}/versions`).then((r) => r.data.data),
    enabled: open
  })
  const { data: diff, isLoading: diffLoading } = useQuery<MappingDiff>({
    queryKey: ['inbound-mapping-version-diff', mappingId, picked],
    queryFn: () =>
      api
        .get(`/inbound-mappings/${mappingId}/versions/${picked}/diff`, {
          params: { against: 'current' }
        })
        .then((r) => r.data.data),
    enabled: open && picked != null
  })
  const restore = useMutation({
    mutationFn: (vid: number) =>
      api.post(`/inbound-mappings/${mappingId}/versions/${vid}/restore`).then((r) => r.data.data),
    onSuccess: (m: M) => {
      setConfirm(null)
      void qc.invalidateQueries({ queryKey: ['inbound-mapping-versions', mappingId] })
      void qc.invalidateQueries({ queryKey: ['inbound-mapping-version-diff', mappingId] })
      onRestored(m)
      toast.success('Version restored')
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Restore failed', { duration: 8000 })
  })

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-inbound-versions
    >
      <button
        type='button'
        onClick={() => setOpen((o) => !o)}
        className='flex w-full items-center gap-2 px-5 py-3 text-left'
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
        )}
        <History className='h-3.5 w-3.5 text-nvr-cyan' />
        <span className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
          Version history
        </span>
        <span className='text-[11px] text-slate-400'>
          Every save is kept (newest 30) — compare one with now, or put it back.
        </span>
      </button>
      {open && (
        <div className='grid gap-0 border-t border-slate-200 dark:border-border md:grid-cols-[260px_1fr]'>
          <ul className='max-h-[360px] overflow-y-auto border-slate-200 md:border-r dark:border-border'>
            {isLoading ? (
              <li className='p-3 text-[12px] text-slate-400'>Loading…</li>
            ) : versions.length === 0 ? (
              <li className='p-3 text-[12px] text-slate-400'>
                No versions yet — the next save records one.
              </li>
            ) : (
              versions.map((v, i) => (
                <li key={v.id}>
                  <button
                    type='button'
                    data-inbound-version={v.version}
                    onClick={() => {
                      setPicked(v.id)
                      setConfirm(null)
                    }}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 border-b border-slate-100 px-3 py-2 text-left hover:bg-muted dark:border-border/60',
                      picked === v.id && 'bg-accent'
                    )}
                  >
                    <span className='flex w-full items-center gap-1.5 text-[12px] font-medium text-slate-800 dark:text-foreground'>
                      v{v.version}
                      {i === 0 && (
                        <span className='rounded bg-emerald-100 px-1 text-[10px] font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300'>
                          newest
                        </span>
                      )}
                      <span className='ml-auto text-[10.5px] font-normal text-slate-400'>
                        {formatRelative(v.created_at)}
                      </span>
                    </span>
                    <span className='line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400'>
                      {v.note ?? '—'}
                      {v.created_by_name ? ` · ${v.created_by_name}` : ''}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
          <div className='min-h-[160px] p-4'>
            {picked == null ? (
              <p className='text-[12px] text-slate-400'>
                Pick a version to see what changed between it and the mapping as it is now.
              </p>
            ) : diffLoading || !diff ? (
              <div className='h-24 animate-pulse rounded-md bg-muted' />
            ) : (
              <div className='space-y-3' data-inbound-version-diff>
                <div className='flex items-center gap-2'>
                  <p className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                    {diff.total === 0
                      ? 'Identical to the mapping as it is now.'
                      : `${diff.total} change${diff.total === 1 ? '' : 's'} since this version`}
                  </p>
                  {diff.total > 0 &&
                    (confirm === picked ? (
                      <span className='ml-auto flex items-center gap-1.5'>
                        <span className='text-[11px] text-slate-500'>
                          Replace the live mapping?
                        </span>
                        <Button
                          size='sm'
                          className='h-7 text-[12px]'
                          disabled={restore.isPending}
                          onClick={() => restore.mutate(picked)}
                          data-inbound-version-restore-confirm
                        >
                          {restore.isPending ? 'Restoring…' : 'Restore'}
                        </Button>
                        <Button
                          size='sm'
                          variant='outline'
                          className='h-7 text-[12px]'
                          onClick={() => setConfirm(null)}
                        >
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <Button
                        size='sm'
                        variant='outline'
                        className='ml-auto h-7 gap-1.5 text-[12px]'
                        onClick={() => setConfirm(picked)}
                        data-inbound-version-restore
                      >
                        <RotateCcw className='h-3.5 w-3.5' />
                        Restore this version
                      </Button>
                    ))}
                </div>
                {diff.settings.length > 0 && (
                  <DiffBlock title='Settings'>
                    {diff.settings.map((c) => (
                      <li key={c.field}>
                        <code className='font-mono'>{c.field}</code>: {show(c.from)} → {show(c.to)}
                      </li>
                    ))}
                  </DiffBlock>
                )}
                <SetBlock title='Rules (by target field)' set={diff.rules} />
                <SetBlock title='Child sets' set={diff.children} />
                <SetBlock title='Fixtures' set={diff.fixtures} />
                {diff.response_template && (
                  <DiffBlock title='Response template'>
                    <li className='grid gap-1.5 sm:grid-cols-2'>
                      <pre className='max-h-32 overflow-auto whitespace-pre-wrap rounded bg-red-50 p-2 font-mono text-[10.5px] text-red-800 dark:bg-red-500/10 dark:text-red-200'>
                        {diff.response_template.from ?? '(standard body)'}
                      </pre>
                      <pre className='max-h-32 overflow-auto whitespace-pre-wrap rounded bg-emerald-50 p-2 font-mono text-[10.5px] text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200'>
                        {diff.response_template.to ?? '(standard body)'}
                      </pre>
                    </li>
                  </DiffBlock>
                )}
                {diff.response_status.length > 0 && (
                  <DiffBlock title='Status map'>
                    {diff.response_status.map((c) => (
                      <li key={c.field}>
                        {c.field}: {show(c.from)} → {show(c.to)}
                      </li>
                    ))}
                  </DiffBlock>
                )}
                <p className='text-[11px] text-slate-400'>
                  Left = this version, right = now. Restoring keeps the mapping's id and every
                  fixture's id, and records the state it replaces as a new version first.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DiffBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className='mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-slate-400'>
        {title}
      </p>
      <ul className='space-y-0.5 text-[12px] text-slate-700 dark:text-slate-200'>{children}</ul>
    </div>
  )
}

function SetBlock({ title, set }: { title: string; set: SetChange }) {
  if (!set.added.length && !set.removed.length && !set.changed.length) return null
  return (
    <DiffBlock title={title}>
      {set.added.map((k) => (
        <li key={`a-${k}`} className='text-emerald-700 dark:text-emerald-300'>
          + {k} <span className='text-slate-400'>(added since)</span>
        </li>
      ))}
      {set.removed.map((k) => (
        <li key={`r-${k}`} className='text-red-700 dark:text-red-300'>
          − {k} <span className='text-slate-400'>(removed since)</span>
        </li>
      ))}
      {set.changed.map((c) => (
        <li key={`c-${c.key}`} className='text-amber-800 dark:text-amber-200'>
          ~ {c.key} <span className='text-slate-400'>({c.fields.join(', ')} changed)</span>
        </li>
      ))}
    </DiffBlock>
  )
}
