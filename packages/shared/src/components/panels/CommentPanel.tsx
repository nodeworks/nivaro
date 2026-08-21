import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ClipboardPlus, MessageSquare, Pencil, SmilePlus, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { del, get, patch, post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'
import { AutolinkedText } from '../AutolinkedText'
import { UserAvatar } from '../UserAvatar'
import { Avatar, AvatarFallback } from '../ui/avatar'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { Textarea } from '../ui/textarea'

interface Comment {
  id: string
  collection: string
  item: string
  user: { id: string; first_name: string; last_name: string; email: string }
  text: string
  created_at: string
  updated_at: string
  mentions: Array<{ user: string }>
  reactions?: Array<{ emoji: string; count: number; mine: boolean }>
}

const REACTION_EMOJI = ['👍', '✅', '👀', '🎉', '❤️', '😂'] as const

function initials(u: Comment['user']): string {
  const i = [u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join('').toUpperCase()
  return i || u.email?.[0]?.toUpperCase() || '?'
}

function displayName(u: Comment['user']): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}

// ─── Mention autocomplete ─────────────────────────────────────────────────────

type MentionUser = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

// Active "@tok" the caret is currently inside: token start (the @) + the
// partial typed after it. Requires 2+ chars before the menu opens.
function detectMention(text: string, caret: number): { start: number; query: string } | null {
  const upToCaret = text.slice(0, caret)
  const m = upToCaret.match(/(^|\s)@([a-zA-Z0-9._-]{2,})$/)
  if (!m) return null
  return { start: caret - m[2].length - 1, query: m[2] }
}

// The server resolves "@handle" by email prefix (handle@%) or exact first
// name — inserting the email's local part guarantees the mention resolves.
function mentionHandle(u: MentionUser): string {
  return u.email.split('@')[0]
}

function MentionTextarea({
  value,
  onChange,
  ...textareaProps
}: {
  value: string
  onChange: (v: string) => void
} & Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange'>) {
  const client = useNivaroClient()
  const ref = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const debouncedQuery = useDebounced(mention?.query ?? '', 200)

  const { data: users = [] } = useQuery<MentionUser[]>({
    queryKey: ['users', 'mention-search', debouncedQuery],
    queryFn: () =>
      client
        .request<{ data: MentionUser[]; total: number }>(
          get('/users', { limit: 8, sort: 'first_name', search: debouncedQuery })
        )
        .then((r) => r.data),
    enabled: !!mention && debouncedQuery.length >= 2,
    staleTime: 30_000
  })
  // "@owners" is a pseudo-entry: it fans out server-side to whoever currently
  // resolves as the record's pipeline owners.
  const ownersMatch =
    !!mention && debouncedQuery.length >= 2 && 'owners'.startsWith(debouncedQuery.toLowerCase())
  const open = !!mention && debouncedQuery.length >= 2 && (users.length > 0 || ownersMatch)
  const optionCount = users.length + (ownersMatch ? 1 : 0)

  // The menu portals to <body>: CommentPanel's rounded card is overflow-hidden
  // (and the drill-down sheet adds more clipping contexts), so an absolutely
  // positioned child would be cut off. Fixed-position under the textarea;
  // any scroll/resize while open just closes it.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open || !ref.current) {
      setMenuPos(null)
      return
    }
    const r = ref.current.getBoundingClientRect()
    setMenuPos({ top: r.bottom + 4, left: r.left, width: Math.min(r.width, 360) })
    // Close when the PAGE scrolls (fixed position would drift) — but scrolls
    // that originate inside the menu are the user browsing the list.
    const close = (e: Event) => {
      if (menuRef.current?.contains(e.target as Node)) return
      setMention(null)
    }
    const closeNow = () => setMention(null)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', closeNow)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', closeNow)
    }
  }, [open])

  function sync(el: HTMLTextAreaElement) {
    const next = detectMention(el.value, el.selectionStart ?? el.value.length)
    setMention(next)
    if (!next) setHighlight(0)
  }

  function pick(u: MentionUser | '__owners__') {
    if (!mention || !ref.current) return
    const caret = ref.current.selectionStart ?? value.length
    const inserted = u === '__owners__' ? '@owners ' : `@${mentionHandle(u)} `
    const next = value.slice(0, mention.start) + inserted + value.slice(caret)
    onChange(next)
    setMention(null)
    setHighlight(0)
    const newCaret = mention.start + inserted.length
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(newCaret, newCaret)
    })
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => (h + 1) % optionCount)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + optionCount) % optionCount)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      const idx = Math.min(highlight, optionCount - 1)
      pick(ownersMatch && idx === 0 ? '__owners__' : users[ownersMatch ? idx - 1 : idx])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setMention(null)
    }
  }

  return (
    <div className='relative'>
      <Textarea
        {...textareaProps}
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          sync(e.target)
        }}
        onKeyDown={handleKeyDown}
        onClick={(e) => sync(e.currentTarget)}
        onBlur={() => setTimeout(() => setMention(null), 150)}
      />
      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className='fixed z-[110] max-h-60 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-border dark:bg-popover'
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            // Keep the textarea focused for any press inside the menu —
            // scrollbar drags and item clicks must not trigger its onBlur.
            onMouseDown={(e) => e.preventDefault()}
          >
            {ownersMatch && (
              <button
                type='button'
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick('__owners__')
                }}
                onMouseEnter={() => setHighlight(0)}
                className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors ${
                  highlight === 0 ? 'bg-nvr-cyan/10' : ''
                }`}
              >
                <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy/80 dark:text-nvr-cyan'>
                  ★
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                    Owners
                  </span>
                  <span className='block truncate text-[11px] text-slate-400'>
                    Everyone currently assigned to this record
                  </span>
                </span>
              </button>
            )}
            {users.map((u, rawIdx) => {
              const i = ownersMatch ? rawIdx + 1 : rawIdx
              const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
              return (
                <button
                  key={u.id}
                  type='button'
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pick(u)
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors ${
                    i === highlight ? 'bg-nvr-cyan/10' : ''
                  }`}
                >
                  <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy/80 dark:text-nvr-cyan'>
                    {(
                      `${u.first_name?.[0] ?? ''}${u.last_name?.[0] ?? ''}`.trim() || u.email[0]
                    ).toUpperCase()}
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                      {name}
                    </span>
                    <span className='block truncate text-[11px] text-slate-400'>
                      @{mentionHandle(u)}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}

