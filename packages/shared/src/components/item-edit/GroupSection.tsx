import { ChevronDown, ChevronRight } from 'lucide-react'
import * as LucideIcons from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { FC, ReactNode } from 'react'
import { useRef, useState } from 'react'
import { cn, titleCase } from '../../lib/utils'
import { FieldRow } from './FieldRow'
import { resolveColSpan, useContainerWidth } from './helpers'
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps } from './types'

function resolveIcon(name: string | null | undefined): FC<LucideProps> | null {
  if (!name) return null
  const pascal = name.replace(/(^|-)([a-z])/g, (_, _sep, c: string) => c.toUpperCase())
  const icon = (LucideIcons as Record<string, unknown>)[pascal]
  return typeof icon === 'function' ? (icon as FC<LucideProps>) : null
}

function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'object') {
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  const s = String(value)
  // ISO datetime → locale string
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    try { return new Date(s).toLocaleString() } catch { /* noop */ }
  }
  return s
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
  onCountChange
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
}) {
  const [collapsed, setCollapsed] = useState(group.is_collapsed ?? false)
  const hasErrors = !displayOnly && fields.some((f) => errors[f.field])
  const gridRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(gridRef)
  const GroupIcon = resolveIcon(group.icon)

  const visibleFields_ = fields.filter((f) => !f.hidden)

  return (
    <div className={cn('rounded-xl border bg-white', displayOnly ? 'border-slate-100' : 'border-slate-200')}>
      <button
        type='button'
        onClick={() => setCollapsed((v) => !v)}
        className='flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-slate-50/50'
      >
        {GroupIcon && <GroupIcon className='h-3.5 w-3.5 shrink-0 text-slate-400' />}
        <span className={cn('font-semibold text-sm flex-1', displayOnly ? 'text-slate-500' : 'text-slate-700')}>{group.label}</span>
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
              {visibleFields_.map((f) => (
                <div key={f.field} className='min-w-0' style={{ gridColumn: `span ${resolveColSpan(f.options, containerWidth)}` }}>
                  <dt className='text-[11px] font-medium text-slate-400 truncate'>{f.label ?? titleCase(f.field)}</dt>
                  <dd className='mt-0.5 text-[13px] text-slate-700 break-words'>{formatDisplayValue(draft[f.field])}</dd>
                </div>
              ))}
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
        </div>
      )}
    </div>
  )
}
