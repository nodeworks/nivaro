import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { invalidateRecordTasks } from '../../lib/record-tasks'
import { useChatConfig, useUserSearch } from './chat-core'
import { useRoomRecord } from './chat-hooks'

/**
 * Slash commands in the chat composer (#2338).
 *
 * `/task`, `/remind`, `/poll` and `/note` each open a small inline form above
 * the box; extension commands (ctx.chat.registerCommand) join the same list and
 * run server-side as the person typing. The list opens when the draft is just
 * `/` plus the start of a name.
 */

export type BuiltinSlash = 'task' | 'remind' | 'poll' | 'note'

export interface SlashEntry {
  name: string
  description: string
  usage?: string | null
  builtin: boolean
}

const BUILTINS: SlashEntry[] = [
  { name: 'task', description: 'Create a task on this record or for a person', builtin: true },
  { name: 'remind', description: 'Remind yourself about something', builtin: true },
  { name: 'poll', description: 'Ask the room a question with options', builtin: true },
  { name: 'note', description: 'Add a note to this room’s record', builtin: true }
]

/** `/ta` → 'ta'; null unless the whole draft is a slash and a partial name. Pure. */
export function slashQuery(draft: string, cursor: number): string | null {
  const before = draft.slice(0, cursor)
  const m = before.match(/^\/([a-z0-9-]{0,23})$/i)
  return m ? m[1].toLowerCase() : null
}

/** Split `/name rest` → [name, rest]; null when it is not a command line. Pure. */
export function parseSlashLine(draft: string): { name: string; args: string } | null {
  const m = draft.match(/^\/([a-z][a-z0-9-]{1,23})(?:\s+([\s\S]*))?$/i)
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? '').trim() } : null
}

/** Commands matching what has been typed, built-ins first. Pure. */
export function filterSlash(entries: SlashEntry[], q: string): SlashEntry[] {
  return entries
    .filter((e) => e.name.startsWith(q.toLowerCase()))
    .sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name))
}

export function useChatCommands(): SlashEntry[] {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-commands'],
    queryFn: () =>
      client
        .request<{ data: Array<{ name: string; description: string; usage: string | null }> }>(
          get('/chat/commands')
        )
        .then((r) => r.data ?? [])
        .catch(() => []),
    staleTime: 5 * 60_000
  })
  return [...BUILTINS, ...(data ?? []).map((c) => ({ ...c, builtin: false }))]
}

export function SlashMenu({
  entries,
  index,
  onPick,
  accentSoft
}: {
  entries: SlashEntry[]
  index: number
  onPick: (e: SlashEntry) => void
  accentSoft: string
}) {
  return (
    <>
      {entries.map((e, i) => (
        <button
          key={e.name}
          type='button'
          onMouseDown={(ev) => {
            ev.preventDefault()
            onPick(e)
          }}
          className={cn(
            'flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[12.5px]',
            i === index ? accentSoft : 'text-slate-700 dark:text-slate-200'
          )}
          data-chat-slash={e.name}
        >
          <span className='font-mono font-medium'>/{e.name}</span>
          <span className='min-w-0 flex-1 truncate text-[11px] text-slate-500 dark:text-slate-400'>
            {e.description}
          </span>
        </button>
      ))}
    </>
  )
}

const field =
  'h-7 w-full rounded-md border border-slate-200 bg-transparent px-2 text-[12px] outline-none focus:border-slate-400 dark:border-border'

