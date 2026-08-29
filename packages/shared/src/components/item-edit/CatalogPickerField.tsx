import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Loader2, Search, Star, X } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNivaroClient, useParentDraft, useReimportHandler } from '../../context'
import { del, get, patch, post } from '../../lib/commands'
import { cn, titleCase , matchesAllTokens} from '../../lib/utils'
import { canOpenCatalogItem, openCatalogItem } from '../../lib/catalog-item-open'
import { applyDisplayTemplate } from './helpers'
import { evalClientFormula } from './InlineTableField'
import { useO2MStaging } from './O2MStagingContext'
import { ImportFromFileButton } from '../import/ImportFromFileButton'
import { RelationCombobox } from './RelationCombobox'
import type { CMSRelation } from './types'

// ─── CatalogPickerField ───────────────────────────────────────────────────────
// EFP-style BOM catalog picker for an inline-table O2M field: instead of listing
// only the record's existing child rows, renders the FULL catalog (the child
// collection's `item_field` M2O target), grouped into collapsible sections by a
// dotted path on the catalog collection. Entering a quantity next to a catalog
// item creates/updates the child row; clearing it deletes the row. A summary
// table lists everything picked and allows adding ARBITRARY catalog items
// (outside the section filter). `filter` values may reference the parent form
// draft via '$parent.<field>' tokens — until every referenced parent field has
// a value the sections are gated behind a hint (EFP: BOM loads after Project
// Type is chosen). Fully config-driven — nothing here is EFP-specific.

export interface CatalogModeConfig {
  /** Child M2O field pointing at the catalog collection (e.g. 'item'). */
  item_field: string
  /** Dotted path on the CATALOG collection grouping items into sections (e.g. 'bom_category.name'). */
  section_by: string
  /** Optional filter applied to the catalog fetch. String values '$parent.<field>' resolve from the parent draft. */
  filter?: Record<string, unknown>
  /** Child field the entered amount writes to (default 'quantity'). */
  qty_field?: string
  /** Child field ← catalog field copies applied on row create (e.g. {"price": "price"}). */
  copy_fields?: Record<string, string>
  /** Child field ← formula over the child row draft (e.g. {"total": "{{price}} * {{quantity}}"}). */
  compute_fields?: Record<string, string>
  /** Display format per child field in the Summary table (e.g. {"price": "currency", "total": "currency"}). */
  field_formats?: Record<string, 'currency' | 'number'>
  /** Extra display columns per row, dotted paths on the CATALOG collection (e.g. description, part_category.name). */
  columns?: Array<{
    field: string
    label?: string
    format?: 'currency' | 'number'
    summary_only?: boolean
    sections_only?: boolean
  }>
  /** Batched per-item lookups against another collection (e.g. warehouse on-hand qty). `match` values may
   *  use '$parent.<field>' tokens; `copy_to` also autofills the child field on row create/update. */
  related_columns?: Array<{
    key: string
    label?: string
    collection: string
    item_field: string
    value_field: string
    match?: Record<string, unknown>
    copy_to?: string
    format?: 'currency' | 'number' | 'presence'
    summary_only?: boolean
    sections_only?: boolean
    /** 'sum' turns the lookup into an aggregate: value = SUM(value_field)
     *  across ALL matching rows per item (e.g. open-order quantity per CIFA),
     *  instead of the default last-row value. */
    aggregate?: 'sum'
  }>
  /** Flags rows whose entered qty exceeds a related column's value (e.g. warehouse
   *  on-hand): amber tint + inline shortfall note in sections AND the Summary.
   *  Re-evaluates live when the related column's `match` inputs change (switching
   *  the warehouse re-resolves on-hand and re-flags). `column` = related_columns key. */
  qty_warning?: { column: string; label?: string }
  /** Flag Summary rows that rode the parent record's LATEST external submission
   *  when it failed (nivaro_erp_submissions): rows are matched against the
   *  stored payload's `products[]` identifiers (cifaNumber/productNumber). The
   *  object form names catalog columns to match on (e.g. ['item_number',
   *  'product_number'] — fetched separately for the picked rows, since payloads
   *  often carry the product number while row labels show the cifa number);
   *  `true` matches on the row label only. Red icon per row — hover shows the
   *  submission's full error. Clears when a newer attempt lands. */
  submission_errors?: boolean | { match_fields?: string[] }
  /** Per-user starred catalog items: star toggles + a Favorites section pinned first. */
  favorites?: boolean
  /** related_columns KEYS shown as table columns in the favorites manager
   *  drawer (full-catalog browse + star). Values roll up across ALL rows the
   *  column's `match` currently resolves to — i.e. only the warehouses the
   *  form's field selection filters to; numeric values sum, text takes the
   *  first. Omit = no related columns in the drawer. */
  favorites_manager_columns?: string[]
  /** Import template NAME — renders that template's upload button above the Summary
   *  table (existing records; wired through ItemEditForm's reimport flow). */
  upload_template?: string
  /** copy_fields child columns the user may edit per Summary row (e.g. ['price']);
   *  a manual edit survives later qty commits and re-runs compute_fields. */
  editable_fields?: string[]
  /** Attribute-driven item builders (e.g. fiber jumpers: pick connector + length → resolves a catalog item). */
  builders?: CatalogBuilderConfig[]
  /** Read-only CHILD-ROW columns appended to the Summary table (e.g. each line's
   *  sales order / warehouses once submitted). Plain entries read the child row
   *  directly; an `m2m` block resolves junction rows to joined labels. */
  summary_fields?: Array<{
    field: string
    label?: string
    format?: 'currency' | 'number'
    m2m?: {
      junction: string
      fk_to_child: string
      related_field: string
      related_collection: string
      label_field?: string
    }
  }>
}

export interface CatalogBuilderConfig {
  /** Section title (e.g. 'Yellow Fiber Jumpers'). */
  label: string
  /** Resolver collection: one row per attribute combination, carrying an item FK (e.g. 'fiber_jumpers'). */
  collection: string
  /** Resolver's M2O field pointing at the catalog collection (defaults to the picker's item_field name). */
  item_field?: string
  /** Ordered attribute picks; each an M2O field on the resolver collection + the label field on its target. */
  attributes: Array<{ field: string; label_field: string }>
  /** Optional filter on the resolver fetch. */
  filter?: Record<string, unknown>
  /** Show this builder only when the parent draft matches, e.g. {"project_type": {"_in": [26, 27, 5]}}. */
  show_when?: Record<string, unknown>
}

// Resolves a related-column `match` config into a server filter: string
// '$parent.<field>' tokens substitute from the draft as {_eq}, OBJECT values
// deep-resolve embedded tokens and pass through raw — nested relation filters
// like {warehouse: {regions: {_some: {regions_id: {_eq: '$parent.region'}}}}}
// scope a lookup to the warehouses of the record's region. Returns null while
// any referenced parent field is still empty (query gates until resolved).
function resolveRelatedMatch(
  matchCfg: Record<string, unknown> | undefined,
  parentDraft: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  const match: Record<string, unknown> = {}
  let missing = false
  const deep = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$parent.')) {
      const pv = parentDraft?.[v.slice('$parent.'.length)]
      if (pv === null || pv === undefined || pv === '') {
        missing = true
        return v
      }
      return pv
    }
    if (Array.isArray(v)) return v.map(deep)
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
    return v
  }
  for (const [k, v] of Object.entries(matchCfg ?? {})) {
    if (typeof v === 'string' && v.startsWith('$parent.')) {
      const pv = parentDraft?.[v.slice('$parent.'.length)]
      if (pv === null || pv === undefined || pv === '') {
        missing = true
        continue
      }
      match[k] = { _eq: pv }
    } else if (v && typeof v === 'object') {
      match[k] = deep(v)
    } else {
      match[k] = { _eq: v }
    }
  }
  return missing ? null : match
}

// Minimal client-side condition check over the parent draft (_eq/_neq/_in/_nin/_null/_nnull;
// AND across fields). Ids compare as strings so int and uuid PKs both match.
export function matchesShowWhen(
  cond: Record<string, unknown> | undefined,
  draft: Record<string, unknown> | undefined
): boolean {
  if (!cond) return true
  for (const [field, opsRaw] of Object.entries(cond)) {
    const val = draft?.[field]
    const s = val == null ? null : String(val)
    const ops =
      opsRaw && typeof opsRaw === 'object' ? (opsRaw as Record<string, unknown>) : { _eq: opsRaw }
    for (const [op, expected] of Object.entries(ops)) {
      switch (op) {
        case '_eq':
          if (s !== String(expected)) return false
          break
        case '_neq':
          if (s === String(expected)) return false
          break
        case '_in':
          if (!Array.isArray(expected) || !expected.map(String).includes(s ?? '')) return false
          break
        case '_nin':
          if (Array.isArray(expected) && expected.map(String).includes(s ?? '')) return false
          break
        case '_null':
          if (s !== null) return false
          break
        case '_nnull':
          if (s === null) return false
          break
        default:
          return false
      }
    }
  }
  return true
}

const CATALOG_LIMIT = 2000

