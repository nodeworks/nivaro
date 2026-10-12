import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain, Check, History, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { AiHistorySwitch } from '../ai/AiHistorySwitch'
import { SectionCard } from './primitives'

/**
 * Ask AI memory (#1804): the person's own notes that ride every Ask AI
 * question ("I work Zone 3 inventory requests", "amounts in thousands").
 * Added here or by saying "remember that …" in Ask AI. Stored in
 * preferences.ai_memory — the card PATCHes the whole list; the server caps
 * it (20 notes, 300 characters each) and never shows it to anyone else.
 */

interface Note {
  id: string
  text: string
  at: string
}

const MAX_NOTES = 20
const MAX_CHARS = 300

export function AiMemoryCard() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: prefs } = useQuery({
    queryKey: ['nvr-profile-prefs'],
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>)
  })
  const notes: Note[] = Array.isArray(prefs?.ai_memory)
    ? (prefs.ai_memory as Note[]).filter((n) => n && typeof n.text === 'string')
    : []
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (next: Array<Pick<Note, 'text'> & Partial<Note>>) =>
      client.request(patch('/users/me/preferences', { ai_memory: next.length ? next : null })),
    onSuccess: () => {
      setError(null)
      void qc.invalidateQueries({ queryKey: ['nvr-profile-prefs'] })
    },
    onError: (err) =>
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          (err instanceof Error ? err.message : 'Could not save')
      )
  })

  const add = () => {
    const text = draft.trim()
    if (!text) return
    save.mutate([...notes, { text }], { onSuccess: () => setDraft('') })
  }
  const commitEdit = () => {
    if (!editing) return
    const text = editing.text.trim()
    const next = text
      ? notes.map((n) => (n.id === editing.id ? { ...n, text } : n))
      : notes.filter((n) => n.id !== editing.id)
    save.mutate(next, { onSuccess: () => setEditing(null) })
  }

  return (
    <SectionCard
      icon={<Brain className='h-4 w-4' />}
      title='Ask AI memory'
      hint='Notes every Ask AI answer takes into account. Only you see them.'
      testId='ai-memory'
    >
      {notes.length === 0 ? (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          Nothing yet. Add a note below, or say “remember that amounts are in thousands” in Ask AI.
        </p>
      ) : (
        <ul className='space-y-1' data-ai-memory-list>
          {notes.map((n) => (
            <li
              key={n.id}
              className='group flex items-start gap-2 rounded-md px-1.5 py-1 hover:bg-muted'
            >
              {editing?.id === n.id ? (
                <>
                  <input
                    value={editing.text}
                    maxLength={MAX_CHARS}
                    onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    // biome-ignore lint/a11y/noAutofocus: the person just chose to edit this note
                    autoFocus
                    className='min-w-0 flex-1 rounded border border-slate-200 bg-white px-2 py-0.5 text-[12.5px] dark:border-border dark:bg-background'
                  />
                  <button
                    type='button'
                    onClick={commitEdit}
                    className='rounded p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                    aria-label='Save note'
                  >
                    <Check className='h-3.5 w-3.5' />
                  </button>
                  <button
                    type='button'
                    onClick={() => setEditing(null)}
                    className='rounded p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                    aria-label='Cancel'
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                </>
              ) : (
                <>
                  <span className='min-w-0 flex-1 break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
                    {n.text}
                  </span>
                  <button
                    type='button'
                    onClick={() => setEditing({ id: n.id, text: n.text })}
                    className='invisible rounded p-1 text-slate-400 hover:text-slate-700 group-hover:visible dark:hover:text-slate-200'
                    aria-label='Edit note'
                  >
                    <Pencil className='h-3 w-3' />
                  </button>
                  <button
                    type='button'
                    onClick={() => save.mutate(notes.filter((x) => x.id !== n.id))}
                    className='invisible rounded p-1 text-slate-400 hover:text-red-600 group-hover:visible'
                    aria-label='Forget this note'
                  >
                    <Trash2 className='h-3 w-3' />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {notes.length < MAX_NOTES ? (
        <div className='mt-3 flex items-center gap-2'>
          <input
            value={draft}
            maxLength={MAX_CHARS}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add()
            }}
            placeholder='e.g. I work Zone 3 inventory requests'
            className='min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px] dark:border-border dark:bg-background'
            data-ai-memory-input
          />
          <button
            type='button'
            onClick={add}
            disabled={!draft.trim() || save.isPending}
            className='inline-flex items-center gap-1 rounded-md bg-nvr-cyan px-2.5 py-1.5 text-[12px] font-medium text-white disabled:opacity-50'
          >
            <Plus className='h-3.5 w-3.5' /> Remember
          </button>
        </div>
      ) : (
        <p className='mt-3 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {MAX_NOTES} notes is the limit — remove one to add another.
        </p>
      )}
      {error && <p className='mt-2 text-[11.5px] text-red-600'>{error}</p>}
    </SectionCard>
  )
}

/** Ask AI history opt-out (#1833) — "Don't save my questions". */
export function AiHistoryCard() {
  const qc = useQueryClient()
  return (
    <SectionCard
      icon={<History className='h-4 w-4' />}
      title='Ask AI history'
      hint='Whether Ask AI keeps your conversations.'
      testId='ai-history'
    >
      <AiHistorySwitch
        onDeleted={() => void qc.invalidateQueries({ queryKey: ['ask-conversations'] })}
      />
    </SectionCard>
  )
}
