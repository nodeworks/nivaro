import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Undo2 } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { useApiFetchConfig } from '../context'
import { forgetSettledReads } from '../lib/request-gate'
import { userErrorMessage } from '../lib/safe-error'
import { cn, titleCase, truncate } from '../lib/utils'
import { Button } from './ui/button'
import { Checkbox } from './ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/**
 * Undo from the audit log (#22). Renders nothing unless the entry can be
 * undone by the signed-in person (a field edit, a bulk update or a delete
 * still in trash — `POST /activity/undoable`, batched across every button
 * on the screen). Clicking opens a preview of exactly what will change and
 * what is skipped and why; fields someone changed since are listed with a
 * tick box (per-field revert). Apply goes through `POST /activity/:id/undo`
 * {dry_run:false} — the server writes through the items service as the
 * person, so their permissions, field lists, scopes and locks apply.
 */

type FieldStatus =
  | 'revert'
  | 'changed_since'
  | 'already'
  | 'not_allowed'
  | 'unreadable'
  | 'derived'
  | 'no_previous'

interface FieldPlan {
  field: string
  status: FieldStatus
  previous?: unknown
  written?: unknown
  current?: unknown
}

interface RecordPlan {
  activity_id: number
  collection: string
  item: string
  status: string
  reason?: string
  fields: FieldPlan[]
}

export interface UndoPreviewAnswer {
  activity_id: number
  kind: 'update' | 'bulk_update' | 'delete' | null
  reversible: boolean
  reason?: string
  already_undone?: { activity_id: number; at: string; by: string | null } | null
  group_size: number
  truncated?: boolean
  records: RecordPlan[]
  will_change: number
  skipped: number
  applied?: boolean
  changed?: number
  failed?: Array<{ item: string; reason: string }>
}

// ─── Batched "may this entry show Undo?" ──────────────────────────────────────

type Cfg = ReturnType<typeof useApiFetchConfig>
let pending: Array<{ id: number; resolve: (ok: boolean) => void; reject: (e: unknown) => void }> =
  []
let timer: ReturnType<typeof setTimeout> | null = null

function loadUndoable(cfg: Cfg, id: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    pending.push({ id, resolve, reject })
    if (timer) return
    timer = setTimeout(() => {
      const batch = pending
      pending = []
      timer = null
      const ids = [...new Set(batch.map((b) => b.id))].slice(0, 500)
      fetch(`${cfg.apiBase}/activity/undoable`, {
        method: 'POST',
        headers: { ...cfg.authHeaders, 'content-type': 'application/json' },
        credentials: cfg.credentials,
        body: JSON.stringify({ ids })
      })
        .then(async (res) => {
          const json = (await res.json().catch(() => ({}))) as {
            data?: { undoable?: number[] }
          }
          const ok = new Set(res.ok ? (json.data?.undoable ?? []) : [])
          for (const b of batch) b.resolve(ok.has(b.id))
        })
        .catch((e) => {
          for (const b of batch) b.reject(e)
        })
    }, 25)
  })
}

async function postUndo(
  cfg: Cfg,
  id: number,
  body: Record<string, unknown>
): Promise<UndoPreviewAnswer> {
  const res = await fetch(`${cfg.apiBase}/activity/${id}/undo`, {
    method: 'POST',
    headers: { ...cfg.authHeaders, 'content-type': 'application/json' },
    credentials: cfg.credentials,
    body: JSON.stringify(body)
  })
  const json = (await res.json().catch(() => ({}))) as { data?: UndoPreviewAnswer; error?: string }
  if (!res.ok || !json.data) throw new Error(json.error ?? 'Could not undo this change')
  return json.data
}

// ─── Component ────────────────────────────────────────────────────────────────

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'empty'
  if (typeof v === 'object') return truncate(JSON.stringify(v), 40)
  return truncate(String(v), 40)
}

const FIELD_NOTE: Partial<Record<FieldStatus, string>> = {
  already: 'already back',
  not_allowed: 'you cannot change this field',
  unreadable: 'hidden from you',
  derived: 'follows the other fields',
  no_previous: 'no earlier value kept'
}

