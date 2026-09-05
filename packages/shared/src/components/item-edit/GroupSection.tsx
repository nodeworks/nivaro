import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as LucideIcons from 'lucide-react'
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  Loader2,
  Mail,
  MessageCircle,
  Phone,
  User,
  UserCheck
} from 'lucide-react'
import React, { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  type FieldDrilldownConfig,
  fieldDrilldownConfig,
  useDrilldown,
  useNavigation,
  useOptionalNivaroClient
} from '../../context'
import { get, post } from '../../lib/commands'
import { choiceLabel, cn, titleCase } from '../../lib/utils'
import { canOpenDm, openDmWith } from '../chat/chat-core'
import { UserAvatar } from '../UserAvatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { type InputBinding, WidgetSlot } from '../WidgetSlot'
import { FieldRow } from './FieldRow'
import { applyDisplayTemplate, resolveColSpan, useContainerWidth } from './helpers'
import type {
  CMSField,
  CMSRelation,
  FieldGroup,
  RenderFieldProps,
  SlotAssignment,
  SummaryAggConfig,
  SummaryEntry
} from './types'

// ── Inline display ────────────────────────────────────────────────────────────

export type InlineDisplayEntry = {
  field: string
  label: string | null
  format: string | null
  line_break?: boolean
}

// input_bindings arrives as a JSON string from the layout API — parse like the
// header widget path does, or inputs resolve empty.
function parseBindings(raw: unknown): InputBinding[] {
  if (typeof raw !== 'string') return (raw ?? []) as InputBinding[]
  try {
    return JSON.parse(raw) as InputBinding[]
  } catch {
    return []
  }
}

export function InlineDisplay({
  relCollection,
  relId,
  entries,
  separator
}: {
  relCollection: string
  relId: string | number
  entries: InlineDisplayEntry[]
  separator?: string | null
}) {
  const client = useOptionalNivaroClient()
  const idStr = String(relId)
  // Dotted entry fields (e.g. 'project_type.name') resolve via the single-read
  // endpoint's nested expansion — request exactly the configured paths.
  const hasDotted = entries.some((e) => e.field.includes('.'))
  const fieldsParam = hasDotted ? ['id', ...entries.map((e) => e.field)].join(',') : null
  const { data: record } = useQuery<Record<string, unknown> | null>({
    queryKey: ['inline-display', relCollection, idStr, fieldsParam],
    queryFn: () =>
      client!
        .request<{ data: Record<string, unknown> }>(
          get(`/items/${relCollection}/${idStr}`, fieldsParam ? { fields: fieldsParam } : undefined)
        )
        .then((r) => r.data ?? null),
    enabled: !!client && !!idStr,
    staleTime: 60_000
  })
  if (!record) return null
  const valueOf = (path: string): unknown => {
    let cur: unknown = record
    for (const seg of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
    return cur
  }

  if (separator != null) {
    const resolveDisplay = (e: InlineDisplayEntry): string | null => {
      const val = valueOf(e.field)
      if (val === null || val === undefined || val === '') return null
      const fmt = e.format ?? 'text'
      if (fmt === 'date' || fmt === 'datetime') {
        try {
          return new Date(String(val)).toLocaleDateString()
        } catch {
          return String(val)
        }
      }
      if (fmt === 'boolean') return val ? 'Yes' : 'No'
      return String(val)
    }
    // Group entries into visual lines via line_break markers
    const lines: InlineDisplayEntry[][] = []
    let cur: InlineDisplayEntry[] = []
    for (const e of entries) {
      if (e.line_break && cur.length > 0) {
        lines.push(cur)
        cur = [e]
      } else cur.push(e)
    }
    if (cur.length > 0) lines.push(cur)
    type Token = { label: string | null; display: string }
    const renderedLines: Token[][] = lines
      .map(
        (line) =>
          line
            .map((e) => {
              const d = resolveDisplay(e)
              return d ? { label: e.label ?? null, display: d } : null
            })
            .filter(Boolean) as Token[]
      )
      .filter((l) => l.length > 0)
    if (renderedLines.length === 0) return null
    return (
      <div className='mt-1'>
        {renderedLines.map((tokens, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: stable line order
          <p key={i} className='text-[12px] text-slate-500 dark:text-slate-400'>
            {tokens.map((t, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable token order
              <React.Fragment key={j}>
                {j > 0 && separator}
                {t.label && (
                  <span className='font-semibold text-slate-600 dark:text-slate-300'>
                    {t.label}:
                  </span>
                )}
                {t.label ? ' ' : ''}
                {t.display}
              </React.Fragment>
            ))}
          </p>
        ))}
      </div>
    )
  }

  const rows = entries
    .map((e) => {
      const val = valueOf(e.field)
      if (val === null || val === undefined || val === '') return null
      const fmt = e.format ?? 'text'
      let display: string
      if (fmt === 'date' || fmt === 'datetime') {
        try {
          display = new Date(String(val)).toLocaleDateString()
        } catch {
          display = String(val)
        }
      } else if (fmt === 'boolean') {
        display = val ? 'Yes' : 'No'
      } else {
        display = String(val)
      }
      return { label: e.label, display }
    })
    .filter(Boolean) as Array<{ label: string | null; display: string }>
  if (rows.length === 0) return null
  return (
    <div className='mt-1 rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50 px-3 py-1.5 space-y-0.5'>
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable order from config
        <div key={i} className='flex items-baseline gap-2'>
          {row.label && (
            <span className='shrink-0 min-w-[56px] text-[10px] font-medium text-slate-400'>
              {row.label}
            </span>
          )}
          <span className='text-[12px] text-slate-700 dark:text-slate-300 truncate'>
            {row.display}
          </span>
        </div>
      ))}
    </div>
  )
}

function resolveIcon(name: string | null | undefined): React.ElementType | null {
  if (!name) return null
  const pascal = name.replace(/(^|-)([a-z])/g, (_, _sep, c: string) => c.toUpperCase())
  const icon = (LucideIcons as Record<string, unknown>)[pascal]
  return icon ? (icon as React.ElementType) : null
}

