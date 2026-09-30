import { useQueries, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, Loader2, MinusCircle, Send } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  type AvailableBulkAction,
  type BulkRunResult,
  type BulkTarget,
  bulkActionEnabled,
  useAvailableBulkActions
} from './BulkActionButtons'

/**
 * #620 — integration pushes over a selection, rendered inside
 * BulkActionButtons (so the collection browser's bar and the queue pill both
 * get them). Two built-in bulk actions, each shown only when a target
 * collection lists it as available AND the surface's allow-list includes it:
 *
 *  - 'push': one button per registered item action on the target collections
 *    ("Push to <partner>") — POST /bulk-actions/push.
 *  - 'retry-push': "Retry failed pushes" — re-sends each record's latest
 *    failed push, partner by partner — POST /bulk-actions/retry-push.
 *
 * Each popover opens with the dry run (how many records the run would touch
 * and why the rest are skipped), then runs sequentially server-side and keeps
 * the per-row result list open until dismissed.
 */

export interface PushItemAction {
  id: string
  label: string
  variant?: 'default' | 'destructive' | 'outline'
  confirm?: {
    title?: string
    body?: string
    confirm_label?: string
    input?: { label: string; placeholder?: string; required?: boolean }
  }
}

export type PushRunOutcome = BulkRunResult & {
  outcomes: Array<{ item: string; outcome: 'change' | 'skip' | 'fail'; reason?: string }>
}

type Target = BulkTarget & { label?: string | null }

/** Is a built-in listed for the collection and allowed on this surface? */
export function builtinListed(
  data: Record<string, AvailableBulkAction[]> | undefined,
  enabledKeys: string[] | null | undefined,
  collection: string,
  key: string
): boolean {
  return (
    (data?.[collection] ?? []).some((a) => a.source === 'builtin' && a.key === key) &&
    bulkActionEnabled(enabledKeys, collection, key)
  )
}

/** Sum per-collection runs into one result (keys stay `collection:item` unique). */
function mergeRuns(runs: Array<{ collection: string; data: PushRunOutcome }>): PushRunOutcome {
  const out: PushRunOutcome = { succeeded: 0, failed: 0, skipped: 0, errors: [], outcomes: [] }
  for (const { collection, data } of runs) {
    out.succeeded += data.succeeded ?? 0
    out.failed += data.failed ?? 0
    out.skipped += data.skipped ?? 0
    out.errors.push(...(data.errors ?? []))
    for (const o of data.outcomes ?? [])
      out.outcomes.push({ ...o, item: `${collection}:${o.item}` })
  }
  return out
}

function describe(label: string, r: PushRunOutcome): string {
  const parts = [`${r.succeeded} done`]
  if (r.skipped) parts.push(`${r.skipped} skipped`)
  if (r.failed) parts.push(`${r.failed} failed`)
  return `${label}: ${parts.join(' · ')}`
}

type Op =
  | { kind: 'push'; action: PushItemAction & { collections: string[] } }
  | { kind: 'retry'; collections: string[] }

