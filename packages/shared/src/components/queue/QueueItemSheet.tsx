import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { type ColumnFormatConfig, formatMultiValue } from '../../lib/format-value'
import { cn, formatRelative } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { OwnerAvatars } from './OwnerAvatars'

interface QueueOwner {
  id: string
  name: string
}

export interface SheetItem {
  collection: string
  item_id: string
  label: string
  state: string | null
  state_color: string | null
  owners: QueueOwner[]
  sla_status: 'ok' | 'warning' | 'breached' | null
  at_risk: boolean
  aging_hours: number | null
  claimed_by: QueueOwner | null
  extra?: Record<string, unknown>
  url: string
}

interface InstanceState {
  id: string
  key: string
  label: string
  color: string | null
}

interface InstanceTransition {
  id: string
  label: string | null
  to_state: string
}

interface InstanceData {
  instance: { id: string } | null
  states: InstanceState[]
  available_transitions: InstanceTransition[]
}

interface CommentRow {
  id: number
  text: string
  created_at: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

function formatAging(hours: number | null): string {
  if (hours == null) return '—'
  if (hours < 1) return '<1h'
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

function formatFieldHeader(path: string): string {
  return path
    .split('.')
    .map((seg) => seg.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
    .join(' → ')
}

function MetaCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='bg-white px-3 py-2.5 dark:bg-card'>
      <p className='mb-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
        {label}
      </p>
      <div className='text-[12px] text-slate-700 dark:text-slate-200'>{children}</div>
    </div>
  )
}

export function QueueItemSheet({
  item,
  onOpenChange,
  onClaim,
  onRelease,
  workNextActive,
  onNext,
  refetchItems,
  stateLabels,
  collectionLabel,
  claimsEnabled = true,
  columnFormats,
  width,
  itemLayout
}: {
  item: SheetItem | null
  onOpenChange: (open: boolean) => void
  onClaim: (item: SheetItem) => void
  onRelease: (item: SheetItem) => void
  workNextActive?: boolean
  onNext?: () => void
  refetchItems: () => void
  /** State key → display label (falls back to the raw key). */
  stateLabels?: Record<string, string>
  /** Collection name → display name. */
  collectionLabel?: (name: string) => string
  /** When false the claim/release button is hidden. */
  claimsEnabled?: boolean
  /** Extra-field path → display format config (display-only). */
  columnFormats?: Record<string, ColumnFormatConfig>
  /** Sidebar width: px number or 'NN%' of viewport; default 480. */
  width?: number | string | null
  /** Layout slug the Open button pins on the full item; null = default. */
  itemLayout?: string | null
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const { open: openItemPage } = useItemNavigation()
  const [commentText, setCommentText] = useState('')

  const collection = item?.collection
  const itemId = item?.item_id

  const { data: instance } = useQuery<InstanceData | null>({
    queryKey: ['queue-sheet-instance', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: InstanceData }>(get(`/pipelines/instance/${collection}/${itemId}`))
        .then((r) => r.data),
    enabled: !!collection && !!itemId
  })

  const { data: comments } = useQuery<{ data: CommentRow[] }>({
    queryKey: ['queue-sheet-comments', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: CommentRow[] }>(get('/comments', { collection, item: itemId }))
        .catch(() => ({ data: [] })),
    enabled: !!collection && !!itemId
  })

  const transitionMut = useMutation({
    mutationFn: (transitionId: string) =>
      client.request(
        post(`/pipelines/instance/${collection}/${itemId}/transition`, {
          transition_id: transitionId
        })
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['queue-sheet-instance', collection, itemId] })
      refetchItems()
      toast.success('Transitioned')
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Transition failed')
    }
  })

  const commentMut = useMutation({
    mutationFn: (text: string) =>
      client.request(post('/comments', { collection, item: itemId, text })),
    onSuccess: () => {
      setCommentText('')
      qc.invalidateQueries({ queryKey: ['queue-sheet-comments', collection, itemId] })
    },
    onError: () => toast.error('Failed to post comment')
  })

  const transitions = instance?.available_transitions ?? []
  const stateById = new Map((instance?.states ?? []).map((s) => [s.id, s]))

