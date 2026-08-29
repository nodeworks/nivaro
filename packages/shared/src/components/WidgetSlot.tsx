import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Bookmark,
  Calendar,
  Check,
  CheckCircle,
  Clipboard,
  Clock,
  Copy,
  Download,
  Edit,
  Edit2,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileText,
  Filter,
  Flag,
  Folder,
  Heart,
  HelpCircle,
  Info,
  Link,
  Lock,
  type LucideIcon,
  Mail,
  MessageSquare,
  Minus,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Pause,
  Phone,
  Play,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  Sliders,
  Star,
  Trash2,
  Unlock,
  Upload,
  User,
  UserCheck,
  UserPlus,
  Users,
  X,
  XCircle,
  Zap
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useApiFetchConfig, useDrilldown } from '../context'
import { useDebounced } from '../hooks/useDebounced'
import { useStagedRelations } from './item-edit/O2MStagingContext'
import { QueryTable, type QueryTableConfig } from './QueryTable'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from './ui/dropdown-menu'
import {
  type ReportSlotPayload,
  ReportSlotWidget,
  reportSlotScalar
} from './widgets/ReportSlotWidget'
import {
  type ReviewListConfig,
  type ReviewListResult,
  ReviewListWidget
} from './widgets/ReviewListWidget'
import { type RollupConfig, type RollupResult, RollupWidget } from './widgets/RollupWidget'

const ICON_MAP: Record<string, LucideIcon> = {
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowUpRight,
  ExternalLink,
  Link,
  Share2,
  Check,
  CheckCircle,
  X,
  XCircle,
  Plus,
  Minus,
  Edit,
  Edit2,
  Trash2,
  Save,
  Download,
  Upload,
  Send,
  Eye,
  EyeOff,
  Lock,
  Unlock,
  Star,
  Heart,
  Bookmark,
  Flag,
  AlertCircle,
  AlertTriangle,
  Info,
  HelpCircle,
  Play,
  Pause,
  RefreshCw,
  RotateCcw,
  Settings,
  Sliders,
  Filter,
  Search,
  Power,
  Zap,
  Activity,
  User,
  Users,
  UserPlus,
  UserCheck,
  Mail,
  MessageSquare,
  Phone,
  Bell,
  FileText,
  File,
  Folder,
  Paperclip,
  Calendar,
  Clock,
  Copy,
  Clipboard,
  MoreHorizontal,
  MoreVertical
}

export interface InputBinding {
  key: string
  binding_type: 'item_field' | 'static' | 'url_param'
  binding_value: string
}

function StripCell({
  label,
  value,
  display,
  loading
}: {
  label: string
  value?: unknown
  display: Record<string, unknown>
  loading?: boolean
}) {
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = loading ? null : formatStatValue(value, (display.format ?? '') as string)
  return (
    <div className='flex flex-col justify-start px-4 py-2 min-w-0'>
      <span className='flex h-4 items-end truncate text-[10px] font-medium leading-none text-slate-400 dark:text-slate-500'>
        {label}
      </span>
      {/* leading-tight, not leading-none: a field chip in the same strip uses
          it, and the shorter line box sat the value 2px higher — enough for the
          two kinds of cell to read as different rows. */}
      <span className='mt-1 leading-tight truncate max-w-[220px]'>
        {loading ? (
          <span className='animate-pulse inline-block h-3.5 w-16 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
        ) : (
          <span className='text-[13px] font-semibold tabular-nums text-slate-900 dark:text-slate-100'>
            {prefix}
            {formatted}
            {suffix}
          </span>
        )}
      </span>
    </div>
  )
}

function StripDisplay({
  data,
  label,
  loading,
  widgetConfig
}: {
  data: Record<string, unknown> | null
  label: string
  loading?: boolean
  widgetConfig?: Record<string, unknown> | null
}) {
  const wrapper = 'h-full flex items-stretch divide-x divide-slate-200 dark:divide-border'

  if (data && 'values' in data) {
    const values = (data.values ?? []) as Array<{
      value: unknown
      label: string
      display: Record<string, unknown>
    }>
    if (values.length === 0) return null
    return (
      <div className={wrapper}>
        {values.map((v, i) => (
          <StripCell
            key={i}
            label={v.label}
            value={v.value}
            display={v.display ?? {}}
            loading={false}
          />
        ))}
      </div>
    )
  }

  if (loading) {
    const vf =
      (widgetConfig?.value_fields as
        | Array<{ label?: string; prefix?: string; suffix?: string; format?: string }>
        | undefined) ?? []
    const sections = vf.length > 0 ? vf : [{ label }]
    return (
      <div className={wrapper}>
        {sections.map((v, i) => (
          <StripCell
            key={i}
            label={v.label ?? label}
            display={{ prefix: v.prefix ?? '', suffix: v.suffix ?? '', format: v.format ?? '' }}
            loading={true}
          />
        ))}
      </div>
    )
  }

  if (!data) return null
  const display = (data.display ?? {}) as Record<string, unknown>
  return (
    <div className={wrapper}>
      <StripCell label={label} value={data.value} display={display} loading={false} />
    </div>
  )
}

interface WidgetSlotProps {
  widgetId: number
  inputBindings?: InputBinding[]
  itemDraft?: Record<string, unknown>
  itemCollection?: string
  ready?: boolean
  label?: string
  defaultExpanded?: boolean
  /** Render body only — no card border/header/collapse (host provides chrome). */
  frameless?: boolean
  apiBase?: string
  compact?: boolean
  strip?: boolean
  onClientAction?: (action: ClientAction) => void
  onWidgetType?: (type: string) => void
  /**
   * Reports whether the widget has anything to show (review_list: any rows;
   * other types: any successful render; errors count as content so failures
   * stay visible). Lets a host section's hide_when_empty consider widget
   * content, not just field values.
   */
  onContentChange?: (hasContent: boolean) => void
}

