import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, MessageSquare, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { SimpleSelect } from '../ui/SimpleSelect'
import { get, post } from '../../lib/commands'
import { canOpenChatRoom, openChatRoom } from '../chat/chat-core'

/**
 * Record ↔ chat: "Discuss" opens the record's entity room (`wf:CR26-…`) in the
 * host's chat dock, and "Send to a room…" posts the record's token (+ note)
 * into any of my rooms, where it renders as a live record chip.
 *
 * Deliberately OUTSIDE the ChatProvider tree — the record form mounts in hosts
 * that may or may not have chat. The Discuss action needs a registered room
 * opener (chat dock present); sharing only needs the API. The whole control
 * hides when the collection has no entity-room registration, so non-chat
 * deployments never see it.
 */

interface RoomType {
  prefix: string
  collection: string
  match_field: string
  is_active: boolean
}

interface SidebarRoom {
  room: string
  kind: string
  label: string | null
}

export function RecordChatActions({
  collection,
  itemDraft
}: {
  collection: string
  itemDraft: Record<string, unknown>
}) {
  const client = useNivaroClient()
  const [shareOpen, setShareOpen] = useState(false)
  const [shareRoom, setShareRoom] = useState('')
  const [note, setNote] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const { data: types } = useQuery({
    queryKey: ['nvr-chat-room-types'],
    queryFn: async () => {
      const res = (await client.request(get<{ data: RoomType[] }>('/chat/room-types'))) as {
        data: RoomType[]
      }
      return (res.data ?? []).filter((t) => t.is_active)
    },
    staleTime: 5 * 60_000
  })
  const type = types?.find((t) => t.collection === collection)
  const token = type ? String(itemDraft[type.match_field] ?? '').trim() : ''

  const { data: rooms } = useQuery({
    queryKey: ['nvr-chat-share-rooms'],
    queryFn: async () => {
      const res = (await client.request(get<{ data: SidebarRoom[] }>('/chat/rooms'))) as {
        data: SidebarRoom[]
      }
      // Entity rooms would just point back at records — sharing targets
      // conversations.
      return (res.data ?? []).filter((r) => r.kind !== 'entity')
    },
    enabled: shareOpen,
    staleTime: 30_000
  })

  const share = useMutation({
    mutationFn: () =>
      client.request(
        post('/chat/messages', {
          room: shareRoom,
          message: note.trim() ? `${note.trim()} ${token}` : token,
          mentions: []
        })
      ),
    onSuccess: () => {
      toast.success('Shared to chat')
      setShareOpen(false)
      setNote('')
    },
    onError: () => toast.error('Could not share to that room')
  })

  useEffect(() => {
    if (!shareOpen) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null
      // The room dropdown (Radix Select) PORTALS its options to document.body
      // — clicking an option must not read as "outside the popup".
      if (t?.closest?.('[data-radix-popper-content-wrapper], [role="listbox"]')) return
      if (!rootRef.current?.contains(e.target as Node)) setShareOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [shareOpen])

  // No registration for this collection, or the record has no token value yet
  // (unsaved / blank human id) — nothing sensible to open or share.
  if (!type || !token) return null
  const room = `${type.prefix}:${token}`
  const discussable = canOpenChatRoom()

  return (
    <div ref={rootRef} className='relative'>
      <div className='inline-flex h-8 items-stretch overflow-hidden rounded-md border border-slate-200 bg-white text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'>
        {/* Primary click = straight into the record's own room. No menu, no
            picking — the room IS the point of the button. */}
        <button
          type='button'
          onClick={() => {
            if (discussable) openChatRoom(room, token)
            else setShareOpen((o) => !o)
          }}
          title="Open this record's chat room"
          className='inline-flex items-center gap-1.5 px-2.5 text-[12px] hover:bg-muted'
          data-record-chat
        >
          <MessageSquare className='h-3.5 w-3.5' strokeWidth={2} />
          Chat
        </button>
        {discussable && (
          <button
            type='button'
            onClick={() => setShareOpen((o) => !o)}
            title='Send this record to a room'
            aria-label='Send this record to a room'
            className='inline-flex items-center border-l border-slate-200 px-1 hover:bg-muted dark:border-border'
            data-record-chat-more
          >
            <ChevronDown className='h-3 w-3' strokeWidth={2} />
          </button>
        )}
      </div>
      {shareOpen && (
        <div className='absolute right-0 top-full z-30 mt-1 w-[260px] rounded-lg border border-slate-200 bg-white p-2.5 shadow-lg dark:border-border dark:bg-card'>
          <div className='mb-1.5 flex items-center justify-between'>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              Share {token}
            </p>
            <button
              type='button'
              onClick={() => setShareOpen(false)}
              className='text-slate-400 hover:text-slate-600'
              aria-label='Close'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <SimpleSelect
            value={shareRoom}
            onChange={setShareRoom}
            ariaLabel='Room'
            className='mb-1.5 w-full'
            options={[
              { value: '', label: 'Pick a room…' },
              ...(rooms ?? []).map((r) => ({ value: r.room, label: r.label ?? r.room }))
            ]}
          />
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='Add a note (optional)'
            rows={2}
            className='mb-1.5 w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[12px] dark:border-border dark:bg-card'
            aria-label='Note'
          />
          <button
            type='button'
            disabled={!shareRoom || share.isPending}
            onClick={() => share.mutate()}
            className='flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-nvr-cyan text-[12px] font-medium text-white hover:brightness-110 disabled:opacity-40'
          >
            <Send className='h-3.5 w-3.5' /> {share.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}
    </div>
  )
}
