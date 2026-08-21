import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { Button } from '../ui/button'

/**
 * Admin-defined custom action buttons (#39) — no-code record buttons (run a
 * flow, call an external API, write fields) configured per collection. Guards
 * are evaluated against the LIVE draft so a button hides the moment its
 * condition stops holding; the server re-checks on execute regardless.
 */

interface CustomAction {
  id: number
  label: string
  action_type: string
  guard: Array<{ field: string; op: string; value?: unknown }> | null
  confirm_text: string | null
}

function guardPasses(action: CustomAction, draft: Record<string, unknown>): boolean {
  for (const r of action.guard ?? []) {
    const v = draft[r.field]
    const want = r.value
    const ok = (() => {
      switch (r.op) {
        case 'eq':
          return String(v ?? '') === String(want ?? '')
        case 'neq':
          return String(v ?? '') !== String(want ?? '')
        case 'null':
          return v === null || v === undefined || v === ''
        case 'nnull':
          return !(v === null || v === undefined || v === '')
        case 'in':
          return String(want ?? '')
            .split(',')
            .map((x) => x.trim())
            .includes(String(v ?? ''))
        default:
          return false
      }
    })()
    if (!ok) return false
  }
  return true
}

export function CustomActionButtons({
  collection,
  itemId,
  draft
}: {
  collection: string
  itemId: string
  draft: Record<string, unknown>
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState<CustomAction | null>(null)
  const [runningId, setRunningId] = useState<number | null>(null)

  const { data: actions = [] } = useQuery({
    queryKey: ['custom-actions', collection],
    queryFn: () =>
      client
        .request<{ data: CustomAction[] }>(get('/custom-actions', { collection }))
        .then((r) => r.data ?? [])
        .catch(() => [] as CustomAction[]),
    staleTime: 5 * 60_000
  })

  const execute = useMutation({
    mutationFn: (action: CustomAction) =>
      client.request(post(`/custom-actions/${action.id}/execute`, { item: itemId })),
    onSuccess: (_res, action) => {
      toast.success(`${action.label} completed`)
      void qc.invalidateQueries({ queryKey: ['item', collection, String(itemId)] })
      void qc.invalidateQueries({ queryKey: ['o2m-rows'] })
    },
    onError: (err, action) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? `${action.label} failed`, { duration: 10000 })
    },
    onSettled: () => setRunningId(null)
  })

  const visible = actions.filter((a) => guardPasses(a, draft))
  if (visible.length === 0) return null

  const run = (a: CustomAction) => {
    setConfirming(null)
    setRunningId(a.id)
    execute.mutate(a)
  }

  return (
    <>
      {visible.map((a) =>
        confirming?.id === a.id ? (
          <span
            key={a.id}
            className='inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1 dark:border-amber-500/40 dark:bg-amber-500/10'
          >
            <span className='max-w-[260px] truncate text-[12px] text-amber-700 dark:text-amber-300'>
              {a.confirm_text || `Run "${a.label}"?`}
            </span>
            <Button type='button' size='sm' className='h-6 px-2 text-[11.5px]' onClick={() => run(a)}>
              Yes
            </Button>
            <Button
              type='button'
              size='sm'
              variant='outline'
              className='h-6 px-2 text-[11.5px]'
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            key={a.id}
            type='button'
            size='sm'
            variant='outline'
            className='gap-1.5'
            disabled={runningId !== null}
            data-custom-action={a.id}
            onClick={() => {
              if (a.confirm_text || a.action_type !== 'update_fields') setConfirming(a)
              else run(a)
            }}
          >
            {runningId === a.id ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
            ) : (
              <Zap className='h-3.5 w-3.5' />
            )}
            {a.label}
          </Button>
        )
      )}
    </>
  )
}
