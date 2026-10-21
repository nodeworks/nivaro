import { Pencil, RotateCw, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { discardOutbox, editOutbox, holdOutbox, type OutboxItem, retryOutbox } from './chat-outbox'

/**
 * Messages still on their way out (#983, #984, #2782): "Sending…", "Waiting
 * for a connection" (offline or reconnecting — sends on its own when the
 * connection is back) or "Not sent" with the reason. A waiting or unsent
 * message can be edited in place or cancelled; one already on its way cannot.
 * While it is being edited the room's later messages wait behind it.
 */
export function OutboxBubbles({
  items,
  th
}: {
  items: OutboxItem[]
  th: { bubbleMine: string; accentText: string }
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // Leaving the room mid-edit lets the message go as it was.
  const editingRef = useRef<string | null>(null)
  editingRef.current = editing
  useEffect(
    () => () => {
      if (editingRef.current) holdOutbox(editingRef.current, false)
    },
    []
  )
  // The message left (sent from another tab, or cancelled): stop editing it.
  useEffect(() => {
    if (editing && !items.some((o) => o.client_id === editing)) setEditing(null)
  }, [items, editing])
  useEffect(() => {
    if (!editing) return
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  if (items.length === 0) return null

  const startEdit = (o: OutboxItem) => {
    if (!holdOutbox(o.client_id, true)) return
    setDraft(o.text)
    setEditing(o.client_id)
  }
  const stopEdit = (o: OutboxItem) => {
    holdOutbox(o.client_id, false)
    setEditing(null)
  }
  const saveEdit = (o: OutboxItem) => {
    editOutbox(o.client_id, draft)
    setEditing(null)
  }

  const action = cn('inline-flex items-center gap-0.5 font-medium', th.accentText)
  const quiet =
    'inline-flex items-center gap-0.5 text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'

  return (
    <>
      {items.map((o) => {
        const isEditing = editing === o.client_id
        const canChange = o.status !== 'sending'
        return (
          <div
            key={o.client_id}
            className='flex flex-row-reverse gap-2'
            data-chat-outbox={o.status}
            data-chat-outbox-editing={isEditing ? '' : undefined}
          >
            <div className={cn('text-right', isEditing ? 'w-full max-w-[78%]' : 'max-w-[78%]')}>
              {isEditing ? (
                <div className='rounded-2xl rounded-br-md border border-slate-200 bg-white p-1.5 text-left dark:border-border dark:bg-card'>
                  <textarea
                    ref={inputRef}
                    value={draft}
                    rows={Math.min(6, Math.max(2, draft.split('\n').length))}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        saveEdit(o)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        stopEdit(o)
                      }
                    }}
                    aria-label='Edit message before it is sent'
                    className='block w-full resize-none bg-transparent px-1.5 py-1 text-[12.5px] leading-snug text-slate-800 outline-none placeholder:text-slate-500 dark:text-slate-100'
                    data-chat-outbox-input
                  />
                  <div className='mt-1 flex items-center justify-end gap-2 px-1 text-[11px]'>
                    <span className='mr-auto text-slate-500 dark:text-slate-400'>
                      Enter saves · Esc keeps it as it was
                    </span>
                    <button
                      type='button'
                      onClick={() => stopEdit(o)}
                      className={quiet}
                      data-chat-outbox-edit-cancel
                    >
                      Keep as it was
                    </button>
                    <button
                      type='button'
                      onClick={() => saveEdit(o)}
                      className='rounded-md bg-nvr-cyan px-2 py-0.5 font-medium text-white hover:bg-nvr-cyan/90'
                      data-chat-outbox-save
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div
                  className={cn(
                    'inline-block whitespace-pre-wrap rounded-2xl rounded-br-md px-3 py-1.5 text-left text-[12.5px] leading-snug',
                    th.bubbleMine,
                    o.status !== 'failed' && 'opacity-70'
                  )}
                >
                  {o.text ||
                    `${o.attachments.length} attachment${o.attachments.length === 1 ? '' : 's'}`}
                </div>
              )}
              {!isEditing && (
                <p className='mt-0.5 flex flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[10.5px]'>
                  {o.status === 'sending' && (
                    <span className='text-slate-500 dark:text-slate-400'>Sending…</span>
                  )}
                  {o.status === 'queued' && (
                    <span className='text-amber-700 dark:text-amber-300'>
                      {o.held
                        ? 'Waiting while it is edited'
                        : 'Waiting for a connection — it sends when you are back online'}
                    </span>
                  )}
                  {o.status === 'failed' && (
                    <span className='text-red-600 dark:text-red-400'>
                      Not sent{o.error ? ` — ${o.error}` : ''}
                    </span>
                  )}
                  {o.status === 'failed' && (
                    <button
                      type='button'
                      onClick={() => retryOutbox(o.client_id)}
                      className={action}
                      data-chat-outbox-retry
                    >
                      <RotateCw className='h-3 w-3' /> Retry
                    </button>
                  )}
                  {canChange && o.text && (
                    <button
                      type='button'
                      onClick={() => startEdit(o)}
                      className={quiet}
                      data-chat-outbox-edit
                    >
                      <Pencil className='h-3 w-3' /> Edit
                    </button>
                  )}
                  {canChange && (
                    <button
                      type='button'
                      onClick={() => discardOutbox(o.client_id)}
                      className='inline-flex items-center gap-0.5 text-slate-500 hover:text-red-600 dark:text-slate-400 dark:hover:text-red-400'
                      data-chat-outbox-cancel
                    >
                      <Trash2 className='h-3 w-3' /> {o.status === 'failed' ? 'Remove' : 'Cancel'}
                    </button>
                  )}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
