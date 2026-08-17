import { useMutation, useQuery } from '@tanstack/react-query'
import { MessageSquare, Send, X } from 'lucide-react'
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
  const [menuOpen, setMenuOpen] = useState(false)
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
      setMenuOpen(false)
      setNote('')
    },
    onError: () => toast.error('Could not share to that room')
  })

  useEffect(() => {
    if (!menuOpen && !shareOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
        setShareOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [menuOpen, shareOpen])

  // No registration for this collection, or the record has no token value yet
  // (unsaved / blank human id) — nothing sensible to open or share.
  if (!type || !token) return null
  const room = `${type.prefix}:${token}`
  const discussable = canOpenChatRoom()

  return (
    <div ref={rootRef} className='relative'>
      <button
        type='button'
        onClick={() => {
          if (discussable && !menuOpen) {
            setMenuOpen(true)
          } else {
            setMenuOpen((o) => !o)
          }
        }}
        title='Chat about this record'
        className='inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-600 hover:bg-muted dark:border-border dark:bg-card dark:text-slate-300'
        data-record-chat
      >
        <MessageSquare className='h-3.5 w-3.5' strokeWidth={2} />
        Chat
      </button>
      {menuOpen && !shareOpen && (
        <div className='absolute right-0 top-full z-30 mt-1 w-[190px] overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-border dark:bg-card'>
          {discussable && (
            <button
              type='button'
              onClick={() => {
                setMenuOpen(false)
                openChatRoom(room, token)
              }}
              className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
            >
              <MessageSquare className='h-3.5 w-3.5' /> Discuss this record
            </button>
          )}
          <button
            type='button'
            onClick={() => setShareOpen(true)}
            className='flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-slate-600 hover:bg-muted dark:text-slate-300'
          >
            <Send className='h-3.5 w-3.5' /> Send to a room…
          </button>
        </div>
      )}
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
