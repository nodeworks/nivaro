import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn, titleCase } from '../../lib/utils'
import { parseJson, SENTINEL_FIELDS, SYSTEM_FIELDS } from './helpers'
import type { M2MStagingCtx } from './M2MStagingContext'
import { RelatedItemLabel } from './RelationCombobox'
import type { CMSField, CMSRelation, FieldGroup, StepDef } from './types'

// ─── M2MSummaryCount ──────────────────────────────────────────────────────────

function M2MSummaryCount({
  relation,
  parentId,
  allRelations,
  staging,
  maxValues
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  staging: M2MStagingCtx | null
  maxValues?: number
}) {
  const client = useNivaroClient()
  const manyField = relation.many_field ?? ''
  const junctionField =
    relation.junction_field ??
    (() => {
      const other = allRelations.find(
        (r) => r.many_collection === relation.many_collection && r.id !== relation.id
      )
      return other?.many_field ?? ''
    })()
  const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`
  const relatedCollection =
    allRelations.find(
      (r) =>
        r.many_collection === relation.many_collection &&
        r.many_field === junctionField &&
        r.id !== relation.id
    )?.one_collection ?? null

  const { data: junctionItems = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-items', relation.many_collection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 200,
            fields: `id,${junctionField}`
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000
  })

  const { data: colMeta } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    enabled: !!relatedCollection && maxValues === 1,
    staleTime: 300_000
  })

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()
  const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id))
  const count = committedItems.length + stagedLinks.length

  if (count === 0) return <span className='text-slate-300'>—</span>

  if (maxValues === 1 && relatedCollection) {
    const relatedId = stagedLinks[0] ?? committedItems[0]?.[junctionField]
    if (relatedId != null) {
      return (
        <RelatedItemLabel
          collection={relatedCollection}
          id={relatedId}
          displayTemplate={colMeta?.display_template}
        />
      )
    }
  }

  return (
    <span className='text-slate-800'>
      {count} item{count !== 1 ? 's' : ''}
    </span>
  )
}

// ─── SummaryFieldValue ─────────────────────────────────────────────────────────

function SummaryFieldValue({
  field,
  val,
  relations,
  collection,
  itemId,
  staging
}: {
  field: CMSField
  val: unknown
  relations: CMSRelation[]
  collection: string
  itemId: string
  staging: M2MStagingCtx | null
}) {
  const iface = field.interface ?? ''

  const m2mRel = (() => {
    const r = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === field.field
    )
    if (!r) return null
    if (r.junction_field) return r
    const companion = relations.find(
      (c) => c.many_collection === r.many_collection && c.id !== r.id
    )
    return companion ? { ...r, junction_field: companion.many_field } : null
  })()
  if (m2mRel && itemId && itemId !== 'new') {
    const fieldOpts = parseJson<{ max_values?: number }>(field.options)
    return (
      <M2MSummaryCount
        relation={m2mRel}
        parentId={itemId}
        allRelations={relations}
        staging={staging}
        maxValues={fieldOpts?.max_values}
      />
    )
  }

  const isEmpty = val === null || val === undefined || val === ''
  if (isEmpty) return <span className='text-slate-300'>—</span>

  if (iface === 'extension-editorjs') {
    try {
      const doc = JSON.parse(String(val)) as { blocks?: Array<{ data: { text?: string } }> }
      const text = (doc.blocks ?? [])
        .map((b) => b.data?.text ?? '')
        .join(' ')
        .trim()
      return <span className='text-slate-800 truncate'>{text || '—'}</span>
    } catch {
      /* fall through */
    }
  }
  if (iface === 'input-rich-text-html') {
    const div = typeof document !== 'undefined' ? document.createElement('div') : null
    if (div) {
      div.innerHTML = String(val)
      return <span className='text-slate-800 truncate'>{div.textContent || '—'}</span>
    }
  }

  if (typeof val === 'boolean') return <span className='text-slate-800'>{val ? 'Yes' : 'No'}</span>

  const m2oRel = relations.find(
    (r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field
  )
  if (m2oRel?.one_collection) {
    return <RelatedItemLabel collection={m2oRel.one_collection} id={val} />
  }

  if (field.type === 'datetime' || field.type === 'date') {
    try {
      return <span className='text-slate-800'>{new Date(String(val)).toLocaleDateString()}</span>
    } catch {
      /* fall through */
    }
  }

  return <span className='text-slate-800 truncate'>{String(val)}</span>
}

// ─── SummaryPanel ──────────────────────────────────────────────────────────────

export function SummaryPanel({
  allSteps,
  groupedMap,
  ungroupedFields,
  sectionGroups,
  draft,
  relations,
  collection,
  itemId,
  staging,
  onFieldClick
}: {
  allSteps: StepDef[]
  groupedMap: Record<string, CMSField[]>
  ungroupedFields: CMSField[]
  sectionGroups: FieldGroup[]
  draft: Record<string, unknown>
  relations: CMSRelation[]
  collection: string
  itemId: string
  staging: M2MStagingCtx | null
  onFieldClick: (stepKey: string, fieldKey: string) => void
}) {
  const hasGeneralStep = allSteps.some((s) => s.key === '__general__')
  const syntheticSteps: StepDef[] = [
    ...(!hasGeneralStep && ungroupedFields.length > 0
      ? [{ key: '__general__', label: 'General' }]
      : []),
    ...allSteps
  ]

  const stepSections = syntheticSteps
    .map((step) => {
      const fields = (
        step.key === '__general__'
          ? [...ungroupedFields, ...sectionGroups.flatMap((g) => groupedMap[g.key] ?? [])]
          : (groupedMap[step.key] ?? [])
      ).filter((f) => !f.hidden && !SYSTEM_FIELDS.has(f.field) && !SENTINEL_FIELDS.has(f.field))
      return { step, fields }
    })
    .filter((s) => s.fields.length > 0)

  if (stepSections.length === 0) return null

  return (
    <div className='bg-white overflow-hidden'>
      <div className='px-4 py-2.5 border-b border-slate-100'>
        <p className='text-[11px] font-semibold uppercase tracking-wider text-slate-500'>Summary</p>
      </div>
      {stepSections.map(({ step, fields }, si) => (
        <div key={step.key}>
          {si > 0 && <div className='border-t border-slate-200' />}
          <div className='px-4 py-1.5 bg-slate-50 border-b border-slate-100'>
            <span className='text-[10px] font-semibold uppercase tracking-wider text-slate-400'>
              {step.label}
            </span>
          </div>
          {fields.map((f, fi) => {
            const val = draft[f.field]
            const label = f.label ?? titleCase(f.field)
            return (
              <button
                key={f.field}
                type='button'
                onClick={() => onFieldClick(step.key, f.field)}
                className={cn(
                  'flex w-full flex-col px-4 py-2 text-left hover:bg-slate-50 transition-colors',
                  fi < fields.length - 1 && 'border-b border-slate-50'
                )}
              >
                <span className='text-[10px] font-medium text-slate-400 truncate'>{label}</span>
                <span className='mt-0.5 w-full text-[12px] min-w-0 overflow-hidden'>
                  <SummaryFieldValue
                    field={f}
                    val={val}
                    relations={relations}
                    collection={collection}
                    itemId={itemId}
                    staging={staging}
                  />
                </span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
