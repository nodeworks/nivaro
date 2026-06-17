import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useRef, useState } from 'react'
import { FieldRow } from './FieldRow'
import { resolveColSpan, useContainerWidth } from './helpers'
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps } from './types'

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
  renderField?: (props: RenderFieldProps) => ReactNode
  onCountChange?: (field: string, count: number) => void
}) {
  const [collapsed, setCollapsed] = useState(group.is_collapsed ?? false)
  const hasErrors = fields.some((f) => errors[f.field])
  const gridRef = useRef<HTMLDivElement>(null)
  const containerWidth = useContainerWidth(gridRef)

  return (
    <div className='overflow-hidden rounded-xl border border-slate-200 bg-white'>
      <button
        type='button'
        onClick={() => setCollapsed((v) => !v)}
        className='flex w-full items-center gap-2.5 px-5 py-3.5 text-left hover:bg-slate-50/50'
      >
        <span className='font-semibold text-sm text-slate-700 flex-1'>{group.label}</span>
        {hasErrors && <span className='h-2 w-2 rounded-full bg-destructive shrink-0' />}
        {collapsed ? (
          <ChevronRight className='h-4 w-4 text-slate-400' />
        ) : (
          <ChevronDown className='h-4 w-4 text-slate-400' />
        )}
      </button>
      {!collapsed && (
        <div className='border-t border-slate-100 px-5 py-5'>
          <div ref={gridRef} className='grid grid-cols-12 gap-4 items-start'>
            {fields
              .filter((f) => !f.hidden)
              .map((f) => (
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
        </div>
      )}
    </div>
  )
}
