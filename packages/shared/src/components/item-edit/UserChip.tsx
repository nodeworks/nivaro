import { useQuery } from '@tanstack/react-query'
import {
  Building2,
  Clock,
  ExternalLink,
  Mail,
  MessageCircle,
  Phone,
  User,
  UserCheck
} from 'lucide-react'
import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useItemEditAuth, useNavigation, useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { userCardQuery } from '../../lib/user-cards'
import { cn } from '../../lib/utils'
import { canOpenDm, openDmWith } from '../chat/chat-core'
import { HuddlePresenceLine } from '../chat/huddle/HuddleLiveBadge'
import { useHuddleLive } from '../chat/huddle/huddle-live'
import { MailSuppressedPill } from '../profile/MailSuppressedPill'
import { useCardPresence } from '../profile/usePersonPresence'
import { UserAvatar } from '../UserAvatar'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

// The person chip, its contact card and the owner rosters. Their own module
// (not GroupSection) so a screen that only shows people — chat, lists, the
// read view — does not load the whole form renderer with them.

/**
 * Close a floating user card/roster the moment the person looks elsewhere.
 * Two gaps the Radix dismiss layer leaves: it listens for the outside press
 * in the BUBBLE phase, so any grid/editor that stops pointerdown propagation
 * (resize handles, map layers, forecast cells…) swallowed the click; and a
 * press in an iframe, devtools or another window never reaches the document
 * at all — only a window blur says focus left. Capture phase + blur cover both.
 * `inside(target)` = the press belongs to the card (or its own trigger, which
 * toggles it itself).
 */
function useDismissOnOutside(
  active: boolean,
  inside: (target: Element) => boolean,
  close: () => void
) {
  const insideRef = useRef(inside)
  insideRef.current = inside
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null
      if (t && insideRef.current(t)) return
      closeRef.current()
    }
    const onBlur = () => closeRef.current()
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [active])
}

// Compact owners — no label, tiny inline style, used inside SummaryStrip
/** Stacked avatar cluster (+N) with a hover/pinnable portal roster whose rows
 *  are UserChips — the single user-display primitive for owners/user lists.
 *  Reused by the item-header Owners chip and the collection browser. */
