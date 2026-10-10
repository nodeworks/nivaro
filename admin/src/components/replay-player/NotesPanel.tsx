/**
 * #1363 — the notes list beside the player. A note is pinned to the moment
 * you START writing it (the playhead when the field took focus; "now"
 * re-pins), lists earliest first, seeks on its time, and copies onto the
 * issue this recording is linked to or an open investigation notebook with a
 * deep link back to that second. Text renders as text, never markup.
 *
 * Takes only stable props (the id, a time getter, the seek callback), so the
 * player's per-frame re-render does not reach it.
 */
import { Copy, Pencil, StickyNote, Trash2 } from 'lucide-react'
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { formatRelative } from '@/lib/utils'
import { fmtClock } from './logic'
import { type CopyTarget, type NoteTargets, type ReplayNote, useReplayNotes } from './notes'

export const ReplayNotesPanel = memo(function ReplayNotesPanel({
  recordingId,
  getTime,
  onSeek
}: {
  recordingId: string
  /** The playhead right now (ms). */
  getTime: () => number
  onSeek: (ms: number) => void
}) {
  const { notes, targets, ready, add, edit, remove, copy } = useReplayNotes(recordingId)
  const { user } = useAuth()
  const [draft, setDraft] = useState('')
  const [pinnedAt, setPinnedAt] = useState<number | null>(null)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  if (!ready) {
    return (
      <p className='mt-3 text-[11.5px] text-slate-400'>
        Notes need migration 423 on this instance.
      </p>
    )
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    const at = Math.round(pinnedAt ?? getTime())
    add.mutate(
      { at_ms: at, text },
      {
        onSuccess: () => {
          setDraft('')
          setPinnedAt(null)
        }
      }
    )
  }

  return (
    <section
      className='mt-3 rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-replay-notes=''
    >
      <header className='flex items-center gap-2 border-b border-slate-100 px-3 py-2 dark:border-border/60'>
        <StickyNote className='h-3.5 w-3.5 text-violet-500' />
        <span className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
          Notes{notes.length > 0 ? ` (${notes.length})` : ''}
        </span>
      </header>
      <form
        className='flex items-center gap-2 px-3 py-2'
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <button
          type='button'
          className='shrink-0 rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-violet-700 dark:text-violet-300'
          onClick={() => setPinnedAt(getTime())}
          data-tip='The moment this note is pinned to — click to pin it to the playhead now'
        >
          {pinnedAt == null ? 'at playhead' : `at ${fmtClock(pinnedAt)}`}
        </button>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            if (pinnedAt == null) setPinnedAt(getTime())
          }}
          maxLength={2000}
          placeholder='What happens here?'
          className='h-7 flex-1 text-[12px]'
          aria-label='New note'
        />
        <Button
          type='submit'
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          disabled={!draft.trim() || add.isPending}
        >
          Add note
        </Button>
      </form>
      {notes.length > 0 && (
        <ol className='max-h-64 overflow-y-auto px-1 pb-2'>
          {notes.map((n) => (
            <li
              key={n.id}
              className='group flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50'
            >
              <button
                type='button'
                onClick={() => onSeek(Math.max(0, n.at_ms - 500))}
                className='mt-px shrink-0 font-mono text-[11px] tabular-nums text-violet-600 hover:underline dark:text-violet-300'
              >
                {fmtClock(n.at_ms)}
              </button>
              <div className='min-w-0 flex-1'>
                {editing?.id === n.id ? (
                  <div className='space-y-1'>
                    <Textarea
                      value={editing.text}
                      onChange={(e) => setEditing({ id: n.id, text: e.target.value })}
                      maxLength={2000}
                      className='min-h-[56px] text-[12px]'
                    />
                    <div className='flex justify-end gap-1.5'>
                      <Button
                        size='sm'
                        variant='ghost'
                        className='h-6 text-[11px]'
                        onClick={() => setEditing(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size='sm'
                        variant='outline'
                        className='h-6 text-[11px]'
                        disabled={!editing.text.trim() || edit.isPending}
                        onClick={() =>
                          edit.mutate(
                            { id: n.id, text: editing.text },
                            { onSuccess: () => setEditing(null) }
                          )
                        }
                      >
                        Save
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className='whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100'>
                    {n.text}
                  </p>
                )}
                <p className='text-[10.5px] text-slate-400'>
                  {n.user_name ?? 'Unknown'} · {formatRelative(n.created_at)}
                </p>
              </div>
              <div className='flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'>
                <CopyMenu
                  note={n}
                  targets={targets}
                  pending={copy.isPending}
                  onCopy={(target, label) => copy.mutate({ id: n.id, target, label })}
                />
                {user?.id && n.user && n.user.toLowerCase() === user.id.toLowerCase() && (
                  <button
                    type='button'
                    className='p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                    onClick={() => setEditing({ id: n.id, text: n.text })}
                    aria-label='Edit note'
                  >
                    <Pencil className='h-3.5 w-3.5' />
                  </button>
                )}
                {confirmDelete === n.id ? (
                  <button
                    type='button'
                    className='rounded px-1 text-[11px] text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10'
                    onClick={() => remove.mutate(n.id, { onSettled: () => setConfirmDelete(null) })}
                  >
                    Delete?
                  </button>
                ) : (
                  <button
                    type='button'
                    className='p-1 text-slate-400 hover:text-red-500'
                    onClick={() => setConfirmDelete(n.id)}
                    aria-label='Delete note'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
})

function CopyMenu({
  note,
  targets,
  pending,
  onCopy
}: {
  note: ReplayNote
  targets: NoteTargets
  pending: boolean
  onCopy: (target: CopyTarget, label: string) => void
}) {
  const [open, setOpen] = useState(false)
  const none = targets.issues.length === 0 && targets.investigations.length === 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
          aria-label={`Copy the note at ${fmtClock(note.at_ms)}`}
          data-tip='Copy onto the linked issue or an investigation notebook'
        >
          <Copy className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-1.5'>
        {none && (
          <p className='px-2 py-1.5 text-[11.5px] text-slate-500'>
            No issue is linked to this recording and there is no open investigation notebook.
          </p>
        )}
        {targets.issues.length > 0 && (
          <p className='px-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
            Linked issues
          </p>
        )}
        {targets.issues.map((i) => (
          <button
            key={`i${i.id}`}
            type='button'
            disabled={pending}
            className='block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
            onClick={() => {
              onCopy({ issue_id: i.id }, `issue #${i.id}`)
              setOpen(false)
            }}
          >
            #{i.id} · {i.title}
          </button>
        ))}
        {targets.investigations.length > 0 && (
          <p className='px-2 pt-1 text-[10.5px] font-semibold uppercase tracking-wide text-slate-400'>
            Investigation notebooks
          </p>
        )}
        {targets.investigations.map((inv) => (
          <button
            key={`n${inv.id}`}
            type='button'
            disabled={pending}
            className='block w-full truncate rounded px-2 py-1 text-left text-[12px] hover:bg-slate-100 dark:hover:bg-muted'
            onClick={() => {
              onCopy({ investigation_id: inv.id }, `“${inv.title}”`)
              setOpen(false)
            }}
          >
            {inv.title}
            {inv.created_by_name ? (
              <span className='text-slate-400'> · {inv.created_by_name}</span>
            ) : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
