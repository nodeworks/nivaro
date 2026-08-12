import {
  type ChannelMeta,
  ChatChannelBrowser,
  ChatChannelSettings,
  type ChatOnlineUser,
  ChatRoomList,
  ChatRoomView,
  chatAvatarColor,
  chatInitials,
  dmRoom,
  useChatConfig,
  useChatRooms
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, MessageCircle, MessagesSquare, Settings2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import { AdminChatProvider, type ChatRoomType, useChatRoomTypes } from '@/components/team-chat'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn } from '@/lib/utils'

/**
 * Full-page chat workspace — the same shared components the slide-over panel
 * uses (rooms, DMs, channel browse/create, settings, mentions, typing,
 * receipts), laid out master-detail, plus the admin-only entity-room registry.
 * Deep link: /chat?room=<key>.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type ActiveRoom = { room: string; label: string; channel?: ChannelMeta | null }

function OnlineList({ onOpenDm }: { onOpenDm: (u: ChatOnlineUser) => void }) {
  const cfg = useChatConfig()
  const users = cfg.onlineUsers
  if (users.length === 0) {
    return (
      <p className='px-3 py-8 text-center text-[12px] text-slate-400'>
        No one else is online right now.
      </p>
    )
  }
  return (
    <div className='p-2'>
      {users.map((u) => {
        const role = u.role_name?.trim()
        const subtitle =
          [role && !UUID_RE.test(role) ? role : null, u.current_path].filter(Boolean).join(' · ') ||
          'Online'
        return (
          <button
            key={u.user_id}
            type='button'
            onClick={() => onOpenDm(u)}
            title='Send a direct message'
            className='flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
          >
            <span className='relative'>
              <span
                className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-[#04263b]'
                style={{ backgroundColor: chatAvatarColor(u.user_id) }}
                aria-hidden
              >
                {chatInitials(u.display_name)}
              </span>
              <span className='absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-400 dark:border-card' />
            </span>
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                {u.display_name ?? 'Unknown user'}
              </span>
              <span className='block truncate text-[11px] text-slate-400'>{subtitle}</span>
            </span>
            <MessageCircle className='h-4 w-4 shrink-0 text-slate-300' strokeWidth={1.8} />
          </button>
        )
      })}
    </div>
  )
}

function CollectionCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const { data: collections } = useQuery({
    queryKey: ['chat-rt-collections'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections')
        .then((r) => r.data.data ?? [])
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          className='h-8 w-full justify-between px-2 text-[12.5px] font-normal'
        >
          {value || 'Pick a collection…'}
          <ChevronsUpDown className='h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' />
          <CommandList>
            <CommandEmpty>No collection found.</CommandEmpty>
            <CommandGroup>
              {(collections ?? []).map((c) => (
                <CommandItem
                  key={c.collection}
                  value={c.collection}
                  onSelect={() => {
                    onChange(c.collection)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      value === c.collection ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {c.collection}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Entity-room registry (admin only). A row here is what turns a room key like
 * `wf:CR26-76773` into "the chat room of that record" — visibility derives
 * from whether the viewer can read the record, so an unregistered prefix
 * fails closed.
 */
function RoomTypesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const { data: types } = useChatRoomTypes()
  const [prefix, setPrefix] = useState('')
  const [collection, setCollection] = useState('')
  const [matchField, setMatchField] = useState('')
  const [label, setLabel] = useState('')

  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-chat-room-types'] })

  const create = useMutation({
    mutationFn: () =>
      api.post('/chat/room-types', {
        prefix: prefix.trim(),
        collection,
        match_field: matchField.trim() || 'id',
        label: label.trim() || null
      }),
    onSuccess: () => {
      toast.success('Room type registered')
      setPrefix('')
      setCollection('')
      setMatchField('')
      setLabel('')
      refresh()
    },
    onError: (err) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to register room type'
      toast.error(msg)
    }
  })

  const toggle = useMutation({
    mutationFn: (t: ChatRoomType) =>
      api.patch(`/chat/room-types/${t.id}`, { is_active: !t.is_active }),
    onSuccess: refresh,
    onError: () => toast.error('Failed to update room type')
  })

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className='flex w-[420px] flex-col gap-0 p-0 sm:max-w-[420px]'>
        <SheetHeader className='border-b border-slate-100 px-5 py-4 dark:border-border'>
          <SheetTitle className='text-[15px]'>Record room types</SheetTitle>
          <SheetDescription className='text-[12px]'>
            Registered prefixes turn a room key like{' '}
            <code className='rounded bg-slate-100 px-1 text-[11px] dark:bg-muted'>
              wf:&lt;record id&gt;
            </code>{' '}
            into that record's chat room. Visibility follows record read access — unregistered
            prefixes are invisible to everyone.
          </SheetDescription>
        </SheetHeader>

        <div className='min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4'>
          <div>
            {(types ?? []).length === 0 ? (
              <p className='py-4 text-center text-[12px] text-slate-400'>
                No room types registered yet.
              </p>
            ) : (
              <div className='overflow-hidden rounded-lg border border-slate-200 dark:border-border'>
                {(types ?? []).map((t, i) => (
                  <div
                    key={t.id}
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5',
                      i > 0 && 'border-t border-slate-100 dark:border-border/60'
                    )}
                  >
                    <code className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-muted dark:text-slate-300'>
                      {t.prefix}:
                    </code>
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
                        {t.label || t.collection}
                      </p>
                      <p className='truncate text-[11px] text-slate-400'>
                        {t.collection} · matches {t.match_field}
                      </p>
                    </div>
                    <Switch
                      checked={t.is_active}
                      onCheckedChange={() => toggle.mutate(t)}
                      aria-label={t.is_active ? 'Deactivate' : 'Activate'}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className='space-y-2.5 rounded-lg border border-slate-200 p-3 dark:border-border'>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>
              Register a room type
            </p>
            <div className='grid grid-cols-2 gap-2'>
              <label className='block' htmlFor='rt-prefix'>
                <span className='mb-1 block text-[11px] font-medium text-slate-400'>Prefix</span>
                <Input
                  id='rt-prefix'
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder='wf'
                  className='h-8 text-[12.5px]'
                />
              </label>
              <label className='block' htmlFor='rt-match-field'>
                <span className='mb-1 block text-[11px] font-medium text-slate-400'>
                  Match field
                </span>
                <Input
                  id='rt-match-field'
                  value={matchField}
                  onChange={(e) => setMatchField(e.target.value)}
                  placeholder='id'
                  className='h-8 text-[12.5px]'
                />
              </label>
            </div>
            <div>
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>Collection</span>
              <CollectionCombobox value={collection} onChange={setCollection} />
            </div>
            <label className='block' htmlFor='rt-label'>
              <span className='mb-1 block text-[11px] font-medium text-slate-400'>Label</span>
              <Input
                id='rt-label'
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder='Workflows'
                className='h-8 text-[12.5px]'
              />
            </label>
            <Button
              size='sm'
              className='h-8'
              disabled={!prefix.trim() || !collection || create.isPending}
              onClick={() => create.mutate()}
            >
              Register
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ChatWorkspace() {
  const cfg = useChatConfig()
  const { user } = useAuth()
  const { rooms, totalUnread } = useChatRooms()
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<'rooms' | 'browse' | 'online'>('rooms')
  const [active, setActive] = useState<ActiveRoom | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [typesOpen, setTypesOpen] = useState(false)

  // Deep link: apply ?room= once the room list has resolved (labels/channel
  // meta come from it). An unknown key still opens — entity rooms you've
  // never joined are valid targets.
  const appliedRef = useRef(false)
  useEffect(() => {
    if (appliedRef.current || active) return
    const key = searchParams.get('room')
    if (!key) {
      appliedRef.current = true
      return
    }
    const known = rooms.find((r) => r.room === key)
    if (known) {
      appliedRef.current = true
      setActive({ room: known.room, label: known.label, channel: known.channel })
    } else if (rooms.length > 0) {
      appliedRef.current = true
      setActive({ room: key, label: cfg.roomLabel?.(key) ?? key.toUpperCase() })
    }
  }, [rooms, searchParams, active, cfg])

  const openRoom = (next: ActiveRoom) => {
    setSettingsOpen(false)
    setActive(next)
    searchParams.set('room', next.room)
    setSearchParams(searchParams, { replace: true })
  }

  const openDm = (u: ChatOnlineUser) => {
    if (!cfg.me) return
    openRoom({ room: dmRoom(cfg.me.id, u.user_id), label: u.display_name ?? 'Direct message' })
  }

  const tabs = useMemo(
    () =>
      [
        ['rooms', totalUnread > 0 ? `Rooms · ${totalUnread}` : 'Rooms'],
        ['browse', 'Browse'],
        ['online', `Online · ${cfg.onlineUsers.length}`]
      ] as const,
    [totalUnread, cfg.onlineUsers.length]
  )

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-3 dark:border-border dark:bg-card'>
        <div className='min-w-0'>
          <h1 className='truncate text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            Team Chat
          </h1>
          <p className='truncate text-[12px] text-slate-500'>
            Channels, direct messages and record rooms — visibility enforced per room.
          </p>
        </div>
        {user?.is_admin && (
          <Button
            variant='outline'
            size='sm'
            className='h-8 gap-1.5 text-[12.5px]'
            onClick={() => setTypesOpen(true)}
          >
            <Settings2 className='h-3.5 w-3.5' />
            Record rooms
          </Button>
        )}
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex shrink-0 gap-0.5 border-b border-slate-100 p-2 dark:border-border/60'>
            {tabs.map(([key, label]) => (
              <button
                key={key}
                type='button'
                onClick={() => setTab(key)}
                className={cn(
                  'rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors',
                  tab === key
                    ? 'bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                    : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className='flex min-h-0 flex-1 flex-col overflow-y-auto'>
            {tab === 'rooms' ? (
              <ChatRoomList
                rooms={rooms}
                onOpen={(r) => openRoom({ room: r.room, label: r.label, channel: r.channel })}
              />
            ) : tab === 'browse' ? (
              <ChatChannelBrowser
                onOpen={(room, label, channel) => openRoom({ room, label, channel })}
              />
            ) : (
              <OnlineList onOpenDm={openDm} />
            )}
          </div>
        </aside>

        <section className='flex min-w-0 flex-1 flex-col bg-white dark:bg-card'>
          {active && settingsOpen && active.channel ? (
            <ChatChannelSettings
              channel={active.channel}
              label={active.label}
              onBack={() => setSettingsOpen(false)}
            />
          ) : active ? (
            <ChatRoomView
              key={active.room}
              room={active.room}
              label={active.label}
              onBack={() => {
                setActive(null)
                searchParams.delete('room')
                setSearchParams(searchParams, { replace: true })
              }}
              onOpenSettings={active.channel ? () => setSettingsOpen(true) : undefined}
            />
          ) : (
            <div className='flex flex-1 flex-col items-center justify-center gap-2 text-center'>
              <MessagesSquare className='h-8 w-8 text-slate-300' strokeWidth={1.5} />
              <p className='text-[13px] font-medium text-slate-500'>Pick a conversation</p>
              <p className='max-w-[280px] text-[12px] text-slate-400'>
                Open a room on the left, browse channels to join one, or start a direct message from
                the Online tab.
              </p>
            </div>
          )}
        </section>
      </div>

      <RoomTypesSheet open={typesOpen} onClose={() => setTypesOpen(false)} />
    </div>
  )
}

export function ChatPage() {
  return (
    <AdminChatProvider>
      <ChatWorkspace />
    </AdminChatProvider>
  )
}
