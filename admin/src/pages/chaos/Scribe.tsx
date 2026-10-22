import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, Search, Wrench } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import type { ChaosRunEvent } from './api'
import { errText } from './api'
import { addNote, fetchNotes, gamedayKeys, MARK_LABEL, type NoteMark } from './gameday-api'

/**
 * Scribe button (#2853): during a run or game day, anyone taking part stamps what they saw in
 * one click — Noticed, Found cause, Fixed — or a free-text note. Marks become the run's time to
 * detect / find the cause / fix (server: gameday-plan.ts notePoints). Notes on a game day's
 * child run land on the game day itself.
 *
 * `useRunNotes` + `<NoteMarkers>` are the pieces the cockpit charts (#2845) and the run report
 * (#2849) draw the marks with.
 */

export function useRunNotes(runId: string | null | undefined, live = false) {
  return useQuery({
    queryKey: gamedayKeys.notes(runId ?? ''),
    queryFn: () => fetchNotes(String(runId)),
    enabled: !!runId,
    refetchInterval: live ? 5_000 : false
  })
}

const PRESETS: Array<{ mark: Exclude<NoteMark, 'declared'>; icon: typeof Eye }> = [
  { mark: 'noticed', icon: Eye },
  { mark: 'found_cause', icon: Search },
  { mark: 'fixed', icon: Wrench }
]

export function ScribeBar({ runId, className }: { runId: string; className?: string }) {
  const qc = useQueryClient()
  const [text, setText] = useState('')
  const [last, setLast] = useState<string | null>(null)
  const stamp = useMutation({
    mutationFn: (body: { mark?: NoteMark | null; text?: string | null }) => addNote(runId, body),
    onSuccess: (ev, body) => {
      setLast(
        `${body.mark ? MARK_LABEL[body.mark] : 'Note'} at ${new Date(ev.at).toLocaleTimeString(
          'en-US',
          { hour: 'numeric', minute: '2-digit', second: '2-digit' }
        )}`
      )
      if (!body.mark) setText('')
      void qc.invalidateQueries({ queryKey: ['chaos'] })
    },
    onError: (e) => toast.error(errText(e, 'The note was not stamped'))
  })
  const send = () => {
    const t = text.trim()
    if (t) stamp.mutate({ text: t })
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {PRESETS.map(({ mark, icon: Icon }) => (
        <button
          key={mark}
          type='button'
          disabled={stamp.isPending}
          onClick={() => stamp.mutate({ mark })}
          className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-[12.5px] font-medium text-slate-800 transition-colors duration-150 hover:border-nvr-cyan hover:bg-nvr-cyan/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan active:bg-nvr-cyan/10 disabled:opacity-40 dark:border-border dark:bg-card dark:text-foreground'
        >
          <Icon className='h-3.5 w-3.5 text-slate-500 dark:text-muted-foreground' aria-hidden />
          {MARK_LABEL[mark]}
        </button>
      ))}
      <form
        className='flex min-w-[220px] flex-1 items-center gap-1.5'
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          placeholder='Note what you see…'
          aria-label='Note'
          className='h-8 min-w-0 flex-1 rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-900 placeholder:text-slate-500 focus:border-nvr-cyan focus:outline-none dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
        />
        <button
          type='submit'
          disabled={!text.trim() || stamp.isPending}
          className='h-8 rounded-md px-3 text-[12.5px] font-medium text-slate-700 transition-colors duration-150 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-40 dark:text-foreground dark:hover:bg-muted'
        >
          Add note
        </button>
      </form>
      <span
        role='status'
        className='w-full text-[11.5px] text-slate-500 tabular-nums dark:text-muted-foreground'
      >
        {last ? `Stamped: ${last}` : 'Stamp it the moment it happens — the times feed the report.'}
      </span>
    </div>
  )
}

const MARK_TONE: Record<NoteMark, string> = {
  noticed: 'bg-sky-500',
  found_cause: 'bg-amber-500',
  fixed: 'bg-emerald-500',
  declared: 'bg-red-500'
}

/**
 * Scribe marks along a time axis — drop it over a chart's plot area (`absolute inset-0`) and
 * give it the axis range. Free-text notes draw as small slate ticks.
 */
export function NoteMarkers({
  notes,
  from,
  to,
  className
}: {
  notes: ChaosRunEvent[]
  from: number
  to: number
  className?: string
}) {
  const span = Math.max(1, to - from)
  return (
    <div className={cn('pointer-events-none absolute inset-0', className)} aria-hidden>
      {notes.map((n) => {
        const at = Date.parse(n.at)
        if (!Number.isFinite(at) || at < from || at > to) return null
        const mark = n.data?.mark as NoteMark | undefined
        const label = mark ? MARK_LABEL[mark] : String(n.data?.text ?? 'Note')
        return (
          <span
            key={n.id}
            data-tip={`${label} · ${new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`}
            className={cn(
              'pointer-events-auto absolute top-0 bottom-0 w-px',
              mark ? MARK_TONE[mark] : 'bg-slate-400 dark:bg-slate-500'
            )}
            style={{ left: `${((at - from) / span) * 100}%` }}
          >
            <span
              className={cn(
                'absolute -top-0.5 left-1/2 h-2 w-2 -translate-x-1/2 rounded-full ring-2 ring-white dark:ring-card',
                mark ? MARK_TONE[mark] : 'bg-slate-400 dark:bg-slate-500'
              )}
            />
          </span>
        )
      })}
    </div>
  )
}
