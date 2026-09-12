import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * Registry bulk actions (GET /bulk-actions/available) rendered as buttons in
 * a selection bar. Each button opens an anchored popover — what the action
 * does, how many records, the reason field when the action requires one —
 * and runs it via POST /bulk-actions/run (DB-defined) or
 * POST /bulk-actions/:id/execute (extension-registered). Targets may span
 * collections (queues): one run per collection that offers the action.
 */

export interface AvailableBulkAction {
  key: string
  source: 'db' | 'extension' | 'builtin'
  collection: string | null
  label: string
  icon: string | null
  variant: 'default' | 'danger'
  kind: 'update_fields' | 'transition' | 'extension' | 'builtin'
  require_reason: boolean
  confirm_text: string | null
  summary: string
  surfaces?: Array<'browser' | 'queue'>
}

export interface BulkTarget {
  collection: string
  id: string | number
}

export interface BulkRunResult {
  succeeded: number
  failed: number
  skipped: number
  errors: Array<{ item: string; error: string }>
}

/** Available actions per collection, for the viewer. */
export function useAvailableBulkActions(collections: string[]) {
  const client = useNivaroClient()
  const key = [...new Set(collections)].sort().join(',')
  return useQuery<Record<string, AvailableBulkAction[]>>({
    queryKey: ['bulk-actions-available', key],
    queryFn: async () => {
      const out: Record<string, AvailableBulkAction[]> = {}
      await Promise.all(
        key.split(',').map(async (c) => {
          try {
            const res = await client.request<{ data: AvailableBulkAction[] }>(
              get('/bulk-actions/available', { collection: c })
            )
            out[c] = res.data ?? []
          } catch {
            out[c] = []
          }
        })
      )
      return out
    },
    enabled: key.length > 0,
    staleTime: 60_000
  })
}

/** Is `key` on `collection` enabled by a surface's list? null/undefined = all. */
export function bulkActionEnabled(
  enabledKeys: string[] | null | undefined,
  collection: string,
  key: string
): boolean {
  if (!enabledKeys) return true
  return enabledKeys.includes(key) || enabledKeys.includes(`${collection}:${key}`)
}

/**
 * Gate for the bars' BUILT-IN operations (Update Field, Transition, Message,
 * Delete, Compare, Merge, recipes, Claim, Release): shown when at least one
 * of the collections lists the built-in as available AND the surface's
 * allow-list includes it. An API that returns no built-in entries at all
 * (older server, request failed) leaves everything visible — the server
 * still enforces on the endpoints behind each operation.
 */
export function useBuiltinGate(collections: string[], enabledKeys?: string[] | null) {
  const { data } = useAvailableBulkActions(collections)
  const known = !!data && Object.values(data).some((l) => l.some((a) => a.source === 'builtin'))
  return (key: string): boolean => {
    if (!known) return true
    return collections.some(
      (c) =>
        (data?.[c] ?? []).some((a) => a.source === 'builtin' && a.key === key) &&
        bulkActionEnabled(enabledKeys, c, key)
    )
  }
}

/** Distinct REGISTRY actions across the targets' collections (built-ins are
 *  rendered by the host bars themselves — see useBuiltinGate). */
export function mergeBulkActions(
  byCollection: Record<string, AvailableBulkAction[]> | undefined,
  collections: string[],
  enabledKeys: string[] | null | undefined
): Array<AvailableBulkAction & { collections: string[] }> {
  const out = new Map<string, AvailableBulkAction & { collections: string[] }>()
  for (const c of collections) {
    for (const a of byCollection?.[c] ?? []) {
      if (a.source === 'builtin') continue
      if (!bulkActionEnabled(enabledKeys, c, a.key)) continue
      const id = `${a.source}:${a.key}`
      const cur = out.get(id)
      if (cur) cur.collections.push(c)
      else out.set(id, { ...a, collections: [c] })
    }
  }
  return [...out.values()]
}

function describeResult(label: string, r: BulkRunResult, total: number): string {
  const parts = [`${r.succeeded} done`]
  if (r.skipped) parts.push(`${r.skipped} skipped`)
  if (r.failed) parts.push(`${r.failed} failed`)
  return `${label}: ${parts.join(' · ')}${total !== r.succeeded + r.skipped + r.failed ? ` of ${total}` : ''}`
}