export function UserRosterCluster({
  users,
  showSingleName = true
}: {
  users: Array<{ id: string; name: string }>
  showSingleName?: boolean
}) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState<null | 'hover' | 'pin'>(null)
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const show = (mode: 'hover' | 'pin') => {
    cancelClose()
    const r = anchorRef.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left, y: r.bottom + 6 })
    setOpen((prev) => (prev === 'pin' ? 'pin' : mode))
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen((prev) => (prev === 'pin' ? prev : null)), 160)
  }
  // Clamp the portal panel to the viewport (a cluster near the right edge
  // would otherwise open past it).
  React.useLayoutEffect(() => {
    if (!open) return
    const el = panelRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let { x, y } = pos
    if (r.right > window.innerWidth - 8) x = Math.max(8, window.innerWidth - r.width - 8)
    if (r.bottom > window.innerHeight - 8) {
      const a = anchorRef.current?.getBoundingClientRect()
      y = Math.max(8, (a?.top ?? y) - r.height - 6)
    }
    if (x !== pos.x || y !== pos.y) setPos({ x, y })
  }, [open, pos])
  useDismissOnOutside(
    !!open,
    (t) =>
      // Clicks inside the user-card popover (portaled by Radix) keep the
      // roster mounted — closing would unmount the card mid-click.
      !!t.closest?.('[data-radix-popper-content-wrapper]') ||
      !!panelRef.current?.contains(t) ||
      !!anchorRef.current?.contains(t),
    () => setOpen(null)
  )
  const initials = (n: string) =>
    n
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  if (users.length === 0)
    return (
      <span className='text-[11px] text-slate-400' data-roster-empty>
        —
      </span>
    )
  const shown = users.slice(0, 4)
  const extra = users.length - shown.length
  // NOTE: solid tint hex, never bg-nvr-cyan/N — the opacity modifier is a
  // silent no-op on the opaque nvr-cyan var (documented gotcha).
  const avatarCls =
    'flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-[#c7f0fb] text-[10px] font-bold leading-none text-[#04516b] dark:border-slate-900 dark:bg-[#0c3b4a] dark:text-[#7dd8f2]'
  return (
    <span
      ref={anchorRef}
      onMouseEnter={() => show('hover')}
      onMouseLeave={scheduleClose}
      onClick={(e) => {
        e.stopPropagation()
        show('pin')
      }}
      className='inline-flex cursor-pointer items-center'
    >
      <span className='flex -space-x-2'>
        {shown.map((o) => (
          <UserAvatar
            key={o.id}
            userId={o.id}
            className='h-6 w-6 border-2 border-white dark:border-slate-900'
            fallback={
              <span data-copy-skip aria-hidden='true' className={avatarCls}>
                {initials(o.name)}
              </span>
            }
          />
        ))}
      </span>
      {extra > 0 && (
        <span className='ml-1 rounded-full bg-slate-200 px-1.5 py-0.5 text-[10.5px] font-bold leading-none text-slate-600 dark:bg-slate-700 dark:text-slate-300'>
          +{extra}
        </span>
      )}
      {showSingleName && users.length === 1 && (
        <span className='ml-1.5 max-w-[130px] truncate text-[12px] font-medium text-slate-700 dark:text-slate-200'>
          {users[0].name}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={rosterPortalStyle(anchorRef.current, pos)}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            onMouseDown={(e) => {
              e.stopPropagation()
              setOpen('pin')
            }}
            onClick={(e) => e.stopPropagation()}
            className='w-max min-w-[190px] max-w-[300px] rounded-lg border border-slate-200 bg-white py-1.5 shadow-xl dark:border-slate-600 dark:bg-slate-800'
          >
            <p className='px-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400'>
              {users.length} user{users.length === 1 ? '' : 's'}
            </p>
            {/* Same UserChip as the Creator header field — click opens the
                full user card popover. */}
            {users.map((o) => (
              <div key={o.id} className='px-2 py-0.5'>
                <UserChip userId={o.id} size='compact' />
              </div>
            ))}
          </div>,
          rosterPortalContainer(anchorRef.current)
        )}
    </span>
  )
}

// Inside a modal Radix Sheet/Dialog, body-level portals inherit the modal
// lock's pointer-events:none — the roster would render but be dead to the
// mouse (same trap DropPanel documents). Portal into the dialog CONTENT
// element instead; it is also the transform ancestor, so coords convert from
// viewport space to content-relative absolute positioning.
function rosterPortalContainer(anchor: HTMLElement | null): HTMLElement {
  return (anchor?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body
}

function rosterPortalStyle(
  anchor: HTMLElement | null,
  pos: { x: number; y: number }
): React.CSSProperties {
  const container = rosterPortalContainer(anchor)
  if (container === document.body) return { position: 'fixed', left: pos.x, top: pos.y, zIndex: 50 }
  const c = container.getBoundingClientRect()
  return { position: 'absolute', left: pos.x - c.left, top: pos.y - c.top, zIndex: 120 }
}

export function OwnersInlineCompact({
  collection,
  itemId
}: {
  collection: string
  itemId: string
}) {
  const client = useOptionalNivaroClient()
  // RESOLVED owners for the record's current state (owner groups + manual
  // adds + delegation) — the per-item /owners endpoint only returns raw
  // manually-assigned rows, which is usually empty.
  const { data: owners = [], isLoading } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['pipeline-owners-resolved', collection, itemId],
    queryFn: () =>
      client!
        .request<{ data: Record<string, Array<{ id: string; name: string }>> }>(
          post(`/pipelines/instance/${collection}/owners/batch`, { ids: [itemId] })
        )
        .then((r) => r.data?.[itemId] ?? []),
    enabled: !!client && !!collection && !!itemId && itemId !== 'new',
    staleTime: 30_000
  })
  if (isLoading)
    return (
      <span className='animate-pulse h-3 w-20 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))] inline-block' />
    )
  return <UserRosterCluster users={owners} />
}