/** A note recorded elsewhere on the record. Never editable here: it belongs to
 *  the transition, change or addendum that captured it. */
interface RelatedNote {
  id: string
  source: 'transition' | 'change_reason' | 'addendum' | 'note'
  label: string
  text: string
  context: string | null
  user_name: string | null
  created_at: string
}

/**
 * A note the system recorded rather than a comment someone posted here: the
 * text is the person's, but it lives with the transition, change or addendum
 * that captured it — so it reads as part of the thread while being visibly not
 * a comment, and carries no edit or delete affordance.
 */
function RecordedNote({ note }: { note: RelatedNote }) {
  const tone =
    note.source === 'transition'
      ? 'border-nvr-cyan/30 bg-nvr-cyan/[0.06] text-nvr-navy dark:text-nvr-cyan'
      : note.source === 'addendum'
        ? 'border-amber-200 bg-amber-50/60 text-amber-700 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-400'
        : 'border-slate-200 bg-slate-50/80 text-slate-600 dark:border-border dark:bg-muted/40 dark:text-slate-300'
  return (
    <div className='flex gap-3' data-recorded-note={note.source}>
      <div className='mt-1 h-8 w-8 shrink-0' aria-hidden />
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <span className={`rounded border px-1.5 py-px text-[10px] font-medium ${tone}`}>
            {note.label}
          </span>
          {note.user_name && (
            <span className='text-[12px] font-medium text-slate-700 dark:text-slate-200'>
              {note.user_name}
            </span>
          )}
          {note.context && (
            <span className='truncate text-[11px] text-slate-400'>{note.context}</span>
          )}
          <span className='text-[11px] text-slate-400'>{formatRelative(note.created_at)}</span>
        </div>
        <p className='mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug text-slate-600 dark:text-slate-300'>
          <AutolinkedText text={note.text} />
        </p>
      </div>
    </div>
  )
}