function parseFieldOpts(field: CMSField): Record<string, unknown> {
  if (!field.options) return {}
  if (typeof field.options === 'object') return field.options as Record<string, unknown>
  try {
    return JSON.parse(field.options as string) as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatDisplayValue(value: unknown, field?: CMSField): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  const iface = field?.interface ?? ''

  // Per-field display formats (#350): options.display_format overrides the
  // default rendering — 'currency', 'percent', a number precision ('0.00'),
  // or a compact date ('date'/'datetime').
  const df = (() => {
    try {
      const o = field?.options
        ? (JSON.parse(String(field.options)) as { display_format?: string })
        : null
      return o?.display_format ?? null
    } catch {
      return null
    }
  })()
  if (df) {
    const n = Number(value)
    if (df === 'currency' && Number.isFinite(n))
      return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
    if (df === 'percent' && Number.isFinite(n)) return `${(n * 100).toFixed(1)}%`
    if (/^0\.0+$/.test(df) && Number.isFinite(n)) return n.toFixed(df.length - 2)
    if (df === 'date' && typeof value === 'string') {
      const d = value.length === 10 ? new Date(`${value}T00:00:00`) : new Date(value)
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString()
    }
    if (df === 'datetime' && typeof value === 'string') {
      const d = new Date(value)
      if (!Number.isNaN(d.getTime())) return d.toLocaleString()
    }
  }

  // Structured interface displays (Field Types sprint)
  if (iface === 'duration' && Number.isFinite(Number(value))) {
    const mins = Number(value)
    return `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}`
  }
  if (iface === 'rating' && Number.isFinite(Number(value)))
    return `${'★'.repeat(Number(value))} (${value}/5)`
  if (iface === 'checklist' && typeof value === 'string') {
    try {
      const items = JSON.parse(value) as Array<{ done?: boolean }>
      if (Array.isArray(items)) return `${items.filter((x) => x?.done).length}/${items.length} done`
    } catch {
      /* fall through */
    }
  }
  if (iface === 'address' && typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const a = JSON.parse(value) as Record<string, string>
      return [a.street, a.city, a.state, a.zip].filter(Boolean).join(', ') || '—'
    } catch {
      /* fall through */
    }
  }

  // Boolean-like interfaces
  if (iface === 'toggle' || iface === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.length ? `${value.length} items` : '—'
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }

  const s = String(value)

  // ISO datetime → locale string. Date-only when the value carries no time,
  // or the field is configured date-only (options.date_mode: 'date').
  if (
    iface === 'datetime' ||
    iface === 'date' ||
    /^\d{4}-\d{2}-\d{2}T/.test(s) ||
    /^\d{4}-\d{2}-\d{2}$/.test(s)
  ) {
    try {
      let dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s) || iface === 'date'
      if (!dateOnly && field?.options) {
        try {
          const o = typeof field.options === 'string' ? JSON.parse(field.options) : field.options
          if (o && (o as Record<string, unknown>).date_mode === 'date') dateOnly = true
        } catch {
          /* noop */
        }
      }
      // Bare yyyy-mm-dd — and ISO strings at exactly UTC midnight, which is
      // how MSSQL `date` columns serialize — parse as UTC midnight; local
      // conversion would shift them a day (and first-of-month values a whole
      // MONTH) back. Render the stored calendar day from the string parts.
      const dm = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/)
      if (dm) {
        return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3])).toLocaleDateString()
      }
      return dateOnly ? new Date(s).toLocaleDateString() : new Date(s).toLocaleString()
    } catch {
      /* noop */
    }
  }

  // Select / radio: resolve choice label from options.choices
  if ((iface === 'select-dropdown' || iface === 'radio-buttons') && field) {
    const opts = parseFieldOpts(field)
    const choices = opts.choices as Array<{ text: string; value: string }> | undefined
    if (Array.isArray(choices)) {
      const match = choices.find((c) => String(c.value) === s)
      if (match) return choiceLabel(match.text)
    }
  }

  // Numeric formatting (options.format: 'int' | 'decimal' | 'currency')
  const num = Number(s)
  if (!Number.isNaN(num) && s !== '' && field) {
    const opts = parseFieldOpts(field)
    const fmt = opts.format as string | undefined
    // Unit declarations (#451): a field declares its unit ONCE
    // (options.unit: '$' | '%' | 'days' | 'hrs' | any suffix) and every render
    // formats consistently. '$' implies currency; '%' suffixes; anything else
    // is a plain suffix with a space.
    const unit = typeof opts.unit === 'string' ? opts.unit.trim() : ''
    if (unit && !fmt) {
      const n = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num)
      if (unit === '$') {
        try {
          return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
            num
          )
        } catch {
          return `$${n}`
        }
      }
      if (unit === '%') return `${n}%`
      return `${n} ${unit}`
    }
    if (fmt === 'currency') {
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: (opts.currency as string) || 'USD'
        }).format(num)
      } catch {
        /* noop */
      }
    }
    if (fmt === 'int') {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num)
    }
    if (fmt === 'decimal') {
      const precision = typeof opts.precision === 'number' ? opts.precision : 2
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision
      }).format(num)
    }
  }

  // Slug/enum-like value (no spaces, not a UUID, not purely numeric) → titleCase
  if (
    !s.includes(' ') &&
    !s.includes('@') &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) &&
    !/^\d+$/.test(s) &&
    (s.includes('_') || s.includes('-') || /^[a-z]/.test(s))
  ) {
    return titleCase(s)
  }

  return s
}

export { formatDisplayValue }

