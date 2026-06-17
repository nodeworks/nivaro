import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import type { SlotRendererProps } from '../LayoutForm'

interface Comment {
  id: string
  user: { id: string; first_name: string; last_name: string; email: string }
  text: string
  created_at: string
  updated_at: string
}

function initials(u: Comment['user']) {
  return (
    [u.first_name?.[0], u.last_name?.[0]].filter(Boolean).join('').toUpperCase() ||
    u.email?.[0]?.toUpperCase() ||
    '?'
  )
}
function displayName(u: Comment['user']) {
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email
}
function relativeTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function CommentsSlot({
  collection,
  itemId,
  labelOverride,
  defaultExpanded
}: SlotRendererProps) {
  const client = useOptionalNivaroClient()
  const [open, setOpen] = useState(false)
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const mountedRef = useRef(true)
  const syncedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    if (!syncedRef.current && defaultExpanded !== undefined) {
      syncedRef.current = true
      setOpen(defaultExpanded)
    }
  }, [defaultExpanded])

  const fetchComments = useCallback(async () => {
    if (!client || !itemId) return
    setLoading(true)
    try {
      const res = await client.request<{ data: Comment[] }>(
        get('/comments', { collection, item: String(itemId) })
      )
      if (mountedRef.current) setComments(res.data ?? [])
    } catch {
      if (mountedRef.current) setComments([])
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [client, collection, itemId])

  useEffect(() => {
    void fetchComments()
  }, [fetchComments])

  async function postComment(e: React.FormEvent) {
    e.preventDefault()
    if (!client || !draft.trim() || posting) return
    setPosting(true)
    try {
      await client.request(
        post('/comments', { collection, item: String(itemId), text: draft.trim() })
      )
      setDraft('')
      await fetchComments()
    } catch {
      /* no-op */
    } finally {
      if (mountedRef.current) setPosting(false)
    }
  }

  async function saveEdit(id: string) {
    if (!client || !editText.trim()) return
    try {
      await client.request(patch(`/comments/${id}`, { text: editText.trim() }))
      setEditingId(null)
      setEditText('')
      await fetchComments()
    } catch {
      /* no-op */
    }
  }

  async function deleteComment(id: string) {
    if (!client) return
    try {
      await client.request(del(`/comments/${id}`))
      await fetchComments()
    } catch {
      /* no-op */
    }
  }

  return (
    <div data-nf-slot='__comments__' data-nf-slot-open={open ? 'true' : 'false'}>
      <button type='button' onClick={() => setOpen((v) => !v)} data-nf-slot-toggle>
        <svg
          data-nf-slot-icon
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          aria-hidden='true'
        >
          <path d='M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' />
        </svg>
        <span data-nf-slot-label>{labelOverride ?? 'Comments'}</span>
        {!open && comments.length > 0 && (
          <span data-nf-slot-count>
            {comments.length} comment{comments.length !== 1 ? 's' : ''}
          </span>
        )}
        <svg
          data-nf-slot-chevron
          width='14'
          height='14'
          viewBox='0 0 24 24'
          fill='none'
          stroke='currentColor'
          strokeWidth='2'
          strokeLinecap='round'
          strokeLinejoin='round'
          style={{ transform: open ? 'rotate(180deg)' : undefined }}
          aria-hidden='true'
        >
          <polyline points='6 9 12 15 18 9' />
        </svg>
      </button>

      {open && (
        <div data-nf-slot-content>
          {/* New comment form */}
          <form onSubmit={(e) => void postComment(e)} data-nf-comment-form>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder='Write a comment…'
              rows={3}
              data-nf-comment-textarea
            />
            <div data-nf-comment-form-footer>
              <span data-nf-comment-hint>Use @ to mention a teammate.</span>
              <button type='submit' data-nf-btn-primary disabled={!draft.trim() || posting}>
                {posting ? 'Posting…' : 'Comment'}
              </button>
            </div>
          </form>

          <div data-nf-divider />

          {/* Comment list */}
          {loading ? (
            <div data-nf-comment-list>
              {[0, 1].map((i) => (
                <div key={i} data-nf-comment-skeleton>
                  <div data-nf-skeleton-avatar />
                  <div data-nf-skeleton-lines>
                    <div data-nf-skeleton-line style={{ width: '30%' }} />
                    <div data-nf-skeleton-line style={{ width: '100%' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : comments.length === 0 ? (
            <p data-nf-empty>No comments yet.</p>
          ) : (
            <div data-nf-comment-list>
              {comments.map((c) => {
                const isEditing = editingId === c.id
                const edited = c.updated_at && c.updated_at !== c.created_at
                return (
                  <div key={c.id} data-nf-comment>
                    <div data-nf-avatar>{initials(c.user)}</div>
                    <div data-nf-comment-body>
                      <div data-nf-comment-header>
                        <span data-nf-comment-author>{displayName(c.user)}</span>
                        <span data-nf-comment-time>{relativeTime(c.created_at)}</span>
                        {edited && <span data-nf-comment-edited>(edited)</span>}
                        <div data-nf-comment-actions>
                          {!isEditing && (
                            <>
                              <button
                                type='button'
                                data-nf-icon-btn
                                title='Edit'
                                onClick={() => {
                                  setEditingId(c.id)
                                  setEditText(c.text)
                                }}
                              >
                                <svg
                                  width='12'
                                  height='12'
                                  viewBox='0 0 24 24'
                                  fill='none'
                                  stroke='currentColor'
                                  strokeWidth='2'
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                  aria-hidden='true'
                                >
                                  <path d='M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' />
                                  <path d='M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' />
                                </svg>
                              </button>
                              <button
                                type='button'
                                data-nf-icon-btn
                                data-nf-icon-btn-danger
                                title='Delete'
                                onClick={() => void deleteComment(c.id)}
                              >
                                <svg
                                  width='12'
                                  height='12'
                                  viewBox='0 0 24 24'
                                  fill='none'
                                  stroke='currentColor'
                                  strokeWidth='2'
                                  strokeLinecap='round'
                                  strokeLinejoin='round'
                                  aria-hidden='true'
                                >
                                  <polyline points='3 6 5 6 21 6' />
                                  <path d='M19 6l-1 14H6L5 6' />
                                  <path d='M10 11v6M14 11v6M9 6V4h6v2' />
                                </svg>
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {isEditing ? (
                        <div data-nf-comment-edit>
                          <textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={3}
                            data-nf-comment-textarea
                          />
                          <div data-nf-confirm-actions>
                            <button
                              type='button'
                              data-nf-btn-primary
                              disabled={!editText.trim()}
                              onClick={() => void saveEdit(c.id)}
                            >
                              ✓ Save
                            </button>
                            <button
                              type='button'
                              data-nf-btn-ghost
                              onClick={() => {
                                setEditingId(null)
                                setEditText('')
                              }}
                            >
                              ✕ Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p data-nf-comment-text>{c.text}</p>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