function resolveDraftPath(draft: Record<string, unknown>, path: string): unknown {
  // Try exact key first (simple field names with no dots)
  if (Object.hasOwn(draft, path)) return draft[path] ?? null
  // Walk dotted path — if we hit a scalar mid-path (M2O FK value), return it directly
  const parts = path.split('.')
  let val: unknown = draft
  for (const p of parts) {
    if (val == null || typeof val !== 'object') return val ?? null
    val = (val as Record<string, unknown>)[p]
  }
  return val ?? null
}

function resolveInputs(
  bindings: InputBinding[],
  draft: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const b of bindings) {
    if (b.binding_type === 'item_field') {
      out[b.key] = resolveDraftPath(draft, b.binding_value)
    } else if (b.binding_type === 'static') {
      out[b.key] = b.binding_value
    } else if (b.binding_type === 'url_param') {
      if (typeof window !== 'undefined') {
        const sp = new URLSearchParams(window.location.search)
        out[b.key] = sp.get(b.binding_value) ?? null
      }
    }
  }
  return out
}

interface WidgetDef {
  id: number
  name: string
  widget_type: string
  inputs: Array<{ key: string; label: string; type: string; required?: boolean }> | null
  config: ({ compact_style?: string } & Record<string, unknown>) | null
}

function StatDisplay({ data }: { data: Record<string, unknown> }) {
  const display = (data.display ?? {}) as Record<string, unknown>
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = formatStatValue(data.value, (display.format ?? '') as string)
  return (
    <div className='flex items-baseline gap-1'>
      {prefix && <span className='text-[13px] text-slate-500'>{prefix}</span>}
      <span className='text-2xl font-semibold text-slate-900 dark:text-slate-100'>{formatted}</span>
      {suffix && <span className='text-[13px] text-slate-500'>{suffix}</span>}
    </div>
  )
}

