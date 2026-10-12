import type { NivaroClient } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { HelpCircle, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

// ─── Access insights ─────────────────────────────────────────────────────────
// "Why?" beside a refused save / move / delete (#1867) and beside a record's
// owners (#1956, #1907). Every word comes from /access-insights — the server
// re-runs the same gates and the same owner resolver the app runs, so these
// popovers can only repeat what actually decided the outcome.

export type DeniedAction = 'read' | 'update' | 'delete' | 'transition'

interface DeniedExplanation {
  allowed: boolean
  reasons: Array<{ type: string; message: string }>
  who_can_change: Array<{ kind: string; people: string[]; message: string }>
  summary: string
}

interface OwnerExplanation {
  state: { label: string }
  summary: string
  owners: Array<{ id: string; name: string; sentences: string[]; unavailable: string | null }>
  groups: Array<{
    name: string | null
    is_default: boolean
    filters: Array<{ label: string; wants: string; record_value: string }>
  }>
}

interface ActNow {
  people: Array<{ id: string; online: boolean | null; available: boolean }>
  summary: string
}

/** A refusal the explainer can speak to: 403 (policy, scope, role, owner). */
export function isAccessRefusal(err: unknown): boolean {
  const r = (err as { response?: { status?: number }; status?: number } | null) ?? null
  return (r?.response?.status ?? r?.status) === 403
}

function deniedPath(o: {
  collection: string
  itemId: string
  action: DeniedAction
  transitionId?: string | null
}): string {
  const q = new URLSearchParams({ action: o.action })
  if (o.transitionId) q.set('transition', o.transitionId)
  return `/access-insights/denied/${o.collection}/${encodeURIComponent(o.itemId)}?${q}`
}

/**
 * A Sonner `action` for a refusal toast: "Why?" fetches the explanation and
 * shows it as a second, longer-lived toast (a toast cannot host a popover).
 */
export function deniedToastAction(
  client: NivaroClient,
  o: { collection: string; itemId: string; action: DeniedAction; transitionId?: string | null }
): { label: string; onClick: () => void } {
  return {
    label: 'Why?',
    onClick: () => {
      void client
        .request<{ data: DeniedExplanation }>(get(deniedPath(o)))
        .then((r) => {
          const d = r.data
          toast.info(d.summary, {
            description: d.who_can_change.map((w) => w.message).join(' '),
            duration: 20000
          })
        })
        .catch(() => toast.error('Could not explain this refusal'))
    }
  }
}

function DeniedBody(o: {
  collection: string
  itemId: string
  action: DeniedAction
  transitionId?: string | null
}) {
  const client = useNivaroClient()
  const { data, isLoading, isError } = useQuery<DeniedExplanation>({
    queryKey: ['access-insights', 'denied', o.collection, o.itemId, o.action, o.transitionId ?? ''],
    queryFn: () =>
      client.request<{ data: DeniedExplanation }>(get(deniedPath(o))).then((r) => r.data),
    staleTime: 15_000
  })
  if (isLoading)
    return (
      <p className='flex items-center gap-1.5 text-[12px] text-slate-500'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' /> Checking your access…
      </p>
    )
  if (isError || !data)
    return <p className='text-[12px] text-slate-500'>Could not explain this refusal.</p>
  return (
    <div className='space-y-2.5 text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
      <p className='font-medium text-slate-800 dark:text-slate-100'>{data.summary}</p>
      {data.who_can_change.length > 0 && (
        <div className='space-y-1 border-t border-slate-200 pt-2 dark:border-border'>
          <p className='text-[11px] font-medium text-slate-500'>Who can change it</p>
          {data.who_can_change.map((w) => (
            <p key={w.kind}>{w.message}</p>
          ))}
        </div>
      )}
    </div>
  )
}

/** "Why?" link beside a refusal message; the answer opens in a popover. */
export function WhyDeniedButton(props: {
  collection: string
  itemId: string
  action: DeniedAction
  transitionId?: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-why-denied
          className={
            props.className ??
            'inline-flex items-center gap-0.5 text-[11px] font-medium text-nvr-cyan hover:underline'
          }
        >
          <HelpCircle className='h-3 w-3' />
          Why?
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-80 p-3'>
        {open && <DeniedBody {...props} />}
      </PopoverContent>
    </Popover>
  )
}

function OwnersBody({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const base = `${collection}/${encodeURIComponent(itemId)}`
  const owners = useQuery<OwnerExplanation | null>({
    queryKey: ['access-insights', 'owners', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: OwnerExplanation }>(get(`/access-insights/owners/${base}`))
        .then((r) => r.data ?? null),
    staleTime: 30_000
  })
  const act = useQuery<ActNow | null>({
    queryKey: ['access-insights', 'act-now', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: ActNow }>(get(`/access-insights/act-now/${base}`))
        .then((r) => r.data ?? null)
        .catch(() => null),
    staleTime: 30_000
  })
  if (owners.isLoading)
    return (
      <p className='flex items-center gap-1.5 text-[12px] text-slate-500'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' /> Working out who owns this…
      </p>
    )
  const ex = owners.data
  if (!ex)
    return <p className='text-[12px] text-slate-500'>This record has no owners to explain.</p>
  const online = new Map((act.data?.people ?? []).map((p) => [p.id, p.online]))
  return (
    <div className='space-y-2.5 text-[12px] leading-relaxed text-slate-700 dark:text-slate-300'>
      <p className='font-medium text-slate-800 dark:text-slate-100'>{ex.summary}</p>
      {ex.owners.map((o) => (
        <div key={o.id} className='border-t border-slate-200 pt-2 dark:border-border'>
          <p className='flex items-center gap-1.5 text-[12px] font-medium text-slate-800 dark:text-slate-100'>
            {o.name}
            {online.get(o.id) === true && (
              <span className='rounded-full bg-emerald-500/10 px-1.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400'>
                online
              </span>
            )}
            {o.unavailable && (
              <span className='rounded-full bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400'>
                cannot act
              </span>
            )}
          </p>
          {o.sentences.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      ))}
      {act.data && (
        <p className='border-t border-slate-200 pt-2 text-[11.5px] text-slate-500 dark:border-border'>
          {act.data.summary}
        </p>
      )}
    </div>
  )
}

/** "Why these owners?" beside a record's owners list. */
export function WhyOwnersButton({ collection, itemId }: { collection: string; itemId: string }) {
  const [open, setOpen] = useState(false)
  if (!itemId || itemId === 'new') return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-why-owners
          className='flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-nvr-cyan'
        >
          <HelpCircle className='h-3 w-3' />
          Why?
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='max-h-[420px] w-96 overflow-y-auto overscroll-contain p-3'
      >
        {open && <OwnersBody collection={collection} itemId={itemId} />}
      </PopoverContent>
    </Popover>
  )
}
