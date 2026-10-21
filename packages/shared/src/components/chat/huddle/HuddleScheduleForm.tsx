import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { cn } from '../../../lib/utils'
import { SimpleSelectXs } from '../../ui/SimpleSelect'
import { dmPeer } from '../chat-core'
import { HuddlePeopleList } from './HuddlePeoplePicker'
import { defaultStart, type HuddleScheduleCardData, toLocalInput } from './huddle-schedule'

const DURATIONS = [
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
  { value: '45', label: '45 min' },
  { value: '60', label: '1 hour' },
  { value: '90', label: '1½ hours' },
  { value: '120', label: '2 hours' }
]

const input =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-[12.5px] text-slate-900 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-slate-100'

/**
 * Schedule a huddle (#2860) — the view inside the room's ⋯ menu. A title, a
 * start, how long, and who to invite (people who can see the room; in a
 * direct message the other person is already in). Saving posts the card in
 * the room, tells the invitees, and the server reminds and rings them later.
 */
export function HuddleScheduleForm({
  room,
  me,
  renderAvatar,
  onDone,
  theme
}: {
  room: string
  me: string | null
  renderAvatar: (id: string, name: string | null) => ReactNode
  onDone: () => void
  theme?: { input?: string }
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const peer = me ? dmPeer(room, me) : null
  const [title, setTitle] = useState('')
  const [when, setWhen] = useState(() => toLocalInput(defaultStart()))
  const [duration, setDuration] = useState('30')
  const [people, setPeople] = useState<Map<string, string>>(() =>
    peer ? new Map([[peer.toUpperCase(), 'them']]) : new Map()
  )
  const [error, setError] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: () =>
      client.request<{ data: HuddleScheduleCardData }>(
        post('/chat/huddle/schedules', {
          room,
          title,
          starts_at: new Date(when).toISOString(),
          duration_min: Number(duration),
          invitees: [...people.keys()]
        })
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['nvr-huddle-schedules', room] })
      toast.success(`Huddle scheduled — "${r.data.title}"`, {
        description:
          r.data.invitees.length > 0
            ? `${r.data.invitees.length} ${r.data.invitees.length === 1 ? 'person was' : 'people were'} invited. Everyone gets a reminder five minutes before.`
            : 'The room has the card; invite people from it later.'
      })
      onDone()
    },
    onError: (e) =>
      setError(
        (e as { response?: { error?: string } })?.response?.error ??
          (e as Error)?.message ??
          'Could not schedule it'
      )
  })
  const invalidWhen = Number.isNaN(new Date(when).getTime())
  const tooSoon = !invalidWhen && new Date(when).getTime() < Date.now() + 60_000
  const canSave = title.trim().length > 0 && !invalidWhen && !tooSoon && !save.isPending

  return (
    <form
      className='space-y-2.5 p-0.5'
      onSubmit={(e) => {
        e.preventDefault()
        setError(null)
        if (canSave) save.mutate()
      }}
      data-huddle-schedule-form
    >
      <div>
        <label
          htmlFor='huddle-sched-title'
          className='mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400'
        >
          Title
        </label>
        <input
          id='huddle-sched-title'
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder='What is it about?'
          className={cn(input, theme?.input)}
        />
      </div>
      <div className='flex items-end gap-2'>
        <div className='min-w-0 flex-1'>
          <label
            htmlFor='huddle-sched-when'
            className='mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400'
          >
            Starts
          </label>
          <input
            id='huddle-sched-when'
            type='datetime-local'
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className={cn(input, theme?.input, tooSoon && 'border-red-400 dark:border-red-500')}
            aria-invalid={tooSoon || invalidWhen}
          />
        </div>
        <div className='shrink-0'>
          <span className='mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400'>
            For
          </span>
          <SimpleSelectXs
            value={duration}
            onChange={setDuration}
            options={DURATIONS}
            ariaLabel='Duration'
            className='h-8 text-[12px]'
          />
        </div>
      </div>
      {tooSoon && (
        <p className='text-[11px] text-red-600 dark:text-red-300'>
          Pick a time at least a minute from now.
        </p>
      )}
      {!peer && (
        <div>
          <span className='mb-1 block text-[11px] font-medium text-slate-500 dark:text-slate-400'>
            Invite
          </span>
          {people.size > 0 && (
            <div className='mb-1.5 flex flex-wrap gap-1' data-huddle-sched-invitees>
              {[...people].map(([id, name]) => (
                <span
                  key={id}
                  className='inline-flex h-6 items-center gap-1 rounded-full bg-slate-100 pl-0.5 pr-1 text-[11px] text-slate-700 dark:bg-muted dark:text-slate-200'
                >
                  <span style={{ lineHeight: 0 }}>{renderAvatar(id, name)}</span>
                  <span className='max-w-[120px] truncate'>{name}</span>
                  <button
                    type='button'
                    onClick={() =>
                      setPeople((m) => {
                        const next = new Map(m)
                        next.delete(id)
                        return next
                      })
                    }
                    className='grid h-4 w-4 place-items-center rounded-full text-slate-500 hover:bg-slate-200 hover:text-slate-800 dark:hover:bg-white/10 dark:hover:text-slate-100'
                    aria-label={`Remove ${name}`}
                  >
                    <X className='h-3 w-3' strokeWidth={2} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className='rounded-md border border-slate-200 dark:border-border'>
            <HuddlePeopleList
              room={room}
              selected={new Set(people.keys())}
              renderAvatar={renderAvatar}
              placeholder='Add people who can see this room…'
              onPick={(p) =>
                setPeople((m) => {
                  const next = new Map(m)
                  const key = p.id.toUpperCase()
                  if (next.has(key)) next.delete(key)
                  else next.set(key, p.name)
                  return next
                })
              }
            />
          </div>
        </div>
      )}
      {peer && (
        <p className='text-[11px] text-slate-500 dark:text-slate-400'>
          The other person in this conversation is invited and will be called at the start.
        </p>
      )}
      {error && (
        <p className='text-[11px] text-red-600 dark:text-red-300' role='alert'>
          {error}
        </p>
      )}
      <div className='flex items-center justify-end gap-1.5 pt-0.5'>
        <button
          type='button'
          onClick={onDone}
          className='h-7 rounded-md px-2 text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
        >
          Cancel
        </button>
        <button
          type='submit'
          disabled={!canSave}
          className='h-7 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:bg-[#00b8e0] disabled:opacity-40 disabled:hover:bg-nvr-cyan'
          data-huddle-sched-save
        >
          {save.isPending ? 'Scheduling…' : 'Schedule'}
        </button>
      </div>
    </form>
  )
}
