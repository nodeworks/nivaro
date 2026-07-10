import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, MessageSquare, Pencil, Trash2, X } from 'lucide-react'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { useDebounced } from '../../hooks/useDebounced'
import { del, get, patch, post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'
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
}

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
  const open = !!mention && debouncedQuery.length >= 2 && users.length > 0

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

  function pick(u: MentionUser) {
    if (!mention || !ref.current) return
    const caret = ref.current.selectionStart ?? value.length
    const inserted = `@${mentionHandle(u)} `
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
      setHighlight((h) => (h + 1) % users.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => (h - 1 + users.length) % users.length)
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(users[Math.min(highlight, users.length - 1)])
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
            {users.map((u, i) => {
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
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:bg-card dark:border-border'>
      <button
        type='button'
        onClick={() => setExpanded((v) => !v)}
        className='flex w-full items-center gap-2.5 px-5 py-3.5 transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
      >
        <MessageSquare className='h-3.5 w-3.5 shrink-0 text-slate-400' />
        <span className='font-semibold text-sm text-slate-700'>{title || 'Comments'}</span>
        {!expanded && (comments.length > 0 || (queuedComments ?? []).length > 0) && (
          <span className='ml-1 text-[11px] text-slate-400'>
            {isNew
              ? `${(queuedComments ?? []).length} pending`
              : `${comments.length} comment${comments.length !== 1 ? 's' : ''}`}
          </span>
        )}
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150${expanded ? ' rotate-180' : ''}`}
        />
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
                    Type @ plus two letters to mention a teammate.
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
                      <div className='h-8 w-8 shrink-0 animate-pulse rounded-full bg-slate-100' />
                      <div className='flex-1 space-y-1.5'>
                        <div className='h-3 w-32 animate-pulse rounded bg-slate-100' />
                        <div className='h-3 w-full animate-pulse rounded bg-slate-100' />
                      </div>
                    </div>
                  ))}
                </div>
              ) : isError ? (
                <p className='py-6 text-center text-[12px] text-red-500'>
                  Failed to load comments.
                </p>
              ) : comments.length === 0 ? (
                <p className='py-6 text-center text-[12px] text-slate-400'>No comments yet.</p>
              ) : (
                <div className='space-y-4'>
                  {comments.map((c) => {
                    const isOwn = userId === c.user.id
                    const isEditing = editingId === c.id
                    return (
                      <div key={c.id} className='group flex gap-3'>
                        <Avatar className='h-8 w-8 shrink-0'>
                          <AvatarFallback className='bg-nvr-cyan/15 text-[11px] font-bold text-nvr-navy'>
                            {initials(c.user)}
                          </AvatarFallback>
                        </Avatar>
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
                            {isOwn && !isEditing && (
                              <div className='ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
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
                              {c.text}
                            </p>
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
