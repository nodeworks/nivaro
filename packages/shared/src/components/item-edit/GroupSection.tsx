import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ExternalLink, Loader2, Mail, Phone, User } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import React, { type ReactNode } from 'react'
import { useRef, useState } from 'react'
import { useNavigation, useOptionalNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { WidgetSlot } from '../WidgetSlot'
import { FieldRow } from './FieldRow'
import { applyDisplayTemplate, resolveColSpan, useContainerWidth } from './helpers'
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps, SlotAssignment, SummaryAggConfig, SummaryEntry } from './types'

// ── Inline display ────────────────────────────────────────────────────────────

export type InlineDisplayEntry = { field: string; label: string | null; format: string | null; line_break?: boolean }

export function InlineDisplay({
  relCollection,
  relId,
  entries,
  separator,
}: {
  relCollection: string
  relId: string | number
  entries: InlineDisplayEntry[]
  separator?: string | null
}) {
  const client = useOptionalNivaroClient()
  const idStr = String(relId)
  const { data: record } = useQuery<Record<string, unknown> | null>({
    queryKey: ['inline-display', relCollection, idStr],
    queryFn: () =>
      client!
        .request<{ data: Record<string, unknown> }>(get(`/items/${relCollection}/${idStr}`))
        .then((r) => r.data ?? null),
    enabled: !!client && !!idStr,
    staleTime: 60_000,
  })
  if (!record) return null

  if (separator != null) {
    const resolveDisplay = (e: InlineDisplayEntry): string | null => {
      const val = record[e.field]
      if (val === null || val === undefined || val === '') return null
      const fmt = e.format ?? 'text'
      if (fmt === 'date' || fmt === 'datetime') {
        try { return new Date(String(val)).toLocaleDateString() } catch { return String(val) }
      }
      if (fmt === 'boolean') return val ? 'Yes' : 'No'
      return String(val)
    }
    // Group entries into visual lines via line_break markers
    const lines: InlineDisplayEntry[][] = []
    let cur: InlineDisplayEntry[] = []
    for (const e of entries) {
      if (e.line_break && cur.length > 0) { lines.push(cur); cur = [e] }
      else cur.push(e)
    }
    if (cur.length > 0) lines.push(cur)
    type Token = { label: string | null; display: string }
    const renderedLines: Token[][] = lines
      .map((line) =>
        line
          .map((e) => { const d = resolveDisplay(e); return d ? { label: e.label ?? null, display: d } : null })
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
                {t.label && <span className='font-semibold text-slate-600 dark:text-slate-300'>{t.label}:</span>}
                {t.label ? ' ' : ''}{t.display}
              </React.Fragment>
            ))}
          </p>
        ))}
      </div>
    )
  }

  const rows = entries
    .map((e) => {
      const val = record[e.field]
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
          <span className='text-[12px] text-slate-700 dark:text-slate-300 truncate'>{row.display}</span>
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
  try { return JSON.parse(field.options as string) as Record<string, unknown> } catch { return {} }
}

function formatDisplayValue(value: unknown, field?: CMSField): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'

  const iface = field?.interface ?? ''

  // Boolean-like interfaces
  if (iface === 'toggle' || iface === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (typeof value === 'object') {
    if (Array.isArray(value)) return value.length ? `${value.length} items` : '—'
    try { return JSON.stringify(value) } catch { return String(value) }
  }

  const s = String(value)

  // ISO datetime → locale string
  if (iface === 'datetime' || iface === 'date' || /^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    try { return new Date(s).toLocaleString() } catch { /* noop */ }
  }

  // Select / radio: resolve choice label from options.choices
  if ((iface === 'select-dropdown' || iface === 'radio-buttons') && field) {
    const opts = parseFieldOpts(field)
    const choices = opts.choices as Array<{ text: string; value: string }> | undefined
    if (Array.isArray(choices)) {
      const match = choices.find((c) => String(c.value) === s)
      if (match) return match.text
    }
  }

  // Numeric formatting (options.format: 'int' | 'decimal' | 'currency')
  const num = Number(s)
  if (!Number.isNaN(num) && s !== '' && field) {
    const opts = parseFieldOpts(field)
    const fmt = opts.format as string | undefined
    if (fmt === 'currency') {
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: (opts.currency as string) || 'USD',
        }).format(num)
      } catch { /* noop */ }
    }
    if (fmt === 'int') {
      return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(num)
    }
    if (fmt === 'decimal') {
      const precision = typeof opts.precision === 'number' ? opts.precision : 2
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: precision,
        maximumFractionDigits: precision,
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
  const { navigate } = useNavigation()
  const { data: user } = useQuery<{ first_name: string | null; last_name: string | null; email: string } | null>({
    queryKey: ['user-chip', userId],
    queryFn: () =>
      client!.request<{ data: { first_name: string | null; last_name: string | null; email: string } }>(
        get(`/users/${userId}`)
      ).then((r) => r.data ?? null),
    enabled: !!client && !!userId,
    staleTime: 120_000,
  })
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.email) : userId
  const initials = name.split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <span className='inline-flex cursor-pointer items-center gap-1 rounded-full bg-slate-100 py-px pl-0.5 pr-2 hover:bg-slate-200 transition-colors'>
          <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>{initials}</span>
          <span className='text-[11px] text-slate-600'>{name}</span>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='text-[12px]'>
        <DropdownMenuItem className='gap-2 text-[12px] cursor-pointer' onSelect={() => navigate(`/users/${userId}`)}>
          <User className='h-3.5 w-3.5' /> View profile
        </DropdownMenuItem>
        {user?.email && (
          <DropdownMenuItem
            className='gap-2 text-[12px] cursor-pointer'
            onSelect={() => { window.location.href = `mailto:${user.email}` }}
          >
            <Mail className='h-3.5 w-3.5' /> Send email
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Compact owners — no label, tiny inline style, used inside SummaryStrip
export function OwnersInlineCompact({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useOptionalNivaroClient()
  const { data: owners = [], isLoading } = useQuery<Array<{ id: number; first_name: string | null; last_name: string | null; email: string }>>({
    queryKey: ['pipeline-instance-owners', collection, itemId],
    queryFn: () =>
      client!.request<{ data: Array<{ id: number; first_name: string | null; last_name: string | null; email: string }> }>(
        get(`/pipelines/instance/${collection}/${itemId}/owners`)
      ).then((r) => r.data ?? []),
    enabled: !!client && !!collection && !!itemId && itemId !== 'new',
    staleTime: 30_000,
  })
  const name = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
  const initials = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    name(o).split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  if (isLoading) return <span className='animate-pulse h-3 w-20 rounded bg-slate-200 dark:bg-slate-700 inline-block' />
  if (owners.length === 0) return <span className='text-[11px] text-slate-400'>—</span>
  return (
    <span className='inline-flex flex-wrap gap-x-1.5 gap-y-0.5'>
      {owners.map((o) => (
        <span key={o.id} className='inline-flex items-center gap-1 rounded-full bg-slate-100 py-px pl-0.5 pr-2'>
          <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>{initials(o)}</span>
          <span className='text-[11px] text-slate-600'>{name(o)}</span>
        </span>
      ))}
    </span>
  )
}

// Inline owners display — renders pipeline state owners as avatar chips, no panel wrapper
export function OwnersInline({ collection, itemId, label }: { collection: string; itemId: string; label: string }) {
  const client = useOptionalNivaroClient()
  const { data: owners = [] } = useQuery<Array<{ id: number; state: string | null; first_name: string | null; last_name: string | null; email: string }>>({
    queryKey: ['pipeline-instance-owners', collection, itemId],
    queryFn: () =>
      client!.request<{ data: Array<{ id: number; state: string | null; first_name: string | null; last_name: string | null; email: string }> }>(
        get(`/pipelines/instance/${collection}/${itemId}/owners`)
      ).then((r) => r.data ?? []),
    enabled: !!client && !!collection && !!itemId && itemId !== 'new',
    staleTime: 30_000,
  })
  const name = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
  const initials = (o: { first_name: string | null; last_name: string | null; email: string }) =>
    name(o).split(' ').map((p) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <div>
      <p className='text-[11px] font-medium text-slate-400 mb-1.5'>{label}</p>
      {owners.length === 0 ? (
        <p className='text-[13px] text-slate-400'>—</p>
      ) : (
        <div className='flex flex-wrap gap-2'>
          {owners.map((o) => (
            <div key={o.id} className='flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5'>
              <span className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
                {initials(o)}
              </span>
              <span className='text-[12px] text-slate-700'>{name(o)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Single user chip — fetches user by id, shows initials avatar + contact card on click
export function UserChip({ userId }: { userId: string }) {
  const client = useOptionalNivaroClient()
  const { navigate } = useNavigation()
  const { data: user, isLoading } = useQuery<{
    id: number
    first_name: string | null
    last_name: string | null
    email: string
    title?: string | null
    phone?: string | null
    department?: string | null
  } | null>({
    queryKey: ['user-chip', userId],
    queryFn: () =>
      client!.request<{ data: { id: number; first_name: string | null; last_name: string | null; email: string; title?: string | null; phone?: string | null; department?: string | null } }>(
        get(`/users/${userId}`)
      ).then((r) => r.data ?? null),
    enabled: !!client && !!userId,
    staleTime: 120_000,
  })

  if (isLoading) {
    return (
      <span className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5'>
        <span className='flex h-6 w-6 shrink-0 rounded-full animate-pulse bg-slate-200 dark:bg-slate-700' />
        <span className='animate-pulse h-2.5 w-16 rounded bg-slate-200 dark:bg-slate-700 inline-block' />
      </span>
    )
  }

  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.email) : userId
  const initials = name.split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <div className='inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 py-0.5 pl-0.5 pr-2.5 hover:bg-slate-100 dark:border-border dark:bg-card dark:hover:bg-accent transition-colors'>
          <span className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/15 text-[10px] font-semibold text-nvr-navy dark:text-nvr-cyan'>
            {initials}
          </span>
          <span className='text-[12px] text-slate-700 dark:text-slate-300'>{name}</span>
        </div>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-0 overflow-hidden'>
        {/* Header */}
        <div className='flex items-center gap-3 p-4 bg-gradient-to-br from-nvr-cyan/8 to-nvr-cyan/4 dark:from-nvr-cyan/10 dark:to-transparent border-b border-slate-100 dark:border-border'>
          <span className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[15px] font-bold text-nvr-navy dark:text-nvr-cyan ring-2 ring-white dark:ring-card shadow-sm'>
            {initials}
          </span>
          <div className='min-w-0 flex-1'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate'>{name}</p>
            {(user?.title || user?.department) && (
              <p className='text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5'>
                {[user.title, user.department].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        </div>
        {/* Contact info */}
        {(user?.email || user?.phone) && (
          <div className='px-4 py-3 space-y-2 border-b border-slate-100 dark:border-border'>
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
        {/* Actions */}
        <div className='flex items-center gap-1 p-2'>
          <button
            type='button'
            onClick={() => navigate(`/users/${userId}`)}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
          >
            <User className='h-3.5 w-3.5' /> View profile
          </button>
          {user?.email && (
            <button
              type='button'
              onClick={() => { window.location.href = `mailto:${user.email}` }}
              className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
            >
              <ExternalLink className='h-3.5 w-3.5' /> Send email
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Async M2O display cell — fetches related record + collection display_template
function PdfGenerateButton({ collection, itemId, layoutId, attachField, filenameTemplate, label }: {
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
      await client.request(post(`/collection-layouts/${layoutId}/generate-and-attach`, {
        collection,
        item_id: itemId,
        attach_field: attachField,
        filename_template: filenameTemplate ?? undefined,
      }))
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
      <svg xmlns='http://www.w3.org/2000/svg' className='h-3.5 w-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
        <path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' />
        <polyline points='14 2 14 8 20 8' />
      </svg>
      {busy ? 'Generating…' : label}
    </button>
  )
}

export function RelationCell({ relCollection, id }: { relCollection: string; id: unknown }) {
  const client = useOptionalNivaroClient()
  const idStr = id != null && id !== '' ? String(id) : null
  const { data: colMeta } = useQuery<{ display_template?: string | null }>({
    queryKey: ['col-meta-dt', relCollection],
    queryFn: () =>
      client!.request<{ data: { display_template?: string | null } }>(get(`/collections/${relCollection}`)).then((r) => r.data),
    enabled: !!client && !!idStr,
    staleTime: 300_000,
  })
  const { data: record, isLoading } = useQuery<Record<string, unknown> | null>({
    queryKey: ['rel-display', relCollection, idStr],
    queryFn: () =>
      client!.request<{ data: Record<string, unknown> }>(get(`/items/${relCollection}/${idStr}`)).then((r) => r.data ?? null),
    enabled: !!client && !!idStr,
    staleTime: 60_000,
  })
  if (!idStr) return <span>—</span>
  if (isLoading) return <span className='animate-pulse h-3 w-20 rounded bg-slate-200 dark:bg-slate-700 inline-block' />
  if (!record) return <span className='text-[13px] text-slate-700'>{idStr}</span>
  const label = colMeta?.display_template
    ? applyDisplayTemplate(colMeta.display_template, record)
    : String(record.name ?? record.title ?? record.label ?? record.display_name ?? idStr)
  return <span className='text-[13px] text-slate-700'>{label}</span>
}

// Compact user pill for the header strip — smaller trigger, same contact card popover as UserChip
function StripUserChip({ userId }: { userId: string }) {
  const client = useOptionalNivaroClient()
  const { navigate } = useNavigation()
  const { data: user, isLoading } = useQuery<{
    first_name: string | null
    last_name: string | null
    email: string
    title?: string | null
    phone?: string | null
    department?: string | null
  } | null>({
    queryKey: ['user-chip', userId],
    queryFn: () =>
      client!.request<{ data: { first_name: string | null; last_name: string | null; email: string; title?: string | null; phone?: string | null; department?: string | null } }>(
        get(`/users/${userId}`)
      ).then((r) => r.data ?? null),
    enabled: !!client && !!userId,
    staleTime: 120_000,
  })
  if (isLoading) return <span className='animate-pulse inline-block h-3.5 w-16 rounded bg-slate-200 dark:bg-slate-700' />
  const name = user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || user.email) : userId
  const initials = name.split(' ').map((p: string) => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <span className='inline-flex cursor-pointer items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 py-px pl-px pr-1.5 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors'>
          <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>{initials}</span>
          <span className='text-[11px] font-medium text-slate-600 dark:text-slate-300'>{name}</span>
        </span>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-64 p-0 overflow-hidden'>
        {/* Header */}
        <div className='flex items-center gap-3 p-4 bg-gradient-to-br from-nvr-cyan/8 to-nvr-cyan/4 dark:from-nvr-cyan/10 dark:to-transparent border-b border-slate-100 dark:border-border'>
          <span className='flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[15px] font-bold text-nvr-navy dark:text-nvr-cyan ring-2 ring-white dark:ring-card shadow-sm'>
            {initials}
          </span>
          <div className='min-w-0 flex-1'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100 truncate'>{name}</p>
            {(user?.title || user?.department) && (
              <p className='text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5'>
                {[user.title, user.department].filter(Boolean).join(' · ')}
              </p>
            )}
          </div>
        </div>
        {/* Contact info */}
        {(user?.email || user?.phone) && (
          <div className='px-4 py-3 space-y-2 border-b border-slate-100 dark:border-border'>
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
        {/* Actions */}
        <div className='flex items-center gap-1 p-2'>
          <button
            type='button'
            onClick={() => navigate(`/users/${userId}`)}
            className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
          >
            <User className='h-3.5 w-3.5' /> View profile
          </button>
          {user?.email && (
            <button
              type='button'
              onClick={() => { window.location.href = `mailto:${user.email}` }}
              className='flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-accent transition-colors'
            >
              <ExternalLink className='h-3.5 w-3.5' /> Send email
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── StripFieldValue ──────────────────────────────────────────────────────────
// Used by ItemEditForm header strip — same rendering logic as SummaryStrip

export function StripFieldValue({
  field,
  val,
  relations,
  collection,
  displayFormat,
  textClassName,
}: {
  field: CMSField
  val: unknown
  relations: CMSRelation[]
  collection: string
  displayFormat?: string
  textClassName?: string
}) {
  const base = textClassName ?? 'text-slate-900 dark:text-slate-100'
  const m2oRel = relations.find(
    (r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field
  )

  if (m2oRel?.one_collection) {
    const ids = Array.isArray(val) ? val : (val != null && val !== '' ? [val] : [])
    if (ids.length === 0) return <span className='text-slate-300 dark:text-slate-600'>—</span>
    if (m2oRel.one_collection === 'nivaro_users') {
      return (
        <span className='inline-flex flex-wrap gap-x-1 gap-y-0.5'>
          {ids.map((id) => <StripUserChip key={String(id)} userId={String(id)} />)}
        </span>
      )
    }
    return (
      <span className='inline-flex flex-wrap gap-x-1.5'>
        {ids.map((id) => <RelationCell key={String(id)} relCollection={m2oRel.one_collection!} id={id} />)}
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
      return <span className={`text-[13px] font-semibold ${base}`}>{new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(num)}</span>
    }
    if (displayFormat === 'integer' && !isNaN(num)) {
      return <span className={`text-[13px] font-semibold ${base}`}>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(num))}</span>
    }
    if (displayFormat === 'decimal' && !isNaN(num)) {
      return <span className={`text-[13px] font-semibold ${base}`}>{new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(num)}</span>
    }
    if (displayFormat === 'percent' && !isNaN(num)) {
      return <span className={`text-[13px] font-semibold ${base}`}>{new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(num / 100)}</span>
    }
    if (displayFormat === 'date') {
      try { return <span className={`text-[13px] font-semibold ${base}`}>{new Date(String(val)).toLocaleDateString()}</span> } catch { /* fall through */ }
    }
    if (displayFormat === 'datetime') {
      try { return <span className={`text-[13px] font-semibold ${base}`}>{new Date(String(val)).toLocaleString()}</span> } catch { /* fall through */ }
    }
  }

  return <span className={`text-[13px] font-semibold ${base}`}>{formatDisplayValue(val, field)}</span>
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
  hideEmpty,
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

  const renderItem = (key: string): React.ReactNode => {
    if (key === '__owners__') {
      const ownersLabel = ownersAssignment?.label_override || 'Owners'
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{ownersLabel}</span>
          <OwnersInlineCompact collection={collection} itemId={itemId} />
        </div>
      )
    }

    const entry = summaryFields.find((e) => (typeof e === 'string' ? e : e.field) === key)
    const customLabel = entry && typeof entry !== 'string' ? entry.label : undefined
    const f = fields.find((x) => x.field === key)
    const label = customLabel || f?.label || key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

    if (o2mLoading?.has(key)) {
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
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
          ? (() => { try { return JSON.parse(cfg.field_options) } catch { return {} } })()
          : {}
        const fmt = fieldOpts.format as string | undefined
        if (fmt === 'currency') {
          try {
            formatted = new Intl.NumberFormat(undefined, {
              style: 'currency',
              currency: (fieldOpts.currency as string) || 'USD',
            }).format(n)
          } catch { formatted = n.toLocaleString(undefined, { maximumFractionDigits: 2 }) }
        } else if (fmt === 'int') {
          formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(n)
        } else if (fmt === 'decimal') {
          const precision = typeof fieldOpts.precision === 'number' ? fieldOpts.precision : 2
          formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision }).format(n)
        } else {
          formatted = n.toLocaleString(undefined, { maximumFractionDigits: 2 })
        }
      }
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{displayLabel}</span>
          <span className='text-[11px] text-slate-600'>{formatted}</span>
        </div>
      )
    }

    if (m2mCounts && key in m2mCounts) {
      const n = m2mCounts[key]
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
          <span className='text-[11px] text-slate-600'>{n} item{n !== 1 ? 's' : ''}</span>
        </div>
      )
    }

    if (o2mCounts && key in o2mCounts) {
      const n = o2mCounts[key]
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
          <span className='text-[11px] text-slate-600'>{n} row{n !== 1 ? 's' : ''}</span>
        </div>
      )
    }

    const v = draft[key]
    const m2oRel = relations.find(
      (r) => r.many_collection === collection && r.many_field === key && !r.junction_field
    )

    if (m2oRel?.one_collection) {
      const ids = Array.isArray(v) ? v : (v != null && v !== '' ? [v] : [])
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
          {ids.length === 0
            ? <span className='text-[11px] text-slate-400'>—</span>
            : m2oRel.one_collection === 'nivaro_users'
              ? <span className='inline-flex flex-wrap gap-x-1.5 gap-y-0.5'>{ids.map((id) => <SummaryUserName key={String(id)} userId={String(id)} />)}</span>
              : <span className='inline-flex flex-wrap gap-x-1.5'>{ids.map((id) => <RelationCell key={String(id)} relCollection={m2oRel.one_collection!} id={id} />)}</span>
          }
        </div>
      )
    }

    if (Array.isArray(v)) {
      const m2mRel = relations.find((r) => r.many_field === key && r.junction_field)
      const targetCol = m2mRel?.one_collection
      return (
        <div className='flex items-center gap-1.5'>
          <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
          {v.length === 0
            ? <span className='text-[11px] text-slate-400'>—</span>
            : targetCol
              ? <span className='inline-flex flex-wrap gap-x-1.5 gap-y-0.5'>{v.map((id) =>
                  targetCol === 'nivaro_users'
                    ? <SummaryUserName key={String(id)} userId={String(id)} />
                    : <RelationCell key={String(id)} relCollection={targetCol} id={id} />
                )}</span>
              : <span className='text-[11px] text-slate-600'>{v.length} item{v.length !== 1 ? 's' : ''}</span>
          }
        </div>
      )
    }

    return (
      <div className='flex items-center gap-1.5'>
        <span className='text-[10px] font-medium text-slate-400 shrink-0'>{label}</span>
        {(v === null || v === undefined || v === '')
          ? <span className='text-[11px] text-slate-400'>—</span>
          : <span className='text-[11px] text-slate-600'>{formatDisplayValue(v, f)}</span>
        }
      </div>
    )
  }

  return (
    <div className='flex flex-wrap gap-1.5 border-t border-slate-100 px-5 py-2'>
      {visibleFields.map((key) => (
        <div key={key} className='inline-flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2.5 py-1'>
          {renderItem(key)}
        </div>
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
  widgetApiBase = '/api',
  fieldInlineDisplay,
  swapConfig,
  swapped,
  onSwapToggle,
  alternateFields,
  alternateWidths,
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
  swapConfig?: { enabled: boolean; primary_field: string; alternate_fields: ({ field: string; width: 1 | 2 } | string)[]; toggle_label?: string; back_label?: string } | null
  swapped?: boolean
  onSwapToggle?: () => void
  alternateFields?: CMSField[]
  alternateWidths?: Record<string, 1 | 2>
}) {
  const [localCollapsed, setLocalCollapsed] = useState(group.is_collapsed ?? false)
  // Accordion mode: parent controls open/closed via isOpen + onToggle.
  const controlled = onToggle !== undefined
  const collapsed = controlled ? !isOpen : localCollapsed
  const toggle = controlled ? onToggle : () => setLocalCollapsed((v) => !v)
  const hasErrors = !displayOnly && fields.some((f) => errors[f.field])

  // Section visibility rules (layout-configured)
  const visibilityMode = group.visibility_mode ?? 'always'
  if (visibilityMode === 'new_only' && !isNew) return null
  if (visibilityMode === 'existing_only' && isNew) return null
  if (group.hide_when_empty && fieldValues) {
    const allEmpty = fieldValues.every(
      (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
    )
    if (allEmpty) return null
  }
  const gridRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(gridRef)
  const GroupIcon = resolveIcon(group.icon)

  const visibleFields_ = fields.filter((f) => !f.hidden)

  return (
    <div className='rounded-xl border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={toggle}
        className='flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-slate-50/50'
      >
        {GroupIcon && <GroupIcon className='h-3.5 w-3.5 shrink-0 text-slate-400' />}
        <span className='font-semibold text-sm shrink-0 text-slate-700'>{group.label}</span>
        <span className='flex-1' />
        {hasErrors && <span className='h-2 w-2 rounded-full bg-destructive shrink-0' />}
        {collapsed ? (
          <ChevronRight className='h-4 w-4 text-slate-400' />
        ) : (
          <ChevronDown className='h-4 w-4 text-slate-400' />
        )}
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
      {!collapsed && (
        <div className='border-t border-slate-100 px-5 py-4'>
          {(() => {
            // Merge fields + optional inline owners/pdf/widgets into a sorted render list
            type RenderItem = { _k: string; sort: number } & (
              | { _t: 'field'; f: CMSField }
              | { _t: 'owners'; slot: SlotAssignment }
              | { _t: 'pdf'; slot: SlotAssignment }
              | { _t: 'widget'; slot: SlotAssignment }
            )
            const items: RenderItem[] = visibleFields_.map((f) => ({ _k: f.field, sort: f.sort ?? 0, _t: 'field' as const, f }))
            if (ownersAssignment) {
              items.push({ _k: '__owners__', sort: ownersAssignment.sort, _t: 'owners' as const, slot: ownersAssignment })
            }
            if (pdfAssignment) {
              items.push({ _k: '__pdf__', sort: pdfAssignment.sort, _t: 'pdf' as const, slot: pdfAssignment })
            }
            for (const ws of (widgetAssignments ?? [])) {
              items.push({ _k: ws.field, sort: ws.sort, _t: 'widget' as const, slot: ws })
            }
            items.sort((a, b) => a.sort - b.sort)

            return displayOnly ? (
              <div ref={gridRef} className='grid grid-cols-12 gap-x-6 gap-y-3'>
                {items.map((item) => {
                  if (item._t === 'owners') {
                    const span = item.slot.col_span ?? 12
                    return (
                      <div key='__owners__' className='min-w-0' style={{ gridColumn: `span ${span}` }}>
                        <OwnersInline collection={collection} itemId={itemId} label={item.slot.label_override || 'Owners'} />
                      </div>
                    )
                  }
                  if (item._t === 'pdf') return null
                  if (item._t === 'widget') return null
                  const f = item.f
                  const m2oRel = relations.find(
                    (r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field
                  )
                  return (
                    <div key={f.field} className='min-w-0' style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}>
                      <dt className='text-[11px] font-medium text-slate-400 truncate'>{f.label || titleCase(f.field)}</dt>
                      <dd className='mt-0.5 break-words'>
                        {m2oRel?.one_collection === 'nivaro_users'
                          ? (() => {
                              const v = draft[f.field]
                              const ids = Array.isArray(v) ? v : (v != null && v !== '' ? [v] : [])
                              return ids.length === 0
                                ? <span className='text-[13px] text-slate-400'>—</span>
                                : <div className='flex flex-wrap gap-1.5'>{ids.map((id) => <UserChip key={String(id)} userId={String(id)} />)}</div>
                            })()
                          : m2oRel?.one_collection
                            ? <RelationCell relCollection={m2oRel.one_collection} id={draft[f.field]} />
                            : <span className='text-[13px] text-slate-700'>{formatDisplayValue(draft[f.field], f)}</span>
                        }
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
                        <OwnersInline collection={collection} itemId={itemId} label={item.slot.label_override || 'Owners'} />
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
                    return (
                      <div key={item.slot.field} style={{ gridColumn: `span ${span}` }}>
                        <WidgetSlot
                          widgetId={item.slot.widget_id}
                          inputBindings={(item.slot.input_bindings ?? []) as import('../WidgetSlot').InputBinding[]}
                          itemDraft={draft}
                          label={item.slot.label_override ?? undefined}
                          defaultExpanded={item.slot.default_expanded ?? true}
                          apiBase={widgetApiBase}
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
                  const inlineRelCollection = (inlineEntries?.length && hasVal)
                    ? (relations.find((r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field)?.one_collection ?? null)
                    : null
                  const isPrimary = swapConfig?.enabled && f.field === swapConfig.primary_field
                  const primaryHasValue = (() => { const v = draft[swapConfig?.primary_field ?? '']; return v !== null && v !== undefined && v !== '' })()
                  const altHasValue = (alternateFields ?? []).some((af) => { const v = draft[af.field]; return v !== null && v !== undefined && v !== '' })
                  const swapBtn = isPrimary && onSwapToggle ? (
                    <span className='inline-flex items-center gap-1.5'>
                      <button
                        type='button'
                        onClick={onSwapToggle}
                        className='inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan hover:bg-nvr-cyan/10 transition-colors'
                      >
                        {swapped ? (swapConfig!.back_label ?? 'Back') : (swapConfig!.toggle_label ?? 'Enter manually')}
                      </button>
                      <span className={['inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium', primaryHasValue ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'].join(' ')} title='Original field'>
                        <span className={['h-1.5 w-1.5 rounded-full', primaryHasValue ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'].join(' ')} />
                        Original
                      </span>
                      <span className={['inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[9px] font-medium', altHasValue ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'].join(' ')} title='Manual fields'>
                        <span className={['h-1.5 w-1.5 rounded-full', altHasValue ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'].join(' ')} />
                        Manual
                      </span>
                    </span>
                  ) : undefined
                  const swapCnt = isPrimary && swapped && alternateFields?.length ? (
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
                    <div key={f.field} style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}>
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
