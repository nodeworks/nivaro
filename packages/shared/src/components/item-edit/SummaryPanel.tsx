import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Loader2 } from 'lucide-react'
import { useRef, useState } from 'react'
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
    staleTime: 30_000,
    enabled: !!parentId && parentId !== 'new'
  })

  const isFilesCollection = relatedCollection === 'nivaro_files' || relatedCollection === 'directus_files'
  const { data: colMeta } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    enabled: !!relatedCollection && !isFilesCollection,
    staleTime: 300_000
  })

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()
  const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id))

  const allRelatedIds = [
    ...stagedLinks,
    ...committedItems.map((i) => i[junctionField]).filter((id) => id != null)
  ]

  if (allRelatedIds.length === 0) return <span className='text-slate-400 dark:text-slate-500'>—</span>

  if (relatedCollection) {
    const MAX_SHOW = 5
    const showIds = allRelatedIds.slice(0, MAX_SHOW)
    const extra = allRelatedIds.length - MAX_SHOW
    return (
      <span className='text-[12px] text-slate-700 dark:text-slate-200'>
        {showIds.map((id, i) => (
          <span key={String(id)}>
            {i > 0 && ', '}
            <RelatedItemLabel collection={relatedCollection} id={id} displayTemplate={colMeta?.display_template} />
          </span>
        ))}
        {extra > 0 && <span className='text-slate-400 dark:text-slate-500'> +{extra} more</span>}
      </span>
    )
  }

  return (
    <span className='text-slate-700 dark:text-slate-200'>
      {allRelatedIds.length} item{allRelatedIds.length !== 1 ? 's' : ''}
    </span>
  )
}

// ─── O2MSummaryCount ──────────────────────────────────────────────────────────

function O2MSummaryCount({
  relatedCollection,
  manyField,
  parentId,
  rowFilter
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  rowFilter?: Record<string, unknown>
}) {
  const client = useNivaroClient()
  // Same row_filter semantics as InlineTableField: flat values → _eq, object
  // values pass through — so a filtered grid's summary count matches its rows.
  const filterClause =
    rowFilter && Object.keys(rowFilter).length > 0
      ? {
          _and: [
            { [manyField]: { _eq: parentId } },
            Object.fromEntries(
              Object.entries(rowFilter).map(([k, v]) => [
                k,
                v !== null && typeof v === 'object' ? v : { _eq: v }
              ])
            )
          ]
        }
      : { [manyField]: { _eq: parentId } }
  const { data: rows, isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: ['o2m-rows', relatedCollection, manyField, parentId, rowFilter ? JSON.stringify(rowFilter) : ''],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: JSON.stringify(filterClause),
            limit: 200
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!parentId && parentId !== 'new',
    staleTime: 30_000
  })
  if (isLoading) return <Loader2 className='h-3 w-3 animate-spin text-slate-400 dark:text-slate-500' />
  if (!rows || rows.length === 0) return <span className='italic text-[11px] text-slate-400 dark:text-slate-500'>No rows</span>
  return <span className='text-slate-700 dark:text-slate-200'>{rows.length} row{rows.length !== 1 ? 's' : ''}</span>
}

// ─── SummaryFieldValue ─────────────────────────────────────────────────────────