export function BulkActionButtons({
  targets,
  enabledKeys,
  tone = 'light',
  disabled,
  onDone
}: {
  targets: BulkTarget[]
  /** Surface allow-list (browser_config.bulk_actions / display_config.bulk_action_keys). */
  enabledKeys?: string[] | null
  /** 'dark' = the collection browser's navy bar; 'light' = the queue pill. */
  tone?: 'dark' | 'light'
  disabled?: boolean
  onDone?: (result: BulkRunResult & { action: AvailableBulkAction }) => void
}) {
  const client = useNivaroClient()
  const collections = [...new Set(targets.map((t) => t.collection))]
  const { data } = useAvailableBulkActions(collections)
  const actions = mergeBulkActions(data, collections, enabledKeys)
  const [open, setOpen] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [running, setRunning] = useState<string | null>(null)

  if (actions.length === 0) return null

  const run = async (a: AvailableBulkAction & { collections: string[] }) => {
    const id = `${a.source}:${a.key}`
    setRunning(id)
    const total: BulkRunResult = { succeeded: 0, failed: 0, skipped: 0, errors: [] }
    let count = 0
    try {
      for (const c of a.collections) {
        const ids = targets.filter((t) => t.collection === c).map((t) => t.id)
        if (ids.length === 0) continue
        count += ids.length
        const body = { collection: c, ids, reason: reason.trim() || null }
        const res =
          a.source === 'db'
            ? await client.request<{ data: BulkRunResult }>(
                post('/bulk-actions/run', { ...body, key: a.key })
              )
            : await client.request<{ data: { message?: string } }>(
                post(`/bulk-actions/${a.key}/execute`, body)
              )
        const r = (res as { data: Partial<BulkRunResult> }).data ?? {}
        total.succeeded += r.succeeded ?? (a.source === 'extension' ? ids.length : 0)
        total.failed += r.failed ?? 0
        total.skipped += r.skipped ?? 0
        total.errors.push(...(r.errors ?? []))
      }
      const msg = describeResult(a.label, total, count)
      const detail = total.errors
        .slice(0, 3)
        .map((e) => `#${e.item}: ${e.error}`)
        .join('\n')
      if (total.failed > 0) toast.warning(msg, { description: detail || undefined, duration: 8000 })
      else toast.success(msg, { duration: 4000 })
      onDone?.({ ...total, action: a })
      setOpen(null)
      setReason('')
    } catch (err) {
      const resp = (err as { response?: { error?: string } }).response
      toast.error(resp?.error ?? (err instanceof Error ? err.message : `${a.label} failed`))
    } finally {
      setRunning(null)
    }
  }

  const btn = (a: AvailableBulkAction, active: boolean) =>
    tone === 'dark'
      ? cn(
          'h-8 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50',
          a.variant === 'danger'
            ? 'border border-red-400/50 text-red-200 hover:bg-red-500/20'
            : 'border border-white/20 hover:bg-white/10',
          active && (a.variant === 'danger' ? 'bg-red-500/20' : 'bg-white/10')
        )
      : cn(
          'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50',
          a.variant === 'danger'
            ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-500/10'
            : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-muted',
          active &&
            (a.variant === 'danger' ? 'bg-red-50 dark:bg-red-500/10' : 'bg-slate-100 dark:bg-muted')
        )

  return (
    <>
      {actions.map((a) => {
        const id = `${a.source}:${a.key}`
        const isOpen = open === id
        const isRunning = running === id
        const n = targets.filter((t) => a.collections.includes(t.collection)).length
        const canRun = n > 0 && (!a.require_reason || reason.trim().length > 0) && !isRunning
        return (
          <Popover
            key={id}
            open={isOpen}
            onOpenChange={(o) => {
              setOpen(o ? id : null)
              if (!o) setReason('')
            }}
          >
            <PopoverTrigger asChild>
              <button
                type='button'
                disabled={disabled || !!running}
                data-bulk-action={a.key}
                title={a.summary}
                className={btn(a, isOpen)}
              >
                {isRunning ? <Loader2 className='inline h-3.5 w-3.5 animate-spin' /> : a.label}
              </button>
            </PopoverTrigger>
            <PopoverContent
              align='center'
              side='top'
              sideOffset={8}
              className='w-[320px] p-3'
              data-bulk-action-popover={a.key}
            >
              <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
                {a.label}
                <span className='ml-1.5 font-normal text-slate-500 dark:text-slate-400'>
                  · {n} record{n === 1 ? '' : 's'}
                </span>
              </p>
              <p className='mt-1 text-[12px] leading-snug text-slate-600 dark:text-slate-400'>
                {a.confirm_text ?? a.summary}
              </p>
              {a.require_reason && (
                <label className='mt-2.5 block'>
                  <span className='text-[11px] font-medium text-slate-600 dark:text-slate-400'>
                    Reason <span className='text-destructive'>*</span>
                  </span>
                  <textarea
                    // biome-ignore lint/a11y/noAutofocus: the popover just opened for this
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canRun) void run(a)
                    }}
                    rows={2}
                    placeholder='Recorded on every record’s history'
                    className='mt-1 w-full resize-none rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12.5px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                  />
                </label>
              )}
              <div className='mt-3 flex items-center justify-end gap-2'>
                <button
                  type='button'
                  onClick={() => setOpen(null)}
                  className='h-8 rounded-md px-2.5 text-[12.5px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
                >
                  Close
                </button>
                <button
                  type='button'
                  onClick={() => void run(a)}
                  disabled={!canRun}
                  data-bulk-action-run
                  className={cn(
                    'h-8 rounded-md px-3 text-[12.5px] font-semibold disabled:opacity-40',
                    a.variant === 'danger'
                      ? 'bg-red-600 text-white hover:bg-red-700'
                      : 'bg-nvr-cyan text-[#172940] hover:bg-[#00b8e0]'
                  )}
                >
                  {isRunning ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : `${a.label} ${n}`}
                </button>
              </div>
            </PopoverContent>
          </Popover>
        )
      })}
    </>
  )
}