export function CommentPanel({
  collection,
  item,
  title,
  defaultExpanded,
  queuedComments,
  onQueueComment
}: {
  collection: string
  item: string | number
  title?: string
  defaultExpanded?: boolean
  queuedComments?: string[]
  onQueueComment?: (text: string) => void
}) {
  const client = useNivaroClient()
  const { userId } = useItemEditAuth()
  const queryClient = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')

  const isNew = !item || item === 'new'
  const queryKey = ['comments', collection, String(item)]

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () =>
      client
        .request<{ data: Comment[] }>(get('/comments', { collection, item }))
        .then((r) => r.data),
    enabled: !isNew
  })

  const comments: Comment[] = data ?? []

  // Everything else anyone wrote about this record — transition comments,
  // change reasons (including ones left on child rows, like a forecast's
  // justification) and addendum reasons. They belong in the same thread: a
  // reader looking for "what did people say about this" should not have to
  // know which panel each note happened to be typed into.
  const { data: relatedData } = useQuery<RelatedNote[]>({
    queryKey: ['comments-related', collection, String(item)],
    queryFn: () =>
      client
        .request<{ data: RelatedNote[] }>(get('/comments/related', { collection, item }))
        .then((r) => r.data ?? [])
        .catch(() => []),
    enabled: !isNew,
    staleTime: 30_000
  })
  const related: RelatedNote[] = relatedData ?? []

  /** One time-ordered thread, NEWEST FIRST: the latest note is what a reader
   *  opens the panel for — history scrolls down, not up. */
  const threadEntries = useMemo(() => {
    const own = comments.map((c) => ({ kind: 'comment' as const, at: c.created_at, comment: c }))
    const rel = related.map((r) => ({ kind: 'related' as const, at: r.created_at, note: r }))
    return [...own, ...rel].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
  }, [comments, related])

  const create = useMutation({
    mutationFn: (text: string) => client.request(post('/comments', { collection, item, text })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setDraft('')
    },
    onError: () => toast.error('Failed to post comment')
  })

  const update = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      client.request(patch(`/comments/${id}`, { text })),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      setEditingId(null)
      setEditText('')
    },
    onError: () => toast.error('Failed to update comment')
  })

  const remove = useMutation({
    mutationFn: (id: string) => client.request(del(`/comments/${id}`)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error('Failed to delete comment')
  })

  const react = useMutation({
    mutationFn: ({ id, emoji }: { id: string; emoji: string }) =>
      client.request(post(`/comments/${id}/reactions`, { emoji })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: () => toast.error('Failed to react')
  })
  const [reactMenuId, setReactMenuId] = useState<string | null>(null)

  // "Make this a task" — the comment text becomes a task on this record,
  // assigned to whoever clicked (they're the one who decided it's actionable).
  const makeTask = useMutation({
    mutationFn: (c: Comment) =>
      client.request(
        post('/tasks', {
          collection,
          item,
          title: c.text
            .replace(/<[^>]*>/g, '')
            .replace(/@\[([^\]]+)\]/g, '@$1')
            .slice(0, 200),
          assignee: userId
        })
      ),
    onSuccess: () => toast.success('Task created from comment — assigned to you'),
    onError: () => toast.error('Could not create a task')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!draft.trim()) return
    if (isNew && onQueueComment) {
      onQueueComment(draft.trim())
      setDraft('')
    } else {
      create.mutate(draft.trim())
    }
  }

  return (
    // Addressable from elsewhere (the summary panel jumps here), which needs
    // both a handle and whether it is currently open.
    <div
      data-panel='notes'
      data-panel-expanded={expanded ? 'true' : 'false'}
      className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:bg-card dark:border-border'
    >
      <button
        type='button'
        data-panel-toggle='notes'
        onClick={() => setExpanded((v) => !v)}
        className='flex w-full flex-col px-5 py-3.5 text-left transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
      >
        <span className='flex w-full items-center gap-2.5'>
          <MessageSquare className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {title || 'Comments'}
          </span>
          {(threadEntries.length > 0 || (queuedComments ?? []).length > 0) && (
            <span className='rounded-full bg-slate-100 px-1.5 py-px text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
              {isNew ? (queuedComments ?? []).length : threadEntries.length}
            </span>
          )}
          <ChevronDown
            className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
          />
        </span>
        {/* Collapsed: the latest note rides the header so the panel answers
            "anything new?" without a click. */}
        {!expanded &&
          !isNew &&
          threadEntries.length > 0 &&
          (() => {
            // Newest entry — the thread sorts newest-first now.
            const last = threadEntries[0]
            const who =
              last.kind === 'comment'
                ? displayName(last.comment.user)
                : (last.note.user_name ?? 'System')
            const text = (last.kind === 'comment' ? last.comment.text : last.note.text)
              .replace(/<[^>]*>/g, ' ')
              .replace(/@\[([^\]]+)\]/g, '@$1')
              .replace(/\s+/g, ' ')
              .trim()
            if (!text) return null
            return (
              <span className='mt-1 w-full truncate pl-6 text-[11.5px] text-slate-400'>
                <span className='font-medium text-slate-500 dark:text-slate-400'>{who}:</span>{' '}
                {text}
              </span>
            )
          })()}
      </button>
      {expanded && (
        <div className='border-t border-slate-100 px-5 py-4 dark:border-border/60'>
          {isNew ? (
            <div className='space-y-4'>
              <form onSubmit={handleSubmit} className='space-y-2'>
                <MentionTextarea
                  value={draft}
                  onChange={setDraft}
                  placeholder='Write a comment…'
                  rows={3}
                  className='text-[13px]'
                />
                <div className='flex items-center justify-between'>
                  <p className='text-[11px] text-slate-400'>
                    Comment will be posted after the record is saved.
                  </p>
                  <Button type='submit' size='sm' disabled={!draft.trim()}>
                    Queue
                  </Button>
                </div>
              </form>
              {(queuedComments ?? []).length > 0 && (
                <div className='space-y-2'>
                  <Separator />
                  {(queuedComments ?? []).map((text, i) => (
                    <div
                      key={i}
                      className='flex items-start gap-2.5 rounded-lg border border-dashed border-amber-200/70 bg-amber-50/40 px-3 py-2 dark:border-amber-500/20 dark:bg-amber-500/5'
                    >
                      <span className='mt-0.5 inline-flex shrink-0 items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-500/15 dark:text-amber-400'>
                        Pending
                      </span>
                      <p className='text-[13px] leading-relaxed text-slate-600 dark:text-slate-300'>
                        {text}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              <form onSubmit={handleSubmit} className='space-y-2'>
                <MentionTextarea
                  value={draft}
                  onChange={setDraft}
                  placeholder='Write a comment…'
                  rows={3}
                  className='text-[13px]'
                />
                <div className='flex items-center justify-between'>
                  <p className='text-[11px] text-slate-400'>
                    Type @ plus two letters to mention a teammate, or @owners to notify everyone
                    currently assigned.
                  </p>
                  <Button type='submit' size='sm' disabled={!draft.trim() || create.isPending}>
                    {create.isPending ? 'Posting…' : 'Comment'}
                  </Button>
                </div>
              </form>
              <Separator className='my-4' />
              {isLoading ? (
                <div className='space-y-4'>
                  {(['a', 'b'] as const).map((k) => (
                    <div key={k} className='flex gap-3'>
                      <div className='h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                      <div className='flex-1 space-y-1.5'>
                        <div className='h-3 w-32 animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                        <div className='h-3 w-full animate-pulse rounded bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))]' />
                      </div>
                    </div>
                  ))}
                </div>
              ) : isError ? (
                <p className='py-6 text-center text-[12px] text-red-500'>
                  Failed to load comments.
                </p>
              ) : threadEntries.length === 0 ? (
                <p className='py-6 text-center text-[12px] text-slate-400'>No notes yet.</p>
              ) : (
                <div className='space-y-4'>
                  {threadEntries.map((entry) => {
                    if (entry.kind === 'related') {
                      return <RecordedNote key={entry.note.id} note={entry.note} />
                    }
                    const c = entry.comment
                    const isOwn = userId === c.user.id
                    const isEditing = editingId === c.id
                    return (
                      <div key={c.id} className='group flex gap-3'>
                        <UserAvatar
                          userId={c.user.id}
                          className='h-8 w-8'
                          fallback={
                            <Avatar className='h-8 w-8 shrink-0'>
                              <AvatarFallback className='bg-nvr-cyan/15 text-[11px] font-bold text-nvr-navy'>
                                {initials(c.user)}
                              </AvatarFallback>
                            </Avatar>
                          }
                        />
                        <div className='min-w-0 flex-1'>
                          <div className='flex items-center gap-2'>
                            <span className='text-[13px] font-medium text-slate-800'>
                              {displayName(c.user)}
                            </span>
                            <span className='text-[11px] text-slate-400'>
                              {formatRelative(c.created_at)}
                            </span>
                            {c.updated_at && c.updated_at !== c.created_at && (
                              <span className='text-[10px] text-slate-300'>(edited)</span>
                            )}
                            {!isEditing && (
                              <div className='ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                                <button
                                  type='button'
                                  title='Make a task from this comment'
                                  className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-muted'
                                  onClick={() => makeTask.mutate(c)}
                                >
                                  <ClipboardPlus className='h-3 w-3' />
                                </button>
                                {isOwn && (
                                  <>
                                    <button
                                      type='button'
                                      className='rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700'
                                      onClick={() => {
                                        setEditingId(c.id)
                                        setEditText(c.text)
                                      }}
                                    >
                                      <Pencil className='h-3 w-3' />
                                    </button>
                                    <button
                                      type='button'
                                      className='rounded p-1 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500'
                                      onClick={() => remove.mutate(c.id)}
                                    >
                                      <Trash2 className='h-3 w-3' />
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                          {isEditing ? (
                            <div className='mt-1.5 space-y-2'>
                              <MentionTextarea
                                value={editText}
                                onChange={setEditText}
                                rows={3}
                                className='text-[13px]'
                              />
                              <div className='flex items-center gap-1.5'>
                                <Button
                                  size='sm'
                                  className='h-7 gap-1.5'
                                  disabled={!editText.trim() || update.isPending}
                                  onClick={() => update.mutate({ id: c.id, text: editText.trim() })}
                                >
                                  <Check className='h-3 w-3' /> Save
                                </Button>
                                <Button
                                  size='sm'
                                  variant='outline'
                                  className='h-7 gap-1.5'
                                  onClick={() => {
                                    setEditingId(null)
                                    setEditText('')
                                  }}
                                >
                                  <X className='h-3 w-3' /> Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <p className='mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed text-slate-600'>
                              <AutolinkedText text={c.text} />
                            </p>
                          )}
                          {/* Reactions: aggregated chips + hover palette */}
                          {!isEditing && (
                            <div className='mt-1 flex flex-wrap items-center gap-1'>
                              {(c.reactions ?? []).map((r) => (
                                <button
                                  key={r.emoji}
                                  type='button'
                                  onClick={() => react.mutate({ id: c.id, emoji: r.emoji })}
                                  className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] transition-colors ${
                                    r.mine
                                      ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:border-slate-300 dark:border-border dark:bg-muted dark:text-slate-300'
                                  }`}
                                >
                                  {r.emoji}
                                  <span className='tabular-nums text-[10px] font-semibold'>{r.count}</span>
                                </button>
                              ))}
                              <span className='relative'>
                                <button
                                  type='button'
                                  onClick={() => setReactMenuId(reactMenuId === c.id ? null : c.id)}
                                  className={`rounded p-0.5 text-slate-300 transition-all hover:bg-slate-100 hover:text-slate-500 dark:hover:bg-muted ${
                                    (c.reactions ?? []).length > 0 ? '' : 'opacity-0 group-hover:opacity-100'
                                  }`}
                                  aria-label='Add reaction'
                                >
                                  <SmilePlus className='h-3.5 w-3.5' />
                                </button>
                                {reactMenuId === c.id && (
                                  <span className='absolute bottom-6 left-0 z-20 flex gap-0.5 rounded-full border border-slate-200 bg-white px-1.5 py-1 shadow-lg dark:border-border dark:bg-popover'>
                                    {REACTION_EMOJI.map((e) => (
                                      <button
                                        key={e}
                                        type='button'
                                        onClick={() => {
                                          react.mutate({ id: c.id, emoji: e })
                                          setReactMenuId(null)
                                        }}
                                        className='rounded-full px-1 text-[14px] hover:bg-muted'
                                      >
                                        {e}
                                      </button>
                                    ))}
                                  </span>
                                )}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
