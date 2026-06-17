import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'
import type { CMSField, CMSRelation, FieldGroup, RenderFieldProps } from './types'
import { FieldRow, getColSpanClass } from './FieldRow'

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
  renderField
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
  renderField?: (props: RenderFieldProps) => ReactNode
}) {
  const [collapsed, setCollapsed] = useState(group.is_collapsed ?? false)
  const hasErrors = fields.some((f) => errors[f.field])
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
          <div className='grid grid-cols-12 gap-4 items-start'>
            {fields
              .filter((f) => !f.hidden)
              .map((f) => (
                <div key={f.field} className={getColSpanClass(f.options)}>
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
                    renderField={renderField}
                  />
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