  return (
    <Sheet open={!!item} onOpenChange={onOpenChange}>
      <SheetContent
        side='right'
        className='flex max-w-full flex-col gap-0 p-0'
        style={{ width: width ?? 480, maxWidth: '96vw' }}
      >
        {item && (
          <>
            <SheetHeader className='shrink-0 border-b border-slate-200 px-5 py-4 dark:border-border'>
              <div className='flex items-start justify-between gap-3 pr-6'>
                <div className='min-w-0'>
                  <SheetTitle className='truncate text-[15px] font-semibold'>
                    {item.label}
                  </SheetTitle>
                  <div className='mt-1.5 flex items-center gap-2'>
                    <Badge variant='outline'>
                      {collectionLabel ? collectionLabel(item.collection) : item.collection}
                    </Badge>
                    {item.state && (
                      <span
                        className='rounded px-1.5 py-0.5 text-[11px] font-medium'
                        style={{
                          backgroundColor: item.state_color ? `${item.state_color}1a` : undefined,
                          color: item.state_color ?? undefined
                        }}
                      >
                        {stateLabels?.[item.state] ?? item.state}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type='button'
                  onClick={() =>
                    openItemPage({
                      collection: item.collection,
                      itemId: item.item_id,
                      layoutSlug: itemLayout ?? null
                    })
                  }
                  className='flex shrink-0 items-center gap-1 text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
                >
                  Open <ExternalLink className='h-3 w-3' />
                </button>
              </div>
            </SheetHeader>

            <div className='flex-1 overflow-y-auto px-5 py-4'>
              <div className='mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
                <MetaCell label='Owners'>
                  <OwnerAvatars owners={item.owners} max={6} />
                </MetaCell>
                <MetaCell label='Claimed by'>{item.claimed_by?.name ?? '—'}</MetaCell>
                <MetaCell label='SLA'>
                  {item.sla_status ? (
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[11px] font-medium',
                        item.sla_status === 'breached'
                          ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                          : item.sla_status === 'warning'
                            ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400'
                            : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400'
                      )}
                    >
                      {item.sla_status}
                    </span>
                  ) : (
                    '—'
                  )}
                </MetaCell>
                <MetaCell label='Aging'>{formatAging(item.aging_hours)}</MetaCell>
                {item.at_risk && (
                  <MetaCell label='Risk'>
                    <span className='text-red-500'>⚑ At risk</span>
                  </MetaCell>
                )}
                {Object.entries(item.extra ?? {}).map(([key, value]) => (
                  <MetaCell key={key} label={formatFieldHeader(key)}>
                    {value == null || value === ''
                      ? '—'
                      : columnFormats?.[key]
                        ? formatMultiValue(String(value), columnFormats[key])
                        : String(value)}
                  </MetaCell>
                ))}
              </div>

              {transitions.length > 0 && (
                <div className='mb-4'>
                  <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
                    Transitions
                  </p>
                  <div className='flex flex-wrap gap-1.5'>
                    {transitions.map((t) => {
                      const target = stateById.get(t.to_state)
                      return (
                        <button
                          key={t.id}
                          type='button'
                          disabled={transitionMut.isPending}
                          onClick={() => transitionMut.mutate(t.id)}
                          className='flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:border-nvr-cyan hover:text-nvr-navy disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:text-nvr-cyan'
                        >
                          {t.label || target?.label || target?.key || 'Move'}
                          <ArrowRight className='h-3 w-3 text-slate-400' />
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {(claimsEnabled || item.claimed_by) && (
                <div className='mb-4'>
                  <button
                    type='button'
                    onClick={() => (item.claimed_by ? onRelease(item) : onClaim(item))}
                    className='rounded-md bg-nvr-cyan px-3 py-1.5 text-[12px] font-medium text-white hover:bg-nvr-cyan/90'
                  >
                    {item.claimed_by ? 'Release claim' : 'Claim this item'}
                  </button>
                </div>
              )}

              <div>
                <p className='mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-muted-foreground'>
                  Comments
                </p>
                <div className='space-y-2.5'>
                  {(comments?.data ?? []).map((c) => (
                    <div key={c.id} className='rounded-md bg-slate-50 px-3 py-2 dark:bg-muted/40'>
                      <p className='text-[11px] font-medium text-slate-500 dark:text-muted-foreground'>
                        {[c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || '—'}
                        <span className='ml-1.5 font-normal text-slate-400'>
                          {formatRelative(c.created_at)}
                        </span>
                      </p>
                      <p className='mt-0.5 whitespace-pre-wrap text-[12px] text-slate-700 dark:text-slate-200'>
                        {c.text}
                      </p>
                    </div>
                  ))}
                  {(comments?.data ?? []).length === 0 && (
                    <p className='text-[12px] text-slate-400'>No comments yet.</p>
                  )}
                </div>
                <div className='mt-2.5'>
                  <textarea
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    placeholder='Add a comment…'
                    rows={2}
                    className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-card'
                  />
                  <button
                    type='button'
                    disabled={!commentText.trim() || commentMut.isPending}
                    onClick={() => commentMut.mutate(commentText.trim())}
                    className='mt-1 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:text-slate-800 disabled:opacity-50 dark:border-border dark:text-slate-300'
                  >
                    Post
                  </button>
                </div>
              </div>
            </div>

            {workNextActive && onNext && (
              <div className='shrink-0 border-t border-slate-200 px-5 py-3 dark:border-border'>
                <button
                  type='button'
                  onClick={onNext}
                  className='flex w-full items-center justify-center gap-1.5 rounded-md bg-nvr-cyan px-3 py-2 text-[13px] font-semibold text-white hover:bg-nvr-cyan/90'
                >
                  Next <ArrowRight className='h-3.5 w-3.5' />
                </button>
              </div>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
