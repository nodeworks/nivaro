import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import type { ReactNode } from 'react'
import type React from 'react'
import { useRef, useState } from 'react'
import { useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { FieldRow } from './FieldRow'
import { applyDisplayTemplate, resolveColSpan, useContainerWidth } from './helpers'
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps } from './types'

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

// Async M2O display cell — fetches related record + collection display_template
function RelationCell({ relCollection, id }: { relCollection: string; id: unknown }) {
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
  if (isLoading) return <span className='text-slate-400 text-[13px]'>…</span>
  if (!record) return <span className='text-[13px] text-slate-700'>{idStr}</span>
  const label = colMeta?.display_template
    ? applyDisplayTemplate(colMeta.display_template, record)
    : String(record.name ?? record.title ?? record.label ?? record.display_name ?? idStr)
  return <span className='text-[13px] text-slate-700'>{label}</span>
}

function buildSummaryText(
  summaryFields: string[] | undefined,
  fields: CMSField[],
  draft: Record<string, unknown>,
  m2mCounts?: Record<string, number>,
  o2mCounts?: Record<string, number>
): string {
  if (!summaryFields || summaryFields.length === 0) return ''
  const parts: string[] = []
  for (const key of summaryFields.slice(0, 3)) {
    if (m2mCounts && key in m2mCounts) {
      const n = m2mCounts[key]
      if (n > 0) parts.push(`${n} items`)
      continue
    }
    if (o2mCounts && key in o2mCounts) {
      const n = o2mCounts[key]
      if (n > 0) parts.push(`${n} rows`)
      continue
    }
    const v = draft[key]
    if (v === null || v === undefined || v === '') continue
    if (Array.isArray(v)) {
      if (v.length > 0) parts.push(`${v.length} items`)
      continue
    }
    if (typeof v === 'boolean') {
      parts.push(v ? 'Yes' : 'No')
      continue
    }
    if (typeof v === 'object') continue
    const s = String(v)
    parts.push(s.length > 30 ? `${s.slice(0, 30)}…` : s)
  }
  let text = parts.join(' · ')
  if (text.length > 60) text = `${text.slice(0, 60)}…`
  return text
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
  footerSlot
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
  summaryFields?: string[]
  m2mCounts?: Record<string, number>
  o2mCounts?: Record<string, number>
  footerSlot?: ReactNode
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
  const summaryText = collapsed ? buildSummaryText(summaryFields, fields, draft, m2mCounts, o2mCounts) : ''

  return (
    <div className={cn('rounded-xl border bg-white', displayOnly ? 'border-slate-100' : 'border-slate-200')}>
      <button
        type='button'
        onClick={toggle}
        className='flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-slate-50/50'
      >
        {GroupIcon && <GroupIcon className='h-3.5 w-3.5 shrink-0 text-slate-400' />}
        <span className={cn('font-semibold text-sm shrink-0', displayOnly ? 'text-slate-500' : 'text-slate-700')}>{group.label}</span>
        {collapsed && summaryText && (
          <span className='text-[11px] text-slate-400 truncate ml-2'>{summaryText}</span>
        )}
        <span className='flex-1' />
        {hasErrors && <span className='h-2 w-2 rounded-full bg-destructive shrink-0' />}
        {collapsed ? (
          <ChevronRight className='h-4 w-4 text-slate-400' />
        ) : (
          <ChevronDown className='h-4 w-4 text-slate-400' />
        )}
      </button>
      {!collapsed && (
        <div className='border-t border-slate-100 px-5 py-4'>
          {displayOnly ? (
            <div ref={gridRef} className='grid grid-cols-12 gap-x-6 gap-y-3'>
              {visibleFields_.map((f) => {
                // Find M2O relation: current collection holds the FK
                const m2oRel = relations.find(
                  (r) => r.many_collection === collection && r.many_field === f.field && !r.junction_field
                )
                return (
                  <div key={f.field} className='min-w-0' style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}>
                    <dt className='text-[11px] font-medium text-slate-400 truncate'>{f.label || titleCase(f.field)}</dt>
                    <dd className='mt-0.5 break-words'>
                      {m2oRel?.one_collection
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
              {visibleFields_.map((f) => (
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
                  />
                </div>
              ))}
            </div>
          )}
          {footerSlot && <div className='mt-4'>{footerSlot}</div>}
        </div>
      )}
    </div>
  )
}
