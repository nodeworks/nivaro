import {
  Archive,
  ArchiveRestore,
  AtSign,
  BellOff,
  CalendarClock,
  CalendarDays,
  Check,
  ChevronLeft,
  ExternalLink,
  HelpCircle,
  LogOut,
  MoreHorizontal,
  Settings,
  Star,
  Video
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { ChatTheme } from './ChatPanel'
import { JumpToDateForm } from './RoomParts'

export type RoomNotifyMode = 'all' | 'mentions' | 'muted'

/** One header icon button — every room-header action shares this size and
 *  colour so the strip reads as one row of equal targets. */
export const headerIconButton =
  'grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors'
export const headerIconIdle =
  'text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-slate-100'

/** Small status marks beside a room's name: starred, muted, mentions only. The
 *  actions that set them live in the More menu, so the state stays visible
 *  without a button for each. */
export function RoomStatusMarks({ starred, notify }: { starred: boolean; notify: RoomNotifyMode }) {
  if (!starred && notify === 'all') return null
  return (
    <span className='flex shrink-0 items-center gap-1' data-chat-room-status>
      {starred && (
        <Star
          role='img'
          aria-label='Starred'
          data-tip='Starred'
          className='h-3 w-3 fill-current text-amber-500'
          strokeWidth={2}
        />
      )}
      {notify === 'muted' && (
        <BellOff
          role='img'
          aria-label='Muted'
          data-tip='Muted — no alerts from this room'
          className='h-3 w-3 text-slate-400 dark:text-slate-500'
          strokeWidth={2}
        />
      )}
      {notify === 'mentions' && (
        <AtSign
          role='img'
          aria-label='Mentions only'
          data-tip='Mentions only — alerts only when someone @mentions you'
          className='h-3 w-3 text-slate-400 dark:text-slate-500'
          strokeWidth={2}
        />
      )}
    </span>
  )
}

interface Props {
  th: ChatTheme
  /** Omitted when the room cannot be starred (not in the person's list). */
  starred?: boolean
  onStar?: () => void
  /** Omitted when the room has no per-person notification setting. */
  notify?: RoomNotifyMode
  onNotify?: (mode: RoomNotifyMode) => void
  onJump: (dateIso: string) => void
  onOpenRecord?: () => void
  onTeamsCall?: () => void
  /** #2860 — the schedule-a-huddle form, rendered as its own view; omitted = no item. */
  huddleSchedule?: (close: () => void) => ReactNode
  onSettings?: () => void
  archived?: boolean
  onArchive?: () => void
  onLeave?: () => void
  tips: ReactNode
}

type View = 'menu' | 'date' | 'tips' | 'huddle'

/** The room header's More menu: every action that is not used on most visits
 *  (star, notifications, jump to date, Teams call, archive, leave, settings,
 *  tips) lives here so the room name keeps its width in a narrow dock. */
export function RoomHeaderMenu(p: Props) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('menu')
  const close = () => setOpen(false)
  const run = (fn?: () => void) => () => {
    close()
    fn?.()
  }
  const hasRoomGroup = !!(p.onOpenRecord || p.onStar || p.onTeamsCall)
  const hasManageGroup = !!(p.onSettings || p.onArchive || p.onLeave)

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setView('menu')
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(headerIconButton, open ? p.th.accentSoft : headerIconIdle)}
          aria-label='More room actions'
          data-tip='More'
          data-chat-room-more
        >
          <MoreHorizontal className='h-4 w-4' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className={cn(
          'p-1',
          view === 'tips'
            ? 'w-[420px] max-w-[92vw]'
            : view === 'date'
              ? 'w-[240px]'
              : view === 'huddle'
                ? 'w-[320px] max-w-[92vw]'
                : 'w-[232px]'
        )}
        data-chat-room-menu
      >
        {view === 'menu' && (
          <div role='menu' aria-label='Room actions' className='flex flex-col'>
            {p.onOpenRecord && (
              <Row icon={<ExternalLink />} onClick={run(p.onOpenRecord)} data='open-record'>
                Open the record
              </Row>
            )}
            {p.onStar && (
              <Row
                icon={<Star className={cn(p.starred && 'fill-current text-amber-500')} />}
                onClick={run(p.onStar)}
                data='star'
              >
                {p.starred ? 'Unstar' : 'Star — keep it at the top'}
              </Row>
            )}
            {p.onTeamsCall && (
              <Row icon={<Video />} onClick={run(p.onTeamsCall)} data='teams-call'>
                Start a Teams call
              </Row>
            )}
            {p.huddleSchedule && (
              <Row
                icon={<CalendarClock />}
                onClick={() => setView('huddle')}
                data='schedule-huddle'
              >
                Schedule a huddle…
              </Row>
            )}
            <Row icon={<CalendarDays />} onClick={() => setView('date')} data='jump-date'>
              Jump to a date…
            </Row>
            {p.notify && p.onNotify && (
              <>
                <Divider />
                <p className='px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400'>
                  Notify me
                </p>
                {(
                  [
                    ['all', 'About every message'],
                    ['mentions', 'Only when mentioned'],
                    ['muted', 'Never (muted)']
                  ] as const
                ).map(([mode, text]) => (
                  <button
                    key={mode}
                    type='button'
                    role='menuitemradio'
                    aria-checked={p.notify === mode}
                    onClick={run(() => p.onNotify?.(mode))}
                    className='flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] text-slate-700 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none dark:text-slate-200'
                    data-chat-notify={mode}
                  >
                    <span className='w-4 shrink-0'>
                      {p.notify === mode && <Check className='h-3.5 w-3.5' strokeWidth={2.25} />}
                    </span>
                    {text}
                  </button>
                ))}
              </>
            )}
            {hasManageGroup && <Divider />}
            {p.onSettings && (
              <Row icon={<Settings />} onClick={run(p.onSettings)} data='settings'>
                Channel settings
              </Row>
            )}
            {p.onArchive && (
              <Row
                icon={p.archived ? <ArchiveRestore /> : <Archive />}
                onClick={run(p.onArchive)}
                data={p.archived ? 'unarchive' : 'archive'}
                hint={p.archived ? undefined : 'Only for you — others still see it'}
              >
                {p.archived ? 'Unarchive' : 'Archive for me'}
              </Row>
            )}
            {p.onLeave && (
              <Row
                icon={<LogOut />}
                onClick={run(p.onLeave)}
                data='leave'
                hint='Open it from the record again to rejoin'
              >
                Leave this record's chat
              </Row>
            )}
            {(hasRoomGroup || hasManageGroup || p.notify) && <Divider />}
            <Row icon={<HelpCircle />} onClick={() => setView('tips')} data='tips'>
              What this chat can do
            </Row>
          </div>
        )}
        {view === 'date' && (
          <div className='p-1.5'>
            <BackRow onClick={() => setView('menu')} />
            <JumpToDateForm onJump={p.onJump} onDone={close} />
          </div>
        )}
        {view === 'huddle' && p.huddleSchedule && (
          <div className='p-1.5'>
            <BackRow onClick={() => setView('menu')} />
            {p.huddleSchedule(close)}
          </div>
        )}
        {view === 'tips' && (
          <div>
            <div className='px-1.5 pt-1.5'>
              <BackRow onClick={() => setView('menu')} />
            </div>
            {p.tips}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function Row({
  icon,
  children,
  hint,
  onClick,
  data
}: {
  icon: ReactNode
  children: ReactNode
  hint?: string
  onClick: () => void
  data: string
}) {
  return (
    <button
      type='button'
      role='menuitem'
      onClick={onClick}
      className='flex min-h-8 w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-slate-700 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none dark:text-slate-200'
      data-chat-room-action={data}
    >
      <span className='grid w-4 shrink-0 place-items-center text-slate-500 dark:text-slate-400 [&>svg]:h-3.5 [&>svg]:w-3.5'>
        {icon}
      </span>
      <span className='min-w-0'>
        <span className='block'>{children}</span>
        {hint && (
          <span className='block text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
            {hint}
          </span>
        )}
      </span>
    </button>
  )
}

function Divider() {
  return <hr className='my-1 border-0 border-t border-slate-100 dark:border-border/60' />
}

function BackRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='mb-1.5 flex items-center gap-1 rounded px-1 py-0.5 text-[11.5px] font-medium text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
    >
      <ChevronLeft className='h-3.5 w-3.5' strokeWidth={2} />
      Back
    </button>
  )
}