export function SummaryFieldValue({
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

  const M2M_IFACES = new Set(['select-multiple-m2m', 'files-m2m', 'relation-grouped'])

  // O2M — try relation lookup for any non-M2M field; relation criteria is precise enough
  if (!M2M_IFACES.has(iface) && itemId) {
    const o2mRel = relations.find(
      (r) =>
        !r.junction_field &&
        (r.one_field === field.field || r.many_collection === field.field) &&
        (r.one_collection === collection || r.one_collection == null)
    )
    if (o2mRel?.many_collection && o2mRel.many_field) {
      const fOpts = (() => {
        try {
          return typeof field.options === 'string'
            ? JSON.parse(field.options)
            : (field.options ?? {})
        } catch {
          return {}
        }
      })()
      return (
        <O2MSummaryCount
          relatedCollection={o2mRel.many_collection}
          manyField={o2mRel.many_field}
          parentId={itemId}
          rowFilter={
            fOpts.row_filter && typeof fOpts.row_filter === 'object'
              ? (fOpts.row_filter as Record<string, unknown>)
              : undefined
          }
        />
      )
    }
  }

  // M2M — interface is the authoritative signal
  if (M2M_IFACES.has(iface) && itemId) {
    const r = relations.find(
      (rel) => rel.one_collection === collection && rel.one_field === field.field
    )
    const m2mRel = r
      ? r.junction_field
        ? r
        : (() => {
            const companion = relations.find(
              (c) => c.many_collection === r.many_collection && c.id !== r.id
            )
            return companion ? { ...r, junction_field: companion.many_field } : null
          })()
      : null
    if (m2mRel) {
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
  }

  const isEmpty = val === null || val === undefined || val === ''
  if (isEmpty) return <span className='text-slate-400 dark:text-slate-500'>—</span>

  if (iface === 'extension-editorjs') {
    try {
      const doc = JSON.parse(String(val)) as { blocks?: Array<{ data: { text?: string } }> }
      const text = (doc.blocks ?? [])
        .map((b) => b.data?.text ?? '')
        .join(' ')
        .trim()
      return <span className='truncate text-slate-700 dark:text-slate-200'>{text || '—'}</span>
    } catch {
      /* fall through */
    }
  }
  if (iface === 'input-rich-text-html') {
    const div = typeof document !== 'undefined' ? document.createElement('div') : null
    if (div) {
      div.innerHTML = String(val)
      return <span className='truncate text-slate-700 dark:text-slate-200'>{div.textContent || '—'}</span>
    }
  }

  if (typeof val === 'boolean') return <span className='text-slate-700 dark:text-slate-200'>{val ? 'Yes' : 'No'}</span>

  const m2oRel = relations.find(
    (r) => r.many_collection === collection && r.many_field === field.field && !r.junction_field
  )
  if (m2oRel?.one_collection) {
    return <RelatedItemLabel collection={m2oRel.one_collection} id={val} />
  }

  if (field.type === 'datetime' || field.type === 'date') {
    try {
      return <span className='text-slate-700 dark:text-slate-200'>{new Date(String(val)).toLocaleDateString()}</span>
    } catch {
      /* fall through */
    }
  }

  return <span className='truncate text-slate-700 dark:text-slate-200'>{String(val)}</span>
}

// ─── getDisplayText ────────────────────────────────────────────────────────────

function getDisplayText(val: unknown): string {
  if (val === null || val === undefined || val === '') return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  const s = String(val)
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    try { return new Date(s).toLocaleDateString() } catch { /* noop */ }
  }
  return s
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
  errors,
  staleFields,
  aliasEmptiness,
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
  errors?: Record<string, string>
  /** Fields whose stored value no longer resolves to an available option. */
  staleFields?: Set<string>
  /** Emptiness for alias fields the draft cannot answer for: true/false, or
   *  null while the junction state is still settling. */
  aliasEmptiness?: Record<string, boolean | null>
  onFieldClick: (stepKey: string, fieldKey: string) => void
}) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const valueRefs = useRef<Map<string, HTMLSpanElement | null>>(new Map())

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

  // O2M rels whose alias field didn't make it into any step (hidden, unassigned, etc.)
  const renderedFieldNames = new Set(stepSections.flatMap((s) => s.fields.map((f) => f.field)))
  const extraO2MRels = itemId && itemId !== 'new'
    ? relations.filter(
        (r) =>
          !r.junction_field &&
          r.many_field &&
          r.many_collection &&
          (r.one_collection === collection || r.one_collection == null) &&
          r.one_field != null &&
          !renderedFieldNames.has(r.one_field)
      )
    : []

  if (stepSections.length === 0 && extraO2MRels.length === 0) return null

  return (
    <div className='overflow-hidden bg-white dark:bg-card'>
      <div className='bg-slate-200 border-b border-slate-300 px-4 py-2.5 dark:bg-white/[0.1] dark:border-border'>
        <span className='text-[12px] font-semibold text-slate-700 dark:text-slate-200'>Summary</span>
      </div>

      {stepSections.map(({ step, fields }, si) => (
        <div key={step.key}>
          <div className={cn(
            'bg-slate-100 px-4 py-2 border-b border-slate-200 dark:bg-white/[0.06] dark:border-border/80',
            si > 0 && 'border-t border-slate-200 dark:border-border/80'
          )}>
            <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
              {step.label}
            </span>
          </div>

          {fields.map((f, fi) => {
            const val = draft[f.field]
            const label = f.label ?? titleCase(f.field)
            const hasError = !!errors?.[f.field]
            // Required but empty: the summary is where someone checks whether a
            // record is finished, so the fields standing between them and a save
            // have to be visible without opening every tab. Distinct from an
            // error — nothing is wrong yet, it is simply not done.
            const aliasEmpty = aliasEmptiness?.[f.field]
            const isEmpty =
              aliasEmpty !== undefined
                ? aliasEmpty === true
                : val === null ||
                  val === undefined ||
                  (typeof val === 'string' && val.trim() === '') ||
                  (Array.isArray(val) && val.length === 0)
            // While an alias is still resolving, claim nothing.
            const undecided = aliasEmpty === null
            const needsValue = !!f.required && isEmpty && !hasError && !undecided
            const isStale = staleFields?.has(f.field) ?? false
            return (
              <div
                key={f.field}
                className={cn(
                  'group/row flex items-stretch',
                  fi < fields.length - 1 && 'border-b border-slate-100 dark:border-border/60',
                  hasError
                    ? 'bg-red-50 dark:bg-red-900/10'
                    : needsValue || isStale
                      ? 'bg-amber-50/70 dark:bg-amber-900/10'
                      : ''
                )}
              >
                <button
                  type='button'
                  onClick={() => onFieldClick(step.key, f.field)}
                  className={cn(
                    'flex flex-1 flex-col px-4 py-2 text-left transition-colors duration-150 min-w-0',
                    hasError
                      ? 'hover:bg-red-50 dark:hover:bg-red-900/15'
                      : 'hover:bg-slate-50 dark:hover:bg-white/[0.03]'
                  )}
                >
                  <span
                    className={cn(
                      'flex items-center gap-1 text-[10px] font-medium truncate',
                      hasError
                        ? 'text-red-500 dark:text-red-400'
                        : needsValue || isStale
                          ? 'text-amber-700 dark:text-amber-400'
                          : 'text-slate-400 dark:text-slate-500'
                    )}
                  >
                    <span className='truncate'>{label}</span>
                    {needsValue && (
                      <span className='shrink-0 rounded bg-amber-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'>
                        required
                      </span>
                    )}
                    {isStale && (
                      <span
                        title='This value is no longer one of the available options'
                        className='shrink-0 rounded bg-amber-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                      >
                        unavailable
                      </span>
                    )}
                  </span>
                  <span
                    ref={(el) => { valueRefs.current.set(f.field, el) }}
                    className='mt-0.5 w-full text-[12px] min-w-0 overflow-hidden'
                  >
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
                <button
                  type='button'
                  title='Copy value'
                  onClick={(e) => {
                    e.stopPropagation()
                    const text = valueRefs.current.get(f.field)?.textContent?.trim() ?? getDisplayText(val)
                    navigator.clipboard.writeText(text).catch(() => {})
                    setCopiedField(f.field)
                    setTimeout(() => setCopiedField(prev => prev === f.field ? null : prev), 1500)
                  }}
                  className={cn(
                    'flex items-center px-2 opacity-0 group-hover/row:opacity-100 transition-all duration-150',
                    copiedField === f.field
                      ? 'text-emerald-500'
                      : 'text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-300'
                  )}
                >
                  {copiedField === f.field
                    ? <Check className='h-3 w-3' />
                    : <Copy className='h-3 w-3' />
                  }
                </button>
              </div>
            )
          })}
        </div>
      ))}

      {extraO2MRels.length > 0 && (
        <div>
          <div className='bg-slate-100 px-4 py-2 border-y border-slate-200 dark:bg-white/[0.06] dark:border-border/80'>
            <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>Related</span>
          </div>
          {extraO2MRels.map((r, ri) => (
            <div
              key={r.id ?? `${r.many_collection}.${r.many_field}`}
              className={cn(
                'flex items-stretch',
                ri < extraO2MRels.length - 1 && 'border-b border-slate-100 dark:border-border/60'
              )}
            >
              <div className='flex flex-1 flex-col px-4 py-2 min-w-0'>
                <span className='text-[10px] font-medium truncate text-slate-400 dark:text-slate-500'>
                  {titleCase(r.one_field ?? r.many_collection ?? '')}
                </span>
                <span className='mt-0.5 text-[12px]'>
                  <O2MSummaryCount
                    relatedCollection={r.many_collection ?? ''}
                    manyField={r.many_field!}
                    parentId={itemId}
                  />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
