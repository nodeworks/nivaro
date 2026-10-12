import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, MessageSquare, Pin, PinOff, Search, Trash2, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

/**
 * Ask AI history (#1833): the person's own conversations and the ones shared
 * with them, newest first with pins on top, searchable by title and text.
 * Branches (#1883) nest under the conversation they were cut from.
 */

export interface ConversationListItem {
  id: string
  title: string
  pinned: boolean
  parent_id: string | null
  branch_from: string | null
  message_count: number
  created_at: string
  updated_at: string
  owner: { id: string; name: string }
  access: 'owner' | 'shared'
  share_count: number
}

export const ASK_LIST_KEY = ['ask-conversations'] as const

export function AskHistory({
  activeId,
  onOpen,
  onDeleted
}: {
  activeId: string | null
  onOpen: (id: string) => void
  onDeleted: (id: string) => void
}) {
  const qc = useQueryClient()
  const [term, setTerm] = useState('')
  const [applied, setApplied] = useState('')
  const { data: items = [], isLoading } = useQuery({
    queryKey: [...ASK_LIST_KEY, applied],
    queryFn: () =>
      api
        .get<{ data: ConversationListItem[] }>('/ai/conversations', {
          params: applied ? { q: applied } : {}
        })
        .then((r) => r.data.data)
  })

  // Branches sit under their source when the source is in the list too.
  const rows = useMemo(() => {
    const ids = new Set(items.map((i) => i.id))
    const children = new Map<string, ConversationListItem[]>()
    const top: ConversationListItem[] = []
    for (const i of items) {
      if (i.parent_id && ids.has(i.parent_id)) {
        children.set(i.parent_id, [...(children.get(i.parent_id) ?? []), i])
      } else top.push(i)
    }
    return top.flatMap((t) => [
      { item: t, depth: 0 },
      ...(children.get(t.id) ?? []).map((c) => ({ item: c, depth: 1 }))
    ])
  }, [items])

  const pin = useMutation({
    mutationFn: (i: ConversationListItem) =>
      api.patch(`/ai/conversations/${i.id}`, { pinned: !i.pinned }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ASK_LIST_KEY })
  })
  const remove = useMutation({
    mutationFn: (i: ConversationListItem) => api.delete(`/ai/conversations/${i.id}`),
    onSuccess: (_r, i) => {
      toast.success(i.access === 'owner' ? 'Conversation deleted' : 'Removed from your list')
      void qc.invalidateQueries({ queryKey: ASK_LIST_KEY })
      onDeleted(i.id)
    }
  })
  const [confirming, setConfirming] = useState<string | null>(null)

  return (
    <div className='flex min-h-0 flex-1 flex-col' data-ask-history>
      <form
        className='shrink-0 border-b border-slate-200 p-2 dark:border-border'
        onSubmit={(e) => {
          e.preventDefault()
          setApplied(term.trim())
        }}
      >
        <label className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-border dark:bg-background'>
          <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <input
            value={term}
            onChange={(e) => {
              setTerm(e.target.value)
              if (!e.target.value.trim()) setApplied('')
            }}
            placeholder='Search conversations'
            className='min-w-0 flex-1 bg-transparent text-[12.5px] outline-none'
            data-ask-history-search
          />
        </label>
      </form>
      <div className='min-h-0 flex-1 overflow-y-auto p-1.5'>
        {isLoading ? (
          <p className='px-2 py-3 text-[12px] text-slate-400'>Loading…</p>
        ) : rows.length === 0 ? (
          <p className='px-2 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {applied ? 'No conversation matches.' : 'Your questions are kept here.'}
          </p>
        ) : (
          rows.map(({ item: i, depth }) => (
            <div
              key={i.id}
              className={cn(
                'group relative flex items-start gap-1.5 rounded-md px-2 py-1.5',
                depth ? 'ml-4' : '',
                i.id === activeId ? 'bg-accent' : 'hover:bg-muted'
              )}
              data-ask-history-item={i.id}
            >
              <button
                type='button'
                onClick={() => onOpen(i.id)}
                className='flex min-w-0 flex-1 items-start gap-1.5 text-left'
              >
                {depth ? (
                  <GitBranch className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
                ) : i.access === 'shared' ? (
                  <Users className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
                ) : (
                  <MessageSquare className='mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400' />
                )}
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                    {i.title}
                  </span>
                  <span className='block truncate text-[11px] text-slate-500 dark:text-slate-400'>
                    {i.access === 'shared' ? `${i.owner.name} · ` : ''}
                    {formatRelative(i.updated_at)}
                    {i.share_count > 0 && i.access === 'owner' ? ` · shared` : ''}
                  </span>
                </span>
              </button>
              {i.pinned && (
                <Pin className='mt-1 h-3 w-3 shrink-0 text-nvr-cyan group-hover:hidden' />
              )}
              <span className='invisible flex shrink-0 items-center group-hover:visible'>
                <button
                  type='button'
                  onClick={() => pin.mutate(i)}
                  className='rounded p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                  data-tip={i.pinned ? 'Unpin' : 'Pin to the top'}
                >
                  {i.pinned ? <PinOff className='h-3 w-3' /> : <Pin className='h-3 w-3' />}
                </button>
                {confirming === i.id ? (
                  <button
                    type='button'
                    onClick={() => {
                      setConfirming(null)
                      remove.mutate(i)
                    }}
                    onBlur={() => setConfirming(null)}
                    className='rounded px-1 text-[11px] font-medium text-red-600'
                  >
                    {i.access === 'owner' ? 'Delete?' : 'Remove?'}
                  </button>
                ) : (
                  <button
                    type='button'
                    onClick={() => setConfirming(i.id)}
                    className='rounded p-1 text-slate-400 hover:text-red-600'
                    data-tip={i.access === 'owner' ? 'Delete' : 'Remove from my list'}
                  >
                    <Trash2 className='h-3 w-3' />
                  </button>
                )}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