function PillSection({
  label,
  value,
  display,
  dark,
  loading
}: {
  label: string
  value?: unknown
  display: Record<string, unknown>
  dark: boolean
  loading?: boolean
}) {
  const prefix = (display.prefix ?? '') as string
  const suffix = (display.suffix ?? '') as string
  const formatted = loading ? null : formatStatValue(value, (display.format ?? '') as string)
  return (
    <div className='flex flex-col justify-center px-2.5 py-1 min-w-0 gap-0.5'>
      <span
        className={`text-[9px] font-medium uppercase tracking-wider leading-none truncate ${dark ? 'text-slate-500' : 'text-slate-400'}`}
      >
        {label}
      </span>
      <span
        className={`flex items-baseline gap-0.5 text-[13px] font-semibold tabular-nums leading-none ${dark ? 'text-slate-100' : 'text-slate-900'}`}
      >
        {loading ? (
          <span
            className={`animate-pulse inline-block h-3 w-14 rounded ${dark ? 'bg-slate-600' : 'bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]'}`}
          />
        ) : (
          <>
            {prefix && (
              <span className={`text-[10px] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
                {prefix}
              </span>
            )}
            {formatted}
            {suffix && (
              <span className={`text-[10px] ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
                {suffix}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  )
}

function PillDisplay({
  data,
  label,
  style,
  loading,
  widgetConfig
}: {
  data: Record<string, unknown> | null
  label: string
  style: 'pill-dark' | 'pill-light'
  loading?: boolean
  widgetConfig?: Record<string, unknown> | null
}) {
  const dark = style === 'pill-dark'
  const base = dark
    ? 'flex items-stretch divide-x divide-slate-700 rounded-md bg-slate-800/90 border border-slate-700 overflow-hidden'
    : 'flex items-stretch divide-x divide-slate-200 rounded-md bg-white border border-slate-200 overflow-hidden dark:bg-card dark:border-border dark:divide-border'

  // Multi-value — use render data if available, else fall back to config value_fields for skeleton labels
  if (data && 'values' in data) {
    const values = (data.values ?? []) as Array<{
      value: unknown
      label: string
      display: Record<string, unknown>
    }>
    if (values.length === 0) return null
    return (
      <div className={base}>
        {values.map((v, i) => (
          <PillSection
            key={i}
            label={v.label}
            value={v.value}
            display={v.display ?? {}}
            dark={dark}
            loading={false}
          />
        ))}
      </div>
    )
  }

  if (loading) {
    // Skeleton: derive sections from widget config value_fields
    const vf =
      (widgetConfig?.value_fields as
        | Array<{ label?: string; prefix?: string; suffix?: string; format?: string }>
        | undefined) ?? []
    const sections = vf.length > 0 ? vf : [{ label }]
    return (
      <div className={base}>
        {sections.map((v, i) => (
          <PillSection
            key={i}
            label={v.label ?? label}
            display={{ prefix: v.prefix ?? '', suffix: v.suffix ?? '', format: v.format ?? '' }}
            dark={dark}
            loading={true}
          />
        ))}
      </div>
    )
  }

  if (!data) return null
  const display = (data.display ?? {}) as Record<string, unknown>
  return (
    <div className={base}>
      <PillSection label={label} value={data.value} display={display} dark={dark} loading={false} />
    </div>
  )
}

function formatStatValue(value: unknown, format: string): string {
  if (value == null) return '—'
  if (typeof value === 'number') {
    if (format === 'currency')
      return new Intl.NumberFormat(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(value)
    if (format === 'integer') return new Intl.NumberFormat().format(Math.round(value))
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)
  }
  return String(value)
}

function MultiStatDisplay({ data }: { data: Record<string, unknown> }) {
  const values = (data.values ?? []) as Array<{
    value: unknown
    label: string
    display: Record<string, unknown>
  }>
  if (values.length === 0) return <p className='text-[12px] text-slate-400'>No values</p>
  return (
    <div
      className='grid gap-3'
      style={{ gridTemplateColumns: `repeat(${Math.min(values.length, 3)}, minmax(0, 1fr))` }}
    >
      {values.map((v, i) => {
        const prefix = (v.display?.prefix ?? '') as string
        const suffix = (v.display?.suffix ?? '') as string
        const format = (v.display?.format ?? '') as string
        return (
          <div key={i} className='flex flex-col gap-0.5'>
            {v.label && (
              <span className='text-[11px] text-slate-400 dark:text-slate-500'>{v.label}</span>
            )}
            <div className='flex items-baseline gap-0.5'>
              {prefix && <span className='text-[12px] text-slate-500'>{prefix}</span>}
              <span className='text-xl font-semibold text-slate-900 dark:text-slate-100'>
                {formatStatValue(v.value, format)}
              </span>
              {suffix && <span className='text-[12px] text-slate-500'>{suffix}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ListDisplay({ data }: { data: Record<string, unknown> }) {
  const rows = (data.rows ?? []) as Array<Record<string, unknown>>
  const fields = (data.fields ?? []) as string[]
  if (rows.length === 0) return <p className='text-[12px] text-slate-400'>No items</p>
  return (
    <div className='overflow-x-auto'>
      <table className='w-full text-[12px]'>
        <thead>
          <tr className='border-b border-slate-100'>
            {fields.map((f) => (
              <th key={f} className='py-1 pr-3 text-left font-medium text-slate-500'>
                {f}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className='border-b border-slate-50'>
              {fields.map((f) => (
                <td key={f} className='py-1 pr-3 text-slate-700'>
                  {String(row[f] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ActionButtonsDisplay({
  data,
  widgetId,
  inputs,
  apiBase,
  onAction
}: {
  data: Record<string, unknown>
  widgetId: number
  inputs: Record<string, unknown>
  apiBase: string
  onAction?: (result: unknown) => void
}) {
  const buttons = (data.buttons ?? []) as Array<Record<string, unknown>>
  const [loading, setLoading] = useState<number | null>(null)
  const fetchCfg = useApiFetchConfig()

  const handleClick = async (idx: number) => {
    setLoading(idx)
    try {
      const workspace =
        typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const res = await fetch(`${apiBase}/widgets-internal/${widgetId}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...fetchCfg.authHeaders,
          ...(workspace ? { 'x-workspace': workspace } : {})
        },
        credentials: fetchCfg.credentials,
        body: JSON.stringify({ button_index: idx, inputs })
      })
      const json = (await res.json()) as { data: unknown }
      const result = json.data as Record<string, unknown>
      if (result?.redirect_url) {
        try {
          const u = new URL(result.redirect_url as string, window.location.origin)
          if (u.origin === window.location.origin) window.location.href = u.toString()
        } catch {
          /* invalid URL — ignore */
        }
      }
      onAction?.(result)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className='flex flex-wrap gap-2'>
      {buttons.map((btn, i) => {
        const style = (btn.style ?? 'secondary') as string
        const base =
          'inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50'
        const cls =
          style === 'primary'
            ? `${base} bg-nvr-cyan text-white hover:bg-nvr-cyan/90`
            : style === 'danger'
              ? `${base} bg-red-500 text-white hover:bg-red-600`
              : `${base} border border-slate-200 bg-white text-slate-700 hover:bg-slate-50`
        return (
          <button
            key={i}
            type='button'
            className={cls}
            disabled={loading !== null}
            onClick={() => handleClick(i)}
          >
            {loading === i ? '…' : String(btn.label ?? `Action ${i + 1}`)}
          </button>
        )
      })}
    </div>
  )
}

export interface ClientAction {
  type: 'open-sidebar'
  collection: string
  itemId: string
}

interface BtnGroupButton {
  id?: string
  label?: string
  icon?: string
  variant?: string
  color?: string
  action?: string
  // client: open-url
  url?: string
  new_tab?: boolean
  // client: email
  email_to?: string
  email_subject?: string
  email_body?: string
  // client: copy
  copy_value?: string
  // client: open-sidebar
  sidebar_collection?: string
  sidebar_id?: string
  // server: toggle
  toggle_input?: string
  label_on?: string
  label_off?: string
  variant_on?: string
  variant_off?: string
  toggle_on_value?: string
  is_on?: boolean
  // server actions share action_config
  action_config?: Record<string, unknown>
}

const SERVER_ACTIONS = new Set(['navigate', 'field-update', 'flow', 'toggle'])

function ButtonGroupDisplay({
  buttons,
  layout,
  widgetId,
  inputs,
  apiBase,
  onClientAction
}: {
  buttons: BtnGroupButton[]
  layout: string
  widgetId: number
  inputs: Record<string, unknown>
  apiBase: string
  onClientAction?: (action: ClientAction) => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [serverLoading, setServerLoading] = useState<string | null>(null)
  const [toggleOverrides, setToggleOverrides] = useState<Record<string, boolean>>({})
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchCfg = useApiFetchConfig()

  function normBit(v: unknown): string {
    if (v === true || v === 1) return '1'
    if (v === false || v === 0) return '0'
    return String(v ?? '')
  }

  function isToggleOn(btn: BtnGroupButton, idx: number): boolean {
    const btnId = btn.id ?? String(idx)
    if (toggleOverrides[btnId] !== undefined) return toggleOverrides[btnId]
    // prefer server-resolved state (reliable for bit fields on a different collection)
    if (btn.is_on !== undefined) return btn.is_on
    return normBit(inputs[btn.toggle_input ?? '']) === normBit(btn.toggle_on_value ?? '1')
  }

  function getToggleLabel(btn: BtnGroupButton, idx: number): string {
    if (btn.action !== 'toggle') return btn.label ?? `Action ${idx + 1}`
    const ac = btn.action_config as Record<string, unknown> | undefined
    const effectiveToggleInput =
      btn.toggle_input || (ac?.toggle_input as string) || (ac?.field as string) || ''
    const bWithInput =
      effectiveToggleInput && effectiveToggleInput !== btn.toggle_input
        ? { ...btn, toggle_input: effectiveToggleInput }
        : btn
    const on = isToggleOn(bWithInput, idx)
    return on
      ? btn.label_on || btn.label || `Action ${idx + 1}`
      : btn.label_off || btn.label || `Action ${idx + 1}`
  }

  function safeUrl(u: string): string | null {
    try {
      if (u.startsWith('/') && !u.startsWith('//')) return u
      const parsed = new URL(u, window.location.origin)
      if (['http:', 'https:'].includes(parsed.protocol)) return parsed.toString()
      return null
    } catch {
      return null
    }
  }

  async function handleServerAction(btn: BtnGroupButton, idx: number) {
    const btnId = btn.id ?? String(idx)
    setServerLoading(btnId)
    try {
      const workspace =
        typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
      const res = await fetch(`${apiBase}/widgets-internal/${widgetId}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...fetchCfg.authHeaders,
          ...(workspace ? { 'x-workspace': workspace } : {})
        },
        credentials: fetchCfg.credentials,
        body: JSON.stringify({ button_index: idx, inputs })
      })
      const json = (await res.json()) as { data: unknown }
      const result = json.data as Record<string, unknown>
      if (result?.redirect_url) {
        try {
          const u = new URL(result.redirect_url as string, window.location.origin)
          if (u.origin === window.location.origin) window.location.href = u.toString()
        } catch {
          /* invalid URL */
        }
      }
    } finally {
      setServerLoading(null)
    }
  }

  function handleClick(btn: BtnGroupButton, idx: number) {
    const action = btn.action ?? 'open-url'
    if (SERVER_ACTIONS.has(action)) {
      if (action === 'toggle') {
        const btnId = btn.id ?? String(idx)
        setToggleOverrides((prev) => ({ ...prev, [btnId]: !isToggleOn(btn, idx) }))
      }
      handleServerAction(btn, idx)
      return
    }
    if (action === 'open-url' && btn.url) {
      const target = safeUrl(btn.url)
      if (!target) return
      if (btn.new_tab) {
        window.open(target, '_blank', 'noopener,noreferrer')
      } else {
        window.location.href = target
      }
    } else if (action === 'email') {
      const parts: string[] = []
      if (btn.email_subject) parts.push(`subject=${encodeURIComponent(btn.email_subject)}`)
      if (btn.email_body) parts.push(`body=${encodeURIComponent(btn.email_body)}`)
      window.location.href = `mailto:${btn.email_to ?? ''}${parts.length ? `?${parts.join('&')}` : ''}`
    } else if (action === 'copy') {
      const val = btn.copy_value ?? ''
      navigator.clipboard.writeText(val).then(() => {
        setCopied(btn.id ?? String(idx))
        if (copiedTimer.current) clearTimeout(copiedTimer.current)
        copiedTimer.current = setTimeout(() => setCopied(null), 1800)
      })
    } else if (action === 'open-sidebar' && btn.sidebar_collection && btn.sidebar_id) {
      onClientAction?.({
        type: 'open-sidebar',
        collection: btn.sidebar_collection,
        itemId: btn.sidebar_id
      })
    }
  }

  function isLightColor(hex: string): boolean {
    const c = hex.replace('#', '')
    if (c.length < 6) return true
    const r = parseInt(c.slice(0, 2), 16)
    const g = parseInt(c.slice(2, 4), 16)
    const b = parseInt(c.slice(4, 6), 16)
    return (r * 299 + g * 587 + b * 114) / 1000 > 128
  }

  function renderBtn(btn: BtnGroupButton, idx: number, variant?: string) {
    const btnId = btn.id ?? String(idx)
    const isCopied = copied === btnId
    const isLoading = serverLoading === btnId

    let label = btn.label ?? 'Button'
    let v = (variant ?? btn.variant ?? 'secondary') as
      | 'default'
      | 'secondary'
      | 'destructive'
      | 'outline'
      | 'ghost'

    const ac = btn.action_config as Record<string, unknown> | undefined
    const effectiveToggleInput =
      btn.toggle_input || (ac?.toggle_input as string) || (ac?.field as string) || ''
    if (btn.action === 'toggle') {
      const bWithInput =
        effectiveToggleInput && effectiveToggleInput !== btn.toggle_input
          ? { ...btn, toggle_input: effectiveToggleInput }
          : btn
      const on = isToggleOn(bWithInput, idx)
      label = on ? btn.label_on || label : btn.label_off || label
      v = (on ? (btn.variant_on ?? v) : (btn.variant_off ?? v)) as typeof v
    }

    const IconComp = btn.icon ? ICON_MAP[btn.icon] : null
    const colorStyle = btn.color
      ? ({
          backgroundColor: btn.color,
          borderColor: btn.color,
          color: isLightColor(btn.color) ? '#1e293b' : '#ffffff'
        } as React.CSSProperties)
      : undefined

    return (
      <Button
        key={btnId}
        type='button'
        variant={v}
        size='sm'
        className='h-7 gap-1.5 text-[12px]'
        style={colorStyle}
        disabled={serverLoading !== null}
        onClick={() => handleClick(btn, idx)}
      >
        {IconComp && <IconComp className='h-3.5 w-3.5 shrink-0' />}
        {isLoading ? '…' : isCopied ? '✓ Copied' : label}
      </Button>
    )
  }

  if (buttons.length === 0) return null

  if (layout === 'split' && buttons.length > 1) {
    const [primary, ...rest] = buttons
    const primaryId = primary.id ?? '0'
    const primaryLoading = serverLoading === primaryId
    const isLabelOnly = primary.action === 'none' || !primary.action

    let primaryLabel = primary.label ?? 'Button'
    let primaryVariant = (primary.variant ?? 'default') as
      | 'default'
      | 'secondary'
      | 'destructive'
      | 'outline'
      | 'ghost'
    const primaryAc = primary.action_config as Record<string, unknown> | undefined
    const primaryToggleInput =
      primary.toggle_input ||
      (primaryAc?.toggle_input as string) ||
      (primaryAc?.field as string) ||
      ''
    if (primary.action === 'toggle' && primaryToggleInput) {
      const pWithInput =
        primaryToggleInput !== primary.toggle_input
          ? { ...primary, toggle_input: primaryToggleInput }
          : primary
      const on = isToggleOn(pWithInput, 0)
      primaryLabel = on ? primary.label_on || primaryLabel : primary.label_off || primaryLabel
      primaryVariant = (
        on ? (primary.variant_on ?? primaryVariant) : (primary.variant_off ?? primaryVariant)
      ) as typeof primaryVariant
    }

    const PrimaryIconComp = primary.icon ? ICON_MAP[primary.icon] : null
    const primaryColorStyle = primary.color
      ? ({
          backgroundColor: primary.color,
          borderColor: primary.color,
          color: isLightColor(primary.color) ? '#1e293b' : '#ffffff'
        } as React.CSSProperties)
      : undefined

    // Label-only primary: single unified dropdown trigger (label + chevron in one button)
    if (isLabelOnly) {
      return (
        <div className='flex items-center'>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type='button'
                variant={primaryVariant}
                size='sm'
                className='h-7 gap-1.5 text-[12px]'
                style={primaryColorStyle}
                disabled={serverLoading !== null}
              >
                {PrimaryIconComp && <PrimaryIconComp className='h-3.5 w-3.5 shrink-0' />}
                {primaryLabel}
                <svg width='12' height='12' viewBox='0 0 12 12' fill='none' aria-hidden='true'>
                  <path
                    d='M2 4L6 8L10 4'
                    stroke='currentColor'
                    strokeWidth='1.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  />
                </svg>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align='end' className='min-w-[140px]'>
              {rest.map((btn, i) => (
                <DropdownMenuItem
                  key={btn.id ?? i}
                  className='cursor-pointer text-[12px]'
                  onSelect={() => handleClick(btn, i + 1)}
                >
                  {btn.icon &&
                    ICON_MAP[btn.icon] &&
                    (() => {
                      const IC = ICON_MAP[btn.icon!]
                      return <IC className='mr-1.5 h-3.5 w-3.5 shrink-0' />
                    })()}
                  {getToggleLabel(btn, i + 1)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )
    }

    return (
      <div className='flex items-center'>
        <Button
          type='button'
          variant={primaryVariant}
          size='sm'
          className='h-7 rounded-r-none text-[12px] gap-1.5 border-r-0'
          style={primaryColorStyle}
          disabled={serverLoading !== null}
          onClick={() => handleClick(primary, 0)}
        >
          {PrimaryIconComp && <PrimaryIconComp className='h-3.5 w-3.5 shrink-0' />}
          {primaryLoading ? '…' : copied === primaryId ? '✓ Copied' : primaryLabel}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type='button'
              variant={primaryVariant}
              size='sm'
              className='h-7 rounded-l-none px-1.5 text-[12px]'
              style={primaryColorStyle}
              disabled={serverLoading !== null}
              aria-label='More actions'
            >
              <svg width='12' height='12' viewBox='0 0 12 12' fill='none' aria-hidden='true'>
                <path
                  d='M2 4L6 8L10 4'
                  stroke='currentColor'
                  strokeWidth='1.5'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                />
              </svg>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='min-w-[140px]'>
            {rest.map((btn, i) => (
              <DropdownMenuItem
                key={btn.id ?? i}
                className='text-[12px]'
                onSelect={() => handleClick(btn, i + 1)}
              >
                {btn.icon &&
                  ICON_MAP[btn.icon] &&
                  (() => {
                    const IC = ICON_MAP[btn.icon!]
                    return <IC className='mr-1.5 h-3.5 w-3.5 shrink-0' />
                  })()}
                {getToggleLabel(btn, i + 1)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    )
  }

  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {buttons.map((btn, i) => renderBtn(btn, i))}
    </div>
  )
}

export function WidgetSlot({
  widgetId,
  inputBindings = [],
  itemDraft = {},
  itemCollection,
  ready = true,
  label,
  defaultExpanded = true,
  frameless = false,
  apiBase: apiBaseProp,
  compact = false,
  strip = false,
  onClientAction,
  onWidgetType,
  onContentChange
}: WidgetSlotProps) {
  const fetchCfg = useApiFetchConfig()
  const apiBase = apiBaseProp ?? fetchCfg.apiBase
  const [open, setOpen] = useState(defaultExpanded)
  const [widget, setWidget] = useState<WidgetDef | null>(null)
  const [renderData, setRenderData] = useState<Record<string, unknown> | null>(null)
  const [defLoading, setDefLoading] = useState(true)
  const [renderLoading, setRenderLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Bumped by review_list's onRefetch after a group PATCH settles — included
  // (undebounced) in the render effect's deps to force an immediate refetch.
  const [refetchTick, setRefetchTick] = useState(0)
  // First-load marker: input-driven render refetches keep stale values on
  // screen instead of flashing the skeleton.
  const hasRenderDataRef = useRef(false)

  // Auto-include scalar item draft fields so toggle/field-update actions work
  // without requiring explicit input bindings for every field. Explicit bindings override.
  const draftScalars: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(itemDraft)) {
    if (v == null || typeof v !== 'object') draftScalars[k] = v
  }
  const inputs = { ...draftScalars, ...resolveInputs(inputBindings, itemDraft) }

  // Staged grandchild changes published by the form's grids (unit allocations
  // under pending/queued lines). A rollup widget targeting that collection
  // sends them with the render so its tree reflects unsaved work.
  const stagedRels = useStagedRelations()
  const rollupStaged = useMemo(() => {
    if (widget?.widget_type !== 'rollup' || !stagedRels) return null
    const cfg = widget.config as { collection?: string } | undefined
    const target = cfg?.collection
    if (!target) return null
    const merged = {
      created: [] as Record<string, unknown>[],
      updated: [] as Array<{ id: string | number; values: Record<string, unknown> }>,
      deleted: [] as Array<string | number>
    }
    for (const byCollection of stagedRels.byGrid.values()) {
      const ops = byCollection[target]
      if (!ops) continue
      merged.created.push(...ops.created)
      merged.updated.push(...ops.updated)
      merged.deleted.push(...ops.deleted)
    }
    if (!merged.created.length && !merged.updated.length && !merged.deleted.length) return null
    return merged
  }, [widget, stagedRels])
  const rollupStagedKey = useMemo(
    () => (rollupStaged ? JSON.stringify(rollupStaged) : ''),
    [rollupStaged]
  )

  // Config-driven drill-down: a widget may declare which record its numbers
  // describe, making the whole cell clickable into the standard record sheet.
  // `id_input` names the resolved input carrying the id; when that input holds
  // a HUMAN id (project_id, workflow_id …) rather than a PK, `match_field`
  // says which column to look it up by.
  const drilldown = (widget?.config as Record<string, unknown> | undefined)?.drilldown as
    | {
        collection?: string
        id_input?: string
        match_field?: string
        layout_id?: number | null
        width?: number | string | null
        title?: string
      }
    | undefined
  const drill = useDrilldown()
  const drillValue = drilldown?.id_input ? inputs[drilldown.id_input] : null
  const canDrill = !!drill && !!drilldown?.collection && drillValue != null && drillValue !== ''

  const openDrilldown = async () => {
    if (!canDrill || !drilldown?.collection) return
    const raw = String(drillValue)
    let itemId: string | null = null
    // The same widget can be bound to a PK on one layout and to a HUMAN id on
    // another (workflows binds project → FK; the projects layout binds the
    // project_id string), so resolve tolerantly instead of trusting one shape:
    // try the configured lookup column, then fall back to treating the value
    // as a primary key. Silent on failure — an unresolvable id means no sheet,
    // never a broken-looking error in a header cell.
    const req = (path: string) =>
      fetch(`${apiBase}${path}`, {
        credentials: fetchCfg.credentials,
        headers: fetchCfg.authHeaders
      })
    try {
      if (drilldown.match_field) {
        const res = await req(
          `/items/${drilldown.collection}?filter=${encodeURIComponent(
            JSON.stringify({ [drilldown.match_field]: { _eq: raw } })
          )}&fields=id&limit=1`
        )
        if (res.ok) {
          const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
          const found = body?.data?.[0]?.id
          if (found != null) itemId = String(found)
        }
      }
      if (itemId == null) {
        const res = await req(`/items/${drilldown.collection}/${encodeURIComponent(raw)}?fields=id`)
        if (res.ok) itemId = raw
      }
    } catch {
      return
    }
    if (itemId == null) return
    drill?.open({
      collection: drilldown.collection,
      itemId,
      layoutId: drilldown.layout_id ?? null,
      width: drilldown.width ?? '75%',
      title: drilldown.title
    })
  }
  // A record-scoped widget (review_list / rollup) hard-requires `record_id` and
  // 400s without it, but every `__widget_N__` slot assignment in the wild has
  // `overrides = null` — no binding was ever configured, so nothing supplied it.
  // On a record page the answer is almost always "this record", so fall back to
  // the host record's own id. An explicit binding still wins.
  if (inputs.record_id == null || inputs.record_id === '') {
    const hostId = itemDraft.id
    if (hostId != null && hostId !== '') inputs.record_id = hostId
  }
  const inputsKey = JSON.stringify(inputs) + (itemCollection ?? '') + rollupStagedKey
  // Every scalar draft field feeds inputs, so inputsKey changes per keystroke
  // while editing the parent form — debounce so render refetches settle.
  const debouncedInputsKey = useDebounced(inputsKey, 400)

  function buildHeaders(): Record<string, string> {
    const workspace =
      typeof window !== 'undefined' ? (localStorage.getItem('nivaro_workspace') ?? '') : ''
    return {
      'Content-Type': 'application/json',
      ...fetchCfg.authHeaders,
      ...(workspace ? { 'x-workspace': workspace } : {})
    }
  }

  // Widget DEFINITION — depends only on the widget id. Kept separate from the
  // render fetch so parent-form edits never re-load the definition (which is
  // what used to flash the whole slot back to its skeleton).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchCfg/buildHeaders are recreated per render but stable in content; keying on them would refire every render
  useEffect(() => {
    if (!ready) return
    let cancelled = false
    setDefLoading(true)
    setError(null)
    ;(async () => {
      try {
        const defRes = await fetch(`${apiBase}/widgets-internal/${widgetId}`, {
          credentials: fetchCfg.credentials,
          headers: buildHeaders()
        })
        if (cancelled) return
        if (!defRes.ok) throw new Error('Widget not found')
        const defJson = (await defRes.json()) as { data: WidgetDef }
        if (!cancelled) {
          setWidget(defJson.data)
          setDefLoading(false)
          onWidgetType?.(defJson.data.widget_type)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [widgetId, apiBase, ready])

  // Render data — refetches when the (debounced) inputs change. Stale values
  // stay on screen during a refetch; the skeleton only shows on first load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: inputs/itemDraft/bindings are captured via debouncedInputsKey; fetchCfg/buildHeaders stable in content
  useEffect(() => {
    if (!ready) return
    // The definition arrives from a SEPARATE effect, and `widget` was missing
    // from this effect's deps — so on mount the type guard below read null,
    // failed to match, and fired a render the server rejected with 400. Wait
    // for the definition (the effect now re-runs when widget_type lands).
    if (!widget) return
    // review_list/rollup have no meaning for a record that doesn't exist yet
    // — the server 400s on a missing record_id. Skip the fetch entirely
    // rather than surfacing that 400 as a sticky "Render failed" (the
    // null-render gate below already handles the empty-record display).
    if (
      (widget.widget_type === 'review_list' || widget.widget_type === 'rollup') &&
      (inputs.record_id == null || inputs.record_id === '')
    ) {
      return
    }

    let cancelled = false
    if (!hasRenderDataRef.current) {
      setRenderLoading(true)
      setLoading(true)
    }
    ;(async () => {
      try {
        const renderRes = await fetch(`${apiBase}/widgets-internal/${widgetId}/render`, {
          method: 'POST',
          credentials: fetchCfg.credentials,
          headers: buildHeaders(),
          body: JSON.stringify({
            inputs: rollupStaged ? { ...inputs, staged: rollupStaged } : inputs,
            draft: itemDraft,
            bindings: inputBindings,
            item_collection: itemCollection
          })
        })
        if (cancelled) return
        if (!renderRes.ok) throw new Error('Render failed')
        const renderJson = (await renderRes.json()) as { data: Record<string, unknown> }
        if (!cancelled) {
          hasRenderDataRef.current = true
          setRenderData(renderJson.data)
          setRenderLoading(false)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [widgetId, apiBase, debouncedInputsKey, ready, refetchTick, widget?.widget_type])

  // Content report for hide_when_empty hosts. No report while loading with
  // nothing fetched yet — the host treats unreported widgets as empty.
  useEffect(() => {
    if (!onContentChange) return
    if (error) {
      onContentChange(true)
      return
    }
    if (!renderData) return
    if (widget?.widget_type === 'review_list' || widget?.widget_type === 'rollup') {
      const rows = (renderData as { rows?: unknown }).rows
      onContentChange(Array.isArray(rows) && rows.length > 0)
      return
    }
    if (widget?.widget_type === 'custom-query' && 'rows' in (renderData as object)) {
      const rows = (renderData as { rows?: unknown }).rows
      onContentChange(Array.isArray(rows) && rows.length > 0)
      return
    }
    onContentChange(true)
  }, [renderData, error, widget?.widget_type, onContentChange])

  // No id fallback while the definition loads — "Widget 8" flashing before
  // the real name reads as a bug. Blank until we know the name.
  const title = label || widget?.name || ''

  // Report-widget payloads nest their numbers under `data` — reduce to the
  // flat {value, display} shape the strip/pill/stat cells render.
  const displayRenderData =
    widget?.widget_type === 'report_widget' && renderData
      ? (reportSlotScalar(renderData as unknown as ReportSlotPayload) as unknown as Record<
          string,
          unknown
        >)
      : renderData

  // review_list/rollup have no meaning for a record that doesn't exist yet
  // (no rows to reach via the relation path) — render nothing rather than
  // surfacing the render endpoint's 400 for a missing record_id. Mirrors the
  // server's own emptiness check (renderWidget's review_list/rollup branch)
  // so a falsy-but-valid id (e.g. 0) isn't misread as "new".
  const reviewListRecordId = inputs.record_id
  if (
    (widget?.widget_type === 'review_list' || widget?.widget_type === 'rollup') &&
    (reviewListRecordId == null || reviewListRecordId === '')
  )
    return null

  if (compact) {
    const compactStyle = (widget?.config?.compact_style as string | undefined) ?? 'default'
    const isPill = compactStyle === 'pill-dark' || compactStyle === 'pill-light'

    if (error)
      return (
        <span className='text-[11px] text-red-400' title={error}>
          !
        </span>
      )

    // Strip mode: dedicated band below header, full-height cells with dividers
    if (strip) {
      if (defLoading) {
        return (
          <div className='flex flex-col justify-center border-r border-slate-200 dark:border-border px-4 py-2.5 w-36'>
            <span className='animate-pulse h-2 w-10 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))] mb-1' />
            <span className='animate-pulse h-3.5 w-20 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
          </div>
        )
      }
      // Button-group doesn't fit the stat cell model — render inline in the strip
      if (widget!.widget_type === 'button-group') {
        return (
          <div className='h-full flex items-center px-3'>
            {renderLoading ? (
              <div className='animate-pulse h-7 w-24 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
            ) : (
              renderData && (
                <ButtonGroupDisplay
                  buttons={(renderData.buttons ?? []) as BtnGroupButton[]}
                  layout={(renderData.layout as string) ?? 'flat'}
                  widgetId={widgetId}
                  inputs={inputs}
                  apiBase={apiBase}
                  onClientAction={onClientAction}
                />
              )
            )}
          </div>
        )
      }
      {
        const strip = (
          <StripDisplay
            data={renderLoading ? null : (displayRenderData ?? null)}
            label={label || widget!.name}
            loading={renderLoading}
            widgetConfig={widget!.config}
          />
        )
        // Clickable only when the widget declares what record it describes and
        // a host provides the drill-down sheet — otherwise it stays inert text.
        return canDrill ? (
          <button
            type='button'
            onClick={() => void openDrilldown()}
            title={drilldown?.title ?? 'Open details'}
            className='h-full w-full cursor-pointer text-left transition-colors hover:bg-nvr-cyan/5'
            data-nvr-widget-drill={drilldown?.collection}
          >
            {strip}
          </button>
        ) : (
          strip
        )
      }
    }

    if (isPill) {
      // Skeleton until widget def loads
      if (defLoading) {
        return (
          <div
            className={`animate-pulse h-8 w-36 rounded-md ${compactStyle === 'pill-dark' ? 'bg-slate-700 border border-slate-700' : 'bg-slate-100 dark:bg-[hsl(var(--nvr-skeleton))] border border-slate-200'}`}
          />
        )
      }
      {
        const pill = (
          <PillDisplay
            data={renderLoading ? null : (displayRenderData ?? null)}
            label={label || widget!.name}
            style={compactStyle as 'pill-dark' | 'pill-light'}
            loading={renderLoading}
            widgetConfig={widget!.config}
          />
        )
        return canDrill ? (
          <button
            type='button'
            onClick={() => void openDrilldown()}
            title={drilldown?.title ?? 'Open details'}
            className='cursor-pointer text-left'
            data-nvr-widget-drill={drilldown?.collection}
          >
            {pill}
          </button>
        ) : (
          pill
        )
      }
    }

    // Default compact style — show label skeleton while def loads, value skeleton while rendering
    if (defLoading) {
      return (
        <div className='animate-pulse h-4 w-20 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
      )
    }
    return (
      <div className='flex items-center gap-1.5'>
        {renderLoading ? (
          <div className='flex items-baseline gap-1'>
            <div className='animate-pulse h-5 w-20 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
          </div>
        ) : (
          renderData &&
          widget && (
            <>
              {(widget.widget_type === 'stat' ||
                (widget.widget_type === 'custom-query' && 'value' in renderData)) && (
                <StatDisplay data={renderData} />
              )}
              {widget.widget_type === 'report_widget' && displayRenderData && (
                <StatDisplay data={displayRenderData} />
              )}
              {widget.widget_type === 'custom-query' && 'values' in renderData && (
                <MultiStatDisplay data={renderData} />
              )}
              {widget.widget_type === 'action-buttons' && (
                <ActionButtonsDisplay
                  data={renderData}
                  widgetId={widgetId}
                  inputs={inputs}
                  apiBase={apiBase}
                />
              )}
              {widget.widget_type === 'button-group' && (
                <ButtonGroupDisplay
                  buttons={(renderData.buttons ?? []) as BtnGroupButton[]}
                  layout={(renderData.layout as string) ?? 'flat'}
                  widgetId={widgetId}
                  inputs={inputs}
                  apiBase={apiBase}
                  onClientAction={onClientAction}
                />
              )}
            </>
          )
        )}
      </div>
    )
  }

  // Body-height skeleton while a widget resolves — a bare "Loading…" line was
  // ~16px tall, so the real body arriving shoved everything below it down.
  const bodySkeleton = (
    <div className='space-y-2 py-0.5'>
      <div className='animate-pulse h-4 w-2/3 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
      <div className='animate-pulse h-4 w-full rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
      <div className='animate-pulse h-4 w-5/6 rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
    </div>
  )

  // Host-provided chrome (group sections, container tabs) → body only.
  if (frameless) {
    return (
      <div>
        {loading && bodySkeleton}
        {error && <p className='text-[12px] text-red-500'>{error}</p>}
        {!loading && !error && renderData && widget && renderTypedBody()}
      </div>
    )
  }

  return (
    <div className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <button
        type='button'
        className='flex w-full items-center justify-between px-4 py-3 text-left'
        onClick={() => setOpen((o) => !o)}
      >
        <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
          {title || (
            <span className='inline-block h-3 w-28 animate-pulse rounded bg-[hsl(var(--nvr-skeleton))] align-middle' />
          )}
        </span>
        <span className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
      </button>
      {open && (
        <div className='border-t border-slate-100 px-4 py-3 dark:border-border'>
          {loading && bodySkeleton}
          {error && <p className='text-[12px] text-red-500'>{error}</p>}
          {!loading && !error && renderData && widget && renderTypedBody()}
        </div>
      )}
    </div>
  )

  function renderTypedBody() {
    if (!renderData || !widget) return null
    return (
      <>
        {(widget.widget_type === 'stat' ||
          (widget.widget_type === 'custom-query' && 'value' in renderData)) && (
          <StatDisplay data={renderData} />
        )}
        {widget.widget_type === 'custom-query' && 'values' in renderData && (
          <MultiStatDisplay data={renderData} />
        )}
        {widget.widget_type === 'list' && <ListDisplay data={renderData} />}
        {widget.widget_type === 'custom-query' && 'rows' in renderData && (
          <QueryTable
            rows={(renderData.rows ?? []) as Array<Record<string, unknown>>}
            config={(widget.config as { table?: QueryTableConfig })?.table}
            emptyLabel={title}
          />
        )}
        {widget.widget_type === 'review_list' && (
          <ReviewListWidget
            data={renderData as unknown as ReviewListResult}
            config={(widget.config ?? {}) as unknown as ReviewListConfig}
            onRefetch={() => setRefetchTick((t) => t + 1)}
            hostRecordId={inputs.record_id as string | number | null}
            emptyLabel={title}
          />
        )}
        {widget.widget_type === 'rollup' && (
          <RollupWidget
            data={renderData as unknown as RollupResult}
            config={(widget.config ?? {}) as unknown as RollupConfig}
            emptyLabel={title}
          />
        )}
        {widget.widget_type === 'report_widget' && (
          <ReportSlotWidget payload={renderData as unknown as ReportSlotPayload} />
        )}
        {widget.widget_type === 'action-buttons' && (
          <ActionButtonsDisplay
            data={renderData}
            widgetId={widgetId}
            inputs={inputs}
            apiBase={apiBase}
          />
        )}
        {widget.widget_type === 'button-group' && (
          <ButtonGroupDisplay
            buttons={(renderData.buttons ?? []) as BtnGroupButton[]}
            layout={(renderData.layout as string) ?? 'flat'}
            widgetId={widgetId}
            inputs={inputs}
            apiBase={apiBase}
            onClientAction={onClientAction}
          />
        )}
        {![
          'stat',
          'list',
          'action-buttons',
          'custom-query',
          'button-group',
          'review_list',
          'rollup',
          'report_widget'
        ].includes(widget.widget_type) && (
          <pre className='whitespace-pre-wrap text-[11px] text-slate-500'>
            {JSON.stringify(renderData, null, 2)}
          </pre>
        )}
      </>
    )
  }
}