// Inline owners display — renders pipeline state owners as avatar chips, no panel wrapper
export function OwnersInline({
  collection,
  itemId,
  label
}: {
  collection: string
  itemId: string
  label: string
}) {
  const client = useOptionalNivaroClient()
  const { data: owners = [] } = useQuery<
    Array<{
      id: number
      state: string | null
      first_name: string | null
      last_name: string | null
      email: string
    }>
  >({
    queryKey: ['pipeline-instance-owners', collection, itemId],
    queryFn: () =>
      client!
        .request<{
          data: Array<{
            id: number
            state: string | null
            first_name: string | null
            last_name: string | null
            email: string
          }>
        }>(get(`/pipelines/instance/${collection}/${itemId}/owners`))
        .then((r) => r.data ?? []),
    enabled: !!client && !!collection && !!itemId && itemId !== 'new',
    staleTime: 30_000
  })
  const name = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
  const initials = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    name(o)
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  return (
    <div>
      <p className='text-[11px] font-medium text-slate-400 mb-1.5'>{label}</p>
      {owners.length === 0 ? (
        <p className='text-[13px] text-slate-400'>—</p>
      ) : (
        <div className='flex flex-wrap gap-2'>
          {owners.map((o) => (
            <div
              key={o.id}
              className='flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5'
            >
              <UserAvatar
                userId={o.id}
                className='h-6 w-6'
                fallback={
                  <span className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                    {initials(o)}
                  </span>
                }
              />
              <span className='text-[12px] text-slate-700'>{name(o)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Single user chip — fetches user by id, shows initials avatar + contact card on click
interface UserCardData {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  title?: string | null
  phone?: string | null
  department?: string | null
  status?: string | null
  last_access?: string | null
  is_out_of_office?: boolean
  role_name?: string | null
  manager_name?: string | null
  manager_id?: string | null
  timezone?: string | null
}

function UserCardPopover({
  user,
  userId,
  initials,
  navigate,
  profileUrl,
  online,
  cardId,
  onAction,
  open = false
}: {
  cardId?: string
  user: UserCardData | null | undefined
  userId: string
  initials: string
  navigate: (path: string) => void
  /** Host-aware profile route; null hides the View-profile action. */
  profileUrl: string | null
  online?: boolean
  /** Close the hosting popover — every footer action calls it. */
  onAction?: () => void
  /** Whether the card is showing — lazy reads (the bounce mark) wait for it. */
  open?: boolean
}) {
  const { isAdmin } = useItemEditAuth()
  // #1982 — active, idle or away and the page they are on, under the Online list's rules.
  const live = useCardPresence(userId, open)
  // #2851 — only when the viewer can see that room (the server filters the list).
  const inHuddle = useHuddleLive().roomOf(userId)
  const managerName = user?.manager_name?.trim() || null
  // Local-time chip (#175): "6:12 PM for Jane" — only when their timezone pref
  // is set AND differs from the viewer's, so same-office teams see no noise.
  const localTime = (() => {
    const tz = user?.timezone
    if (!tz) return null
    try {
      const viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz === viewerTz) return null
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: tz
      }).format(new Date())
    } catch {
      return null
    }
  })()
  const lastSeen = user?.last_access
    ? (() => {
        const diff = Date.now() - new Date(user.last_access).getTime()
        const mins = Math.floor(diff / 60_000)
        if (mins < 2) return 'Just now'
        if (mins < 60) return `${mins}m ago`
        const hrs = Math.floor(mins / 60)
        if (hrs < 24) return `${hrs}h ago`
        return `${Math.floor(hrs / 24)}d ago`
      })()
    : null

  return (
    <PopoverContent
      align='start'
      className='w-72 p-0 overflow-hidden'
      data-nvr-user-card={cardId ?? ''}
    >
      {/* Header */}
      <div className='flex items-center gap-3 p-4 bg-gradient-to-br from-nvr-cyan/8 to-nvr-cyan/4 dark:from-nvr-cyan/10 dark:to-transparent border-b border-slate-100 dark:border-border'>
        <UserAvatar
          userId={userId}
          className='h-12 w-12 ring-2 ring-white shadow-sm dark:ring-card'
          fallback={
            <span className='flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[15px] font-bold text-nvr-navy dark:text-nvr-cyan ring-2 ring-white dark:ring-card shadow-sm'>
              {initials}
            </span>
          }
        />
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1.5'>
            {(online || live.word) && (
              <span
                data-card-presence={live.word ?? 'online'}
                className={cn(
                  'h-2 w-2 shrink-0 rounded-full ring-2 ring-white dark:ring-card',
                  live.word === 'away'
                    ? 'bg-white ring-amber-400 dark:bg-card'
                    : live.word === 'idle'
                      ? 'bg-amber-400'
                      : 'bg-emerald-400'
                )}
                title={live.word === 'away' ? 'Away' : live.word === 'idle' ? 'Idle' : 'Online'}
              />
            )}
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate'>
              {user
                ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
                : userId}
            </p>
            {user?.status && user.status !== 'active' && (
              <span
                className={`inline-flex items-center rounded-full px-1.5 py-px text-[10px] font-medium ${user.status === 'suspended' ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400'}`}
              >
                {user.status}
              </span>
            )}
          </div>
          {(user?.title || user?.department) && (
            <p className='text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5'>
              {[user.title, user.department].filter(Boolean).join(' · ')}
            </p>
          )}
          {live.word && (
            <p
              className='mt-0.5 truncate text-[11px] text-slate-500 dark:text-slate-400'
              data-card-presence-line
            >
              {live.word === 'away'
                ? 'Away'
                : live.word === 'idle'
                  ? `Idle${live.minutes ? ` · ${live.minutes}m` : ''}`
                  : 'Online now'}
              {live.page ? ` · on ${live.page}` : ''}
            </p>
          )}
          <HuddlePresenceLine label={inHuddle?.label ?? null} className='mt-0.5' />
          {localTime && (
            <p className='mt-0.5 text-[11px] text-slate-500 dark:text-slate-400'>
              Local time: {localTime}
            </p>
          )}
          {user?.is_out_of_office && (
            <span className='mt-1 inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/30 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:text-amber-400'>
              <UserCheck className='h-2.5 w-2.5' /> Out of office
            </span>
          )}
          <MailSuppressedPill
            email={user?.email}
            enabled={open}
            canClear={isAdmin}
            className='mt-1'
          />
        </div>
      </div>

      {/* Contact */}
      {(user?.email || user?.phone) && (
        <div className='px-4 py-3 space-y-1.5 border-b border-slate-100 dark:border-border'>
          {user?.email && (
            <a
              href={`mailto:${user.email}`}
              className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300 hover:text-nvr-navy dark:hover:text-nvr-cyan transition-colors truncate group'
            >
              <Mail className='h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-nvr-cyan transition-colors' />
              <span className='truncate'>{user.email}</span>
            </a>
          )}
          {user?.phone && (
            <a
              href={`tel:${user.phone}`}
              className='flex items-center gap-2 text-[12px] text-slate-600 dark:text-slate-300 hover:text-nvr-navy dark:hover:text-nvr-cyan transition-colors group'
            >
              <Phone className='h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-nvr-cyan transition-colors' />
              <span>{user.phone}</span>
            </a>
          )}
        </div>
      )}

      {/* Meta */}
      {(user?.role_name || managerName || lastSeen) && (
        <div className='px-4 py-3 space-y-1.5 border-b border-slate-100 dark:border-border'>
          {user?.role_name && (
            <div className='flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
              <Building2 className='h-3.5 w-3.5 shrink-0' />
              <span>{user.role_name}</span>
            </div>
          )}
          {managerName && (
            <div className='flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400'>
              <User className='h-3.5 w-3.5 shrink-0' />
              <span>
                Reports to{' '}
                <span className='font-medium text-slate-600 dark:text-slate-300'>
                  {managerName}
                </span>
              </span>
            </div>
          )}
          {lastSeen && (
            <div className='flex items-center gap-2 text-[11px] text-slate-400'>
              <Clock className='h-3.5 w-3.5 shrink-0' />
              <span>Last seen {lastSeen}</span>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      <div className='flex items-center gap-1 p-2'>
        {profileUrl && (
          <button
            type='button'
            onClick={() => {
              onAction?.()
              navigate(profileUrl)
            }}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
          >
            <User className='h-3.5 w-3.5' /> View profile
          </button>
        )}
        {canOpenDm() && (
          <button
            type='button'
            onClick={() => {
              onAction?.()
              openDmWith(
                userId,
                user
                  ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
                  : undefined
              )
            }}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
          >
            <MessageCircle className='h-3.5 w-3.5' /> Message
          </button>
        )}
        {user?.email && (
          <button
            type='button'
            onClick={() => {
              onAction?.()
              window.location.href = `mailto:${user.email}`
            }}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
          >
            <ExternalLink className='h-3.5 w-3.5' /> Email
          </button>
        )}
      </div>
    </PopoverContent>
  )
}

export function UserChip({
  userId,
  size = 'default',
  children
}: {
  userId: string
  size?: 'default' | 'compact'
  /** A custom trigger (e.g. a chat avatar) that opens the same user card. */
  children?: React.ReactElement
}) {
  const client = useOptionalNivaroClient()
  const { navigate, userUrl } = useNavigation()
  // Host-aware profile route: absent = admin's /users/:id, null = no page.
  const profileUrl = userUrl ? userUrl(userId) : `/users/${userId}`
  const [open, setOpen] = useState(false)
  // One id per chip instance: a press on ANOTHER chip's trigger must close
  // this card, a press on this chip's own trigger is Radix's toggle.
  const chipId = React.useId()
  useDismissOnOutside(
    open,
    (t) =>
      !!t.closest?.(`[data-nvr-user-card="${CSS.escape(chipId)}"]`) ||
      !!t.closest?.(`[data-nvr-user-chip="${CSS.escape(chipId)}"]`) ||
      // Anything else floating above the card (a tooltip, a nested menu).
      (!!t.closest?.('[data-radix-popper-content-wrapper]') &&
        !t.closest?.('[data-nvr-user-card]')),
    () => setOpen(false)
  )

  // Batched: every chip on a list joins one POST /users/cards (lib/user-cards).
  const { data: user, isLoading } = useQuery<UserCardData | null>({
    ...userCardQuery<UserCardData>(client, userId),
    enabled: !!client && !!userId,
    staleTime: 120_000
  })

  const { data: presenceData } = useQuery<{ online: boolean }>({
    queryKey: ['user-presence', userId],
    queryFn: () =>
      client!
        .request<{ online: boolean }>(get(`/presence/users/${userId}`))
        .then((r) => r as { online: boolean }),
    enabled: !!client && !!userId && open,
    staleTime: 15_000,
    refetchInterval: open ? 20_000 : false
  })

  const name = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
    : userId
  const initials = name
    .split(' ')
    .map((p: string) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  const online = presenceData?.online ?? false

  if (isLoading && !children) {
    return size === 'compact' ? (
      <span className='animate-pulse inline-block h-3.5 w-16 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
    ) : (
      <span className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5'>
        <span className='flex h-6 w-6 shrink-0 rounded-full animate-pulse bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
        <span className='animate-pulse h-2.5 w-16 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))] inline-block' />
      </span>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild data-nvr-user-chip={chipId}>
        {children ? (
          children
        ) : size === 'compact' ? (
          <span className='inline-flex cursor-pointer items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 py-px pl-px pr-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors'>
            <UserAvatar
              userId={userId}
              className='h-4 w-4'
              fallback={
                <span
                  data-copy-skip
                  aria-hidden='true'
                  className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[9px] font-bold text-nvr-navy dark:text-nvr-cyan'
                >
                  {initials}
                </span>
              }
            />
            <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
              {name}
            </span>
          </span>
        ) : (
          <div className='inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5 hover:bg-slate-100 dark:border-border dark:bg-card dark:hover:bg-accent transition-colors'>
            <UserAvatar
              userId={userId}
              className='h-6 w-6'
              fallback={
                <span
                  data-copy-skip
                  aria-hidden='true'
                  className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'
                >
                  {initials}
                </span>
              }
            />
            <span className='text-[12px] text-slate-700 dark:text-slate-300'>{name}</span>
          </div>
        )}
      </PopoverTrigger>
      <UserCardPopover
        user={user}
        userId={userId}
        initials={initials}
        navigate={navigate}
        profileUrl={profileUrl}
        online={online}
        cardId={chipId}
        onAction={() => setOpen(false)}
        open={open}
      />
    </Popover>
  )
}