// Tiny inline user pill — used in SummaryStrip only
function SummaryUserName({ userId }: { userId: string }) {
  const client = useOptionalNivaroClient()
  const { navigate, userUrl } = useNavigation()
  // Host-aware profile route: absent = admin's /users/:id, null = no page.
  const profileUrl = userUrl ? userUrl(userId) : `/users/${userId}`
  const { data: user } = useQuery<{
    first_name: string | null
    last_name: string | null
    email: string
  } | null>({
    queryKey: ['user-chip', userId],
    queryFn: () =>
      client!
        .request<{ data: { first_name: string | null; last_name: string | null; email: string } }>(
          get(`/users/${userId}`)
        )
        .then((r) => r.data ?? null),
    enabled: !!client && !!userId,
    staleTime: 120_000
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
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <span className='inline-flex cursor-pointer items-center gap-1 rounded-full bg-slate-100 py-px pl-0.5 pr-2 hover:bg-slate-200 transition-colors'>
          <UserAvatar
            userId={userId}
            className='h-4 w-4'
            fallback={
              <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[9px] font-bold text-nvr-navy dark:text-nvr-cyan'>
                {initials}
              </span>
            }
          />
          <span className='text-[11px] text-slate-600'>{name}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='text-[12px]'>
        {profileUrl && (
          <DropdownMenuItem
            className='gap-2 text-[12px] cursor-pointer'
            onSelect={() => navigate(profileUrl)}
          >
            <User className='h-3.5 w-3.5' /> View profile
          </DropdownMenuItem>
        )}
        {user?.email && (
          <DropdownMenuItem
            className='gap-2 text-[12px] cursor-pointer'
            onSelect={() => {
              window.location.href = `mailto:${user.email}`
            }}
          >
            <Mail className='h-3.5 w-3.5' /> Send email
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
  React.useEffect(() => {
    if (open !== 'pin') return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      const el = t as HTMLElement
      // Clicks inside the user-card popover (portaled by Radix) keep the
      // roster mounted — closing would unmount the card mid-click.
      if (el.closest?.('[data-radix-popper-content-wrapper]')) return
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const initials = (n: string) =>
    n
      .split(' ')
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase()
  if (users.length === 0) return <span className='text-[11px] text-slate-400'>—</span>
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
  onAction
}: {
  user: UserCardData | null | undefined
  userId: string
  initials: string
  navigate: (path: string) => void
  /** Host-aware profile route; null hides the View-profile action. */
  profileUrl: string | null
  online?: boolean
  /** Close the hosting popover — every footer action calls it. */
  onAction?: () => void
}) {
  const managerName = user?.manager_name?.trim() || null
  // Local-time chip (#175): "6:12 PM for Beth" — only when their timezone pref
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
    <PopoverContent align='start' className='w-72 p-0 overflow-hidden'>
      {/* Header */}
      <div className='flex items-center gap-3 p-4 bg-gradient-to-br from-nvr-cyan/8 to-nvr-cyan/4 dark:from-nvr-cyan/10 dark:to-transparent border-b border-slate-100 dark:border-border'>
        <span className='flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[15px] font-bold text-nvr-navy dark:text-nvr-cyan ring-2 ring-white dark:ring-card shadow-sm'>
          {initials}
        </span>
        <div className='min-w-0 flex-1'>
          <div className='flex items-center gap-1.5'>
            {online && (
              <span
                className='h-2 w-2 rounded-full bg-emerald-400 shrink-0 ring-2 ring-white dark:ring-card'
                title='Online'
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
  size = 'default'
}: {
  userId: string
  size?: 'default' | 'compact'
}) {
  const client = useOptionalNivaroClient()
  const { navigate, userUrl } = useNavigation()
  // Host-aware profile route: absent = admin's /users/:id, null = no page.
  const profileUrl = userUrl ? userUrl(userId) : `/users/${userId}`
  const [open, setOpen] = useState(false)

  const { data: user, isLoading } = useQuery<UserCardData | null>({
    queryKey: ['user-card', userId],
    queryFn: () =>
      client!
        .request<{ data: UserCardData }>(get(`/users/${userId}/card`))
        .then((r) => r.data ?? null),
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

  if (isLoading) {
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
      <PopoverTrigger asChild>
        {size === 'compact' ? (
          <span className='inline-flex cursor-pointer items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 py-px pl-px pr-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors'>
            <span
              data-copy-skip
              aria-hidden='true'
              className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[9px] font-bold text-nvr-navy dark:text-nvr-cyan'
            >
              {initials}
            </span>
            <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>
              {name}
            </span>
          </span>
        ) : (
          <div className='inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5 hover:bg-slate-100 dark:border-border dark:bg-card dark:hover:bg-accent transition-colors'>
            <span
              data-copy-skip
              aria-hidden='true'
              className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'
            >
              {initials}
            </span>
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
        onAction={() => setOpen(false)}
      />
    </Popover>
  )
}

// Async M2O display cell — fetches related record + collection display_template
function PdfGenerateButton({
  collection,
  itemId,
  layoutId,
  attachField,
  filenameTemplate,
  label
}: {
  collection: string
  itemId: string
  layoutId: number
  attachField: string | null
  filenameTemplate?: string | null
  label: string
}) {
  const client = useOptionalNivaroClient()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const handleGenerate = async () => {
    if (!client || busy || !attachField) return
    setBusy(true)
    try {
      await client.request(
        post(`/collection-layouts/${layoutId}/generate-and-attach`, {
          collection,
          item_id: itemId,
          attach_field: attachField,
          filename_template: filenameTemplate ?? undefined
        })
      )
      qc.invalidateQueries({ queryKey: ['m2m-items'] })
      qc.invalidateQueries({ queryKey: ['items', collection, itemId] })
    } catch {
      // silent — API errors surface via existing error handling
    } finally {
      setBusy(false)
    }
  }
  const notConfigured = !attachField
  return (
    <button
      type='button'
      onClick={handleGenerate}
      disabled={busy || notConfigured}
      title={notConfigured ? 'Configure PDF field in Data Model → Layouts' : undefined}
      className='inline-flex items-center gap-1.5 rounded-md border border-nvr-cyan/40 bg-nvr-cyan/10 px-3 py-1.5 text-[12px] font-medium text-nvr-navy hover:bg-nvr-cyan/20 disabled:cursor-not-allowed disabled:opacity-40 dark:text-nvr-cyan'
    >
      <svg
        xmlns='http://www.w3.org/2000/svg'
        className='h-3.5 w-3.5'
        viewBox='0 0 24 24'
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        strokeLinecap='round'
        strokeLinejoin='round'
      >
        <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
        <polyline points='14 2 14 8 20 8' />
      </svg>
      {busy ? 'Generating…' : label}
    </button>
  )
}

export function RelationCell({
  relCollection,
  id,
  className
}: {
  relCollection: string
  id: unknown
  className?: string
}) {
  const client = useOptionalNivaroClient()
  const idStr = id != null && id !== '' ? String(id) : null
  const { data: colMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta-dt', relCollection],
    queryFn: () =>
      client!
        .request<{ data: { display_template?: string | null } }>(
          get(`/collections/${relCollection}`)
        )
        .then((r) => r.data),
    enabled: !!client && !!idStr,
    staleTime: 300_000
  })
  const { data: record, isLoading } = useQuery<Record<string, unknown> | null>({
    queryKey: ['rel-display', relCollection, idStr],
    queryFn: () =>
      client!
        .request<{ data: Record<string, unknown> }>(get(`/items/${relCollection}/${idStr}`))
        .then((r) => r.data ?? null),
    enabled: !!client && !!idStr,
    staleTime: 60_000
  })
  if (!idStr) return <span>—</span>
  if (isLoading)
    return (
      <span className='animate-pulse h-3 w-20 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))] inline-block' />
    )
  const textCls = className ?? 'text-[13px] text-slate-700'
  if (!record) return <span className={textCls}>{idStr}</span>
  const label = colMeta?.display_template
    ? applyDisplayTemplate(colMeta.display_template, record)
    : String(record.name ?? record.title ?? record.label ?? record.display_name ?? idStr)
  return <span className={textCls}>{label}</span>
}

// Compact user pill for the header strip — smaller trigger, same contact card popover as UserChip
function StripUserChip({ userId }: { userId: string }) {
  return <UserChip userId={userId} size='compact' />
}

// Header-strip relation value: renders the related record's display template
// and, when the host provides a DrilldownContext, opens it in the record
// drill-down sheet on click (same target shape the layout field drills use).
function StripRelationCell({
  relCollection,
  id,
  drillConfig
}: {
  relCollection: string
  id: unknown
  drillConfig: FieldDrilldownConfig | null
}) {
  const drill = useDrilldown()
  const plain = <RelationCell relCollection={relCollection} id={id} />
  if (!drill || id == null || id === '') return plain
  // The underline lives on the text span itself: text-decoration set on the
  // wrapping button does not reliably paint through RelationCell's own span.
  const cell = (
    <RelationCell
      relCollection={relCollection}
      id={id}
      className='text-[13px] text-slate-700 underline decoration-slate-400 underline-offset-2 group-hover/drill:decoration-[#0284c7] group-hover/drill:text-[#0284c7] dark:text-slate-200 dark:decoration-slate-500'
    />
  )
  return (
    <button
      type='button'
      onClick={(e) => {
        e.stopPropagation()
        drill.open({
          collection: relCollection,
          itemId: String(id),
          layoutId: drillConfig?.layout_id ?? null,
          // Header drills open wide by default — the sheet renders the target's
          // full detail layout, which is unreadable in a narrow panel.
          width: drillConfig?.width ?? '85%'
        })
      }}
      className='group/drill cursor-pointer text-left transition-colors'
    >
      {cell}
    </button>
  )
}

// ─── StripFieldValue ──────────────────────────────────────────────────────────
// Used by ItemEditForm header strip — same rendering logic as SummaryStrip

/** Class that pulses once whenever `value` changes AFTER the first render. */
export function useChangePulse(value: unknown): string {
  const [flash, setFlash] = useState(false)
  const first = useRef(true)
  const prev = useRef(JSON.stringify(value ?? null))
  useEffect(() => {
    const now = JSON.stringify(value ?? null)
    if (first.current) {
      first.current = false
      prev.current = now
      return
    }
    if (now === prev.current) return
    prev.current = now
    // Drop and re-add the class so a second change re-runs the animation.
    setFlash(false)
    const raise = window.setTimeout(() => setFlash(true), 0)
    const clear = window.setTimeout(() => setFlash(false), 1200)
    return () => {
      window.clearTimeout(raise)
      window.clearTimeout(clear)
    }
  }, [value])
  return flash ? 'nvr-value-pulse' : ''
}

export function StripFieldValue({
  field,
  val,
  relations,
  collection,
  displayFormat,
  textClassName
}: {
  field: CMSField
  val: unknown
  relations: CMSRelation[]
  collection: string
  displayFormat?: string
  textClassName?: string
}) {
  const pulse = useChangePulse(val)
  const base = cn(textClassName ?? 'text-slate-900 dark:text-slate-100', pulse)
  // Header relations drill by default (the strip is read-only — clicking a
  // related record to inspect it is the only sensible interaction); an explicit
  // drilldown override still supplies the layout/width.
  const drillCfg = fieldDrilldownConfig(field) ?? { enabled: true, layout_id: null, width: null }

  // M2M alias (e.g. workflows.purchase_orders): the value is a list of RELATED
  // record ids resolved from the junction — never a column on the record, so it
  // has to be matched on the alias relation, not many_field. Without this the
  // header renders '—' for every M2M field even when links exist.
  const m2mRel = relations.find(
    (r) => r.one_collection === collection && r.one_field === field.field && r.junction_field
  )
  if (m2mRel) {
    const companion = relations.find(
      (r) => r.many_collection === m2mRel.many_collection && r.many_field === m2mRel.junction_field
    )
    const target = companion?.one_collection
    const ids = Array.isArray(val) ? val : val != null && val !== '' ? [val] : []
    if (!target || ids.length === 0) {
      return <span className='text-slate-300 dark:text-slate-600'>—</span>
    }
    if (target === 'nivaro_users') {
      return (
        <span className='inline-flex flex-wrap gap-x-1 gap-y-0.5'>
          {ids.map((id) => (
            <StripUserChip key={String(id)} userId={String(id)} />
          ))}
        </span>
      )
    }
    return (
      <span className='inline-flex flex-wrap gap-x-1.5'>
        {ids.map((id) => (
          <StripRelationCell
            key={String(id)}
            relCollection={target}
            id={id}
            drillConfig={drillCfg}
          />
        ))}
      </span>
    )
  }

  const m2oRel = relations.find(
    (r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field
  )

  if (m2oRel?.one_collection) {
    const ids = Array.isArray(val) ? val : val != null && val !== '' ? [val] : []
    if (ids.length === 0) return <span className='text-slate-300 dark:text-slate-600'>—</span>
    if (m2oRel.one_collection === 'nivaro_users') {
      return (
        <span className='inline-flex flex-wrap gap-x-1 gap-y-0.5'>
          {ids.map((id) => (
            <StripUserChip key={String(id)} userId={String(id)} />
          ))}
        </span>
      )
    }
    return (
      <span className='inline-flex flex-wrap gap-x-1.5'>
        {ids.map((id) => (
          <StripRelationCell
            key={String(id)}
            relCollection={m2oRel.one_collection!}
            id={id}
            drillConfig={drillCfg}
          />
        ))}
      </span>
    )
  }

  if (val === null || val === undefined || val === '') {
    return <span className='text-slate-300 dark:text-slate-600'>—</span>
  }

  // Display format override from layout assignment (currency/integer/decimal/percent/date/datetime)
  if (displayFormat && displayFormat !== 'text') {
    const num = Number(val)
    if (displayFormat === 'currency' && !isNaN(num)) {
      return (
        <span className={`text-[13px] font-semibold ${base}`}>
          {new Intl.NumberFormat(undefined, {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2
          }).format(num)}
        </span>
      )
    }
    if (displayFormat === 'integer' && !isNaN(num)) {
      return (
        <span className={`text-[13px] font-semibold ${base}`}>
          {new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(num))}
        </span>
      )
    }
    if (displayFormat === 'decimal' && !isNaN(num)) {
      return (
        <span className={`text-[13px] font-semibold ${base}`}>
          {new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num)}
        </span>
      )
    }
    if (displayFormat === 'percent' && !isNaN(num)) {
      return (
        <span className={`text-[13px] font-semibold ${base}`}>
          {new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(
            num / 100
          )}
        </span>
      )
    }
    if (displayFormat === 'date') {
      try {
        return (
          <span className={`text-[13px] font-semibold ${base}`}>
            {new Date(String(val)).toLocaleDateString()}
          </span>
        )
      } catch {
        /* fall through */
      }
    }
    if (displayFormat === 'datetime') {
      try {
        return (
          <span className={`text-[13px] font-semibold ${base}`}>
            {new Date(String(val)).toLocaleString()}
          </span>
        )
      } catch {
        /* fall through */
      }
    }
  }

  return (
    <span className={`text-[13px] font-semibold ${base}`}>{formatDisplayValue(val, field)}</span>
  )
}

function SummaryStrip({
  summaryFields,
  fields,
  draft,
  relations,
  collection,
  itemId,
  ownersAssignment,
  m2mCounts,
  o2mCounts,
  o2mAggValues,
  summaryAggConfigs,
  o2mLoading,
  hideEmpty
}: {
  summaryFields: SummaryEntry[]
  fields: CMSField[]
  draft: Record<string, unknown>
  relations: CMSRelation[]
  collection: string
  itemId: string
  ownersAssignment?: SlotAssignment | null
  m2mCounts?: Record<string, number>
  o2mCounts?: Record<string, number>
  o2mAggValues?: Record<string, number>
  summaryAggConfigs?: Record<string, SummaryAggConfig>
  o2mLoading?: Set<string>
  hideEmpty?: boolean
}) {
  const summaryKeys = summaryFields.map((e) => (typeof e === 'string' ? e : e.field))
  const visibleFields = hideEmpty
    ? summaryKeys.filter((key) => {
        if (key === '__owners__') return true
        if (o2mLoading?.has(key)) return true
        if (o2mAggValues && key in o2mAggValues) return true
        if (m2mCounts && key in m2mCounts) return (m2mCounts[key] ?? 0) > 0
        if (o2mCounts && key in o2mCounts) return (o2mCounts[key] ?? 0) > 0
        const v = draft[key]
        return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)
      })
    : summaryKeys
  if (visibleFields.length === 0) return null

  const LBL =
    'text-[9px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 shrink-0'
  const VAL = 'text-[12px] font-semibold text-slate-700 dark:text-slate-300'
  const EMPTY = 'text-[12px] text-slate-300 dark:text-slate-600'
  const ROW = 'flex items-baseline gap-1.5'

  const renderItem = (key: string): React.ReactNode => {
    if (key === '__owners__') {
      const ownersLabel = ownersAssignment?.label_override || 'Owners'
      return (
        <div className='flex items-center gap-1.5'>
          <span className={LBL}>{ownersLabel}</span>
          <OwnersInlineCompact collection={collection} itemId={itemId} />
        </div>
      )
    }

    const entry = summaryFields.find((e) => (typeof e === 'string' ? e : e.field) === key)
    const customLabel = entry && typeof entry !== 'string' ? entry.label : undefined
    const f = fields.find((x) => x.field === key)
    const label =
      customLabel || f?.label || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

    if (o2mLoading?.has(key)) {
      return (
        <div className='flex items-center gap-1.5'>
          <span className={LBL}>{label}</span>
          <Loader2 className='h-3 w-3 animate-spin text-slate-300' />
        </div>
      )
    }

    if (o2mAggValues && key in o2mAggValues) {
      const cfg = summaryAggConfigs?.[key]
      const displayLabel = cfg?.label || label
      const n = o2mAggValues[key]
      let formatted: string
      if (cfg?.agg === 'count') {
        formatted = String(n)
      } else {
        const fieldOpts = cfg?.field_options
          ? (() => {
              try {
                return JSON.parse(cfg.field_options)
              } catch {
                return {}
              }
            })()
          : {}
        const fmt = fieldOpts.format as string | undefined
        if (fmt === 'currency') {
          try {
            formatted = new Intl.NumberFormat(undefined, {
              style: 'currency',
              currency: (fieldOpts.currency as string) || 'USD'
            }).format(n)
          } catch {
            formatted = n.toLocaleString(undefined, { maximumFractionDigits: 2 })
          }
        } else if (fmt === 'int') {
          formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)
        } else if (fmt === 'decimal') {
          const precision = typeof fieldOpts.precision === 'number' ? fieldOpts.precision : 2
          formatted = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: precision,
            maximumFractionDigits: precision
          }).format(n)
        } else {
          formatted = n.toLocaleString(undefined, { maximumFractionDigits: 2 })
        }
      }
      return (
        <div className={ROW}>
          <span className={LBL}>{displayLabel}</span>
          <span className={VAL}>{formatted}</span>
        </div>
      )
    }

    if (m2mCounts && key in m2mCounts) {
      const n = m2mCounts[key]
      return (
        <div className={ROW}>
          <span className={LBL}>{label}</span>
          <span className={VAL}>
            {n} item{n !== 1 ? 's' : ''}
          </span>
        </div>
      )
    }

    if (o2mCounts && key in o2mCounts) {
      const n = o2mCounts[key]
      return (
        <div className={ROW}>
          <span className={LBL}>{label}</span>
          <span className={VAL}>
            {n} row{n !== 1 ? 's' : ''}
          </span>
        </div>
      )
    }

    const v = draft[key]
    const m2oRel = relations.find(
      (r) => r.many_collection === collection && r.many_field === key && !r.junction_field
    )

    if (m2oRel?.one_collection) {
      const ids = Array.isArray(v) ? v : v != null && v !== '' ? [v] : []
      return (
        <div className={ROW}>
          <span className={LBL}>{label}</span>
          {ids.length === 0 ? (
            <span className={EMPTY}>—</span>
          ) : m2oRel.one_collection === 'nivaro_users' ? (
            <span className='inline-flex flex-wrap gap-x-1.5 gap-y-0.5'>
              {ids.map((id) => (
                <SummaryUserName key={String(id)} userId={String(id)} />
              ))}
            </span>
          ) : (
            <span className='inline-flex flex-wrap gap-x-1.5'>
              {ids.map((id) => (
                <RelationCell key={String(id)} relCollection={m2oRel.one_collection!} id={id} />
              ))}
            </span>
          )}
        </div>
      )
    }

    if (Array.isArray(v)) {
      const m2mRel = relations.find((r) => r.many_field === key && r.junction_field)
      const targetCol = m2mRel?.one_collection
      return (
        <div className={ROW}>
          <span className={LBL}>{label}</span>
          {v.length === 0 ? (
            <span className={EMPTY}>—</span>
          ) : targetCol ? (
            <span className='inline-flex flex-wrap gap-x-1.5 gap-y-0.5'>
              {v.map((id) =>
                targetCol === 'nivaro_users' ? (
                  <SummaryUserName key={String(id)} userId={String(id)} />
                ) : (
                  <RelationCell key={String(id)} relCollection={targetCol} id={id} />
                )
              )}
            </span>
          ) : (
            <span className={VAL}>
              {v.length} item{v.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      )
    }

    return (
      <div className={ROW}>
        <span className={LBL}>{label}</span>
        {v === null || v === undefined || v === '' ? (
          <span className={EMPTY}>—</span>
        ) : (
          <span className={VAL}>{formatDisplayValue(v, f)}</span>
        )}
      </div>
    )
  }

  return (
    <div className='flex flex-wrap items-baseline gap-x-5 gap-y-1.5 border-t border-slate-100 dark:border-border/60 bg-slate-50/50 dark:bg-white/[0.015] px-5 py-2.5'>
      {visibleFields.map((key) => (
        <React.Fragment key={key}>{renderItem(key)}</React.Fragment>
      ))}
    </div>
  )
}

export function GroupSection({
  group,
  fields,
  draft,
  onChange,
  relations,
  collection,
  itemId,
  errors,
  visibleFields,
  lockedFields,
  layoutAiEnabled,
  displayOnly,
  renderField,
  onCountChange,
  isNew,
  fieldValues,
  isOpen,
  onToggle,
  summaryFields,
  m2mCounts,
  o2mCounts,
  o2mAggValues,
  summaryAggConfigs,
  o2mLoading,
  footerSlot,
  ownersAssignment,
  pdfAssignment,
  pdfAttachField,
  pdfFilenameTemplate,
  layoutId,
  hideEmptySummary,
  widgetAssignments,
  widgetApiBase,
  fieldInlineDisplay,
  swapConfig,
  swapped,
  onSwapToggle,
  alternateFields,
  alternateWidths
}: {
  group: FieldGroup
  fields: CMSField[]
  draft: Record<string, unknown>
  onChange: (field: string, value: unknown) => void
  relations: CMSRelation[]
  collection: string
  itemId: string
  errors: Record<string, string>
  visibleFields: Set<string>
  lockedFields: Set<string>
  layoutAiEnabled?: boolean
  displayOnly?: boolean
  renderField?: (props: RenderFieldProps) => ReactNode
  onCountChange?: (field: string, count: number) => void
  isNew?: boolean
  fieldValues?: unknown[]
  isOpen?: boolean
  onToggle?: () => void
  summaryFields?: SummaryEntry[]
  m2mCounts?: Record<string, number>
  o2mCounts?: Record<string, number>
  o2mAggValues?: Record<string, number>
  summaryAggConfigs?: Record<string, SummaryAggConfig>
  o2mLoading?: Set<string>
  footerSlot?: ReactNode
  ownersAssignment?: SlotAssignment | null
  pdfAssignment?: SlotAssignment | null
  pdfAttachField?: string | null
  pdfFilenameTemplate?: string | null
  layoutId?: number | null
  hideEmptySummary?: boolean
  widgetAssignments?: SlotAssignment[]
  widgetApiBase?: string
  fieldInlineDisplay?: Record<string, { entries: InlineDisplayEntry[]; separator: string | null }>
  swapConfig?: {
    enabled: boolean
    primary_field: string
    alternate_fields: ({ field: string; width: 1 | 2 } | string)[]
    toggle_label?: string
    back_label?: string
  } | null
  swapped?: boolean
  onSwapToggle?: () => void
  alternateFields?: CMSField[]
  alternateWidths?: Record<string, 1 | 2>
}) {
  const [localCollapsed, setLocalCollapsed] = useState(group.is_collapsed ?? false)
  // Widget content reports (WidgetSlot onContentChange) — hide_when_empty must
  // consider widget rows, not just field values, or a widget-only section is
  // permanently hidden (empty fieldValues → every() is vacuously true).
  // Unreported widgets count as empty, so the section stays hidden until
  // rows actually arrive.
  const [widgetContent, setWidgetContent] = useState<Record<string, boolean>>({})
  // Accordion mode: parent controls open/closed via isOpen + onToggle.
  const controlled = onToggle !== undefined
  const collapsed = controlled ? !isOpen : localCollapsed
  const toggle = controlled ? onToggle : () => setLocalCollapsed((v) => !v)
  const hasErrors = !displayOnly && fields.some((f) => errors[f.field])

  // Section visibility rules (layout-configured)
  const visibilityMode = group.visibility_mode ?? 'always'
  if (visibilityMode === 'new_only' && !isNew) return null
  if (visibilityMode === 'existing_only' && isNew) return null
  const groupWidgets = widgetAssignments ?? []
  // A widget that hasn't reported yet is LOADING, not empty — hiding the
  // section until rows arrive made it pop in and shove the layout. While any
  // widget is unreported the section stays visible (its body renders the
  // widget skeleton); it only hides once every widget has definitively
  // reported no content. New records skip this: record-scoped widgets render
  // null there and would never report, pinning the section open forever.
  const widgetsPending =
    !isNew &&
    groupWidgets.some((ws) => ws.widget_id != null && widgetContent[ws.field] === undefined)
  let hiddenWhenEmpty = false
  if (group.hide_when_empty && fieldValues) {
    const allEmpty = fieldValues.every(
      (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
    )
    hiddenWhenEmpty =
      allEmpty && !widgetsPending && groupWidgets.every((ws) => !widgetContent[ws.field])
  }
  // Without widgets the section can unmount outright. With widgets it must
  // stay mounted (CSS-hidden) so they can fetch and report content — an
  // unmounted WidgetSlot could never reveal the section.
  if (hiddenWhenEmpty && groupWidgets.length === 0) return null
  const gridRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(gridRef)
  const GroupIcon = resolveIcon(group.icon)

  const visibleFields_ = fields.filter((f) => !f.hidden)

  return (
    <div
      className={cn(
        'nvr-section-enter rounded-xl border border-slate-200 bg-white dark:bg-card dark:border-border',
        displayOnly && 'bg-slate-50/60 dark:bg-slate-900/20',
        hiddenWhenEmpty && 'hidden'
      )}
    >
      <button
        type='button'
        onClick={toggle}
        className={cn(
          'flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-slate-50/50 dark:hover:bg-white/[0.02] rounded-t-xl',
          // Round the bottom only when nothing renders below the header — an
          // expanded body (or collapsed summary strip) square-joins it, and a
          // rounded hover overlay would leave see-through notches at the seam.
          collapsed && !(summaryFields && summaryFields.length > 0) && 'rounded-b-xl'
        )}
      >
        {GroupIcon && (
          <GroupIcon className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500' />
        )}
        <span className='font-medium text-[13px] shrink-0 text-slate-800 dark:text-slate-200'>
          {group.label}
        </span>
        <span className='flex-1' />
        {hasErrors && <span className='nvr-pop h-2 w-2 rounded-full bg-destructive shrink-0' />}
        <ChevronDown
          className={cn(
            'h-4 w-4 text-slate-400 dark:text-slate-500 transition-transform duration-200',
            collapsed && '-rotate-90'
          )}
        />
      </button>
      {collapsed && summaryFields && summaryFields.length > 0 && (
        <SummaryStrip
          summaryFields={summaryFields}
          fields={fields}
          draft={draft}
          relations={relations}
          collection={collection}
          itemId={itemId}
          ownersAssignment={ownersAssignment}
          m2mCounts={m2mCounts}
          o2mCounts={o2mCounts}
          o2mAggValues={o2mAggValues}
          summaryAggConfigs={summaryAggConfigs}
          o2mLoading={o2mLoading}
          hideEmpty={!!group.summary_hide_empty || !!hideEmptySummary}
        />
      )}
      {/* Collapsed body never mounts its widgets, so a default-collapsed
          hide_when_empty section could never report content and stayed hidden
          forever. Probe-mount the widgets invisibly while collapsed so the
          content reports still arrive; the expanded body takes over on open. */}
      {collapsed && group.hide_when_empty && groupWidgets.length > 0 && (
        <div className='hidden'>
          {groupWidgets
            .filter((ws) => ws.widget_id != null)
            .map((ws) => (
              <WidgetSlot
                key={ws.field}
                widgetId={ws.widget_id as number}
                inputBindings={parseBindings(ws.input_bindings)}
                itemDraft={draft}
                frameless
                apiBase={widgetApiBase}
                onContentChange={(has) =>
                  setWidgetContent((prev) =>
                    prev[ws.field] === has ? prev : { ...prev, [ws.field]: has }
                  )
                }
              />
            ))}
        </div>
      )}
      {!collapsed && (
        <div className='nvr-expand-in border-t border-slate-100 px-5 py-4'>
          {(() => {
            // Merge fields + optional inline owners/pdf/widgets into a sorted render list
            type RenderItem = { _k: string; sort: number } & (
              | { _t: 'field'; f: CMSField }
              | { _t: 'owners'; slot: SlotAssignment }
              | { _t: 'pdf'; slot: SlotAssignment }
              | { _t: 'widget'; slot: SlotAssignment }
            )
            const items: RenderItem[] = visibleFields_.map((f) => ({
              _k: f.field,
              sort: f.sort ?? 0,
              _t: 'field' as const,
              f
            }))
            if (ownersAssignment) {
              items.push({
                _k: '__owners__',
                sort: ownersAssignment.sort,
                _t: 'owners' as const,
                slot: ownersAssignment
              })
            }
            if (pdfAssignment) {
              items.push({
                _k: '__pdf__',
                sort: pdfAssignment.sort,
                _t: 'pdf' as const,
                slot: pdfAssignment
              })
            }
            for (const ws of widgetAssignments ?? []) {
              items.push({ _k: ws.field, sort: ws.sort, _t: 'widget' as const, slot: ws })
            }
            items.sort((a, b) => a.sort - b.sort)

            return displayOnly ? (
              <div ref={gridRef} className='grid grid-cols-12 gap-x-6 gap-y-3'>
                {items.map((item) => {
                  if (item._t === 'owners') {
                    const span = item.slot.col_span ?? 12
                    return (
                      <div
                        key='__owners__'
                        className='min-w-0'
                        style={{ gridColumn: `span ${span}` }}
                      >
                        <OwnersInline
                          collection={collection}
                          itemId={itemId}
                          label={item.slot.label_override || 'Owners'}
                        />
                      </div>
                    )
                  }
                  if (item._t === 'pdf') return null
                  if (item._t === 'widget') return null
                  const f = item.f
                  const m2oRel = relations.find(
                    (r) =>
                      r.many_collection === collection &&
                      r.many_field === f.field &&
                      !r.junction_field
                  )
                  return (
                    <div
                      key={f.field}
                      className='min-w-0'
                      style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}
                    >
                      <dt className='text-[11px] font-medium text-slate-400 truncate'>
                        {f.label || titleCase(f.field)}
                      </dt>
                      <dd className='mt-0.5 break-words'>
                        {m2oRel?.one_collection === 'nivaro_users' ? (
                          (() => {
                            const v = draft[f.field]
                            const ids = Array.isArray(v) ? v : v != null && v !== '' ? [v] : []
                            return ids.length === 0 ? (
                              <span className='text-[13px] text-slate-400'>—</span>
                            ) : (
                              <div className='flex flex-wrap gap-1.5'>
                                {ids.map((id) => (
                                  <UserChip key={String(id)} userId={String(id)} />
                                ))}
                              </div>
                            )
                          })()
                        ) : m2oRel?.one_collection ? (
                          <RelationCell relCollection={m2oRel.one_collection} id={draft[f.field]} />
                        ) : (
                          <span className='text-[13px] text-slate-700'>
                            {formatDisplayValue(draft[f.field], f)}
                          </span>
                        )}
                      </dd>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div ref={gridRef} className='grid grid-cols-12 gap-4 items-start'>
                {items.map((item) => {
                  if (item._t === 'owners') {
                    const span = item.slot.col_span ?? 12
                    return (
                      <div key='__owners__' style={{ gridColumn: `span ${span}` }}>
                        <OwnersInline
                          collection={collection}
                          itemId={itemId}
                          label={item.slot.label_override || 'Owners'}
                        />
                      </div>
                    )
                  }
                  if (item._t === 'pdf') {
                    if (!layoutId) return null
                    const span = item.slot.col_span ?? 12
                    const label = item.slot.label_override?.trim() || 'Generate PDF'
                    return (
                      <div key='__pdf__' style={{ gridColumn: `span ${span}` }}>
                        <PdfGenerateButton
                          collection={collection}
                          itemId={itemId}
                          layoutId={layoutId}
                          attachField={pdfAttachField ?? null}
                          filenameTemplate={pdfFilenameTemplate}
                          label={label}
                        />
                      </div>
                    )
                  }
                  if (item._t === 'widget') {
                    if (!item.slot.widget_id) return null
                    const span = item.slot.col_span ?? 12
                    const bindings = parseBindings(item.slot.input_bindings)
                    return (
                      <div key={item.slot.field} style={{ gridColumn: `span ${span}` }}>
                        <WidgetSlot
                          widgetId={item.slot.widget_id}
                          inputBindings={bindings}
                          itemDraft={draft}
                          label={item.slot.label_override ?? undefined}
                          defaultExpanded={item.slot.default_expanded ?? true}
                          frameless
                          apiBase={widgetApiBase}
                          onContentChange={(has) =>
                            setWidgetContent((prev) =>
                              prev[item.slot.field] === has
                                ? prev
                                : { ...prev, [item.slot.field]: has }
                            )
                          }
                        />
                      </div>
                    )
                  }
                  const f = item.f
                  const inlineConfig = fieldInlineDisplay?.[f.field]
                  const inlineEntries = inlineConfig?.entries
                  const inlineSeparator = inlineConfig?.separator ?? null
                  const rawVal = draft[f.field]
                  const hasVal = rawVal !== null && rawVal !== undefined && rawVal !== ''
                  const inlineRelCollection =
                    inlineEntries?.length && hasVal
                      ? (relations.find(
                          (r) =>
                            r.many_collection === collection &&
                            r.many_field === f.field &&
                            !r.junction_field
                        )?.one_collection ?? null)
                      : null
                  const isPrimary = swapConfig?.enabled && f.field === swapConfig.primary_field
                  const primaryHasValue = (() => {
                    const v = draft[swapConfig?.primary_field ?? '']
                    return v !== null && v !== undefined && v !== ''
                  })()
                  const altHasValue = (alternateFields ?? []).some((af) => {
                    const v = draft[af.field]
                    return v !== null && v !== undefined && v !== ''
                  })
                  const swapBtn =
                    isPrimary && onSwapToggle ? (
                      <span className='inline-flex items-center gap-1.5'>
                        <button
                          type='button'
                          onClick={onSwapToggle}
                          className='inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 transition-colors'
                        >
                          {swapped
                            ? (swapConfig!.back_label ?? 'Back')
                            : (swapConfig!.toggle_label ?? 'Enter manually')}
                        </button>
                        <span
                          className={[
                            'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium',
                            primaryHasValue
                              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                              : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                          ].join(' ')}
                          title='Original field'
                        >
                          <span
                            className={[
                              'h-1.5 w-1.5 rounded-full',
                              primaryHasValue ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                            ].join(' ')}
                          />
                          Original
                        </span>
                        <span
                          className={[
                            'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium',
                            altHasValue
                              ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'
                              : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                          ].join(' ')}
                          title='Manual fields'
                        >
                          <span
                            className={[
                              'h-1.5 w-1.5 rounded-full',
                              altHasValue ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
                            ].join(' ')}
                          />
                          Manual
                        </span>
                      </span>
                    ) : undefined
                  const swapCnt =
                    isPrimary && swapped && alternateFields?.length ? (
                      <div className='mt-2 rounded-lg border border-slate-200 bg-slate-50 dark:border-border dark:bg-slate-900/40 p-3'>
                        <div className='grid grid-cols-2 gap-3'>
                          {alternateFields.map((af) => {
                            const w = alternateWidths?.[af.field] ?? 2
                            return (
                              <div key={af.field} style={{ gridColumn: `span ${w}` }}>
                                <FieldRow
                                  field={af}
                                  draft={draft}
                                  onChange={onChange}
                                  relations={relations}
                                  collection={collection}
                                  itemId={itemId}
                                  error={errors[af.field]}
                                  visible={true}
                                  forceVisible={true}
                                  locked={lockedFields.has(af.field)}
                                  layoutAiEnabled={layoutAiEnabled}
                                  renderField={renderField}
                                  onCountChange={onCountChange}
                                />
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ) : undefined
                  return (
                    <div
                      key={f.field}
                      style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}
                    >
                      <FieldRow
                        field={f}
                        draft={draft}
                        onChange={onChange}
                        relations={relations}
                        collection={collection}
                        itemId={itemId}
                        error={errors[f.field]}
                        visible={visibleFields.has(f.field) || !visibleFields.size}
                        locked={lockedFields.has(f.field)}
                        layoutAiEnabled={layoutAiEnabled}
                        renderField={renderField}
                        onCountChange={onCountChange}
                        swapButton={swapBtn}
                        swapContent={swapCnt}
                      />
                      {inlineEntries?.length && hasVal && inlineRelCollection && (
                        <InlineDisplay
                          relCollection={inlineRelCollection}
                          relId={rawVal as string | number}
                          entries={inlineEntries}
                          separator={inlineSeparator}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
          {footerSlot && <div className='mt-4'>{footerSlot}</div>}
        </div>
      )}
    </div>
  )
}
