import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

interface SubRow {
  id: number
  collection: string | null
  event_type: string
  filter_field: string | null
  filter_value: string | null
  filters: Array<{ field: string; op: string; value?: unknown }> | null
}

type SubscribeMode = 'state' | 'all'

/**
 * Per-record notification subscription — a bell in the item header that lets
 * any user watch this specific record. Backed entirely by the existing
 * nivaro_notification_subscriptions engine:
 *
 *   State changes only → one event_type='workflow_transition' row scoped to
 *     the record via filters [{field:'id', op:'eq', value:<id>}] (filter_field
 *     stays null — on transition subs it means "to_state").
 *   All changes → that row PLUS an event_type='all' row scoped via
 *     filter_field='id' / filter_value (the create/update/delete path reads
 *     only the flat filter pair, never the filters JSON).
 *
 * Transitions never fire the items-service update hook (state mirrors are raw
 * writes), so the two rows can't double-notify.
 */
export function RecordSubscribeButton({
  collection,
  itemId,
  recordLabel
}: {
  collection: string
  itemId: string
  recordLabel?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<SubscribeMode>('all')

  const { data: subs = [], isLoading } = useQuery<SubRow[]>({
    queryKey: ['record-subscriptions', collection, itemId],
    queryFn: async () => {
      const rows = await client
        .request<{ data: SubRow[] }>(get('/notification-subscriptions'))
        .then((r) => r.data ?? [])
      return rows.filter((s) => {
        if (s.collection !== collection) return false
        if (s.filter_field === 'id' && String(s.filter_value) === String(itemId)) return true
        return (s.filters ?? []).some(
          (f) => f.field === 'id' && f.op === 'eq' && String(f.value) === String(itemId)
        )
      })
    },
    staleTime: 30_000
  })

  const subscribed = subs.length > 0
  const currentMode: SubscribeMode = subs.some((s) => s.event_type !== 'workflow_transition')
    ? 'all'
    : 'state'

  const label = useMemo(
    () => `Watching ${titleCase(collection)} ${recordLabel || `#${itemId}`}`.slice(0, 255),
    [collection, recordLabel, itemId]
  )

  const applyMut = useMutation({
    mutationFn: async (next: SubscribeMode | 'off') => {
      const wantTransition = next !== 'off'
      const wantAll = next === 'all'
      const hasTransition = subs.some((s) => s.event_type === 'workflow_transition')
      const allRows = subs.filter((s) => s.event_type !== 'workflow_transition')

      if (wantTransition && !hasTransition) {
        await client.request(
          post('/notification-subscriptions', {
            collection,
            event_type: 'workflow_transition',
            filters: [{ field: 'id', op: 'eq', value: String(itemId) }],
            label
          })
        )
      }
      if (wantAll && allRows.length === 0) {
        await client.request(
          post('/notification-subscriptions', {
            collection,
            event_type: 'all',
            filter_field: 'id',
            filter_value: String(itemId),
            label
          })
        )
      }
      if (!wantAll) {
        for (const s of allRows) {
          await client.request(del(`/notification-subscriptions/${s.id}`))
        }
      }
      if (!wantTransition) {
        for (const s of subs.filter((x) => x.event_type === 'workflow_transition')) {
          await client.request(del(`/notification-subscriptions/${s.id}`))
        }
      }
    },
    onSuccess: (_d, next) => {
      void qc.invalidateQueries({ queryKey: ['record-subscriptions', collection, itemId] })
      toast.success(
        next === 'off'
          ? 'Unsubscribed from this record'
          : next === 'all'
            ? 'Subscribed to all changes on this record'
            : 'Subscribed to state changes on this record'
      )
      setOpen(false)
    },
    onError: (err) => {
      const resp = (err as { response?: { error?: string } })?.response
      toast.error(resp?.error ?? 'Could not update subscription')
    }
  })

  return (
    <>
      <Button
        type='button'
        variant='outline'
        size='sm'
        onClick={() => {
          setMode(subscribed ? currentMode : 'all')
          setOpen(true)
        }}
        title={subscribed ? 'Subscribed to this record — click to manage' : 'Subscribe to this record'}
        className='gap-1.5 px-2'
        data-nvr-record-subscribe={subscribed ? 'on' : 'off'}
      >
        {subscribed ? (
          <BellRing className='h-3.5 w-3.5 text-nvr-cyan' />
        ) : (
          <Bell className='h-3.5 w-3.5' />
        )}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className='max-w-[420px]'>
          <DialogHeader>
            <DialogTitle className='flex items-center gap-2 text-[14px]'>
              <Bell className='h-4 w-4 text-nvr-cyan' />
              {subscribed ? 'Manage subscription' : 'Subscribe to this record'}
            </DialogTitle>
            <DialogDescription className='text-[12px]'>
              Get notified when this {titleCase(collection).replace(/s$/, '').toLowerCase() || 'record'}{' '}
              changes. Notifications arrive in-app and by email.
            </DialogDescription>
          </DialogHeader>
          <div className='space-y-2 py-1'>
            {(
              [
                {
                  value: 'state' as const,
                  title: 'State changes only',
                  desc: 'Only when the record moves to a new workflow state.'
                },
                {
                  value: 'all' as const,
                  title: 'All changes',
                  desc: 'Every edit, deletion, and workflow state change.'
                }
              ] satisfies Array<{ value: SubscribeMode; title: string; desc: string }>
            ).map((opt) => (
              <button
                key={opt.value}
                type='button'
                onClick={() => setMode(opt.value)}
                className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${
                  mode === opt.value
                    ? 'border-nvr-cyan bg-nvr-cyan/5'
                    : 'border-slate-200 hover:border-slate-300 dark:border-border dark:hover:border-slate-600'
                }`}
              >
                <span
                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                    mode === opt.value
                      ? 'border-nvr-cyan bg-nvr-cyan'
                      : 'border-slate-300 dark:border-slate-600'
                  }`}
                >
                  {mode === opt.value && <span className='h-1.5 w-1.5 rounded-full bg-white' />}
                </span>
                <span>
                  <span className='block text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                    {opt.title}
                  </span>
                  <span className='block text-[11.5px] text-slate-500 dark:text-slate-400'>
                    {opt.desc}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <DialogFooter className='flex items-center gap-2 sm:justify-between'>
            {subscribed ? (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='text-red-600 hover:text-red-700'
                disabled={applyMut.isPending}
                onClick={() => applyMut.mutate('off')}
              >
                Unsubscribe
              </Button>
            ) : (
              <span />
            )}
            <div className='flex gap-2'>
              <Button type='button' variant='outline' size='sm' onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type='button'
                size='sm'
                disabled={isLoading || applyMut.isPending || (subscribed && mode === currentMode)}
                onClick={() => applyMut.mutate(mode)}
              >
                {applyMut.isPending ? (
                  <Loader2 className='h-3.5 w-3.5 animate-spin' />
                ) : subscribed ? (
                  'Update'
                ) : (
                  'Subscribe'
                )}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
