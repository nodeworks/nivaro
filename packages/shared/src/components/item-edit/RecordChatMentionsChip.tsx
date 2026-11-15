import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveAvailable, useLiveRecordEvent } from '../../lib/live'
import { useLivePreference } from '../../lib/live-preference'
import { canOpenChatRoom, openChatRoom } from '../chat/chat-core'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * "Being discussed in #ops (3 new)" on a record header (rt7 #18).
 *
 * GET /chat/record-discussion answers, as the viewer, which of the rooms they are IN (and may see)
 * recently named this record — counts and room names only. Hidden when nothing qualifies or the
 * viewer cannot read the record. Live: a message naming the record pings its open pages
 * (`record:chat`, ids only) and reading a room anywhere moves "new" (`read:changed` refreshes
 * every ['nvr-chat-record-room', …] query). Calm and Off do not re-read on their own; the count
 * is as of the page load.
 */

export interface MentionRoom {
  room: string
  kind: 'global' | 'dm' | 'channel'
  label: string
  count: number
  new_count: number
  last_at: string | null
}

export interface MentionsAnswer {
  rooms: MentionRoom[]
  total: number
  new_total: number
}

/** "Being discussed in #ops (3 new)" / "Discussed in 2 chats" — one chip's words (pure). */
export function mentionsText(a: MentionsAnswer): string {
  if (a.rooms.length === 0) return ''
  const where = a.rooms.length === 1 ? a.rooms[0].label : `${a.rooms.length} chats`
  const lead = a.new_total > 0 ? 'Being discussed in' : 'Discussed in'
  return `${lead} ${where}${a.new_total > 0 ? ` (${a.new_total} new)` : ''}`
}

export function RecordChatMentionsChip({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const live = useLiveAvailable()
  const pref = useLivePreference()
  const [open, setOpen] = useState(false)
  const canOpen = canOpenChatRoom()

  const key = ['nvr-chat-record-room', 'mentions', collection, itemId]
  useLiveRecordEvent(
    'record:chat',
    collection,
    itemId,
    () => void qc.invalidateQueries({ queryKey: key }),
    { debounceMs: 1500, includeOwn: true, enabled: !pref.quiet }
  )
  const { data } = useQuery<MentionsAnswer | null>({
    queryKey: key,
    queryFn: async () => {
      const res = (await client.request(
        get<{ data: MentionsAnswer }>('/chat/record-discussion', { collection, item: itemId })
      )) as { data: MentionsAnswer }
      // A malformed answer (older server, stub) is "nothing to show", never a header crash.
      return Array.isArray(res?.data?.rooms) ? res.data : null
    },
    enabled: !!itemId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    // Without a socket (or in Calm/Off) the count is as of load; with one, a slow backstop.
    refetchInterval: live && !pref.quiet ? 5 * 60_000 : false,
    retry: false
  })
  if (!data || data.rooms.length === 0) return null
  const hasNew = data.new_total > 0
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          data-record-chat-mentions
          data-new={hasNew ? data.new_total : undefined}
          className={
            hasNew
              ? 'inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-1.5 py-px font-semibold text-[9.5px] text-sky-800 tabular-nums transition-colors hover:bg-sky-100 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300 dark:hover:bg-sky-500/20'
              : 'inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-px font-medium text-[9.5px] text-slate-500 transition-colors hover:bg-slate-100 dark:border-border dark:bg-muted dark:text-muted-foreground dark:hover:bg-slate-800'
          }
        >
          <MessagesSquare className='h-2.5 w-2.5' aria-hidden />
          {mentionsText(data)}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[280px] p-1'>
        <ul>
          {data.rooms.map((r) => (
            <li key={r.room}>
              <button
                type='button'
                disabled={!canOpen}
                onClick={() => {
                  openChatRoom(r.room, r.label)
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent dark:hover:bg-slate-800'
              >
                <span className='min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100'>
                  {r.label}
                </span>
                <span className='shrink-0 text-[11px] text-slate-500 tabular-nums dark:text-slate-400'>
                  {r.count} {r.count === 1 ? 'message' : 'messages'}
                </span>
                {r.new_count > 0 && (
                  <span className='shrink-0 rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-800 tabular-nums dark:bg-sky-500/20 dark:text-sky-300'>
                    {r.new_count} new
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
