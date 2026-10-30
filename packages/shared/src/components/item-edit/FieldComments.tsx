import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Link2, MessageSquare, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { fieldDeepLinkQuery, fieldThread, openFieldCommentCounts } from '../../lib/field-comments'
import { cn, formatRelative } from '../../lib/utils'
import { AutolinkedText } from '../AutolinkedText'
import { MentionTextarea } from '../panels/CommentPanel'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type FieldCommentsApi, useFieldComments } from './field-comments-context'

/**
 * #3232 — comment on one field from the field itself. The thread is the
 * record's own comments (GET /comments, the Comments panel's query and cache
 * key) narrowed to the field; posting is POST /comments with `field`, so the
 * comment also shows in the record's Comments as "on <Field>". Mentions use
 * the panel's @ autocomplete; the server notifies only people who may open
 * the record and read the field.
 */

interface FieldComment {
  id: string
  user: { id: string; first_name: string | null; last_name: string | null; email: string } | null
  text: string
  created_at: string
  field?: string | null
  resolved_at?: string | null
  deleted?: boolean
}

/** The record's comments — the same key and shape as the Comments panel's read. */
const commentsKey = (collection: string, item: string) => ['comments', collection, item]

function useRecordComments(collection: string, item: string, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery({
    queryKey: commentsKey(collection, item),
    queryFn: () =>
      client
        .request<{ data: FieldComment[] }>(get('/comments', { collection, item }))
        .then((r) => r.data),
    enabled
  })
}

/**
 * The context value the record form provides. Null (no field comments) for a
 * new record, a layout with comments turned off, or the layout editor canvas.
 */
export function useFieldCommentsApi(args: {
  collection: string
  itemId: string | number | null | undefined
  enabled: boolean
  labelOf: (field: string) => string
  jump: (field: string) => void
}): FieldCommentsApi | null {
  const item = args.itemId == null ? '' : String(args.itemId)
  const on = args.enabled && item !== '' && item !== 'new'
  const { data } = useRecordComments(args.collection, item, on)
  const [openField, setOpenField] = useState<string | null>(null)
  const counts = useMemo(() => openFieldCommentCounts(data ?? []), [data])
  const { labelOf, jump, collection } = args
  return useMemo(
    () => (on ? { collection, item, counts, openField, setOpenField, labelOf, jump } : null),
    [on, collection, item, counts, openField, labelOf, jump]
  )
}

