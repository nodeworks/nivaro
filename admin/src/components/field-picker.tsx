import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Loader2, Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, type CMSField, type CMSRelation } from '@/lib/api'
import { titleCase } from '@/lib/utils'

export interface PickedField {
  path: string[]
  pathLabels: string[]
  fieldType: string
  /**
   * When the field was selected from inside a relation traversal (dotted path),
   * this is the collection of that traversal level (e.g. picking `region.name`
   * yields relatedCollection = 'regions'). Undefined for top-level plain fields.
   */
  relatedCollection?: string
}

interface FieldPickerProps {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  value: string
  valueLabel?: string
  onChange: (picked: PickedField) => void
  onClear?: () => void
  placeholder?: string
}

export function FieldPicker({
  collection,
  fields,
  relations,
  value,
  valueLabel,
  onChange,
  onClear,
  placeholder
}: FieldPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const filtered = fields.filter((f) => f.field.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className='relative' ref={containerRef}>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
      >
        <span
          className={
            value
              ? 'font-mono text-[12px] flex-1 text-left truncate'
              : 'text-slate-400 flex-1 text-left'
          }
        >
          {valueLabel || value || placeholder || 'Select field…'}
        </span>
        {value && onClear ? (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onClear()
            }}
            className='flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600'
          >
            <X className='h-3 w-3' />
          </button>
        ) : (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400 shrink-0' />
        )}
      </button>
      {open && (
        <div className='absolute left-0 top-full z-50 mt-1 w-72 rounded-xl border border-slate-200 bg-white shadow-lg'>
          <div className='p-2'>
            <div className='relative mb-1.5'>
              <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='Search fields…'
                className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
              />
            </div>
            <div className='max-h-72 overflow-y-auto'>
              {filtered.map((f) => (
                <PickerFieldRow
                  key={f.field}
                  field={f}
                  collection={collection}
                  relations={relations}
                  pathPrefix={[]}
                  labelPrefix={[]}
                  depth={0}
                  onSelect={(picked) => {
                    onChange(picked)
                    setOpen(false)
                  }}
                />
              ))}
              {filtered.length === 0 && (
                <div className='px-2 py-3 text-center text-[12px] text-slate-400'>No fields</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function PickerRelatedFields({
  relatedCollection,
  pathPrefix,
  labelPrefix,
  depth,
  onSelect
}: {
  relatedCollection: string
  pathPrefix: string[]
  labelPrefix: string[]
  depth: number
  onSelect: (picked: PickedField) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data)
  })

  if (isLoading) {
    return (
      <div
        style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        className='py-2 text-[12px] text-slate-400 flex items-center gap-2'
      >
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Loading…
      </div>
    )
  }

  const relFields: CMSField[] = (data?.fields ?? []).filter((f: CMSField) => !f.hidden)
  const relRelations: CMSRelation[] = data?.relations ?? []

  return (
    <div>
      {relFields.map((f) => (
        <PickerFieldRow
          key={f.field}
          field={f}
          collection={relatedCollection}
          relations={relRelations}
          pathPrefix={pathPrefix}
          labelPrefix={labelPrefix}
          depth={depth}
          onSelect={onSelect}
        />
      ))}
      {relFields.length === 0 && (
        <div
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
          className='px-2 py-1.5 text-[12px] text-slate-400'
        >
          No fields
        </div>
      )}
    </div>
  )
}

interface PickerFieldRowProps {
  field: CMSField
  collection: string
  relations: CMSRelation[]
  pathPrefix: string[]
  labelPrefix: string[]
  depth: number
  onSelect: (picked: PickedField) => void
}

export function CollectionFieldPicker({
  collection,
  value,
  valueLabel,
  onChange,
  onClear,
  placeholder
}: {
  collection: string
  value: string
  valueLabel?: string
  onChange: (picked: PickedField) => void
  onClear?: () => void
  placeholder?: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  if (!collection) {
    return (
      <div className='flex h-8 items-center rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[12px] text-slate-400'>
        No collection bound
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className='flex h-8 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 text-[12px] text-slate-400'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Loading fields…
      </div>
    )
  }

  const fields: CMSField[] = (data?.fields ?? []).filter((f: CMSField) => !f.hidden)
  const relations: CMSRelation[] = data?.relations ?? []

  return (
    <FieldPicker
      collection={collection}
      fields={fields}
      relations={relations}
      value={value}
      valueLabel={valueLabel}
      onChange={onChange}
      onClear={onClear}
      placeholder={placeholder}
    />
  )
}

function PickerFieldRow({
  field,
  collection,
  relations,
  pathPrefix,
  labelPrefix,
  depth,
  onSelect
}: PickerFieldRowProps) {
  const [expanded, setExpanded] = useState(false)

  const m2oRel =
    relations.find(
      (r) =>
        r.many_collection === collection &&
        r.many_field === field.field &&
        r.junction_field === null &&
        r.one_collection
    ) ?? null

  // M2M junction-side: this collection is the junction table's many_field
  const m2mRelJunction = !m2oRel
    ? (relations.find(
        (r) =>
          r.many_collection === collection &&
          r.many_field === field.field &&
          r.junction_field !== null &&
          r.one_collection
      ) ?? null)
    : null

  // M2M parent-side: this collection is the one_collection referenced by a junction
  const m2mRelParent =
    !m2oRel && !m2mRelJunction
      ? (relations.find(
          (r) =>
            r.one_collection === collection &&
            r.one_field === field.field &&
            r.junction_field !== null &&
            r.many_collection
        ) ?? null)
      : null

  const m2mRel = m2mRelJunction ?? m2mRelParent

  // True O2M: junction_field must be null to exclude M2M junctions
  const o2mRel =
    !m2oRel && !m2mRel
      ? (relations.find(
          (r) =>
            r.one_collection === collection &&
            r.one_field === field.field &&
            r.junction_field === null &&
            r.many_collection
        ) ?? null)
      : null

  // For M2M parent-side, resolve through the junction to the actual related collection.
  // getRelations() now returns junction FKs, so we can find the other side here.
  const m2mParentTargetRel = m2mRelParent
    ? (relations.find(
        (r) =>
          r.many_collection === m2mRelParent.many_collection &&
          r.many_field === m2mRelParent.junction_field &&
          r.one_collection
      ) ?? null)
    : null

  const relatedCollection =
    m2oRel?.one_collection ??
    m2mRelJunction?.one_collection ??
    m2mParentTargetRel?.one_collection ??
    m2mRelParent?.many_collection ??
    o2mRel?.many_collection ??
    null

  const relLabel = m2oRel ? 'M2O' : m2mRel ? 'M2M' : o2mRel ? 'O2M' : null

  if (relatedCollection) {
    return (
      <div>
        <button
          type='button'
          onClick={() => setExpanded((v) => !v)}
          className='flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
          style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
        >
          <span className='flex-1'>{titleCase(field.field)}</span>
          {relLabel && (
            <span className='rounded px-1 py-0.5 text-[10px] font-medium bg-slate-100 text-slate-500'>
              {relLabel}
            </span>
          )}
          {expanded ? (
            <ChevronDown className='h-3.5 w-3.5 text-slate-400 shrink-0' />
          ) : (
            <ChevronRight className='h-3.5 w-3.5 text-slate-400 shrink-0' />
          )}
        </button>
        {expanded && (
          <>
            {(m2oRel || m2mRel) && (
              <button
                type='button'
                onClick={() =>
                  onSelect({
                    path: [...pathPrefix, field.field],
                    pathLabels: [...labelPrefix, titleCase(field.field)],
                    fieldType: field.type,
                    relatedCollection: relatedCollection ?? undefined
                  })
                }
                className='w-full rounded-md px-2 py-1 text-left text-[12px] text-slate-500 hover:bg-slate-50 italic'
                style={{ paddingLeft: `${0.5 + (depth + 1) * 1}rem` }}
              >
                (select this field)
              </button>
            )}
            <PickerRelatedFields
              relatedCollection={relatedCollection}
              pathPrefix={[...pathPrefix, field.field]}
              labelPrefix={[...labelPrefix, titleCase(field.field)]}
              depth={depth + 1}
              onSelect={onSelect}
            />
          </>
        )}
      </div>
    )
  }

  return (
    <button
      type='button'
      onClick={() =>
        onSelect({
          path: [...pathPrefix, field.field],
          pathLabels: [...labelPrefix, titleCase(field.field)],
          fieldType: field.type,
          // A leaf field selected inside a relation traversal (depth > 0) lives
          // in the parent traversal's collection — that's the related collection.
          relatedCollection: depth > 0 ? collection : undefined
        })
      }
      className='w-full rounded-md px-2 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
      style={{ paddingLeft: `${0.5 + depth * 1}rem` }}
    >
      {titleCase(field.field)}
    </button>
  )
}

// ─── Panel variants (no trigger button — auto-open) ──────────────────────────

export function FieldPickerPanel({
  collection,
  fields,
  relations,
  onSelect
}: {
  collection: string
  fields: CMSField[]
  relations: CMSRelation[]
  onSelect: (picked: PickedField) => void
}) {
  const [query, setQuery] = useState('')
  const filtered = fields.filter((f) => f.field.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div className='w-72 rounded-xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)]'>
      <div className='p-2'>
        <div className='relative mb-1.5'>
          <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='Search fields…'
            className='h-8 w-full rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-[13px] placeholder-slate-400 focus:border-nvr-cyan/50 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
        </div>
        <div className='max-h-72 overflow-y-auto'>
          {filtered.map((f) => (
            <PickerFieldRow
              key={f.field}
              field={f}
              collection={collection}
              relations={relations}
              pathPrefix={[]}
              labelPrefix={[]}
              depth={0}
              onSelect={onSelect}
            />
          ))}
          {filtered.length === 0 && (
            <div className='px-2 py-3 text-center text-[12px] text-slate-400'>No fields</div>
          )}
        </div>
      </div>
    </div>
  )
}

export function CollectionFieldPickerPanel({
  collection,
  onSelect
}: {
  collection: string
  onSelect: (picked: PickedField) => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  if (isLoading) {
    return (
      <div className='w-72 rounded-xl border border-slate-200 bg-white shadow-[0_4px_16px_rgba(0,0,0,0.10),0_1px_4px_rgba(0,0,0,0.06)] p-4 flex items-center gap-2 text-[12px] text-slate-400'>
        <Loader2 className='h-3.5 w-3.5 animate-spin' />
        Loading fields…
      </div>
    )
  }

  const fields: CMSField[] = (data?.fields ?? []).filter((f: CMSField) => !f.hidden)
  const relations: CMSRelation[] = data?.relations ?? []

  return (
    <FieldPickerPanel
      collection={collection}
      fields={fields}
      relations={relations}
      onSelect={onSelect}
    />
  )
}
