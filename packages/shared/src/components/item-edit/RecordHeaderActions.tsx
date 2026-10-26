import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, Zap } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { userErrorMessage } from '../../lib/safe-error'
import { cn } from '../../lib/utils'
import {
  type AvailableBulkAction,
  guardMatches,
  useAvailableBulkActions
} from '../bulk/BulkActionButtons'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Textarea } from '../ui/textarea'
import { invalidateRecordQueries } from './RecordLiveSync'

/**
 * Registry actions marked "Also a button in the record header" (config.header)
 * — Hold / Remove Hold on EFP workflows (Rob 2026-10-26) — beside the record's
 * transition buttons. Each is offered only when the person may run it
 * (/bulk-actions/available judges access) and the record passes its guard
 * (On Hold never shows on a held record). The fields a guard reads that the
 * form's values lack are read for this record, as the list row menu does.
 */
export function useRecordHeaderActions(
  collection: string,
  itemId: string | null,
  values: Record<string, unknown> | null | undefined
): AvailableBulkAction[] {
  const client = useNivaroClient()
  const enabled = !!itemId && itemId !== 'new'
  const { data: bulkData } = useAvailableBulkActions(enabled ? [collection] : [])
  const candidates = useMemo(
    () =>
      (bulkData?.[collection] ?? []).filter(
        (a) => a.header === true && (a.kind === 'update_fields' || a.kind === 'transition')
      ),
    [bulkData, collection]
  )
  const guardFields = useMemo(() => {
    const need = new Set<string>()
    for (const a of candidates)
      for (const g of a.guard ?? [])
        if (g && typeof g.field === 'string' && !(values && g.field in values)) need.add(g.field)
    return [...need].sort()
  }, [candidates, values])
  const { data: guardRow } = useQuery<Record<string, unknown>>({
    queryKey: ['record-header-action-guard', collection, String(itemId), guardFields.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(
          get(`/items/${encodeURIComponent(collection)}/${encodeURIComponent(String(itemId))}`, {
            fields: guardFields.join(',')
          })
        )
        .then((r) => r.data ?? {})
        .catch(() => ({})),
    enabled: enabled && guardFields.length > 0,
    staleTime: 0
  })
  return useMemo(() => {
    if (guardFields.length > 0 && !guardRow) return candidates.filter((a) => !a.guard?.length)
    const merged = { ...(guardRow ?? {}), ...(values ?? {}) }
    return candidates.filter((a) => guardMatches(a.guard, merged) !== false)
  }, [candidates, guardFields, guardRow, values])
}

function iconFor(a: AvailableBulkAction) {
  if (/remove-hold|unhold/i.test(a.key)) return <Play className='h-3.5 w-3.5' />
  if (/hold/i.test(a.key)) return <Pause className='h-3.5 w-3.5' />
  return <Zap className='h-3.5 w-3.5' />
}

/** Hover text in plain words: what the action does, and that it asks why. */
function headerTip(a: AvailableBulkAction): string {
  const what = a.summary && a.summary !== 'Built-in' ? a.summary : a.label
  return a.require_reason
    ? `${what}. You’ll be asked for a justification, saved as a note on the record.`
    : `${what}.`
}

/** The header buttons. Opening one hands the action to the host, which renders
 *  RecordHeaderActionDialog OUTSIDE the header tool strip (a folded strip
 *  unmounts its children). */
export function RecordHeaderActionButtons({
  actions,
  onPick
}: {
  actions: AvailableBulkAction[]
  onPick: (a: AvailableBulkAction) => void
}) {
  if (actions.length === 0) return null
  return (
    <>
      {actions.map((a) => (
        <button
          key={`${a.source}:${a.key}`}
          type='button'
          data-record-header-action={a.key}
          data-tip={headerTip(a)}
          onClick={() => onPick(a)}
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-[13px] font-medium shadow-sm transition-colors',
            a.variant === 'danger'
              ? 'border-red-300 text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10'
              : 'border-slate-300 bg-background text-slate-700 hover:bg-accent dark:border-border dark:text-slate-200'
          )}
        >
          {iconFor(a)}
          {a.label}
        </button>
      ))}
    </>
  )
}

/** Confirm + justification for one header action, run on this one record
 *  through the registry's own endpoint (access, guard and the reason rule are
 *  judged there). */
export function RecordHeaderActionDialog({
  action,
  collection,
  itemId,
  onClose,
  onDone
}: {
  action: AvailableBulkAction | null
  collection: string
  itemId: string
  onClose: () => void
  onDone?: () => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [reason, setReason] = useState('')
  const needsReason = !!action?.require_reason
  const run = useMutation({
    mutationFn: async (a: AvailableBulkAction) => {
      const body = { collection, ids: [itemId], reason: reason.trim() || null }
      const res =
        a.source === 'db'
          ? await client.request<{
              data: { succeeded?: number; skipped?: number; errors?: Array<{ error: string }> }
            }>(post('/bulk-actions/run', { ...body, key: a.key }))
          : await client.request<{
              data: { succeeded?: number; skipped?: number; errors?: Array<{ error: string }> }
            }>(post(`/bulk-actions/${a.key}/execute`, body))
      return { a, result: res.data ?? {} }
    },
    onSuccess: ({ a, result }) => {
      if (result.errors?.length) {
        toast.error(result.errors[0].error)
      } else if (!result.succeeded && result.skipped) {
        toast.info(`${a.label}: nothing to change on this record`)
      } else {
        toast.success(`${a.label} — done`)
      }
      invalidateRecordQueries(qc, collection, [itemId])
      void qc.invalidateQueries({ queryKey: ['record-header-action-guard', collection] })
      setReason('')
      onDone?.()
      onClose()
    },
    onError: (err: unknown) => toast.error(userErrorMessage(err, 'The action did not run'))
  })
  return (
    <Dialog
      open={!!action}
      onOpenChange={(o) => {
        if (!o) {
          setReason('')
          onClose()
        }
      }}
    >
      <DialogContent className='sm:max-w-md' data-record-header-action-dialog=''>
        <DialogHeader>
          <DialogTitle>{action?.label}</DialogTitle>
          {action?.confirm_text && <DialogDescription>{action.confirm_text}</DialogDescription>}
        </DialogHeader>
        <div className='space-y-1.5'>
          <label htmlFor='record-header-action-reason' className='text-[12.5px] font-medium'>
            {needsReason ? 'Justification (required)' : 'Justification (optional)'}
          </label>
          <Textarea
            id='record-header-action-reason'
            autoFocus
            rows={4}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder='Why? This is saved as a note on the record.'
          />
        </div>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => action && run.mutate(action)}
            disabled={!action || run.isPending || (needsReason && !reason.trim())}
            className='bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
          >
            {run.isPending ? 'Working…' : action?.label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