function personName(u: FieldComment['user']): string {
  if (!u) return 'Someone'
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

/**
 * The comment control beside a field label: hidden until the row is hovered or
 * focused (the slot stays reserved), always shown with a count while the field
 * has open comments.
 */
export function FieldCommentButton({ field, label }: { field: string; label: string }) {
  const ctx = useFieldComments()
  if (!ctx) return null
  return <FieldCommentControl ctx={ctx} field={field} label={label} />
}

function FieldCommentControl({
  ctx,
  field,
  label
}: {
  ctx: FieldCommentsApi
  field: string
  label: string
}) {
  const count = ctx.counts[field] ?? 0
  const open = ctx.openField === field
  return (
    <Popover open={open} onOpenChange={(o) => ctx.setOpenField(o ? field : null)}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-field-comment={field}
          data-field-comment-count={count || undefined}
          aria-label={
            count
              ? `${count} open ${count === 1 ? 'comment' : 'comments'} on ${label}`
              : `Comment on ${label}`
          }
          data-tip={count ? undefined : `Comment on ${label}`}
          className={cn(
            'inline-flex items-center gap-0.5 rounded px-0.5 py-0.5 text-[10px] font-semibold transition-[opacity,color]',
            count || open
              ? 'text-[#0e7490] opacity-100 dark:text-nvr-cyan'
              : 'text-slate-400 opacity-0 hover:text-[#0e7490] focus-visible:opacity-100 group-hover/fieldrow:opacity-100 group-focus-within/fieldrow:opacity-100 dark:text-slate-400 dark:hover:text-nvr-cyan'
          )}
        >
          <MessageSquare aria-hidden className='h-3 w-3' />
          {count > 0 && <span className='tabular-nums'>{count}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-[340px] p-0'
        // The @ menu portals to <body>: picking a person must not close the popover.
        onInteractOutside={(e) => {
          const t = e.target as HTMLElement | null
          if (t?.closest?.('[data-mention-menu]')) e.preventDefault()
        }}
      >
        {open && <FieldThread ctx={ctx} field={field} label={label} />}
      </PopoverContent>
    </Popover>
  )
}

function FieldThread({
  ctx,
  field,
  label
}: {
  ctx: FieldCommentsApi
  field: string
  label: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data, isLoading } = useRecordComments(ctx.collection, ctx.item, true)
  const thread = useMemo(() => fieldThread(data ?? [], field), [data, field])
  const [showResolved, setShowResolved] = useState(false)
  const [draft, setDraft] = useState('')
  const refresh = () => qc.invalidateQueries({ queryKey: commentsKey(ctx.collection, ctx.item) })
  const errorText = (err: unknown, fallback: string) =>
    (err as { response?: { data?: { error?: string } }; data?: { error?: string } })?.response?.data
      ?.error ??
    (err as { data?: { error?: string } })?.data?.error ??
    fallback

  const postMut = useMutation({
    mutationFn: (text: string) =>
      client.request(
        post('/comments', {
          collection: ctx.collection,
          item: ctx.item,
          text,
          field,
          field_label: label
        })
      ),
    onSuccess: () => {
      setDraft('')
      void refresh()
    },
    onError: (err) => toast.error(errorText(err, 'Could not post the comment'))
  })
  const resolveMut = useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      client.request(post(`/comments/${id}/resolve`, { resolved })),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error(errorText(err, 'Could not update the comment'))
  })
  const send = () => {
    const text = draft.trim()
    if (text && !postMut.isPending) postMut.mutate(text)
  }
  const copyLink = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('field')
    const sep = url.search ? '&' : '?'
    void navigator.clipboard
      .writeText(`${url.origin}${url.pathname}${url.search}${sep}${fieldDeepLinkQuery(field)}`)
      .then(
        () => toast.success('Link to this field copied'),
        () => toast.error('Could not copy')
      )
  }

  const row = (c: FieldComment, resolved: boolean) => (
    <li key={c.id} data-field-comment-row={c.id} className='px-3 py-2'>
      <div className='flex items-baseline gap-1.5'>
        <span className='truncate text-[12px] font-medium text-slate-800 dark:text-foreground'>
          {personName(c.user)}
        </span>
        <span className='shrink-0 text-[11px] text-slate-400 dark:text-muted-foreground'>
          {formatRelative(c.created_at)}
        </span>
        <button
          type='button'
          disabled={resolveMut.isPending}
          onClick={() => resolveMut.mutate({ id: c.id, resolved: !resolved })}
          data-field-comment-resolve={c.id}
          className='ml-auto inline-flex shrink-0 items-center gap-1 rounded px-1 py-px text-[11px] text-slate-500 transition-colors hover:bg-muted hover:text-slate-800 disabled:opacity-50 dark:text-muted-foreground dark:hover:text-foreground'
        >
          {resolved ? (
            <RotateCcw aria-hidden className='h-3 w-3' />
          ) : (
            <Check aria-hidden className='h-3 w-3' />
          )}
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
      </div>
      <p
        className={cn(
          'm-0 mt-0.5 whitespace-pre-wrap text-[12.5px] leading-snug [overflow-wrap:anywhere]',
          resolved
            ? 'text-slate-400 dark:text-muted-foreground'
            : 'text-slate-600 dark:text-slate-300'
        )}
      >
        <AutolinkedText text={c.text} />
      </p>
    </li>
  )

  return (
    <div data-field-comments={field}>
      <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
        <p className='m-0 min-w-0 flex-1 truncate text-[12px] font-semibold text-slate-700 dark:text-foreground'>
          Comments on {label}
        </p>
        <button
          type='button'
          onClick={copyLink}
          aria-label={`Copy a link to ${label}`}
          data-tip='Copy a link that opens the record on this field'
          className='rounded p-1 text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'
        >
          <Link2 aria-hidden className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='max-h-[260px] overflow-y-auto overscroll-contain'>
        {isLoading ? (
          <p className='m-0 px-3 py-3 text-[12px] text-slate-400 dark:text-muted-foreground'>
            Loading…
          </p>
        ) : thread.open.length === 0 && thread.resolved.length === 0 ? (
          <p className='m-0 px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
            No comments on this field yet. They also show in the record’s Comments.
          </p>
        ) : (
          <ul className='m-0 list-none divide-y divide-slate-100 p-0 dark:divide-border'>
            {thread.open.map((c) => row(c, false))}
            {showResolved && thread.resolved.map((c) => row(c, true))}
          </ul>
        )}
        {thread.resolved.length > 0 && (
          <button
            type='button'
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
            className='block w-full px-3 py-1.5 text-left text-[11px] text-slate-500 transition-colors hover:bg-muted dark:text-muted-foreground'
          >
            {showResolved ? 'Hide resolved' : `${thread.resolved.length} resolved`}
          </button>
        )}
      </div>
      <div className='space-y-1.5 border-t border-slate-200 p-2 dark:border-border'>
        <MentionTextarea
          value={draft}
          onChange={setDraft}
          rows={2}
          aria-label={`Comment on ${label}`}
          placeholder='Write a comment… type @ to mention someone'
          className='min-h-[56px] text-[12.5px]'
          onKeyDownCapture={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send()
            }
          }}
        />
        <div className='flex items-center justify-between gap-2'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            Only people who can open this record are notified.
          </span>
          <button
            type='button'
            onClick={send}
            disabled={!draft.trim() || postMut.isPending}
            className='inline-flex h-7 shrink-0 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-nvr-cyan-dark disabled:opacity-50'
          >
            {postMut.isPending ? 'Posting…' : 'Comment'}
          </button>
        </div>
      </div>
    </div>
  )
}
