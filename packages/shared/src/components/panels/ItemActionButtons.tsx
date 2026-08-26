import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Play } from 'lucide-react'
import { useState } from 'react'
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

  const execute = useMutation({
    mutationFn: (action: ItemActionMeta) =>
      client.request<{ data: { message: string } }>(
        post(`/item-actions/${action.id}/execute`, { collection, itemId })
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
    onError: (err, action) => {
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
            setRunningId(a.id)
            execute.mutate(a)
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
    </>
  )
}