export function UndoButton({
  activityId,
  onDone,
  className
}: {
  activityId: number | string
  onDone?: (result: UndoPreviewAnswer) => void
  className?: string
}) {
  const id = Number(activityId)
  const cfg = useApiFetchConfig()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<UndoPreviewAnswer | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<UndoPreviewAnswer | null>(null)

  const { data: undoable } = useQuery({
    queryKey: ['activity-undoable', id],
    queryFn: () => loadUndoable(cfg, id),
    enabled: Number.isInteger(id),
    staleTime: 60_000
  })

  const load = useCallback(
    async (fields: string[] | null) => {
      setBusy('preview')
      setError(null)
      try {
        setPreview(await postUndo(cfg, id, { dry_run: true, ...(fields ? { fields } : {}) }))
      } catch (e) {
        setError(userErrorMessage(e, 'Could not check this change'))
      } finally {
        setBusy(null)
      }
    },
    [cfg, id]
  )

  // Fields someone changed since, across the records (the per-field revert offer).
  const changedSince = useMemo(() => {
    const names = new Set<string>()
    for (const r of preview?.records ?? [])
      for (const f of r.fields) if (f.status === 'changed_since') names.add(f.field)
    return [...names].sort()
  }, [preview])
  const revertable = useMemo(() => {
    const names = new Set<string>()
    for (const r of preview?.records ?? [])
      for (const f of r.fields)
        if (f.status === 'revert' || f.status === 'changed_since') names.add(f.field)
    return [...names].sort()
  }, [preview])

  if (!undoable && !done) return null

  const apply = async () => {
    setBusy('apply')
    setError(null)
    try {
      const fields = picked.size > 0 ? [...new Set([...picked, ...cleanFields(preview)])] : null
      const result = await postUndo(cfg, id, { dry_run: false, ...(fields ? { fields } : {}) })
      if (!result.applied) {
        setPreview(result)
        setError(result.reason ?? 'Nothing was changed')
        return
      }
      setDone(result)
      setOpen(false)
      forgetSettledReads()
      void qc.invalidateQueries({ queryKey: ['activity-undoable', id] })
      void qc.invalidateQueries({ queryKey: ['revisions'] })
      void qc.invalidateQueries({ queryKey: ['activity'] })
      onDone?.(result)
    } catch (e) {
      setError(userErrorMessage(e, 'Could not undo this change'))
    } finally {
      setBusy(null)
    }
  }

  if (done) {
    return (
      <span className={cn('text-[11px] text-muted-foreground', className)}>
        Undone{done.kind === 'bulk_update' ? ` · ${done.changed} of ${done.group_size}` : ''}
      </span>
    )
  }

  const willChange =
    picked.size > 0
      ? countWithPick(preview, new Set([...picked, ...cleanFields(preview)]))
      : (preview?.will_change ?? 0)
  const headline = !preview
    ? 'Checking…'
    : preview.kind === 'delete'
      ? 'Restore this record from trash'
      : preview.kind === 'bulk_update'
        ? `Revert ${willChange} of ${preview.group_size} records`
        : 'Put the previous values back'

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && !preview && busy == null) void load(null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className={cn('h-6 gap-1 px-1.5 text-[11px]', className)}
          data-tip='Undo this change'
        >
          <Undo2 className='h-3 w-3' />
          Undo
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[380px] p-0'>
        <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
          <div className='text-[12px] font-medium text-slate-900 dark:text-foreground'>
            {headline}
          </div>
          {preview && !preview.reversible && willChange === 0 && (
            <p className='mt-0.5 text-[11px] text-muted-foreground'>
              {preview.reason ?? 'Nothing here can be undone by you'}
            </p>
          )}
          {preview?.truncated && (
            <p className='mt-0.5 text-[11px] text-muted-foreground'>
              Large change: only its first {preview.group_size} records can be undone here; the rest
              need a bulk edit.
            </p>
          )}
        </div>
        <div className='max-h-[320px] overflow-y-auto'>
          {busy === 'preview' && !preview && (
            <div className='flex items-center gap-2 px-3 py-3 text-[12px] text-muted-foreground'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' /> Checking what would change…
            </div>
          )}
          {preview && preview.records.length > 0 && (
            <ul className='divide-y divide-slate-100 dark:divide-border'>
              {preview.records.slice(0, 25).map((r) => (
                <RecordRow
                  key={r.activity_id}
                  r={r}
                  picked={picked}
                  single={preview.records.length === 1}
                />
              ))}
              {preview.records.length > 25 && (
                <li className='px-3 py-1.5 text-[11px] text-muted-foreground'>
                  and {preview.records.length - 25} more records
                </li>
              )}
            </ul>
          )}
        </div>
        {changedSince.length > 0 && (
          <div className='border-t border-slate-200 px-3 py-2 dark:border-border'>
            <div className='mb-1 text-[11px] text-muted-foreground'>
              Changed since — tick a field to put it back anyway:
            </div>
            <div className='flex flex-wrap gap-x-3 gap-y-1'>
              {changedSince.map((f) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control
                <label key={f} className='flex cursor-pointer items-center gap-1.5 text-[12px]'>
                  <Checkbox
                    checked={picked.has(f)}
                    onCheckedChange={(v) =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (v === true) next.add(f)
                        else next.delete(f)
                        return next
                      })
                    }
                  />
                  {titleCase(f)}
                </label>
              ))}
            </div>
          </div>
        )}
        {error && (
          <p className='border-t border-slate-200 px-3 py-1.5 text-[11px] text-red-600 dark:border-border dark:text-red-400'>
            {error}
          </p>
        )}
        <div className='flex items-center justify-end gap-2 border-t border-slate-200 px-3 py-2 dark:border-border'>
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-7 text-[12px]'
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type='button'
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
            disabled={
              busy != null ||
              !preview ||
              willChange === 0 ||
              revertable.length + (preview.kind === 'delete' ? 1 : 0) === 0
            }
            onClick={() => void apply()}
          >
            {busy === 'apply' ? 'Undoing…' : preview?.kind === 'delete' ? 'Restore' : 'Undo'}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Fields that revert without a pick (still hold this change's values). */
function cleanFields(p: UndoPreviewAnswer | null): string[] {
  const out = new Set<string>()
  for (const r of p?.records ?? [])
    for (const f of r.fields) if (f.status === 'revert') out.add(f.field)
  return [...out]
}

function countWithPick(p: UndoPreviewAnswer | null, pick: Set<string>): number {
  let n = 0
  for (const r of p?.records ?? []) {
    if (r.status === 'restorable') n++
    else if (
      r.fields.some(
        (f) => pick.has(f.field) && (f.status === 'revert' || f.status === 'changed_since')
      )
    )
      n++
  }
  return n
}

function RecordRow({ r, picked, single }: { r: RecordPlan; picked: Set<string>; single: boolean }) {
  const shown = r.fields.filter((f) => f.status !== 'already' || single)
  return (
    <li className='px-3 py-1.5'>
      <div className='flex items-baseline gap-2 text-[11px]'>
        <span className='font-mono text-muted-foreground'>
          {r.collection} #{r.item}
        </span>
        {r.status === 'restorable' && (
          <span className='text-emerald-700 dark:text-emerald-400'>will be restored</span>
        )}
        {r.reason && r.status !== 'revertible' && (
          <span className='text-amber-700 dark:text-amber-400'>{r.reason}</span>
        )}
      </div>
      {shown.length > 0 && (
        <ul className='mt-0.5 space-y-0.5'>
          {shown.map((f) => {
            const goes =
              f.status === 'revert' || (f.status === 'changed_since' && picked.has(f.field))
            return (
              <li key={f.field} className='flex items-baseline gap-1.5 text-[12px]'>
                <span
                  className={cn(
                    'min-w-0 shrink-0',
                    goes ? 'text-slate-900 dark:text-foreground' : 'text-muted-foreground'
                  )}
                >
                  {titleCase(f.field)}
                </span>
                {f.status === 'unreadable' ||
                f.status === 'derived' ||
                f.status === 'not_allowed' ||
                f.status === 'no_previous' ||
                f.status === 'already' ? (
                  <span className='text-[11px] text-muted-foreground'>{FIELD_NOTE[f.status]}</span>
                ) : (
                  <span className='min-w-0 truncate text-[11px]'>
                    <span
                      className={cn(
                        f.status === 'changed_since' && 'text-amber-700 dark:text-amber-400'
                      )}
                    >
                      {show(f.current)}
                    </span>
                    <span className='mx-1 text-muted-foreground'>→</span>
                    <span
                      className={
                        goes ? 'text-slate-900 dark:text-foreground' : 'text-muted-foreground'
                      }
                    >
                      {show(f.previous)}
                    </span>
                    {f.status === 'changed_since' && (
                      <span className='ml-1 text-muted-foreground'>
                        (changed since: this change wrote {show(f.written)})
                      </span>
                    )}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </li>
  )
}
