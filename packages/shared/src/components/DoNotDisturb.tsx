import { BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dndUntil, isDndActive } from '../lib/dnd'
import { cn, getDisplayTimezone } from '../lib/utils'
import { useMyPreferences, useSetMyPreferences } from './chat/chat-core'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

/** Re-render when do not disturb is due to end, so the mark and the row clear on time. */
export function useDndActive(): boolean {
  const prefs = useMyPreferences()
  const [, tick] = useState(0)
  const until = dndUntil(prefs)
  useEffect(() => {
    if (!until) return
    const wait = until.getTime() - Date.now()
    if (wait <= 0) return
    // setTimeout caps near 24 days; a longer wait re-arms itself.
    const t = setTimeout(() => tick((n) => n + 1), Math.min(wait + 250, 2_000_000_000))
    return () => clearTimeout(t)
  }, [until])
  return isDndActive(prefs)
}

/** End of today in the viewer's clock, for "until tomorrow". */
function tomorrowMorning(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(8, 0, 0, 0)
  return d
}

/** The small bell-off mark shown on a person's own avatar while do not disturb is on. */
export function DndMark({ className }: { className?: string }) {
  return (
    <span
      data-dnd-mark
      data-tip='Do not disturb'
      className={cn(
        'flex h-3.5 w-3.5 items-center justify-center rounded-full border border-white bg-red-500 text-white dark:border-card',
        className
      )}
    >
      <BellOff className='h-2 w-2' strokeWidth={3} />
    </span>
  )
}

/**
 * Do not disturb (#2114): holds toasts and sounds on every tab and device until a time or
 * until switched off. The inbox still fills and critical notifications still break through.
 */
export function DoNotDisturbRow() {
  const prefs = useMyPreferences()
  const setPrefs = useSetMyPreferences()
  const active = useDndActive()
  const [open, setOpen] = useState(false)
  const until = dndUntil(prefs)
  const set = (to: Date | null | 'off') => {
    setPrefs.mutate({ dnd: to === 'off' ? null : { until: to ? to.toISOString() : null } })
    setOpen(false)
  }
  const untilText = active
    ? until
      ? `until ${until.toLocaleString('en-US', {
          weekday: 'short',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: getDisplayTimezone() ?? undefined
        })}`
      : 'until you switch it off'
    : null
  return (
    <div
      className='mb-1.5 flex items-center gap-2 px-1 text-[12px]'
      data-chat-dnd={active ? 'on' : 'off'}
    >
      <BellOff
        className={cn('h-3 w-3 shrink-0', active ? 'text-red-500' : 'text-slate-400')}
        aria-hidden
      />
      <span className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'>
        {active ? `Notifications paused ${untilText}` : 'Notifications on'}
      </span>
      {active ? (
        <button
          type='button'
          onClick={() => set('off')}
          className='shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
          data-chat-dnd-off
        >
          Turn off
        </button>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type='button'
              className='shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-muted dark:text-slate-300'
              data-chat-dnd-open
            >
              Do not disturb
            </button>
          </PopoverTrigger>
          <PopoverContent align='end' className='w-56 p-1'>
            <p className='px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400'>
              Pause toasts and sounds for
            </p>
            {(
              [
                ['30 minutes', () => new Date(Date.now() + 30 * 60_000)],
                ['1 hour', () => new Date(Date.now() + 3600_000)],
                ['4 hours', () => new Date(Date.now() + 4 * 3600_000)],
                ['Until tomorrow morning', tomorrowMorning],
                ['Until I switch it off', () => null]
              ] as Array<[string, () => Date | null]>
            ).map(([label, until]) => (
              <button
                key={label}
                type='button'
                onClick={() => set(until())}
                className='flex w-full rounded px-2 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted dark:text-slate-200'
                data-chat-dnd-option={label}
              >
                {label}
              </button>
            ))}
            <p className='px-2 pb-1.5 pt-1 text-[10.5px] leading-snug text-slate-400'>
              Notifications still land in your inbox. Critical ones still break through.
            </p>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
