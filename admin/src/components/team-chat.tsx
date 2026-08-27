import { createNivaro } from '@nivaro/sdk'
import {
  ChatPanel,
  ChatProvider,
  ItemEditAuthContext,
  NivaroProvider,
  useChatRooms,
  useUnreadChirp,
  registerDmOpener,
  registerRoomOpener
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { MessagesSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { usePresenceLive, setTypingRoom, useOnlineUsers, usePresenceHeartbeat } from '@/lib/chat-presence'
import { onCollectionUpdate, subscribeChatRooms } from '@/lib/socket'

/**
 * Admin host for the shared @nivaro/shared chat surface. `AdminChatProvider`
 * supplies the provider trio (NivaroProvider + ItemEditAuthContext +
 * ChatProvider) the chat components consume — the Chat page reuses it, so both
 * surfaces share one react-query cache and one socket. `TeamChatDock` is the
 * always-mounted sidebar entry point: the rail button with the unread badge,
 * the slide-over ChatPanel, the presence heartbeat and the unread chirp.
 */

const client = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

export interface ChatRoomType {
  id: number
  prefix: string
  collection: string
  match_field: string
  label: string | null
  is_active: boolean
}

export function useChatRoomTypes() {
  return useQuery({
    queryKey: ['admin-chat-room-types'],
    queryFn: () =>
      api.get<{ data: ChatRoomType[] }>('/chat/room-types').then((r) => r.data.data ?? []),
    staleTime: 5 * 60_000
  })
}

export function AdminChatProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { users } = useOnlineUsers()
  const { data: roomTypes } = useChatRoomTypes()

  const me = useMemo(
    () =>
      user
        ? {
            id: user.id,
            name: [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || 'Me'
          }
        : null,
    [user]
  )

  // Entity ids in messages become links into the collection browser. The
  // target collection comes from the entity-room registry rather than
  // hardcoding: tokens carrying the legacy `…INV-` marker route to an
  // inventory-flavored room type when one is registered, everything else to
  // the first non-inventory type. No registry → plain text.
  const entityUrl = useCallback(
    (token: string) => {
      const active = (roomTypes ?? []).filter((t) => t.is_active)
      if (active.length === 0) return null
      const isInv = /INV-/i.test(token)
      const pick =
        (isInv
          ? active.find((t) => /inventory/i.test(t.collection))
          : active.find((t) => !/inventory/i.test(t.collection))) ?? active[0]
      return `/collections/${pick.collection}?search=${encodeURIComponent(token)}`
    },
    [roomTypes]
  )

  const authValue = useMemo(
    () => ({ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }),
    [user]
  )

  return (
    <NivaroProvider client={client}>
      <ItemEditAuthContext.Provider value={authValue}>
        <ChatProvider
          me={me}
          onlineUsers={users}
          realtime={onCollectionUpdate}
          subscribeRooms={subscribeChatRooms}
          setTypingRoom={setTypingRoom}
          navigate={(url) => navigate(url)}
          entityUrl={entityUrl}
          recordUrl={(collection, id) => `/collections/${collection}/${id}`}
          // Admin owns the replay page — deep-link straight to the recording.
          sessionUrl={(recordingId) => `/session-replays?recording=${recordingId}`}
        >
          {children}
        </ChatProvider>
      </ItemEditAuthContext.Provider>
    </NivaroProvider>
  )
}

function DockInner() {
  usePresenceHeartbeat()
  usePresenceLive()
  const [open, setOpen] = useState(false)
  const [requestedDm, setRequestedDm] = useState<{
    userId: string
    name?: string
    nonce: number
  } | null>(null)
  const { totalUnread, rooms } = useChatRooms()
  useUnreadChirp(totalUnread, rooms)
  // Online-people bubble (Rob): who's around, before opening the panel.
  // Same query the panel's Online tab uses — react-query dedupes them.
  const { user: dockUser } = useAuth()
  const { users: onlineUsers } = useOnlineUsers()
  const othersOnline = onlineUsers.filter(
    (u) => String(u.user_id).toUpperCase() !== String(dockUser?.id ?? '').toUpperCase()
  ).length

  // UserChip "Send message" → open the slide-over on that DM. The dock is
  // mounted app-wide, so the action works from any page.
  useEffect(
    () =>
      registerDmOpener((userId, name) => {
        setRequestedDm((prev) => ({ userId, name, nonce: (prev?.nonce ?? 0) + 1 }))
        setOpen(true)
      }),
    []
  )

  // A new-message toast opens the conversation it is about: the dock slides
  // out and lands on that room, whichever kind it is.
  const [requestedRoom, setRequestedRoom] = useState<{
    room: string
    label?: string
    nonce: number
  } | null>(null)
  useEffect(
    () =>
      registerRoomOpener((room, label) => {
        setRequestedRoom((prev) => ({ room, label, nonce: (prev?.nonce ?? 0) + 1 }))
        setOpen(true)
      }),
    []
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type='button'
            aria-label='Team chat'
            onClick={() => setOpen(true)}
            className='relative flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white'
          >
            <span className='relative flex'>
              <MessagesSquare className='h-[15px] w-[15px] shrink-0' />
              {totalUnread > 0 && (
                <span className='absolute -right-1.5 -top-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-nvr-cyan px-1 text-[9px] font-bold leading-none text-white'>
                  {totalUnread > 99 ? '99+' : totalUnread}
                </span>
              )}
              {othersOnline > 0 && (
                <span className='absolute -bottom-1.5 -right-1.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-emerald-500 px-0.5 text-[8px] font-bold leading-none text-white'>
                  {othersOnline > 99 ? '99+' : othersOnline}
                </span>
              )}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side='right' sideOffset={8}>
          Team chat
          {totalUnread > 0 && ` · ${totalUnread} unread`}
          {othersOnline > 0 && ` · ${othersOnline} online`}
        </TooltipContent>
      </Tooltip>
      <ChatPanel
        open={open}
        onClose={() => setOpen(false)}
        requestedDm={requestedDm}
        requestedRoom={requestedRoom}
      />
    </>
  )
}

export function TeamChatDock() {
  return (
    <AdminChatProvider>
      <DockInner />
    </AdminChatProvider>
  )
}
