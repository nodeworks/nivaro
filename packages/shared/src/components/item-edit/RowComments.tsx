import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare } from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { formatRelative } from '../../lib/utils'

/**
 * Line-item comments (#11): a comment thread anchored to ONE child grid row
 * ("line 7: wrong CIFA"). The rows are ordinary nivaro_comments keyed by the
 * CHILD collection + row id — the parent record's Notes thread also surfaces
 * them (labelled "Line comment") via /comments/related, so nothing said about
 * a line is invisible at the record level. Enabled per grid via the
 * layout-local `row_comments` option.
 */

interface RowComment {
  id: string
  text: string
  created_at: string
  user: { id: string; first_name: string | null; last_name: string | null; email: string } | null
}

/** Batched per-row counts for the badge column — one call per grid. */
export function useRowCommentCounts(
  collection: string,
  rowIds: string[],
  enabled: boolean
): Record<string, number> {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['row-comment-counts', collection, rowIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, number> }>(
          get('/comments/counts', { collection, ids: rowIds.join(',') })
        )
        .then((r) => r.data ?? {})
        .catch(() => ({}) as Record<string, number>),
    enabled: enabled && rowIds.length > 0,
    staleTime: 30_000
  })
  return data ?? {}
}

export function RowCommentButton({
  collection,
  rowId,
  count
}: {
  collection: string
  rowId: string
  count: number
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [draft, setDraft] = useState('')

  const open = !!pos
  const { data: comments = [], isLoading } = useQuery({
    queryKey: ['comments', collection, rowId],
    queryFn: () =>
      client
        .request<{ data: RowComment[] }>(get('/comments', { collection, item: rowId }))
        .then((r) => r.data ?? []),
    enabled: open
  })

  const create = useMutation({
    mutationFn: (text: string) =>
      client.request(post('/comments', { collection, item: rowId, text })),
    onSuccess: () => {
      setDraft('')
      queryClient.invalidateQueries({ queryKey: ['comments', collection, rowId] })
      queryClient.invalidateQueries({ queryKey: ['row-comment-counts', collection] })
      // The parent record's Notes thread includes line comments.
      queryClient.invalidateQueries({ queryKey: ['comments-related'] })
    },
    onError: () => toast.error('Failed to post comment')
  })

  const toggle = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (pos) {
      setPos(null)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    if (!r) return
    // Flip above when the panel would run off the viewport bottom.
    const panelH = 280
    const top = r.bottom + panelH > window.innerHeight ? Math.max(8, r.top - panelH - 4) : r.bottom + 4
    setPos({ top, left: Math.max(8, Math.min(r.left - 240, window.innerWidth - 320)) })
  }

  return (
    <>
      <button
        ref={btnRef}
        type='button'
        onClick={toggle}
        title='Line comments'
        className={`relative rounded p-0.5 ${count > 0 ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-300 hover:text-[#00ceff]'}`}
        data-row-comments={rowId}
      >
        <MessageSquare className='h-3 w-3' />
        {count > 0 && (
          <span className='absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-nvr-cyan px-0.5 text-[8.5px] font-bold text-white'>
            {count}
          </span>
        )}
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop dismiss */}
            <div className='fixed inset-0 z-[100]' onClick={() => setPos(null)} />
            <div
              className='fixed z-[110] w-[300px] rounded-lg border border-slate-200 bg-white shadow-xl dark:border-border dark:bg-popover'
              style={{ top: pos.top, left: pos.left }}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPos(null)
              }}
              role='dialog'
              aria-label='Line comments'
            >
              <div className='max-h-[190px] overflow-y-auto px-3 py-2'>
                {isLoading ? (
                  <p className='py-3 text-center text-[11px] text-slate-400'>Loading…</p>
                ) : comments.length === 0 ? (
                  <p className='py-3 text-center text-[11px] text-slate-400'>
                    No comments on this line yet.
                  </p>
                ) : (
                  <div className='space-y-2'>
                    {comments.map((c) => (
                      <div key={c.id}>
                        <p className='text-[11px]'>
                          <span className='font-medium text-slate-700 dark:text-slate-200'>
                            {[c.user?.first_name, c.user?.last_name].filter(Boolean).join(' ') ||
                              c.user?.email ||
                              'Unknown'}
                          </span>{' '}
                          <span className='text-slate-400'>{formatRelative(c.created_at)}</span>
                        </p>
                        <p className='whitespace-pre-wrap text-[12px] leading-snug text-slate-600 dark:text-slate-300'>
                          {c.text}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <form
                className='flex items-center gap-1.5 border-t border-slate-100 px-2.5 py-2 dark:border-border/60'
                onSubmit={(e) => {
                  e.preventDefault()
                  if (draft.trim()) create.mutate(draft.trim())
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder='Comment on this line…'
                  className='h-7 min-w-0 flex-1 rounded-md border border-slate-200 bg-background px-2 text-[12px] dark:border-border'
                />
                <button
                  type='submit'
                  disabled={!draft.trim() || create.isPending}
                  className='h-7 shrink-0 rounded-md bg-nvr-cyan px-2.5 text-[11.5px] font-semibold text-white disabled:opacity-50'
                >
                  Post
                </button>
              </form>
            </div>
          </>,
          document.body
        )}
    </>
  )
}