export function PushBulkButtons({
  targets,
  enabledKeys,
  tone = 'light',
  disabled,
  onDone
}: {
  targets: Target[]
  enabledKeys?: string[] | null
  tone?: 'dark' | 'light'
  disabled?: boolean
  onDone?: (result: BulkRunResult) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const collections = useMemo(() => [...new Set(targets.map((t) => t.collection))], [targets])
  const { data } = useAvailableBulkActions(collections)
  const pushCollections = collections.filter((c) => builtinListed(data, enabledKeys, c, 'push'))
  const retryCollections = collections.filter((c) =>
    builtinListed(data, enabledKeys, c, 'retry-push')
  )

  const actionQueries = useQueries({
    queries: pushCollections.map((c) => ({
      queryKey: ['bulk-push-actions', c],
      queryFn: () =>
        client
          .request<{ data: PushItemAction[] }>(get('/item-actions/registered', { collection: c }))
          .then((r) => r.data ?? [])
          .catch(() => [] as PushItemAction[]),
      staleTime: 5 * 60_000
    }))
  })
  const actionStamp = actionQueries.map((q) => q.dataUpdatedAt).join(',')
  // biome-ignore lint/correctness/useExhaustiveDependencies: actionStamp tracks the query results
  const pushActions = useMemo(() => {
    const byId = new Map<string, PushItemAction & { collections: string[] }>()
    pushCollections.forEach((c, i) => {
      for (const a of actionQueries[i]?.data ?? []) {
        const cur = byId.get(a.id)
        if (cur) cur.collections.push(c)
        else byId.set(a.id, { ...a, collections: [c] })
      }
    })
    return [...byId.values()]
  }, [actionStamp, pushCollections.join(',')])

  const [open, setOpen] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [preview, setPreview] = useState<Record<string, PushRunOutcome | 'loading' | null>>({})
  const [results, setResults] = useState<Record<string, PushRunOutcome | null>>({})

  const labelFor = (key: string): string => {
    const [c, ...rest] = key.split(':')
    const id = rest.join(':')
    const t = targets.find((x) => x.collection === c && String(x.id) === id)
    return t?.label ? String(t.label) : `#${id}`
  }

  const runOp = async (op: Op, dryRun: boolean): Promise<PushRunOutcome> => {
    const cols = op.kind === 'push' ? op.action.collections : op.collections
    const runs: Array<{ collection: string; data: PushRunOutcome }> = []
    for (const c of cols) {
      const ids = targets.filter((t) => t.collection === c).map((t) => t.id)
      if (ids.length === 0) continue
      const res =
        op.kind === 'push'
          ? await client.request<{ data: PushRunOutcome }>(
              post('/bulk-actions/push', {
                collection: c,
                action_id: op.action.id,
                ids,
                dry_run: dryRun,
                ...(note.trim() ? { payload: { message: note.trim() } } : {})
              })
            )
          : await client.request<{ data: PushRunOutcome }>(
              post('/bulk-actions/retry-push', { collection: c, ids, dry_run: dryRun })
            )
      runs.push({ collection: c, data: res.data })
    }
    return mergeRuns(runs)
  }

  const idOf = (op: Op) => (op.kind === 'push' ? `push:${op.action.id}` : 'retry-push')
  const labelOf = (op: Op) => (op.kind === 'push' ? op.action.label : 'Retry failed pushes')

  const loadPreview = async (op: Op) => {
    const id = idOf(op)
    setPreview((p) => ({ ...p, [id]: 'loading' }))
    try {
      const r = await runOp(op, true)
      setPreview((p) => ({ ...p, [id]: r }))
    } catch {
      setPreview((p) => ({ ...p, [id]: null }))
    }
  }

  const run = async (op: Op) => {
    const id = idOf(op)
    setRunning(id)
    try {
      const r = await runOp(op, false)
      setResults((p) => ({ ...p, [id]: r }))
      const msg = describe(labelOf(op), r)
      if (r.failed > 0) toast.warning(msg, { duration: 8000 })
      else toast.success(msg, { duration: 4000 })
      for (const key of [
        'erp-submissions',
        'row-push-state',
        'cbv-integrations-summary',
        'queue-integrations-summary',
        'integration-obligations',
        'item-actions'
      ])
        void qc.invalidateQueries({ queryKey: [key] })
    } catch (err) {
      const resp = (err as { response?: { error?: string } }).response
      toast.error(resp?.error ?? (err instanceof Error ? err.message : `${labelOf(op)} failed`))
    } finally {
      setRunning(null)
    }
  }

  const ops: Op[] = [
    ...pushActions.map((action) => ({ kind: 'push' as const, action })),
    ...(retryCollections.length > 0
      ? [{ kind: 'retry' as const, collections: retryCollections }]
      : [])
  ]
  if (ops.length === 0) return null

  const btn = (active: boolean) =>
    tone === 'dark'
      ? cn(
          'inline-flex h-8 items-center gap-1.5 rounded-md border border-white/20 px-3 text-[12.5px] font-medium transition-colors hover:bg-white/10 disabled:opacity-50 dark:border-border dark:hover:bg-muted',
          active && 'bg-white/10'
        )
      : cn(
          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-muted',
          active && 'bg-slate-100 dark:bg-muted'
        )

  return (
    <>
      {ops.map((op) => {
        const id = idOf(op)
        const label = labelOf(op)
        const cols = op.kind === 'push' ? op.action.collections : op.collections
        const n = targets.filter((t) => cols.includes(t.collection)).length
        const isOpen = open === id
        const isRunning = running === id
        const input = op.kind === 'push' ? op.action.confirm?.input : undefined
        const pv = preview[id]
        const done = results[id] ?? null
        const willRun = pv && pv !== 'loading' ? pv.succeeded : null
        const canRun =
          n > 0 && !isRunning && willRun !== 0 && (!input?.required || note.trim().length > 0)
        const body =
          op.kind === 'push'
            ? (op.action.confirm?.body ??
              `Runs "${op.action.label}" on each selected record, one at a time. Every record is a real request to the partner.`)
            : 'Re-sends the latest failed push of each selected record, partner by partner — the same stored request the record’s own Retry button sends.'
        return (
          <Popover
            key={id}
            open={isOpen}
            onOpenChange={(o) => {
              setOpen(o ? id : null)
              if (o) {
                setNote('')
                setResults((p) => ({ ...p, [id]: null }))
                void loadPreview(op)
              } else if (done) {
                onDone?.(done)
              }
            }}
          >
            <PopoverTrigger asChild>
              <button
                type='button'
                disabled={disabled || !!running}
                data-bulk-push-action={op.kind === 'push' ? op.action.id : undefined}
                data-bulk-retry-push={op.kind === 'retry' ? '' : undefined}
                title={
                  op.kind === 'push'
                    ? `Run ${op.action.label} on the selected records`
                    : 'Re-send each selected record’s latest failed push'
                }
                className={btn(isOpen)}
              >
                {isRunning ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Send className='h-3.5 w-3.5' />
                )}
                {label}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align='center'
              side='top'
              sideOffset={8}
              className='w-[340px] p-3'
              data-bulk-push-popover={id}
            >
              <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                {label}
                <span className='ml-1.5 font-normal text-slate-500 dark:text-slate-400'>
                  · {n} record{n === 1 ? '' : 's'}
                </span>
              </p>
              <p className='mt-1 text-[12px] leading-snug text-slate-600 dark:text-slate-400'>
                {body}
              </p>
              {!done &&
                (pv === 'loading' ? (
                  <p className='mt-2 text-[11.5px] text-slate-400' data-bulk-push-preview='loading'>
                    Checking which records this applies to…
                  </p>
                ) : pv ? (
                  <p
                    className='mt-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1.5 text-[11.5px] font-medium text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'
                    data-bulk-push-preview={pv.succeeded}
                  >
                    {pv.succeeded} of {n} would {op.kind === 'push' ? 'run' : 'be retried'}
                    {pv.skipped + pv.failed > 0 && (
                      <span className='font-normal text-slate-500 dark:text-slate-400'>
                        {' · '}
                        {summarizeReasons(pv)}
                      </span>
                    )}
                  </p>
                ) : null)}
              {!done && input && (
                <label className='mt-2.5 block'>
                  <span className='text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                    {input.label}
                    {input.required && <span className='text-destructive'> *</span>}
                  </span>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={input.placeholder ?? 'Sent with every record'}
                    rows={2}
                    className='mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card dark:text-slate-100'
                  />
                </label>
              )}
              {done && <PushResultList result={done} labelFor={labelFor} />}
              <div className='mt-3 flex items-center justify-end gap-2'>
                <button
                  type='button'
                  onClick={() => {
                    setOpen(null)
                    if (done) onDone?.(done)
                  }}
                  className='h-8 rounded-md px-2.5 text-[12.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
                >
                  {done ? 'Done' : 'Close'}
                </button>
                {!done && (
                  <button
                    type='button'
                    onClick={() => void run(op)}
                    disabled={!canRun}
                    data-bulk-push-run
                    className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-semibold text-[#172940] hover:bg-nvr-cyan-dark disabled:opacity-40'
                  >
                    {isRunning ? (
                      <Loader2 className='h-3.5 w-3.5 animate-spin' />
                    ) : willRun != null && willRun !== n ? (
                      `${op.kind === 'push' ? (op.action.confirm?.confirm_label ?? label) : 'Retry'} · ${willRun} of ${n}`
                    ) : (
                      `${op.kind === 'push' ? (op.action.confirm?.confirm_label ?? label) : 'Retry'} ${n}`
                    )}
                  </button>
                )}
              </div>
            </PopoverContent>
          </Popover>
        )
      })}
    </>
  )
}

function summarizeReasons(r: PushRunOutcome): string {
  const by = new Map<string, number>()
  for (const o of r.outcomes) {
    if (o.outcome === 'change') continue
    const k = o.reason ?? o.outcome
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return [...by.entries()].map(([k, c]) => `${c} ${k}`).join(' · ')
}

/** The per-row result list a run leaves in its popover. */
export function PushResultList({
  result,
  labelFor
}: {
  result: PushRunOutcome
  labelFor: (key: string) => string
}) {
  return (
    <div className='mt-2' data-bulk-push-results>
      <p className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
        {result.succeeded} done
        {result.skipped > 0 && ` · ${result.skipped} skipped`}
        {result.failed > 0 && (
          <span className='text-red-600 dark:text-red-400'> · {result.failed} failed</span>
        )}
      </p>
      <ul className='mt-1 max-h-48 space-y-1 overflow-auto'>
        {result.outcomes.map((o) => (
          <li
            key={o.item}
            data-bulk-push-result={o.item}
            data-outcome={o.outcome}
            className='flex items-start gap-1.5 text-[11.5px] leading-snug'
          >
            {o.outcome === 'change' ? (
              <CheckCircle2 className='mt-px h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
            ) : o.outcome === 'fail' ? (
              <AlertCircle className='mt-px h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' />
            ) : (
              <MinusCircle className='mt-px h-3.5 w-3.5 shrink-0 text-slate-400' />
            )}
            <span className='min-w-0'>
              <span className='font-medium text-slate-700 dark:text-slate-200'>
                {labelFor(o.item)}
              </span>
              {o.reason && (
                <span className='break-words text-slate-500 dark:text-slate-400'>
                  {' '}
                  — {o.reason}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
