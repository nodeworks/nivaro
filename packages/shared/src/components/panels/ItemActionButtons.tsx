import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play, X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { Button } from '../ui/button'

/**
 * Extension-registered item actions (ctx.itemActions.register — e.g. EFP's
 * "Push to Fusion") rendered as toolbar buttons for the current record.
 * Headless counterpart of the block the admin's ItemEdit page renders in its
 * own header; hosts opt in via ItemEditForm's `showItemActions`.
 */

interface ItemActionMeta {
  id: string
  label: string
  variant?: 'default' | 'destructive' | 'outline'
  /** Pre-execute dialog: body explains what will happen; input adds an
   *  optional/required free-text field posted as payload.message. */
  confirm?: {
    title?: string
    body?: string
    confirm_label?: string
    input?: { label: string; placeholder?: string; required?: boolean }
  }
}

export function ItemActionButtons({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [runningId, setRunningId] = useState<string | null>(null)

  const { data: actions } = useQuery({
    queryKey: ['item-actions', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: ItemActionMeta[] }>(get('/item-actions/registered', { collection, item: itemId }))
        .then((r) => r.data ?? []),
    staleTime: 5 * 60_000
  })

  const [confirming, setConfirming] = useState<ItemActionMeta | null>(null)
  const [note, setNote] = useState('')

  const execute = useMutation({
    mutationFn: ({ action, message }: { action: ItemActionMeta; message?: string }) =>
      client.request<{ data: { message: string } }>(
        post(`/item-actions/${action.id}/execute`, {
          collection,
          itemId,
          ...(message?.trim() ? { payload: { message: message.trim() } } : {})
        })
      ),
    onSuccess: (res) => {
      toast.success((res as { data?: { message?: string } })?.data?.message ?? 'Action completed')
      void qc.invalidateQueries({ queryKey: ['item', collection, String(itemId)] })
      void qc.invalidateQueries({ queryKey: ['erp-submissions', collection, String(itemId)] })
      // Re-evaluate applicability — an action that just consumed its own
      // precondition (closeout drafts the addendum) should disappear now,
      // not when the 5-minute staleTime lapses.
      void qc.invalidateQueries({ queryKey: ['item-actions', collection, itemId] })
      // An action can change the record's CHILDREN too — Push to Fusion stamps
      // the requisition id onto every line — and those live in their own
      // queries, so refreshing the record alone left the grid showing stale
      // values until a manual page reload.
      void qc.invalidateQueries({ queryKey: ['o2m-rows'] })
      void qc.invalidateQueries({ queryKey: ['pipeline-instance', collection, String(itemId)] })
    },
    onError: (err, { action }) => {
      // SDK attaches the parsed error body as `response` — show the full
      // server message (validation details, HTTP status + body).
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? `${action.label} failed`, { duration: 12000 })
      void qc.invalidateQueries({ queryKey: ['erp-submissions', collection, String(itemId)] })
    },
    onSettled: () => setRunningId(null)
  })

  if (!actions || actions.length === 0) return null

  return (
    <>
      {actions.map((a) => (
        <Button
          key={a.id}
          type='button'
          size='sm'
          variant={a.variant ?? 'outline'}
          className='gap-1.5'
          disabled={runningId !== null}
          onClick={() => {
            if (a.confirm) {
              setNote('')
              setConfirming(a)
              return
            }
            setRunningId(a.id)
            execute.mutate({ action: a })
          }}
        >
          {runningId === a.id ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <Play className='h-3.5 w-3.5' />
          )}
          {a.label}
        </Button>
      ))}
      {confirming &&
        createPortal(
          <div className='fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4'>
            <div className='w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card'>
              <div className='flex items-start justify-between gap-3'>
                <h3 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
                  {confirming.confirm?.title ?? confirming.label}
                </h3>
                <button
                  type='button'
                  onClick={() => setConfirming(null)}
                  className='rounded p-1 text-slate-400 hover:text-slate-600'
                  aria-label='Close'
                >
                  <X className='h-4 w-4' />
                </button>
              </div>
              {confirming.confirm?.body && (
                <p className='mt-2 text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
                  {confirming.confirm.body}
                </p>
              )}
              {confirming.confirm?.input && (
                <div className='mt-3'>
                  <p className='mb-1 text-[11.5px] font-medium text-slate-500'>
                    {confirming.confirm.input.label}
                  </p>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder={confirming.confirm.input.placeholder}
                    rows={3}
                    className='w-full rounded-md border border-slate-200 bg-background px-2.5 py-1.5 text-[12.5px] dark:border-border'
                  />
                </div>
              )}
              <div className='mt-4 flex justify-end gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </Button>
                <Button
                  type='button'
                  size='sm'
                  disabled={!!confirming.confirm?.input?.required && !note.trim()}
                  onClick={() => {
                    const a = confirming
                    setConfirming(null)
                    setRunningId(a.id)
                    execute.mutate({ action: a, message: note })
                  }}
                >
                  {confirming.confirm?.confirm_label ?? confirming.label}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