export function CatalogPickerField({
  relatedCollection,
  manyField,
  parentId,
  parentCollection,
  config,
  readOnly = false
}: {
  relatedCollection: string
  manyField: string
  parentId: string
  parentCollection?: string
  config: CatalogModeConfig
  readOnly?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const staging = useO2MStaging()
  const parentDraftCtx = useParentDraft()
  const reimportHandler = useReimportHandler()
  const editableFields = config.editable_fields ?? []
  const isNew = parentId === 'new'
  const qtyField = config.qty_field ?? 'quantity'

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const collapseInitRef = useRef(false)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())

  // Child collection relations → resolve the catalog collection
  const { data: childRelations = [] } = useQuery<CMSRelation[]>({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: unknown }>(get(`/collections/${relatedCollection}`))
        .then((r) => (r.data as { relations?: CMSRelation[] })?.relations ?? []),
    staleTime: 10 * 60_000
  })
  const catalogCol = useMemo(
    () =>
      childRelations.find(
        (r) =>
          r.many_collection === relatedCollection &&
          r.many_field === config.item_field &&
          !r.junction_field
      )?.one_collection ?? null,
    [childRelations, relatedCollection, config.item_field]
  )

  const { data: catalogMeta } = useQuery<{ display_template?: string }>({
    queryKey: ['col-meta', catalogCol],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${catalogCol}`))
        .then((r) => r.data),
    enabled: !!catalogCol,
    staleTime: 300_000
  })
  const tmpl = catalogMeta?.display_template

  // '$parent.<field>' tokens in the filter resolve from the live parent draft;
  // unresolved tokens gate the section list (mirrors EFP's "pick Project Type
  // first" behaviour).
  const parentDraft = parentDraftCtx?.draft
  const { resolvedFilter, missingParents } = useMemo(() => {
    const missing: string[] = []
    const sub = (v: unknown): unknown => {
      if (typeof v === 'string' && v.startsWith('$parent.')) {
        const key = v.slice('$parent.'.length)
        const pv = parentDraft?.[key]
        if (pv === null || pv === undefined || pv === '') {
          missing.push(key)
          return v
        }
        return pv
      }
      if (Array.isArray(v)) return v.map(sub)
      if (v && typeof v === 'object')
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]))
      return v
    }
    const f = config.filter ? (sub(config.filter) as Record<string, unknown>) : undefined
    return { resolvedFilter: f, missingParents: [...new Set(missing)] }
  }, [config.filter, parentDraft])

  // Catalog fetch: id + display-template fields + section path + copied + display columns
  const catalogFields = useMemo(() => {
    const out = new Set<string>(['id', config.section_by])
    for (const m of [...(tmpl ?? '').matchAll(/\{\{([\w.]+)\}\}/g)]) out.add(m[1])
    for (const src of Object.values(config.copy_fields ?? {})) out.add(src)
    for (const c of config.columns ?? []) out.add(c.field)
    return [...out].join(',')
  }, [tmpl, config.section_by, config.copy_fields, config.columns])

  const filterKey = JSON.stringify(resolvedFilter ?? null)
  const { data: catalogRows = [], isLoading: catalogLoading } = useQuery<Record<string, unknown>[]>(
    {
      queryKey: ['catalog-picker', catalogCol, catalogFields, filterKey],
      queryFn: () =>
        client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${catalogCol}`, {
              limit: CATALOG_LIMIT,
              fields: catalogFields,
              ...(resolvedFilter ? { filter: JSON.stringify(resolvedFilter) } : {})
            })
          )
          .then((r) => r.data ?? []),
      enabled: !!catalogCol && missingParents.length === 0,
      staleTime: 60_000
    }
  )
  const catalogById = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>()
    for (const r of catalogRows) map.set(String(r.id), r)
    return map
  }, [catalogRows])

  // Existing child rows — same query key as InlineTableField so cache/invalidations are shared
  const { data: childRows = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['o2m-rows', relatedCollection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 1000
          })
        )
        .then((r) => r.data ?? []),
    enabled: !isNew,
    staleTime: 15_000
  })
  const pendingRows = isNew && staging ? staging.getPendingRows(relatedCollection, manyField) : []
  // Saved rows removed via the Summary ✕ stage into the outer form's O2M
  // delete queue — nothing is deleted server-side until Save; Undo un-stages.
  const queuedDeletes =
    !isNew && staging ? staging.getPendingDeletes(relatedCollection, manyField) : new Set<string>()

  // catalogId → saved row / pending index
  const savedByCatalogId = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>()
    for (const r of childRows) {
      const v = r[config.item_field]
      if (v != null) map.set(String(v), r)
    }
    return map
  }, [childRows, config.item_field])
  const pendingIdxByCatalogId = useMemo(() => {
    const map = new Map<string, number>()
    pendingRows.forEach((r, i) => {
      const v = r[config.item_field]
      if (v != null) map.set(String(v), i)
    })
    return map
  }, [pendingRows, config.item_field])

  // Picked rows (saved or pending) in a uniform shape for the summary table
  const pickedEntries = useMemo(() => {
    if (isNew)
      return pendingRows
        .filter((r) => r[config.item_field] != null)
        .map((r) => ({ key: String(r[config.item_field]), row: r }))
    return childRows
      .filter((r) => r[config.item_field] != null)
      .map((r) => ({ key: String(r[config.item_field]), row: r }))
  }, [isNew, pendingRows, childRows, config.item_field])

  // Labels for picked items OUTSIDE the filtered catalog (arbitrary adds)
  const missingLabelIds = useMemo(
    () => pickedEntries.filter((e) => !catalogById.has(e.key)).map((e) => e.key),
    [pickedEntries, catalogById]
  )
  const { data: extraLabelRows = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['catalog-picker-labels', catalogCol, catalogFields, missingLabelIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            filter: JSON.stringify({ id: { _in: missingLabelIds } }),
            fields: catalogFields,
            limit: missingLabelIds.length
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!catalogCol && missingLabelIds.length > 0,
    staleTime: 60_000
  })
  // Per-user favorites (config.favorites): pinned ids + their catalog rows
  // (fetched separately so favorites show even outside the current filter)
  const { data: pinnedIds = [] } = useQuery<string[]>({
    queryKey: ['pinned-items', catalogCol],
    queryFn: () =>
      client.request<{ data: string[] }>(get(`/pinned/${catalogCol}`)).then((r) => r.data ?? []),
    enabled: !!catalogCol && !!config.favorites,
    staleTime: 60_000
  })
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])
  const { data: pinnedRowsData = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['pinned-item-rows', catalogCol, catalogFields, pinnedIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            filter: JSON.stringify({ id: { _in: pinnedIds } }),
            fields: catalogFields,
            limit: pinnedIds.length
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!catalogCol && !!config.favorites && pinnedIds.length > 0,
    staleTime: 60_000
  })
  async function togglePin(catalogId: string) {
    if (!catalogCol) return
    await client.request(post(`/pinned/${catalogCol}/${catalogId}/toggle`)).catch(() => {})
    qc.invalidateQueries({ queryKey: ['pinned-items', catalogCol] })
  }
  // Favorites manager drawer (full-catalog search + star). anchorEl resolves
  // the portal container — inside a modal sheet the drawer must portal into
  // the dialog content, not document.body.
  const [favMgrOpen, setFavMgrOpen] = useState(false)
  const favMgrAnchorRef = useRef<HTMLButtonElement>(null)
  const starButton = (catalogId: string) =>
    config.favorites ? (
      <button
        type='button'
        title={pinnedSet.has(catalogId) ? 'Remove from favorites' : 'Add to favorites'}
        onClick={(e) => {
          e.stopPropagation()
          void togglePin(catalogId)
        }}
        className='shrink-0 rounded p-0.5 transition-colors'
      >
        <Star
          className={cn(
            'h-3.5 w-3.5',
            pinnedSet.has(catalogId)
              ? 'fill-amber-400 text-amber-400'
              : 'text-slate-300 hover:text-amber-400'
          )}
        />
      </button>
    ) : null

  // Full-catalog search: the box otherwise only narrows the filtered section
  // rows, so an item outside the request's project-type/zone filter was
  // unfindable. Matches not already visible above render in their own
  // "Full catalog" band with the same qty inputs — picking one behaves
  // exactly like "Add any item" (filter is curation, not a gate).
  const [fullSearchQ, setFullSearchQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setFullSearchQ(search), 300)
    return () => clearTimeout(t)
  }, [search])
  const catalogSortField = useMemo(() => {
    const first = [...(tmpl ?? '').matchAll(/\{\{([\w.]+)\}\}/g)][0]?.[1]
    return first && !first.includes('.') ? first : 'id'
  }, [tmpl])
  const { data: fullSearchRows = [], isFetching: fullSearchFetching } = useQuery<
    Record<string, unknown>[]
  >({
    queryKey: ['catalog-full-search', catalogCol, catalogFields, fullSearchQ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            search: fullSearchQ,
            fields: catalogFields,
            limit: 25,
            sort: catalogSortField
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!catalogCol && fullSearchQ.trim().length > 0,
    staleTime: 30_000,
    placeholderData: (p) => p
  })
  // Pure search results: the box searches the FULL catalog and shows matches
  // in their own band — it never filters the favorites or section lists
  // (narrowing those alongside read as everything vanishing).
  const fullMatches = fullSearchRows

  // Related per-item lookups (config.related_columns): one batched query per
  // column against its collection, matched by the item FK plus resolved match
  // tokens ('$parent.<field>'). Chunked _in keeps MSSQL parameter limits safe.
  const relatedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of catalogRows) ids.add(String(r.id))
    for (const e of pickedEntries) ids.add(e.key)
    for (const id of pinnedIds) ids.add(id)
    for (const r of fullMatches) ids.add(String(r.id))
    return [...ids]
  }, [catalogRows, pickedEntries, pinnedIds, fullMatches])
  const relatedResults = useQueries({
    queries: (config.related_columns ?? []).map((rc) => {
      const match = resolveRelatedMatch(rc.match, parentDraft)
      return {
        queryKey: [
          'catalog-related',
          rc.key,
          rc.collection,
          JSON.stringify(match),
          relatedIds.join(',')
        ],
        queryFn: async () => {
          const map: Record<string, unknown> = {}
          const isSum = rc.aggregate === 'sum'
          // Aggregate lookups need EVERY matching row, and the server clamps a
          // read at 1000 rows — smaller id chunks + paging until a short page.
          const chunkSize = isSum ? 150 : 400
          for (let i = 0; i < relatedIds.length; i += chunkSize) {
            const chunk = relatedIds.slice(i, i + chunkSize)
            let page = 1
            for (;;) {
              const rows = await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${rc.collection}`, {
                    limit: isSum ? 1000 : chunk.length,
                    ...(isSum ? { page } : {}),
                    fields: `${rc.item_field},${rc.value_field}`,
                    filter: JSON.stringify({ ...match, [rc.item_field]: { _in: chunk } })
                  })
                )
                .then((r) => r.data ?? [])
              for (const row of rows) {
                const k = row[rc.item_field]
                if (k == null) continue
                if (isSum) {
                  const n = Number(row[rc.value_field])
                  map[String(k)] = (Number(map[String(k)]) || 0) + (Number.isNaN(n) ? 0 : n)
                } else {
                  map[String(k)] = row[rc.value_field]
                }
              }
              if (!isSum || rows.length < 1000) break
              page += 1
            }
          }
          return map
        },
        enabled: !!catalogCol && match !== null && relatedIds.length > 0,
        staleTime: 30_000
      }
    })
  })
  const relatedValue = (key: string, itemId: string): unknown => {
    const idx = (config.related_columns ?? []).findIndex((rc) => rc.key === key)
    if (idx === -1) return undefined
    return (relatedResults[idx]?.data as Record<string, unknown> | undefined)?.[itemId]
  }

  // qty_warning: entered qty vs the configured related column (warehouse
  // on-hand). Reads the SAME resolved lookup the columns render from, so
  // switching the warehouse re-flags rows against the new availability. An
  // item with no row in the lookup counts as 0 available — a warehouse that
  // doesn't stock the part is a shortfall, not an unknown.
  const qtyShortfall = (catalogId: string): { available: number; qty: number } | null => {
    const wCfg = config.qty_warning
    if (!wCfg) return null
    const qty = currentQty(catalogId) ?? 0
    if (qty <= 0) return null
    const idx = (config.related_columns ?? []).findIndex((rc) => rc.key === wCfg.column)
    if (idx === -1) return null
    const data = relatedResults[idx]?.data as Record<string, unknown> | undefined
    if (data === undefined) return null // lookup gated/loading — don't flag yet
    const raw = data[catalogId]
    const available = raw === undefined || raw === null || raw === '' ? 0 : Number(raw)
    if (Number.isNaN(available)) return null
    return qty > available ? { available, qty } : null
  }
  const qtyWarningLabel = config.qty_warning
    ? (config.qty_warning.label ??
      (config.related_columns ?? []).find((rc) => rc.key === config.qty_warning?.column)?.label ??
      titleCase(config.qty_warning.column))
    : ''

  // submission_errors: the parent record's latest external submission, when
  // failed, tells us WHICH rows were in it (payload products) and WHY it
  // failed (last_error) — mirrors ErpFailureBanner's latest-only semantics.
  const submissionErrorsEnabled = !!config.submission_errors
  const submissionMatchFields = useMemo(
    () =>
      typeof config.submission_errors === 'object' &&
      Array.isArray(config.submission_errors?.match_fields)
        ? config.submission_errors.match_fields.filter((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f))
        : [],
    [config.submission_errors]
  )
  const { data: erpSubs } = useQuery({
    queryKey: ['erp-submissions', parentCollection ?? '', String(parentId)],
    queryFn: () =>
      client
        .request<{
          data: Array<{ status: string; last_error: string | null; payload: unknown }>
        }>(get(`/erp-submissions/${parentCollection}/${encodeURIComponent(parentId)}`))
        .then((r) => r.data ?? []),
    enabled: submissionErrorsEnabled && !isNew && !!parentCollection,
    staleTime: 15_000,
    refetchInterval: 60_000
  })
  const failedSubmission = useMemo(() => {
    const latest = (erpSubs ?? [])[0]
    if (!latest || latest.status !== 'failed') return null
    const body = latest.payload as { products?: Array<Record<string, unknown>> } | null
    const idents = new Set<string>()
    // Vendor-agnostic: every primitive value of each payload line item is a
    // candidate identifier (ERPs disagree on key names — cifaNumber,
    // productNumber, sku…); matching against row label + configured columns
    // filters the noise.
    for (const prod of Array.isArray(body?.products) ? body.products : []) {
      for (const v of Object.values(prod ?? {})) {
        if ((typeof v === 'string' || typeof v === 'number') && v !== '') idents.add(String(v))
      }
    }
    if (idents.size === 0) return null
    return { idents, error: latest.last_error ?? 'Submission failed' }
  }, [erpSubs])
  // The payload usually identifies products by columns the catalog fetch never
  // selects (product_number vs the cifa-number label) — fetch the configured
  // match columns for the picked rows only, and only while a failure shows.
  const pickedIdsKey = pickedEntries.map((e) => e.key).join(',')
  const { data: identRows } = useQuery({
    queryKey: ['catalog-suberr-idents', catalogCol, submissionMatchFields.join(','), pickedIdsKey],
    queryFn: async () => {
      const ids = pickedEntries.map((e) => e.key)
      if (ids.length === 0) return {}
      const rows = await client
        .request<{ data: Array<Record<string, unknown>> }>(
          get(`/items/${catalogCol}`, {
            limit: ids.length,
            fields: ['id', ...submissionMatchFields].join(','),
            filter: JSON.stringify({ id: { _in: ids } })
          })
        )
        .then((r) => r.data ?? [])
      return Object.fromEntries(rows.map((r) => [String(r.id), r]))
    },
    enabled:
      !!catalogCol &&
      !!failedSubmission &&
      submissionMatchFields.length > 0 &&
      pickedEntries.length > 0,
    staleTime: 60_000
  })
  const submissionErrorFor = (catalogId: string): string | null => {
    if (!failedSubmission) return null
    const ident = (identRows as Record<string, Record<string, unknown>> | undefined)?.[catalogId]
    const candidates = [
      labelFor(catalogId),
      ...submissionMatchFields.map((f) => {
        const v = ident?.[f] ?? catalogRowFor(catalogId)[f]
        return v != null && v !== '' ? String(v) : null
      })
    ]
    return candidates.some((c) => c && failedSubmission.idents.has(c))
      ? failedSubmission.error
      : null
  }

  // summary_fields m2m entries: junction rows for the saved child rows resolve
  // to a ", "-joined label string per child row id (e.g. each line's warehouses).
  const summaryFields = config.summary_fields ?? []
  const childIdsKey = childRows.map((r) => String(r.id)).join(',')
  const summaryM2mResults = useQueries({
    queries: summaryFields
      .filter((sf) => sf.m2m)
      .map((sf) => ({
        queryKey: ['catalog-summary-m2m', sf.field, sf.m2m!.junction, childIdsKey],
        queryFn: async (): Promise<Record<string, string>> => {
          const childIds = childRows.map((r) => String(r.id))
          if (childIds.length === 0) return {}
          const m = sf.m2m!
          const junc = await client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${m.junction}`, {
                limit: 1000,
                fields: `${m.fk_to_child},${m.related_field}`,
                filter: JSON.stringify({ [m.fk_to_child]: { _in: childIds } })
              })
            )
            .then((r) => r.data ?? [])
            .catch(() => [] as Record<string, unknown>[])
          const relIds = [...new Set(junc.map((j) => String(j[m.related_field])))]
          const labelField = m.label_field ?? 'name'
          const rel = relIds.length
            ? await client
                .request<{ data: Record<string, unknown>[] }>(
                  get(`/items/${m.related_collection}`, {
                    limit: 500,
                    fields: `id,${labelField}`,
                    filter: JSON.stringify({ id: { _in: relIds } })
                  })
                )
                .then((r) => r.data ?? [])
                .catch(() => [] as Record<string, unknown>[])
            : []
          const labelById = new Map(rel.map((r) => [String(r.id), String(r[labelField] ?? r.id)]))
          const out: Record<string, string> = {}
          for (const j of junc) {
            const cid = String(j[m.fk_to_child])
            const lbl = labelById.get(String(j[m.related_field]))
            if (!lbl) continue
            out[cid] = out[cid] ? `${out[cid]}, ${lbl}` : lbl
          }
          return out
        },
        enabled: !isNew && childRows.length > 0,
        staleTime: 15_000
      }))
  })
  const summaryFieldValue = (
    sf: NonNullable<CatalogModeConfig['summary_fields']>[number],
    entry: { key: string; row: Record<string, unknown> }
  ): unknown => {
    if (!sf.m2m) return entry.row[sf.field]
    const idx = summaryFields.filter((f) => f.m2m).findIndex((f) => f.field === sf.field)
    if (idx === -1) return undefined
    const rowId = entry.row.id
    if (rowId == null) return undefined
    return (summaryM2mResults[idx]?.data as Record<string, string> | undefined)?.[String(rowId)]
  }

  const allDisplayCols = config.columns ?? []
  const allRelatedCols = config.related_columns ?? []
  const displayCols = allDisplayCols.filter((c) => !c.summary_only)
  const relatedCols = allRelatedCols.filter((c) => !c.summary_only)
  const summaryDisplayCols = allDisplayCols.filter((c) => !c.sections_only)
  const summaryRelatedCols = allRelatedCols.filter((c) => !c.sections_only)
  const hasExtraCols = displayCols.length > 0 || relatedCols.length > 0
  const pathValue = (row: Record<string, unknown>, path: string): unknown => {
    let cur: unknown = row
    for (const seg of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
    return cur
  }
  const fmtVal = (v: unknown, format?: 'currency' | 'number' | 'presence'): string => {
    if (format === 'presence')
      return v === undefined || v === null || v === '' || Number(v) === 0 ? 'No' : 'Yes'
    if (v === undefined || v === null || v === '') return '—'
    const n = Number(v)
    if (format === 'currency')
      return Number.isNaN(n)
        ? String(v)
        : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' })
    if (format === 'number')
      return Number.isNaN(n) ? String(v) : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
    return String(v)
  }
  // Cells shared by favorites + section rows; numeric (formatted) columns fixed width right,
  // text columns flexible
  const colCells = (id: string, row: Record<string, unknown>) => (
    <>
      {displayCols.map((c) => (
        <span
          key={c.field}
          className={cn(
            'truncate text-slate-500 dark:text-slate-400',
            c.format ? 'w-20 shrink-0 text-right' : 'min-w-0 flex-1'
          )}
        >
          {fmtVal(pathValue(row, c.field), c.format)}
        </span>
      ))}
      {relatedCols.map((rc) => (
        <span
          key={rc.key}
          className='w-20 shrink-0 truncate text-right text-slate-500 dark:text-slate-400'
        >
          {fmtVal(relatedValue(rc.key, id), rc.format)}
        </span>
      ))}
    </>
  )
  const itemLabelCls = hasExtraCols
    ? 'w-36 shrink-0 truncate text-slate-700 dark:text-slate-200'
    : 'min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'

  // Host-provided detail drawer (e.g. efp-new's stock-planning drawer for
  // cifa_items): when an opener is registered, item labels become links.
  const itemOpenable = canOpenCatalogItem(catalogCol)
  const itemLabel = (catalogId: string, text: string, cls: string) =>
    itemOpenable ? (
      <button
        type='button'
        onClick={() => catalogCol && openCatalogItem(catalogCol, catalogId)}
        title='View stock & planning detail'
        className={cn(cls, 'text-left underline-offset-2 hover:text-[#009abe] hover:underline')}
      >
        {text}
      </button>
    ) : (
      <span className={cls}>{text}</span>
    )

  const labelFor = (catalogId: string): string => {
    const row =
      catalogById.get(catalogId) ??
      extraLabelRows.find((r) => String(r.id) === catalogId) ??
      pinnedRowsData.find((r) => String(r.id) === catalogId)
    return row ? applyDisplayTemplate(tmpl, row) : `#${catalogId}`
  }
  const catalogRowFor = (catalogId: string): Record<string, unknown> =>
    catalogById.get(catalogId) ??
    extraLabelRows.find((r) => String(r.id) === catalogId) ??
    pinnedRowsData.find((r) => String(r.id) === catalogId) ?? { id: catalogId }

  const currentQty = (catalogId: string): number | null => {
    if (isNew) {
      const idx = pendingIdxByCatalogId.get(catalogId)
      if (idx === undefined) return null
      return Number(pendingRows[idx]?.[qtyField] ?? 0)
    }
    const row = savedByCatalogId.get(catalogId)
    return row ? Number(row[qtyField] ?? 0) : null
  }

  const sectionValue = (row: Record<string, unknown>): string => {
    let cur: unknown = row
    for (const seg of config.section_by.split('.')) {
      if (cur == null || typeof cur !== 'object') return ''
      cur = (cur as Record<string, unknown>)[seg]
    }
    return String(cur ?? '').trim()
  }

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase()
    const bySection = new Map<
      string,
      Array<{ id: string; label: string; row: Record<string, unknown> }>
    >()
    for (const row of catalogRows) {
      const label = applyDisplayTemplate(tmpl, row)
      const sec = sectionValue(row) || 'Uncategorized'
      if (!bySection.has(sec)) bySection.set(sec, [])
      bySection.get(sec)!.push({ id: String(row.id), label, row })
    }
    return [...bySection.entries()]
      .sort(([a], [b]) =>
        a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)
      )
      .map(([name, items]) => ({
        name,
        items: items.sort((a, b) => a.label.localeCompare(b.label))
      }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogRows, tmpl, search, config.section_by])

  // First load: collapse everything except sections holding picked rows
  if (!collapseInitRef.current && sections.length > 0) {
    collapseInitRef.current = true
    const start = new Set<string>()
    for (const s of sections) {
      const hasPicked = s.items.some((it) => (currentQty(it.id) ?? 0) > 0)
      if (!hasPicked) start.add(s.name)
    }
    setCollapsed(start)
  }

  // Related copy_to values for one item; falls back to a direct single-item
  // fetch when the batched lookup hasn't resolved yet (a fast qty entry must
  // not race the warehouse query and miss the price autofill).
  async function relatedCopies(catalogId: string): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const rc of config.related_columns ?? []) {
      if (!rc.copy_to) continue
      let v = relatedValue(rc.key, catalogId)
      if (v === undefined) {
        const match = resolveRelatedMatch(rc.match, parentDraft)
        if (match === null) continue
        v = await client
          .request<{ data: Record<string, unknown>[] }>(
            get(`/items/${rc.collection}`, {
              limit: 1,
              fields: `${rc.item_field},${rc.value_field}`,
              filter: JSON.stringify({ ...match, [rc.item_field]: { _eq: catalogId } })
            })
          )
          .then((r) => r.data?.[0]?.[rc.value_field])
          .catch(() => undefined)
      }
      if (v !== undefined && v !== null) out[rc.copy_to] = v
    }
    return out
  }

  function buildRowPayload(
    catalogId: string,
    qty: number,
    catalogRow: Record<string, unknown>,
    relatedOverrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      [config.item_field]: catalogRow.id ?? catalogId,
      [qtyField]: qty
    }
    for (const [dst, src] of Object.entries(config.copy_fields ?? {})) {
      if (catalogRow[src] !== undefined) payload[dst] = catalogRow[src]
    }
    // Related lookups with copy_to override plain catalog copies (e.g. the
    // supporting warehouse's price beats the catalog list price)
    Object.assign(payload, relatedOverrides)
    for (const [dst, formula] of Object.entries(config.compute_fields ?? {})) {
      const v = evalClientFormula(formula, payload)
      if (v !== null) payload[dst] = v
    }
    return payload
  }

  async function commitQty(catalogId: string, raw: string, catalogRow: Record<string, unknown>) {
    const qty = raw.trim() === '' ? 0 : Number(raw)
    if (Number.isNaN(qty) || qty < 0) return
    const prev = currentQty(catalogId)
    if ((prev ?? 0) === qty) return
    const rel = qty > 0 ? await relatedCopies(catalogId) : {}

    if (isNew) {
      const idx = pendingIdxByCatalogId.get(catalogId)
      if (qty === 0) {
        if (idx !== undefined) staging?.removeRow(relatedCollection, manyField, idx)
      } else if (idx !== undefined) {
        staging?.updateRow(relatedCollection, manyField, idx, {
          ...pendingRows[idx],
          ...buildRowPayload(catalogId, qty, catalogRow, rel)
        })
      } else {
        staging?.queueRow(
          relatedCollection,
          manyField,
          buildRowPayload(catalogId, qty, catalogRow, rel)
        )
      }
      return
    }

    setSavingIds((p) => new Set(p).add(catalogId))
    try {
      const existing = savedByCatalogId.get(catalogId)
      if (qty === 0) {
        if (existing?.id != null)
          await client.request(del(`/items/${relatedCollection}/${existing.id}`))
      } else if (existing?.id != null) {
        const payload = buildRowPayload(catalogId, qty, catalogRow, rel)
        // Manually-edited columns survive qty commits; formulas re-run over the
        // preserved values.
        for (const f of editableFields) {
          if (existing[f] != null && existing[f] !== '') payload[f] = existing[f]
        }
        for (const [dst, formula] of Object.entries(config.compute_fields ?? {})) {
          const v = evalClientFormula(formula, { ...existing, ...payload })
          if (v !== null) payload[dst] = v
        }
        const merged = { ...existing, ...payload }
        const { id: _id, ...body } = merged
        await client.request(patch(`/items/${relatedCollection}/${existing.id}`, body))
      } else {
        await client.request(
          post(`/items/${relatedCollection}`, {
            [manyField]: parentId,
            ...buildRowPayload(catalogId, qty, catalogRow, rel)
          })
        )
      }
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* leave value as-is; next edit retries */
    } finally {
      setSavingIds((p) => {
        const n = new Set(p)
        n.delete(catalogId)
        return n
      })
    }
  }

  async function commitField(catalogId: string, field: string, raw: string) {
    const num = raw.trim() === '' ? null : Number(raw)
    if (raw.trim() !== '' && Number.isNaN(num)) return
    const recompute = (base: Record<string, unknown>): Record<string, unknown> => {
      const next: Record<string, unknown> = { ...base, [field]: num }
      for (const [dst, formula] of Object.entries(config.compute_fields ?? {})) {
        const v = evalClientFormula(formula, next)
        if (v !== null) next[dst] = v
      }
      return next
    }
    if (isNew) {
      const idx = pendingIdxByCatalogId.get(catalogId)
      if (idx === undefined) return
      staging?.updateRow(relatedCollection, manyField, idx, recompute(pendingRows[idx]))
      return
    }
    const existing = savedByCatalogId.get(catalogId)
    if (existing?.id == null) return
    setSavingIds((p) => new Set(p).add(catalogId))
    try {
      const { id: _id, ...body } = recompute(existing)
      await client.request(patch(`/items/${relatedCollection}/${existing.id}`, body))
      qc.invalidateQueries({ queryKey: ['o2m-rows', relatedCollection, manyField, parentId] })
    } catch {
      /* retry on next edit */
    } finally {
      setSavingIds((p) => {
        const n = new Set(p)
        n.delete(catalogId)
        return n
      })
    }
  }

  async function addArbitrary(id: unknown) {
    if (id == null || id === '' || !catalogCol) return
    const catalogId = String(id)
    const known = catalogRowFor(catalogId)
    let row = known
    if (Object.keys(known).length <= 1) {
      row = await client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            filter: JSON.stringify({ id: { _eq: id } }),
            fields: catalogFields,
            limit: 1
          })
        )
        .then((r) => r.data?.[0] ?? { id })
        .catch(() => ({ id }))
    }
    const next = (currentQty(catalogId) ?? 0) + 1
    await commitQty(catalogId, String(next), row)
  }

  const pickedCount = pickedEntries.length
  const copyCols = Object.keys(config.copy_fields ?? {})
  const computeCols = Object.keys(config.compute_fields ?? {})

  const qtyInput = (catalogId: string, catalogRow: Record<string, unknown>) => {
    const qty = currentQty(catalogId)
    const editVal = editing[catalogId]
    const shown = editVal !== undefined ? editVal : qty && qty > 0 ? String(qty) : ''
    return (
      <input
        type='number'
        min={0}
        disabled={readOnly}
        value={shown}
        placeholder='0'
        onChange={(e) => setEditing((p) => ({ ...p, [catalogId]: e.target.value }))}
        onBlur={(e) => {
          const v = e.target.value
          setEditing((p) => {
            const n = { ...p }
            delete n[catalogId]
            return n
          })
          void commitQty(catalogId, v, catalogRow)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        className='h-7 w-20 shrink-0 rounded border border-slate-200 bg-white px-2 text-right text-[12px] outline-none focus:border-nvr-cyan disabled:opacity-50 dark:border-border dark:bg-background'
      />
    )
  }

  if (!catalogCol) {
    return (
      <p className='py-1 text-[12px] text-slate-400'>
        Catalog picker: field "{config.item_field}" does not resolve to an M2O relation on{' '}
        {relatedCollection}
      </p>
    )
  }

  return (
    <div className='space-y-3'>
      <div className='rounded-lg border border-slate-200 text-[12px] dark:border-border'>
        <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-border'>
          <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search catalog…'
            className='w-full bg-transparent text-[12px] outline-none placeholder:text-slate-400'
          />
          <span className='shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-muted dark:text-slate-400'>
            {pickedCount} picked
          </span>
        </div>

        {hasExtraCols && (
          // Sticky: the catalog list is tall and the page scroller carries it —
          // without this the labels scroll away and favorites/section rows
          // read as headerless columns. Opaque bg (not the /60 tint) so rows
          // never bleed through while pinned.
          <div className='sticky top-0 z-[5] flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-400 dark:border-border dark:bg-muted'>
            {config.favorites && <span className='w-[18px] shrink-0' />}
            <span className='w-36 shrink-0'>Item</span>
            {displayCols.map((c) => (
              <span
                key={c.field}
                className={c.format ? 'w-20 shrink-0 text-right' : 'min-w-0 flex-1'}
              >
                {c.label ?? titleCase(c.field.split('.')[0])}
              </span>
            ))}
            {relatedCols.map((rc) => (
              <span key={rc.key} className='w-20 shrink-0 text-right'>
                {rc.label ?? titleCase(rc.key)}
              </span>
            ))}
            <span className='w-20 shrink-0 text-right'>Qty</span>
          </div>
        )}

        {search.trim().length > 0 && fullMatches.length === 0 && fullSearchFetching && (
          <div className='flex items-center justify-center gap-2 border-b border-slate-100 px-3 py-3 text-slate-400 dark:border-border/50'>
            <Loader2 className='h-3.5 w-3.5 animate-spin' /> Searching the catalog…
          </div>
        )}
        {search.trim().length > 0 &&
          fullMatches.length === 0 &&
          !fullSearchFetching && (
            <p className='px-3 py-4 text-center text-slate-400'>
              No CIFAs match "{search.trim()}"
            </p>
          )}
        {search.trim().length > 0 && fullMatches.length > 0 && (
          <Fragment>
            <div className='flex w-full items-center gap-1.5 border-b border-t border-slate-200 bg-sky-50/70 px-2 py-1.5 dark:border-border dark:bg-sky-900/10'>
              <Search className='h-3 w-3 shrink-0 text-sky-500' />
              <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                Search results
              </span>
              <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                {fullMatches.length}
              </span>
              <span className='text-[10px] text-slate-400'>
                across the entire catalog — enter a quantity to add
              </span>
              {fullSearchFetching && (
                <Loader2 className='h-3 w-3 shrink-0 animate-spin text-slate-400' />
              )}
            </div>
            {fullMatches.map((r, i) => {
              const id = String(r.id)
              const qty = currentQty(id)
              return (
                <div
                  key={id}
                  className={cn(
                    'flex items-center gap-2 border-b border-slate-100 px-3 py-1 dark:border-border/50',
                    i % 2 === 0 ? 'bg-white dark:bg-background' : 'bg-slate-50/50 dark:bg-muted/30',
                    (qty ?? 0) > 0 && 'bg-[#00ceff0d]'
                  )}
                >
                  {starButton(id)}
                  {itemLabel(id, applyDisplayTemplate(tmpl, r), itemLabelCls)}
                  {colCells(id, r)}
                  {savingIds.has(id) && (
                    <Loader2 className='h-3 w-3 shrink-0 animate-spin text-slate-400' />
                  )}
                  {qtyInput(id, r)}
                </div>
              )
            })}
          </Fragment>
        )}

        {missingParents.length > 0 && !search.trim() && (
          <p className='px-3 py-6 text-center text-slate-400'>
            Search the full catalog above, or select{' '}
            {missingParents.map((f) => parentDraftCtx?.fieldLabels?.[f] ?? titleCase(f)).join(', ')} to browse by category
          </p>
        )}
        {missingParents.length === 0 && catalogLoading && (
          <div className='flex items-center justify-center gap-2 py-6 text-slate-400'>
            <Loader2 className='h-4 w-4 animate-spin' /> Loading catalog…
          </div>
        )}
        {missingParents.length === 0 && !catalogLoading && sections.length === 0 && (
          <p className='px-3 py-6 text-center text-slate-400'>No catalog items</p>
        )}

        {config.favorites && (
          <Fragment>
            <div className='flex w-full items-center gap-1.5 border-b border-slate-200 bg-amber-50/70 px-2 py-1 dark:border-border dark:bg-amber-900/10'>
              <button
                type='button'
                onClick={() =>
                  setCollapsed((p) => {
                    const n = new Set(p)
                    if (n.has('__favorites__')) n.delete('__favorites__')
                    else n.add('__favorites__')
                    return n
                  })
                }
                className='flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left'
              >
                <ChevronRight
                  className={cn(
                    'h-3 w-3 shrink-0 text-slate-400 transition-transform',
                    !collapsed.has('__favorites__') && 'rotate-90'
                  )}
                />
                <Star className='h-3 w-3 shrink-0 fill-amber-400 text-amber-400' />
                <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                  Favorites
                </span>
                <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                  {pinnedRowsData.length}
                </span>
              </button>
              <button
                ref={favMgrAnchorRef}
                type='button'
                onClick={() => setFavMgrOpen(true)}
                className='shrink-0 rounded border border-amber-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-amber-700 transition-colors hover:border-amber-300 hover:bg-amber-50 dark:border-amber-400/30 dark:bg-transparent dark:text-amber-300 dark:hover:bg-amber-400/10'
              >
                Manage
              </button>
            </div>
            {!collapsed.has('__favorites__') && pinnedRowsData.length === 0 && (
              <p className='border-b border-slate-100 px-3 py-2 text-center text-[11px] text-slate-400 dark:border-border/50'>
                No favorites yet — Manage lets you search the full catalog and star items.
              </p>
            )}
            {!collapsed.has('__favorites__') &&
              pinnedRowsData
                .map((r, i) => {
                  const id = String(r.id)
                  const qty = currentQty(id)
                  const shortfall = qtyShortfall(id)
                  return (
                    <div
                      key={id}
                      className={cn(
                        'flex items-center gap-2 border-b border-slate-100 px-3 py-1 dark:border-border/50',
                        i % 2 === 0
                          ? 'bg-white dark:bg-background'
                          : 'bg-slate-50/50 dark:bg-muted/30',
                        (qty ?? 0) > 0 && 'bg-[#00ceff0d]',
                        shortfall && 'bg-amber-50 dark:bg-amber-900/15'
                      )}
                    >
                      {starButton(id)}
                      {itemLabel(id, applyDisplayTemplate(tmpl, r), itemLabelCls)}
                      {colCells(id, r)}
                      {shortfall && (
                        <AlertTriangle
                          className='h-3.5 w-3.5 shrink-0 text-amber-500'
                          aria-label={`${qtyWarningLabel} ${shortfall.available} — ${shortfall.qty} requested`}
                        />
                      )}
                      {savingIds.has(id) && (
                        <Loader2 className='h-3 w-3 shrink-0 animate-spin text-slate-400' />
                      )}
                      {qtyInput(id, r)}
                    </div>
                  )
                })}
          </Fragment>
        )}

        {missingParents.length === 0 &&
          sections.map((s) => {
            const isCollapsed = collapsed.has(s.name)
            const pickedInSection = s.items.reduce(
              (n, it) => n + ((currentQty(it.id) ?? 0) > 0 ? 1 : 0),
              0
            )
            return (
              <Fragment key={s.name}>
                <button
                  type='button'
                  onClick={() =>
                    setCollapsed((p) => {
                      const n = new Set(p)
                      if (n.has(s.name)) n.delete(s.name)
                      else n.add(s.name)
                      return n
                    })
                  }
                  className='flex w-full items-center gap-1.5 border-b border-slate-200 bg-slate-100/80 px-2 py-1.5 text-left dark:border-border dark:bg-muted'
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 shrink-0 text-slate-400 transition-transform',
                      !isCollapsed && 'rotate-90'
                    )}
                  />
                  <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    {s.name}
                  </span>
                  <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                    {s.items.length}
                  </span>
                  {pickedInSection > 0 && (
                    <span className='rounded bg-[#00ceff1a] px-1.5 py-0.5 text-[10px] font-semibold text-[#009abe]'>
                      {pickedInSection} picked
                    </span>
                  )}
                </button>
                {!isCollapsed &&
                  s.items.map((it, i) => {
                    const qty = currentQty(it.id)
                    const shortfall = qtyShortfall(it.id)
                    return (
                      <div
                        key={it.id}
                        className={cn(
                          'flex items-center gap-2 border-b border-slate-100 px-3 py-1 dark:border-border/50',
                          i % 2 === 0
                            ? 'bg-white dark:bg-background'
                            : 'bg-slate-50/50 dark:bg-muted/30',
                          (qty ?? 0) > 0 && 'bg-[#00ceff0d]',
                          shortfall && 'bg-amber-50 dark:bg-amber-900/15'
                        )}
                      >
                        {starButton(it.id)}
                        {itemLabel(it.id, it.label, itemLabelCls)}
                        {colCells(it.id, it.row)}
                        {shortfall && (
                          <AlertTriangle
                            className='h-3.5 w-3.5 shrink-0 text-amber-500'
                            aria-label={`${qtyWarningLabel} ${shortfall.available} — ${shortfall.qty} requested`}
                          />
                        )}
                        {savingIds.has(it.id) && (
                          <Loader2 className='h-3 w-3 shrink-0 animate-spin text-slate-400' />
                        )}
                        {qtyInput(it.id, it.row)}
                      </div>
                    )
                  })}
              </Fragment>
            )
          })}

      </div>

      {/* ── Attribute-driven builders (fiber jumpers, attenuator pads, …) ────── */}
      {(config.builders ?? [])
        .filter((b) => matchesShowWhen(b.show_when, parentDraft))
        .map((b) => (
          <BuilderCard
            key={b.label}
            builder={b}
            defaultItemField={config.item_field}
            catalogCol={catalogCol}
            catalogFields={catalogFields}
            tmpl={tmpl}
            qtyInput={qtyInput}
            currentQty={currentQty}
          />
        ))}

      {/* ── Summary of everything picked + arbitrary add ─────────────────────── */}
      <div className='rounded-lg border border-slate-200 text-[12px] dark:border-border'>
        <div className='flex items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted'>
          <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
            Summary
          </span>
          {!readOnly && (
            <div className='flex items-center gap-2' onClick={(e) => e.stopPropagation()}>
              {config.upload_template && !isNew && reimportHandler && parentCollection && (
                <ImportFromFileButton
                  collection={parentCollection}
                  templateFilter={(t) => t.name === config.upload_template && t.reimport?.enabled === true}
                  getLabel={(t) => t.reimport?.button_label ?? t.button_label}
                  onParsed={(result, template) => reimportHandler(result, template)}
                  compact
                />
              )}
              <div className='w-64'>
                <RelationCombobox
                  collection={catalogCol}
                  value={null}
                  onChange={(v) => void addArbitrary(v)}
                  placeholder='＋ Add any item…'
                />
              </div>
            </div>
          )}
        </div>
        {pickedEntries.length === 0 ? (
          <p className='px-3 py-4 text-center text-slate-400'>Nothing picked yet</p>
        ) : (
          (() => {
            // Two-line rows: identity + editable numbers up top (description
            // gets the flex space), availability/fulfillment as self-labeled
            // stats underneath — 16 competing columns crushed the identity
            // cells to "10…" while fixed numerics hogged the width.
            const line1TextCols = summaryDisplayCols.filter((c) => !c.format)
            const descCol = line1TextCols[0]
            const chipCols = line1TextCols.slice(1)
            const statDisplayCols = summaryDisplayCols.filter((c) => !!c.format)
            const statVal = (v: unknown, format?: 'currency' | 'number' | 'presence'): string => {
              if (format === 'presence')
                return v === undefined || v === null || v === '' || Number(v) === 0 ? 'No' : 'Yes'
              if (v === true || v === 'true') return '✓'
              if (v === false || v === 'false') return '—'
              if (v == null || v === '') return '—'
              return fmtVal(v, format)
            }
            const numHead = (label: string) => (
              <span className='w-20 shrink-0 text-right text-[11px] font-medium text-slate-500'>
                {label}
              </span>
            )
            return (
              <div>
                <div className='flex items-center gap-2 border-b border-slate-200 px-3 py-1.5 dark:border-border'>
                  <span className='flex-1 text-[11px] font-medium text-slate-500'>Item</span>
                  {copyCols.map((c) => (
                    <Fragment key={c}>{numHead(titleCase(c))}</Fragment>
                  ))}
                  {numHead(titleCase(qtyField))}
                  {computeCols.map((c) => (
                    <Fragment key={c}>{numHead(titleCase(c))}</Fragment>
                  ))}
                  {!readOnly && <span className='w-6 shrink-0' />}
                </div>
                {pickedEntries.map((e, i) => {
                  const rowDbId = e.row.id != null ? String(e.row.id) : null
                  const isStagedDelete = rowDbId != null && queuedDeletes.has(rowDbId)
                  const shortfall = isStagedDelete ? null : qtyShortfall(e.key)
                  const submissionError = isStagedDelete ? null : submissionErrorFor(e.key)
                  return (
                  <div
                    key={e.key}
                    className={cn(
                      'border-b border-slate-100 px-3 py-2 last:border-b-0 dark:border-border/50',
                      i % 2 === 0 ? 'bg-white dark:bg-background' : 'bg-slate-50/50 dark:bg-muted/30',
                      shortfall && 'bg-amber-50 dark:bg-amber-900/15',
                      submissionError && 'bg-red-50/70 dark:bg-red-900/15',
                      isStagedDelete && 'opacity-60'
                    )}
                  >
                    <div className={cn('flex items-center gap-2', isStagedDelete && 'line-through decoration-slate-400')}>
                      {itemLabel(
                        e.key,
                        labelFor(e.key),
                        'shrink-0 font-semibold text-slate-800 dark:text-slate-100'
                      )}
                      {submissionError && (
                        <span className='group/suberr relative shrink-0'>
                          <AlertCircle className='h-3.5 w-3.5 text-red-500' strokeWidth={2} />
                          {/* CSS hover tooltip — native title has an OS delay */}
                          <span className='pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden w-max max-w-[380px] -translate-x-1/2 whitespace-normal break-words rounded-md bg-[#0f172a] px-2.5 py-1.5 text-left text-[11px] font-normal leading-4 text-white shadow-lg group-hover/suberr:block'>
                            <span className='mb-0.5 block font-semibold text-red-300'>
                              This line was in the failed submission
                            </span>
                            {submissionError}
                          </span>
                        </span>
                      )}
                      {descCol && (
                        <span
                          className='min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300'
                          title={String(pathValue(catalogRowFor(e.key), descCol.field) ?? '')}
                        >
                          {fmtVal(pathValue(catalogRowFor(e.key), descCol.field), undefined)}
                        </span>
                      )}
                      {!descCol && <span className='flex-1' />}
                      {chipCols.map((c) => {
                        const v = pathValue(catalogRowFor(e.key), c.field)
                        if (v == null || v === '') return null
                        return (
                          <span
                            key={c.field}
                            className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 dark:bg-muted dark:text-slate-300'
                          >
                            {String(v)}
                          </span>
                        )
                      })}
                      {copyCols.map((c) =>
                        editableFields.includes(c) && !readOnly ? (
                          <input
                            key={`${e.key}:${c}:${String(e.row[c] ?? '')}`}
                            type='number'
                            min={0}
                            step='any'
                            defaultValue={e.row[c] == null ? '' : String(e.row[c])}
                            onBlur={(ev) => void commitField(e.key, c, ev.target.value)}
                            onKeyDown={(ev) => {
                              if (ev.key === 'Enter') (ev.currentTarget as HTMLInputElement).blur()
                            }}
                            className='h-7 w-20 shrink-0 rounded border border-slate-200 bg-white px-2 text-right text-[12px] outline-none focus:border-nvr-cyan dark:border-border dark:bg-background'
                          />
                        ) : (
                          <span
                            key={c}
                            className='w-20 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-300'
                          >
                            {fmtVal(e.row[c], config.field_formats?.[c])}
                          </span>
                        )
                      )}
                      <span className='inline-flex w-20 shrink-0 items-center justify-end gap-1'>
                        {savingIds.has(e.key) && (
                          <Loader2 className='h-3 w-3 animate-spin text-slate-400' />
                        )}
                        {qtyInput(e.key, catalogRowFor(e.key))}
                      </span>
                      {computeCols.map((c) => {
                        // Stored compute value when present; otherwise derive it
                        // live from the row (rows created outside the picker —
                        // imports, API — never ran the client compute on create).
                        const stored = e.row[c]
                        const v =
                          stored != null && stored !== ''
                            ? stored
                            : evalClientFormula(config.compute_fields?.[c] ?? '', e.row)
                        return (
                          <span
                            key={c}
                            className='w-20 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-300'
                          >
                            {fmtVal(v, config.field_formats?.[c])}
                          </span>
                        )
                      })}
                      {!readOnly && isStagedDelete && (
                        <button
                          type='button'
                          onClick={() => staging?.cancelPendingDelete(relatedCollection, manyField, rowDbId!)}
                          className='shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-nvr-navy underline dark:text-nvr-cyan'
                        >
                          Undo
                        </button>
                      )}
                      {!readOnly && !isStagedDelete && (
                        <button
                          type='button'
                          title='Remove (applies on Save)'
                          onClick={() => {
                            // Stage the removal into the outer form's O2M delete
                            // queue — the DELETE happens on Save, Cancel discards.
                            // Standalone hosts without staging keep the live path.
                            if (!isNew && staging && rowDbId != null) {
                              staging.queueDelete(relatedCollection, manyField, rowDbId)
                              return
                            }
                            void commitQty(e.key, '0', {})
                          }}
                          className='w-6 shrink-0 rounded p-0.5 text-slate-300 transition-colors hover:text-red-500'
                        >
                          <X className='mx-auto h-3.5 w-3.5' />
                        </button>
                      )}
                    </div>
                    {(statDisplayCols.length > 0 ||
                      summaryRelatedCols.length > 0 ||
                      summaryFields.length > 0) && (
                      <div className='mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 pl-0.5 text-[11px]'>
                        {statDisplayCols.map((c) => (
                          <span key={c.field} className='whitespace-nowrap'>
                            <span className='text-slate-500 dark:text-muted-foreground'>
                              {c.label ?? titleCase(c.field.split('.')[0])}
                            </span>{' '}
                            <span className='font-medium tabular-nums text-slate-700 dark:text-slate-200'>
                              {statVal(pathValue(catalogRowFor(e.key), c.field), c.format)}
                            </span>
                          </span>
                        ))}
                        {summaryRelatedCols.map((rc) => (
                          <span key={rc.key} className='whitespace-nowrap'>
                            <span className='text-slate-500 dark:text-muted-foreground'>
                              {rc.label ?? titleCase(rc.key)}
                            </span>{' '}
                            <span className='font-medium tabular-nums text-slate-700 dark:text-slate-200'>
                              {statVal(relatedValue(rc.key, e.key), rc.format)}
                            </span>
                          </span>
                        ))}
                        {summaryFields.map((sf) => {
                          const v = summaryFieldValue(sf, e)
                          return (
                            <span key={sf.field} className='whitespace-nowrap'>
                              <span className='text-slate-500 dark:text-muted-foreground'>
                                {sf.label ?? titleCase(sf.field)}
                              </span>{' '}
                              <span className='font-medium text-slate-700 dark:text-slate-200'>
                                {statVal(v, sf.format)}
                              </span>
                            </span>
                          )
                        })}
                      </div>
                    )}
                    {shortfall && (
                      <p className='mt-1 flex items-center gap-1 pl-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400'>
                        <AlertTriangle className='h-3 w-3 shrink-0' />
                        {qtyWarningLabel} is {fmtVal(shortfall.available, 'number')} — {fmtVal(shortfall.qty, 'number')} requested
                      </p>
                    )}
                    {isStagedDelete && (
                      <p className='mt-1 pl-0.5 text-[11px] text-red-500'>
                        Removed — applies when you save
                      </p>
                    )}
                  </div>
                  )
                })}
              </div>
            )
          })()
        )}
      </div>
      {favMgrOpen && catalogCol && (
        <FavoritesManagerDrawer
          catalogCol={catalogCol}
          tmpl={tmpl}
          sectionBy={config.section_by}
          pinnedSet={pinnedSet}
          pinnedIds={pinnedIds}
          relatedCols={(config.favorites_manager_columns ?? [])
            .map((k) => (config.related_columns ?? []).find((rc) => rc.key === k))
            .filter((rc): rc is NonNullable<typeof rc> => !!rc)}
          parentDraft={parentDraft}
          onToggle={(id) => void togglePin(id)}
          onClose={() => setFavMgrOpen(false)}
          anchor={favMgrAnchorRef.current}
        />
      )}
    </div>
  )
}

