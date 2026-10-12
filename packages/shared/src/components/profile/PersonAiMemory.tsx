import { useMutation } from '@tanstack/react-query'
import { Brain, Eye, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, get } from '../../lib/commands'
import { formatDate } from '../../lib/utils'
import { ConfirmButton, EmptyLine, SectionCard } from './primitives'
import { errorText, type PersonProfile } from './types'

/**
 * Someone's Ask AI memory, for an administrator (#1897) — a support request
 * ("why does Ask AI keep saying thousands?") or a compliance one ("delete
 * what it knows about me"). Nothing loads until "Show notes": every view and
 * every clear is written to the activity log. Remove only — an administrator
 * can never add or reword someone's notes.
 */

interface Note {
  id: string
  text: string
  at: string
}

export function PersonAiMemoryCard({ profile: p }: { profile: PersonProfile }) {
  const client = useNivaroClient()
  const [notes, setNotes] = useState<Note[] | null>(null)
  const base = `/users/${encodeURIComponent(p.id)}/ai-memory`

  const view = useMutation({
    mutationFn: () =>
      client.request<{ data: { notes: Note[] } }>(get(base)).then((r) => r.data.notes ?? []),
    onSuccess: setNotes,
    onError: (e) => toast.error(errorText(e, 'Could not read their Ask AI memory'))
  })
  const clear = useMutation({
    mutationFn: (noteId?: string) =>
      client
        .request<{ data: { removed: number; remaining: number } }>(
          del(noteId ? `${base}/${encodeURIComponent(noteId)}` : base)
        )
        .then((r) => ({ ...r.data, noteId })),
    onSuccess: ({ removed, noteId }) => {
      setNotes((prev) => (noteId ? (prev ?? []).filter((n) => n.id !== noteId) : []))
      toast.success(
        noteId
          ? 'Note removed'
          : removed > 0
            ? `Cleared ${removed} note${removed === 1 ? '' : 's'}`
            : 'Nothing to clear'
      )
    },
    onError: (e) => toast.error(errorText(e, 'Could not clear their Ask AI memory'))
  })

  return (
    <SectionCard
      icon={<Brain className='h-4 w-4' />}
      title='Ask AI memory'
      hint='Their own notes that ride every Ask AI question. Viewing and clearing are logged.'
      testId='person-ai-memory'
      actions={
        <span className='flex items-center gap-1.5'>
          {notes === null && (
            <button
              type='button'
              disabled={view.isPending}
              onClick={() => view.mutate()}
              className='inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 px-2.5 text-[11.5px] font-medium text-slate-700 hover:bg-muted disabled:opacity-50 dark:border-border dark:text-slate-200'
              data-person-ai-memory-view
            >
              <Eye className='h-3 w-3' />
              {view.isPending ? 'Loading…' : 'Show notes'}
            </button>
          )}
          <ConfirmButton
            onConfirm={() => clear.mutate(undefined)}
            disabled={clear.isPending || (notes !== null && notes.length === 0)}
            confirmLabel='Clear all?'
            className='inline-flex h-7 items-center gap-1.5 rounded-md border border-amber-300 px-2.5 text-[11.5px] font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50 dark:border-amber-500/40 dark:text-amber-300 dark:hover:bg-amber-500/10'
            armedClassName='bg-amber-50 dark:bg-amber-500/10'
          >
            <Trash2 className='h-3 w-3' /> Clear all
          </ConfirmButton>
        </span>
      }
    >
      {notes === null ? (
        <EmptyLine>
          Hidden until you ask — showing them writes an entry to the activity log.
        </EmptyLine>
      ) : notes.length === 0 ? (
        <EmptyLine>No notes.</EmptyLine>
      ) : (
        <ul className='space-y-1' data-person-ai-memory-list>
          {notes.map((n) => (
            <li
              key={n.id}
              className='group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted'
            >
              <span className='min-w-0 flex-1 break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
                {n.text}
                <span className='ml-2 text-[11px] text-slate-400'>{formatDate(n.at)}</span>
              </span>
              <ConfirmButton
                onConfirm={() => clear.mutate(n.id)}
                disabled={clear.isPending}
                title='Remove this note'
                confirmLabel='Remove?'
                className='rounded px-1 text-[11px] text-slate-400 hover:text-red-600'
                armedClassName='text-red-600'
              >
                <Trash2 className='h-3 w-3' />
              </ConfirmButton>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
