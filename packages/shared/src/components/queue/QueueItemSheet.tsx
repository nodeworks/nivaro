import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ExternalLink } from 'lucide-react'
import { useEffect, useState } from 'react'

interface ReqDialogState {
  payload: TransitionRequirementsPayload
  transitionId: string
  /** The note the move was asked with — the requirements retry sends it again. */
  comment?: string
  revision: number
}

import { toast } from 'sonner'
import { useItemNavigation, useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { type ColumnFormatConfig, formatMultiValue } from '../../lib/format-value'
import { batchTouches, LIVE_ASPECTS, useLiveRecord } from '../../lib/live'
import { userErrorMessage } from '../../lib/safe-error'
import { cn, formatRelative, humanHours } from '../../lib/utils'
import { transitionRequirementsFromError } from '../panels/PipelinePanel'
import {
  TransitionRequirementsDialog,
  type TransitionRequirementsPayload
} from '../panels/TransitionRequirementsDialog'
import { Badge } from '../ui/badge'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet'
import { OwnerAvatars } from './OwnerAvatars'
import { pathHeader } from './path-label'
import { needsTransitionNote, useTransitionNote } from './transition-note'

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

export interface InstanceTransition {
  id: string
  label: string | null
  to_state: string
  /** Per-transition list-menu gate: false = form-only (Approve), never offered here. */
  in_row_menu?: boolean
  /** 'required' = the move needs a note (Send Back, Cancel). */
  comment_mode?: string | null
}

/**
 * The moves the Peek sheet offers: the row-menu set (army6 H7). Form-only moves
 * (Approve, typically) need the full record in front of the approver; an older
 * server that omits the flag offers everything, as the row menu does.
 */
export function peekTransitions<T extends { in_row_menu?: boolean }>(list: T[] | undefined): T[] {
  return (list ?? []).filter((t) => t.in_row_menu !== false)
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
  /** Soft-deleted: the server keeps a tombstone, the sheet does not show it. */
  deleted?: boolean
}

function formatAging(hours: number | null): string {
  return humanHours(hours)
}

const formatFieldHeader = pathHeader

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
  fieldLabel,
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
  /** Extra-field path → the label its list column header shows (the queue's column
   *  alias); without it the path is spelled out (army 7 N7: "PROJECT TYPE → NAME"). */
  fieldLabel?: (field: string) => string
  /** Sidebar width: px number or 'NN%' of viewport; default 480. */
  width?: number | string | null
  /** Layout slug the Open button pins on the full item; null = default. */
  itemLayout?: string | null
}) {
  const qc = useQueryClient()
  const client = useNivaroClient()
  const { open: openItemPage } = useItemNavigation()
  const [commentText, setCommentText] = useState('')
  const [reqDialog, setReqDialog] = useState<ReqDialogState | null>(null)
  // army6 H7 — nothing moves on one click: a move without a note asks
  // "Move X to Y?" inline first; Send Back / Cancel ask for their note.
  const [confirmMove, setConfirmMove] = useState<InstanceTransition | null>(null)
  const transitionNote = useTransitionNote()

  const collection = item?.collection
  const itemId = item?.item_id
  // A confirm belongs to one record: Next / another row drops it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on record change only
  useEffect(() => setConfirmMove(null), [collection, itemId])

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
        .then((r) => ({ data: (r.data ?? []).filter((c) => !c.deleted) }))
        .catch(() => ({ data: [] })),
    enabled: !!collection && !!itemId
  })

  const transitionMut = useMutation({
    mutationFn: ({ transitionId, comment }: { transitionId: string; comment?: string }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${itemId}/transition`, {
          transition_id: transitionId,
          ...(comment ? { comment } : {})
        })
      ),
    onSuccess: () => {
      setReqDialog(null)
      setConfirmMove(null)
      qc.invalidateQueries({ queryKey: ['queue-sheet-instance', collection, itemId] })
      refetchItems()
      toast.success('Transitioned')
    },
    onError: (err: unknown, { transitionId, comment }) => {
      setConfirmMove(null)
      // 422 requirements gate → open the fill-in dialog instead of erroring
      // (same flow PipelinePanel runs on the item page).
      const requirements = transitionRequirementsFromError(err)
      if (requirements) {
        setReqDialog((prev) => ({
          payload: requirements,
          transitionId,
          comment,
          revision: (prev?.revision ?? 0) + 1
        }))
        return
      }
      toast.error(userErrorMessage(err, 'Transition failed'))
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

  // #1877: the sheet follows its record the way the full record page does.
  useLiveRecord(collection, itemId, (batch) => {
    if (batchTouches(batch, LIVE_ASPECTS.state)) {
      void qc.invalidateQueries({ queryKey: ['queue-sheet-instance', collection, itemId] })
      if (!batch.own) refetchItems()
    }
    if (batchTouches(batch, LIVE_ASPECTS.comments))
      void qc.invalidateQueries({ queryKey: ['queue-sheet-comments', collection, itemId] })
  })

  const transitions = peekTransitions(instance?.available_transitions)
  // A live update that takes the move away (someone else moved it) drops its confirm.
  const pendingMove =
    confirmMove && transitions.some((t) => t.id === confirmMove.id) ? confirmMove : null
  const stateById = new Map((instance?.states ?? []).map((s) => [s.id, s]))
  const moveLabel = (t: InstanceTransition) => {
    const target = stateById.get(t.to_state)
    return t.label || target?.label || target?.key || 'Move'
  }
  const targetLabel = (t: InstanceTransition) => {
    const target = stateById.get(t.to_state)
    return target?.label || target?.key || t.label || 'the next step'
  }
  const startMove = async (t: InstanceTransition) => {
    if (transitionMut.isPending) return
    if (needsTransitionNote(t)) {
      setConfirmMove(null)
      const comment = await transitionNote.ask(moveLabel(t))
      if (!comment) return
      transitionMut.mutate({ transitionId: t.id, comment })
      return
    }
    setConfirmMove(t)
  }

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
                  <MetaCell key={key} label={fieldLabel?.(key) || formatFieldHeader(key)}>
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
                    {transitions.map((t) => (
                      <button
                        key={t.id}
                        type='button'
                        disabled={transitionMut.isPending}
                        aria-pressed={pendingMove?.id === t.id}
                        onClick={() => void startMove(t)}
                        className={cn(
                          'flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-slate-700 hover:border-nvr-cyan hover:text-nvr-navy disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:text-nvr-cyan',
                          pendingMove?.id === t.id && 'border-nvr-cyan'
                        )}
                      >
                        {moveLabel(t)}
                        <ArrowRight className='h-3 w-3 text-slate-400' />
                      </button>
                    ))}
                  </div>
                  {pendingMove && (
                    <div
                      role='alertdialog'
                      aria-label='Confirm move'
                      data-peek-confirm
                      className='mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10'
                    >
                      <p className='text-[12.5px] text-slate-700 dark:text-slate-200'>
                        Move <span className='font-semibold'>{item.label}</span> to{' '}
                        <span className='font-semibold'>{targetLabel(pendingMove)}</span>?
                      </p>
                      <div className='mt-2 flex gap-2'>
                        <button
                          type='button'
                          disabled={transitionMut.isPending}
                          onClick={() => transitionMut.mutate({ transitionId: pendingMove.id })}
                          className='h-7 rounded-md bg-nvr-cyan px-3 text-[12px] font-semibold text-white disabled:opacity-50'
                        >
                          {transitionMut.isPending ? 'Moving…' : 'Confirm'}
                        </button>
                        <button
                          type='button'
                          disabled={transitionMut.isPending}
                          onClick={() => setConfirmMove(null)}
                          className='h-7 rounded-md border border-slate-200 bg-white px-3 text-[12px] text-slate-600 hover:bg-muted disabled:opacity-50 dark:border-border dark:bg-card dark:text-slate-300'
                        >
                          Keep
                        </button>
                      </div>
                    </div>
                  )}
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
      {reqDialog && (
        <TransitionRequirementsDialog
          key={reqDialog.revision}
          payload={reqDialog.payload}
          transitionId={reqDialog.transitionId}
          isRetry={reqDialog.revision > 1}
          onSubmitted={() =>
            transitionMut.mutate({
              transitionId: reqDialog.transitionId,
              comment: reqDialog.comment
            })
          }
          executing={transitionMut.isPending}
          onClose={() => setReqDialog(null)}
        />
      )}
      {transitionNote.dialog}
    </Sheet>
  )
}