// ─── BuilderCard ──────────────────────────────────────────────────────────────
// One attribute-driven item builder: the resolver collection holds one row per
// valid attribute combination with an FK to the catalog item. Picking every
// attribute (options cascade: only combinations that exist remain) resolves the
// item, which then takes a quantity like any other catalog row.

function BuilderCard({
  builder,
  defaultItemField,
  catalogCol,
  catalogFields,
  tmpl,
  qtyInput,
  currentQty
}: {
  builder: CatalogBuilderConfig
  defaultItemField: string
  catalogCol: string
  catalogFields: string
  tmpl: string | undefined
  qtyInput: (catalogId: string, catalogRow: Record<string, unknown>) => ReactNode
  currentQty: (catalogId: string) => number | null
}) {
  const client = useNivaroClient()
  const itemField = builder.item_field ?? defaultItemField
  const [expanded, setExpanded] = useState(false)
  const [sel, setSel] = useState<Record<string, string>>({})

  const resolverFields = useMemo(
    () =>
      [
        'id',
        itemField,
        ...builder.attributes.flatMap((a) => [`${a.field}.id`, `${a.field}.${a.label_field}`])
      ].join(','),
    [itemField, builder.attributes]
  )
  const { data: resolverRows = [], isLoading } = useQuery<Record<string, unknown>[]>({
    queryKey: [
      'catalog-builder',
      builder.collection,
      resolverFields,
      JSON.stringify(builder.filter ?? null)
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${builder.collection}`, {
            limit: 2000,
            fields: resolverFields,
            ...(builder.filter ? { filter: JSON.stringify(builder.filter) } : {})
          })
        )
        .then((r) => r.data ?? []),
    enabled: expanded,
    staleTime: 60_000
  })

  const attrOf = (
    row: Record<string, unknown>,
    field: string
  ): { id: string; label: string } | null => {
    const v = row[field]
    if (v == null) return null
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>
      const lf = builder.attributes.find((a) => a.field === field)?.label_field ?? 'id'
      return { id: String(o.id ?? ''), label: String(o[lf] ?? o.id ?? '') }
    }
    return { id: String(v), label: String(v) }
  }

  // Rows matching the selections made for attributes BEFORE index i
  const matchingRows = (uptoIdx: number): Record<string, unknown>[] =>
    resolverRows.filter((row) =>
      builder.attributes.slice(0, uptoIdx).every((a) => {
        const chosen = sel[a.field]
        if (!chosen) return true
        return attrOf(row, a.field)?.id === chosen
      })
    )

  const allSelected = builder.attributes.every((a) => sel[a.field])
  const resolvedRow = allSelected
    ? resolverRows.find((row) =>
        builder.attributes.every((a) => attrOf(row, a.field)?.id === sel[a.field])
      )
    : undefined
  const resolvedItemId = resolvedRow?.[itemField] != null ? String(resolvedRow[itemField]) : null

  const { data: resolvedCatalogRow } = useQuery<Record<string, unknown> | null>({
    queryKey: ['catalog-builder-item', catalogCol, catalogFields, resolvedItemId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            filter: JSON.stringify({ id: { _eq: resolvedItemId } }),
            fields: catalogFields,
            limit: 1
          })
        )
        .then((r) => r.data?.[0] ?? null),
    enabled: !!resolvedItemId,
    staleTime: 60_000
  })

  return (
    <div className='rounded-lg border border-slate-200 text-[12px] dark:border-border'>
      <button
        type='button'
        onClick={() => setExpanded((e) => !e)}
        className='flex w-full items-center gap-1.5 rounded-t-lg bg-slate-100/80 px-2 py-1.5 text-left dark:bg-muted'
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-slate-400 transition-transform',
            expanded && 'rotate-90'
          )}
        />
        <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
          {builder.label}
        </span>
      </button>
      {expanded && (
        <div className='space-y-2 border-t border-slate-200 p-3 dark:border-border'>
          {isLoading ? (
            <div className='flex items-center gap-2 py-2 text-slate-400'>
              <Loader2 className='h-4 w-4 animate-spin' /> Loading options…
            </div>
          ) : (
            <div className='flex flex-wrap items-end gap-3'>
              {builder.attributes.map((a, i) => {
                const opts = new Map<string, string>()
                for (const row of matchingRows(i)) {
                  const av = attrOf(row, a.field)
                  if (av?.id) opts.set(av.id, av.label)
                }
                const sorted = [...opts.entries()].sort(([, la], [, lb]) =>
                  la.localeCompare(lb, undefined, { numeric: true })
                )
                return (
                  <AttrSelect
                    key={a.field}
                    label={titleCase(a.field)}
                    value={sel[a.field] ?? null}
                    valueLabel={sel[a.field] ? (opts.get(sel[a.field]) ?? sel[a.field]) : null}
                    options={sorted}
                    disabled={i > 0 && !sel[builder.attributes[i - 1].field]}
                    onChange={(id) =>
                      setSel((prev) => {
                        const next: Record<string, string> = {}
                        // keep selections up to this attr; clear later ones
                        for (let j = 0; j < i; j++) {
                          const f = builder.attributes[j].field
                          if (prev[f]) next[f] = prev[f]
                        }
                        if (id) next[a.field] = id
                        return next
                      })
                    }
                  />
                )
              })}
              <div className='flex min-h-[28px] flex-1 items-center gap-2'>
                {resolvedItemId && resolvedCatalogRow ? (
                  <>
                    <span className='min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200'>
                      {applyDisplayTemplate(tmpl, resolvedCatalogRow)}
                    </span>
                    {(currentQty(resolvedItemId) ?? 0) > 0 && (
                      <span className='rounded bg-[#00ceff1a] px-1.5 py-0.5 text-[10px] font-semibold text-[#009abe]'>
                        picked
                      </span>
                    )}
                    {qtyInput(resolvedItemId, resolvedCatalogRow)}
                  </>
                ) : allSelected ? (
                  <span className='text-slate-400'>No matching item for this combination</span>
                ) : (
                  <span className='text-slate-400'>Pick each attribute to resolve an item</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Minimal dropdown for small option lists (attribute picks)
function AttrSelect({
  label,
  value,
  valueLabel,
  options,
  disabled,
  onChange
}: {
  label: string
  value: string | null
  valueLabel: string | null
  options: Array<[string, string]>
  disabled?: boolean
  onChange: (id: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  return (
    <div ref={rootRef} className='relative'>
      <p className='mb-1 text-[10px] font-medium text-slate-500 dark:text-slate-400'>{label}</p>
      <button
        type='button'
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className='flex w-44 items-center justify-between rounded border border-slate-200 bg-white px-2 py-1.5 text-left text-[12px] text-slate-700 hover:border-slate-300 disabled:opacity-50 dark:border-border dark:bg-background dark:text-slate-200'
      >
        <span className={cn('truncate', !valueLabel && 'text-slate-400')}>
          {valueLabel ?? 'Select…'}
        </span>
        <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
      </button>
      {open && (
        <div className='absolute z-50 mt-1 max-h-52 w-44 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-md'>
          {value && (
            <button
              type='button'
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className='flex w-full items-center gap-1.5 border-b border-slate-100 px-2 py-1 text-left text-[12px] text-slate-500 hover:bg-muted dark:border-border dark:text-slate-400'
            >
              <X className='h-3 w-3 text-slate-400' /> Clear
            </button>
          )}
          {options.map(([id, lbl]) => (
            <button
              key={id}
              type='button'
              onClick={() => {
                onChange(id)
                setOpen(false)
              }}
              className={cn(
                'block w-full truncate px-2 py-1 text-left text-[12px] hover:bg-muted',
                id === value ? 'font-medium text-nvr-cyan' : 'text-slate-700 dark:text-slate-200'
              )}
            >
              {lbl}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Favorites manager — a static 50%-width drawer for browsing the FULL catalog
 * (unfiltered by the record's project type / zone gating) and starring items.
 * The section list only ever shows in-scope items, so without this a user
 * could never favorite a CIFA outside the current request's filter. Related
 * columns (config.favorites_manager_columns) roll up across only the rows
 * their `match` resolves to — the same warehouse filter the form drives.
 */
function FavoritesManagerDrawer({
  catalogCol,
  tmpl,
  sectionBy,
  pinnedSet,
  pinnedIds,
  relatedCols,
  parentDraft,
  onToggle,
  onClose,
  anchor
}: {
  catalogCol: string
  tmpl: string | null | undefined
  sectionBy: string
  pinnedSet: Set<string>
  pinnedIds: string[]
  relatedCols: Array<{
    key: string
    label?: string
    collection: string
    item_field: string
    value_field: string
    match?: Record<string, unknown>
    format?: 'currency' | 'number' | 'presence'
  }>
  parentDraft: Record<string, unknown> | undefined
  onToggle: (id: string) => void
  onClose: () => void
  anchor: HTMLElement | null
}) {
  const client = useNivaroClient()
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [pageNum, setPageNum] = useState(1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setDq(q), 300)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setPageNum(1), [dq])
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // Full rows ('*') so a description-ish column shows without the component
  // knowing the catalog's schema; the dotted section path rides alongside for
  // the category column. Sorted by the display template's first plain column
  // (cifa_number on EFP) so the default listing reads as the catalog index.
  const sortField = useMemo(() => {
    const first = [...(tmpl ?? '').matchAll(/\{\{([\w.]+)\}\}/g)][0]?.[1]
    return first && !first.includes('.') ? first : 'id'
  }, [tmpl])
  const listFields = sectionBy.includes('.') ? `*,${sectionBy}` : '*'
  const PAGE = 50
  const { data: listData, isFetching } = useQuery<{
    data: Record<string, unknown>[]
    total?: number
  }>({
    queryKey: ['favorites-manager-list', catalogCol, dq, sortField, pageNum],
    queryFn: () =>
      client.request<{ data: Record<string, unknown>[]; total?: number }>(
        get(`/items/${catalogCol}`, {
          fields: listFields,
          limit: PAGE,
          page: pageNum,
          sort: sortField,
          ...(dq.trim() ? { search: dq } : {})
        })
      ),
    staleTime: 30_000,
    placeholderData: (p) => p
  })
  // Starred rows live ONLY in the favorites group — drop them from All CIFAs.
  const results = (listData?.data ?? []).filter((r) => !pinnedSet.has(String(r.id)))
  const total = listData?.total ?? results.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE))

  // Favorites rows fetched here (not the parent's projection) so description /
  // category columns are populated for them too.
  const { data: favRows = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['favorites-manager-pinned', catalogCol, listFields, pinnedIds.join(',')],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${catalogCol}`, {
            filter: JSON.stringify({ id: { _in: pinnedIds } }),
            fields: listFields,
            limit: pinnedIds.length,
            sort: sortField
          })
        )
        .then((r) => r.data ?? []),
    enabled: pinnedIds.length > 0,
    staleTime: 30_000
  })

  const label = (row: Record<string, unknown>) =>
    tmpl ? applyDisplayTemplate(tmpl, row) : String(row.cifa_number ?? row.name ?? `#${row.id}`)
  const description = (row: Record<string, unknown>) => {
    const d = row.description ?? row.long_description ?? row.name
    return typeof d === 'string' && d.trim() && d.trim() !== label(row) ? d : ''
  }
  const category = (row: Record<string, unknown>) => {
    if (!sectionBy) return ''
    const v = applyDisplayTemplate(`{{${sectionBy}}}`, row)
    return v === `{{${sectionBy}}}` ? '' : v
  }
  const fmt = (v: unknown, format?: 'currency' | 'number' | 'presence'): string => {
    if (format === 'presence')
      return v === null || v === undefined || v === '' || Number(v) === 0 ? 'No' : 'Yes'
    if (v === null || v === undefined || v === '') return '—'
    const n = Number(v)
    if (format === 'currency' && Number.isFinite(n))
      return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
    if (format === 'number' && Number.isFinite(n)) return n.toLocaleString()
    return String(v)
  }

  // One batched lookup per related column over the visible ids (page + pinned),
  // restricted by the resolved match — i.e. only the warehouses the form's
  // current field selection filters to. Multiple matching rows per item ROLL
  // UP: numeric values sum, text takes the first row.
  const visibleIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of results) ids.add(String(r.id))
    for (const id of pinnedIds) ids.add(id)
    return [...ids]
  }, [results, pinnedIds])
  const relatedResults = useQueries({
    queries: relatedCols.map((rc) => {
      const match = resolveRelatedMatch(rc.match, parentDraft)
      return {
        queryKey: [
          'favorites-manager-related',
          rc.key,
          rc.collection,
          JSON.stringify(match),
          visibleIds.join(',')
        ],
        queryFn: async () => {
          const rows = await client
            .request<{ data: Record<string, unknown>[] }>(
              get(`/items/${rc.collection}`, {
                filter: JSON.stringify({ [rc.item_field]: { _in: visibleIds }, ...(match ?? {}) }),
                fields: `${rc.item_field},${rc.value_field}`,
                limit: 1000
              })
            )
            .then((r) => r.data ?? [])
          const map = new Map<string, unknown>()
          for (const row of rows) {
            const id = String(row[rc.item_field])
            const v = row[rc.value_field]
            const prev = map.get(id)
            if (prev === undefined) map.set(id, v)
            else if (Number.isFinite(Number(prev)) && Number.isFinite(Number(v)))
              map.set(id, Number(prev) + Number(v))
          }
          return map
        },
        enabled: visibleIds.length > 0 && (rc.match === undefined || match !== null),
        staleTime: 30_000
      }
    })
  })
  const relatedGated = relatedCols.filter(
    (rc) => rc.match !== undefined && resolveRelatedMatch(rc.match, parentDraft) === null
  )

  const starBtn = (id: string) => {
    const pinned = pinnedSet.has(id)
    return (
      <button
        type='button'
        title={pinned ? 'Remove from favorites' : 'Add to favorites'}
        onClick={() => onToggle(id)}
        className='shrink-0 rounded p-1 transition-colors hover:bg-amber-100/60 dark:hover:bg-amber-400/10'
      >
        <Star
          className={cn(
            'h-4 w-4',
            pinned ? 'fill-amber-400 text-amber-400' : 'text-slate-300 hover:text-amber-400'
          )}
        />
      </button>
    )
  }

  const bandRow = (content: ReactNode, cls: string) => (
    <tr>
      <td colSpan={4 + relatedCols.length} className={cn('border-b px-3 py-1.5', cls)}>
        {content}
      </td>
    </tr>
  )

  const itemRow = (row: Record<string, unknown>, i: number) => {
    const id = String(row.id)
    const desc = description(row)
    return (
      <tr
        key={id}
        className={cn(
          'border-b border-slate-100 dark:border-border/50',
          i % 2 === 0 ? 'bg-white dark:bg-background' : 'bg-slate-50/50 dark:bg-muted/30'
        )}
      >
        <td className='px-2 py-1'>{starBtn(id)}</td>
        <td className='px-2 py-1 font-medium tabular-nums text-slate-700 dark:text-slate-200'>
          {canOpenCatalogItem(catalogCol) ? (
            <button
              type='button'
              onClick={() => openCatalogItem(catalogCol, id)}
              title='View stock & planning detail'
              className='text-left underline-offset-2 hover:text-[#009abe] hover:underline'
            >
              {label(row)}
            </button>
          ) : (
            label(row)
          )}
        </td>
        <td className='max-w-0 px-2 py-1'>
          <p className='truncate text-slate-600 dark:text-slate-300' data-tip={desc || undefined}>
            {desc || '—'}
          </p>
        </td>
        <td className='px-2 py-1'>
          <p className='truncate text-slate-500 dark:text-slate-400'>{category(row) || '—'}</p>
        </td>
        {relatedCols.map((rc, ci) => {
          const gated = rc.match !== undefined && resolveRelatedMatch(rc.match, parentDraft) === null
          const v = gated ? undefined : relatedResults[ci]?.data?.get(id)
          return (
            <td
              key={rc.key}
              className='whitespace-nowrap px-2 py-1 text-right tabular-nums text-slate-600 dark:text-slate-300'
            >
              {gated ? '—' : fmt(v, rc.format)}
            </td>
          )
        })}
      </tr>
    )
  }

  // Inside a modal sheet, body-level portals inherit the modal lock's
  // pointer-events: none — portal into the dialog content instead
  // (RelationCombobox / DropPanel precedent).
  const container = (anchor?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body

  const filteredPinned = q.trim()
    ? favRows.filter((r) =>
        matchesAllTokens(`${label(r)} ${description(r)} ${category(r)}`, q)
      )
    : favRows

  return createPortal(
    <div className='fixed inset-0 z-[125]' role='presentation'>
      <div
        className='absolute inset-0 bg-slate-900/30 motion-safe:animate-in motion-safe:fade-in'
        onClick={onClose}
      />
      <div
        role='dialog'
        aria-label='Manage CIFA favorites'
        style={{ width: '50vw' }}
        className='absolute inset-y-0 right-0 flex flex-col border-l border-slate-200 bg-white shadow-2xl motion-safe:animate-in motion-safe:slide-in-from-right dark:border-border dark:bg-background'
      >
        <div className='flex items-start gap-2.5 border-b border-slate-200 px-4 py-3 dark:border-border'>
          <Star className='mt-0.5 h-4 w-4 shrink-0 fill-amber-400 text-amber-400' />
          <div className='min-w-0 flex-1'>
            <p className='text-[13px] font-semibold text-slate-800 dark:text-slate-100'>
              CIFA favorites
            </p>
            <p className='text-[11px] leading-snug text-slate-500 dark:text-slate-400'>
              Browse the full catalog and star items — favorites appear at the top of every
              request's item list.
            </p>
          </div>
          <button
            type='button'
            onClick={onClose}
            className='shrink-0 rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-white/[0.06]'
            aria-label='Close'
          >
            <X className='h-4 w-4' />
          </button>
        </div>

        <div className='border-b border-slate-200 px-3 py-2 dark:border-border'>
          <div className='flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 focus-within:border-[#00ceff] focus-within:bg-white dark:border-border dark:bg-muted/40 dark:focus-within:bg-background'>
            <Search className='h-3.5 w-3.5 shrink-0 text-slate-400' />
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Search by number or description…'
              className='min-w-0 flex-1 bg-transparent text-[12px] text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-200'
            />
            {q && (
              <button
                type='button'
                onClick={() => setQ('')}
                className='shrink-0 text-slate-400 hover:text-slate-600'
                aria-label='Clear search'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            )}
          </div>
          {relatedGated.length > 0 && (
            <p className='mt-1.5 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400'>
              <AlertTriangle className='h-3 w-3 shrink-0' />
              {relatedGated.map((rc) => rc.label ?? titleCase(rc.key)).join(', ')} fill in once the
              form's warehouse selection is made.
            </p>
          )}
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto'>
          <table className='w-full table-fixed border-collapse text-[11px]'>
            <colgroup>
              <col className='w-9' />
              <col className='w-[88px]' />
              <col />
              <col className='w-[130px]' />
              {relatedCols.map((rc) => (
                <col key={rc.key} className='w-[86px]' />
              ))}
            </colgroup>
            <thead className='sticky top-0 z-[1]'>
              <tr className='bg-slate-100 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-muted dark:text-slate-400'>
                <th className='px-2 py-1.5' aria-label='Favorite' />
                <th className='px-2 py-1.5'>CIFA #</th>
                <th className='px-2 py-1.5'>Description</th>
                <th className='px-2 py-1.5'>Category</th>
                {relatedCols.map((rc) => (
                  <th key={rc.key} className='px-2 py-1.5 text-right'>
                    {rc.label ?? titleCase(rc.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(isFetching && 'opacity-50 transition-opacity')}>
              {bandRow(
                <span className='flex items-center gap-1.5'>
                  <Star className='h-3 w-3 shrink-0 fill-amber-400 text-amber-400' />
                  <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    Your favorites
                  </span>
                  <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                    {pinnedIds.length}
                  </span>
                </span>,
                'border-slate-200 bg-amber-50/70 dark:border-border dark:bg-amber-900/10'
              )}
              {filteredPinned.length === 0 && (
                <tr>
                  <td
                    colSpan={4 + relatedCols.length}
                    className='border-b border-slate-100 px-4 py-3 text-center text-[11px] text-slate-400 dark:border-border/50'
                  >
                    {pinnedIds.length === 0
                      ? 'No favorites yet — star the items you order most.'
                      : 'No favorites match your search.'}
                  </td>
                </tr>
              )}
              {filteredPinned.map((r, i) => itemRow(r, i))}

              {bandRow(
                <span className='flex items-center gap-1.5'>
                  <Search className='h-3 w-3 shrink-0 text-slate-400' />
                  <span className='text-[11px] font-semibold text-slate-600 dark:text-slate-300'>
                    All CIFAs
                  </span>
                  <span className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-500 dark:border-border dark:bg-background dark:text-slate-400'>
                    {total.toLocaleString()}
                  </span>
                  {isFetching && <Loader2 className='h-3 w-3 animate-spin text-slate-400' />}
                </span>,
                'border-t border-slate-200 bg-slate-50 dark:border-border dark:bg-muted/40'
              )}
              {!isFetching && results.length === 0 && (
                <tr>
                  <td
                    colSpan={4 + relatedCols.length}
                    className='px-4 py-4 text-center text-[11px] text-slate-400'
                  >
                    {dq.trim() ? `No CIFAs match "${dq}".` : 'No catalog items.'}
                  </td>
                </tr>
              )}
              {results.map((r, i) => itemRow(r, i))}
            </tbody>
          </table>
        </div>

        {pageCount > 1 && (
          <div className='flex shrink-0 items-center justify-between border-t border-slate-200 px-3 py-2 dark:border-border'>
            <span className='flex items-center gap-2 text-[10px] tabular-nums text-slate-400'>
              {(pageNum - 1) * PAGE + 1}–{Math.min(pageNum * PAGE, total)} of{' '}
              {total.toLocaleString()}
              {isFetching && (
                <span className='flex items-center gap-1 text-slate-500'>
                  <Loader2 className='h-3 w-3 animate-spin' /> Loading…
                </span>
              )}
            </span>
            <div className='flex items-center gap-1'>
              <button
                type='button'
                disabled={pageNum <= 1 || isFetching}
                onClick={() => setPageNum((n) => Math.max(1, n - 1))}
                className='rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.04]'
              >
                ‹ Prev
              </button>
              <span className='px-1 text-[10px] tabular-nums text-slate-400'>
                {pageNum} / {pageCount.toLocaleString()}
              </span>
              <button
                type='button'
                disabled={pageNum >= pageCount || isFetching}
                onClick={() => setPageNum((n) => Math.min(pageCount, n + 1))}
                className='rounded border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:text-slate-300 dark:hover:bg-white/[0.04]'
              >
                Next ›
              </button>
            </div>
          </div>
        )}
      </div>
    </div>,
    container
  )
}
