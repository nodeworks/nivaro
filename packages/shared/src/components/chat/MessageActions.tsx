import { useQuery } from '@tanstack/react-query'
import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

/**
 * Extension items in a chat message's ⋯ menu (#2763) — registered with
 * ctx.chat.registerMessageAction. The room's list is read once (room kinds
 * are filtered on the server); the message-shape checks below run per
 * message, and the server checks them all again before the action runs.
 */

export interface MessageActionEntry {
  key: string
  id: string
  extension: string
  label: string
  description: string | null
  when: {
    has_text?: boolean
    has_attachments?: boolean
    own_messages?: boolean
    text_pattern?: string
  }
}

/** The actions a room offers; [] while loading, on error or when none. */
export function useMessageActions(room: string, enabled = true): MessageActionEntry[] {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-message-actions', room],
    queryFn: () =>
      client
        .request<{ data: MessageActionEntry[] }>(get('/chat/message-actions', { room }))
        .then((r) => r.data ?? [])
        .catch(() => [] as MessageActionEntry[]),
    enabled: enabled && !!room,
    staleTime: 5 * 60_000
  })
  return data ?? []
}

/**
 * Which actions fit this message. Pure. The twin of messageMatches in
 * api/src/services/chat-message-actions.ts — change both together.
 */
export function actionsForMessage(
  actions: MessageActionEntry[],
  msg: { message?: string | null; attachments?: string[] | null; sender?: string | null },
  myId: string | null | undefined
): MessageActionEntry[] {
  const text = String(msg.message ?? '')
  return actions.filter(({ when }) => {
    if (when.has_text && !text.trim()) return false
    if (when.has_attachments && !(msg.attachments ?? []).length) return false
    if (
      when.own_messages &&
      String(msg.sender ?? '').toUpperCase() !== String(myId ?? '').toUpperCase()
    )
      return false
    if (when.text_pattern) {
      try {
        if (!new RegExp(when.text_pattern, 'i').test(text)) return false
      } catch {
        return false
      }
    }
    return true
  })
}

export function MessageActionsMenu({
  messageId,
  actions,
  onOpenChange,
  navigate,
  className
}: {
  messageId: number
  actions: MessageActionEntry[]
  /** The hover toolbar stays visible while the menu is open. */
  onOpenChange?: (open: boolean) => void
  navigate?: (url: string) => void
  className?: string
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const change = (v: boolean) => {
    setOpen(v)
    onOpenChange?.(v)
  }
  const run = async (a: MessageActionEntry) => {
    setRunning(a.key)
    try {
      const r = await client.request<{
        data: { posted_message_id: number | null; reply: string | null; open_url: string | null }
      }>(post(`/chat/messages/${messageId}/actions`, { action: a.key }))
      const out = r.data
      if (out?.reply) toast.message(out.reply)
      else if (!out?.posted_message_id && !out?.open_url) toast.success(`${a.label} — done`)
      if (out?.open_url) {
        if (out.open_url.startsWith('/') && navigate) navigate(out.open_url)
        else window.open(out.open_url, '_blank', 'noopener,noreferrer')
      }
      change(false)
    } catch (err) {
      toast.error(
        (err as { response?: { error?: string } })?.response?.error ?? `${a.label} failed`
      )
    } finally {
      setRunning(null)
    }
  }
  if (!actions.length) return null
  return (
    <Popover open={open} onOpenChange={change}>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='More actions'
          data-tip='More actions'
          className={cn(
            'rounded-full p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200',
            open && 'text-slate-700 dark:text-slate-100',
            className
          )}
          data-chat-msg-more
        >
          <MoreHorizontal className='h-3 w-3' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[240px] p-1' data-chat-msg-actions-menu>
        {actions.map((a) => (
          <button
            key={a.key}
            type='button'
            disabled={running !== null}
            onClick={() => void run(a)}
            className='flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:opacity-60'
          >
            <span className='text-[12px] text-slate-800 dark:text-slate-100'>
              {running === a.key ? `${a.label}…` : a.label}
            </span>
            {a.description && (
              <span className='text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
                {a.description}
              </span>
            )}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