function pad(n: number) {
  return String(n).padStart(2, '0')
}
/** A datetime-local value for a Date, in local time. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function SlashForm({
  kind,
  room,
  initialText,
  parentId,
  onClose,
  th
}: {
  kind: BuiltinSlash
  room: string
  initialText: string
  parentId?: number | null
  onClose: () => void
  th: { surface: string; action: string }
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const cfg = useChatConfig()
  const record = useRoomRecord(room, kind === 'task' || kind === 'note')
  const [text, setText] = useState(initialText)

  // task
  const [onRecord, setOnRecord] = useState(true)
  const [assignee, setAssignee] = useState<{ id: string; name: string } | null>(
    cfg.me ? { id: cfg.me.id, name: 'Me' } : null
  )
  const [who, setWho] = useState('')
  const [due, setDue] = useState('')
  const people = useUserSearch(who, kind === 'task' && who.trim().length >= 2)

  // remind
  const [at, setAt] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)))

  // poll
  const [options, setOptions] = useState(['', ''])
  const [multiple, setMultiple] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [closesAt, setClosesAt] = useState('')

  const done = (msg: string) => {
    toast.success(msg)
    onClose()
  }
  const fail = (e: unknown, fallback: string) =>
    toast.error((e as { response?: { error?: string } })?.response?.error ?? fallback)

  const submit = useMutation({
    mutationFn: async () => {
      if (kind === 'task') {
        if (!text.trim()) throw new Error('A task needs a title')
        const useRecord = onRecord && !!record
        await client.request(
          post('/tasks', {
            ...(useRecord ? { collection: record?.collection, item: String(record?.id) } : {}),
            title: text.trim().slice(0, 200),
            assignee: assignee?.id ?? cfg.me?.id,
            ...(due ? { due_date: due } : {})
          })
        )
        if (useRecord && record) invalidateRecordTasks(qc, record.collection, record.id)
        return assignee && assignee.id !== cfg.me?.id
          ? `Task created for ${assignee.name}`
          : 'Task created'
      }
      if (kind === 'remind') {
        if (!text.trim()) throw new Error('Say what to remind you about')
        await client.request(
          post('/reminders', { note: text.trim(), remind_at: new Date(at).toISOString() })
        )
        return 'Reminder set'
      }
      if (kind === 'note') {
        if (!record) throw new Error('This room has no record to add a note to')
        if (!text.trim()) throw new Error('Write the note first')
        const esc = (t: string) => t.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
        await client.request(
          post('/comments', {
            collection: record.collection,
            item: String(record.id),
            text: `<p>${esc(text.trim()).split(/\n+/).join('</p><p>')}</p>`
          })
        )
        void qc.invalidateQueries({ queryKey: ['comments', record.collection, String(record.id)] })
        return `Note added to ${record.label ?? 'the record'}`
      }
      // poll
      const opts = options.map((o) => o.trim()).filter(Boolean)
      if (!text.trim()) throw new Error('A poll needs a question')
      if (opts.length < 2) throw new Error('Give at least two options')
      await client.request(
        post('/chat/polls', {
          room,
          question: text.trim(),
          options: opts,
          multiple,
          anonymous,
          closes_at: closesAt ? new Date(closesAt).toISOString() : null,
          parent_id: parentId ?? null
        })
      )
      void qc.invalidateQueries({ queryKey: ['nvr-chat', room] })
      return 'Poll posted'
    },
    onSuccess: (msg) => done(msg),
    onError: (e) => fail(e, e instanceof Error ? e.message : 'That did not work')
  })

  const title = { task: 'New task', remind: 'Remind me', poll: 'New poll', note: 'Add a note' }[
    kind
  ]
  const placeholder = {
    task: 'What needs doing?',
    remind: 'Remind me to…',
    poll: 'Ask a question',
    note: 'Note for the record'
  }[kind]

  return (
    <div
      className={cn(
        'absolute bottom-full left-2.5 right-2.5 z-20 mb-1 rounded-xl border border-slate-200 p-3 shadow-lg dark:border-border',
        th.surface
      )}
      data-chat-slash-form={kind}
    >
      <div className='mb-2 flex items-center justify-between'>
        <span className='flex items-center gap-1.5 text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
          <ListChecks className='h-3.5 w-3.5' /> {title}
        </span>
        <button
          type='button'
          onClick={onClose}
          aria-label='Close'
          className='text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        >
          <X className='h-3.5 w-3.5' />
        </button>
      </div>
      <div className='space-y-2'>
        {kind === 'note' ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            rows={3}
            className={cn(field, 'h-auto py-1.5')}
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit command
            autoFocus
          />
        ) : (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className={field}
            // biome-ignore lint/a11y/noAutofocus: opened by an explicit command
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && kind !== 'poll') {
                e.preventDefault()
                submit.mutate()
              }
            }}
          />
        )}

        {kind === 'task' && (
          <>
            {record && (
              <label className='flex items-center gap-1.5 text-[11.5px] text-slate-600 dark:text-slate-300'>
                <input
                  type='checkbox'
                  checked={onRecord}
                  onChange={(e) => setOnRecord(e.target.checked)}
                />
                On {record.label ?? 'this record'}
              </label>
            )}
            <div className='flex items-center gap-2'>
              <span className='shrink-0 text-[11px] text-slate-500'>For</span>
              <input
                value={assignee && !who ? assignee.name : who}
                onFocus={() => {
                  setWho('')
                }}
                onChange={(e) => {
                  setWho(e.target.value)
                  setAssignee(null)
                }}
                placeholder='Me — or search a person'
                className={field}
                data-chat-slash-assignee
              />
              <input
                type='date'
                value={due}
                onChange={(e) => setDue(e.target.value)}
                aria-label='Due date'
                className={cn(field, 'w-[130px] shrink-0')}
              />
            </div>
            {!assignee && who.trim().length >= 2 && (
              <ul className='max-h-24 overflow-y-auto rounded-md border border-slate-200 text-[12px] dark:border-border'>
                {people.users.slice(0, 6).map((u) => {
                  const name =
                    [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || ''
                  return (
                    <li key={u.id}>
                      <button
                        type='button'
                        onClick={() => {
                          setAssignee({ id: u.id, name })
                          setWho('')
                        }}
                        className='w-full px-2 py-1 text-left hover:bg-muted'
                      >
                        {name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </>
        )}

        {kind === 'remind' && (
          <div className='flex flex-wrap items-center gap-1.5'>
            <input
              type='datetime-local'
              value={at}
              onChange={(e) => setAt(e.target.value)}
              aria-label='Remind at'
              className={cn(field, 'w-[210px]')}
            />
            {[
              ['1 hour', () => new Date(Date.now() + 60 * 60_000)],
              [
                'Tomorrow 9am',
                () => {
                  const d = new Date()
                  d.setDate(d.getDate() + 1)
                  d.setHours(9, 0, 0, 0)
                  return d
                }
              ]
            ].map(([label, fn]) => (
              <button
                key={label as string}
                type='button'
                onClick={() => setAt(toLocalInput((fn as () => Date)()))}
                className='rounded-full border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-muted dark:border-border dark:text-slate-300'
              >
                {label as string}
              </button>
            ))}
          </div>
        )}

        {kind === 'poll' && (
          <>
            <div className='space-y-1'>
              {options.map((o, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: positional inputs
                <div key={i} className='flex items-center gap-1'>
                  <input
                    value={o}
                    onChange={(e) =>
                      setOptions((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder={`Option ${i + 1}`}
                    className={field}
                  />
                  {options.length > 2 && (
                    <button
                      type='button'
                      aria-label='Remove option'
                      onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                      className='text-slate-400 hover:text-slate-700'
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  )}
                </div>
              ))}
              {options.length < 10 && (
                <button
                  type='button'
                  onClick={() => setOptions((p) => [...p, ''])}
                  className='inline-flex items-center gap-1 text-[11.5px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-100'
                >
                  <Plus className='h-3 w-3' /> Add option
                </button>
              )}
            </div>
            <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-slate-600 dark:text-slate-300'>
              <label className='flex items-center gap-1.5'>
                <input
                  type='checkbox'
                  checked={multiple}
                  onChange={(e) => setMultiple(e.target.checked)}
                />
                Allow several answers
              </label>
              <label className='flex items-center gap-1.5'>
                <input
                  type='checkbox'
                  checked={anonymous}
                  onChange={(e) => setAnonymous(e.target.checked)}
                />
                Anonymous votes
              </label>
              <label className='flex items-center gap-1.5'>
                Closes
                <input
                  type='datetime-local'
                  value={closesAt}
                  onChange={(e) => setClosesAt(e.target.value)}
                  className={cn(field, 'w-[190px]')}
                />
              </label>
            </div>
          </>
        )}

        <div className='flex justify-end'>
          <button
            type='button'
            disabled={submit.isPending}
            onClick={() => submit.mutate()}
            className={cn('rounded-md px-3 py-1 text-[12px] font-medium', th.action)}
            data-chat-slash-submit
          >
            {kind === 'poll' ? 'Post poll' : kind === 'remind' ? 'Set reminder' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
