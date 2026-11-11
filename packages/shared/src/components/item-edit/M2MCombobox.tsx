import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronsUpDown, Loader2, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useDrilldown, useItemEditAuth, useNivaroClient } from '../../context'
import { parseAllowedCollections } from '../../lib/allowed-collections'
import { get } from '../../lib/commands'
import { compareByMatch } from '../../lib/picker-rank'
import { useRecordReader } from '../../lib/record-loader'
import { useOnlineUsers } from '../../lib/use-online-users'
import { cn, matchesAllTokens, userOptionFilter } from '../../lib/utils'
import { UserAvatar } from '../UserAvatar'

/** Initials from a rendered user label ("Jane Doe (jane@x)" → "JD"). */
function labelInitials(label: string): string {
  return (
    label
      .replace(/\(.*$/, '')
      .trim()
      .split(/\s+/)
      .map((p) => p[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?'
  )
}

import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { applyDisplayTemplate } from './helpers'
import { useM2MStaging } from './M2MStagingContext'
import { onlyCloseMatches } from './picker-search'
import { RelatedItemLabel, useStaleTip } from './RelationCombobox'
import type { CMSRelation } from './types'

// ─── M2A-aware related-collection resolution ─────────────────────────────────
// A plain M2M junction's companion relation carries one_collection. An M2A
// companion has one_collection NULL with the allowed collections in
// one_allowed_collections — resolve a browsable collection from that list
// (user-ish collections map to nivaro_users, which has virtual picker meta)
// so the combobox loads options instead of spinning forever.

function allowedList(rel: CMSRelation | undefined): string[] {
  return parseAllowedCollections(rel?.one_allowed_collections)
}

/** The junction column naming each link's collection on an M2A leg; null for a plain M2M. */
export function m2aDiscriminator(otherRel: CMSRelation | undefined): string | null {
  if (!otherRel || otherRel.one_collection) return null
  if (allowedList(otherRel).length < 2) return null
  return otherRel.one_collection_field || 'collection'
}

/**
 * The collection one junction row's item lives in. On an M2A leg each row names
 * its own (a ship-to contact is a person OR an external email); legacy
 * `directus_users` rows live in nivaro_users. Anything else = the picker's table.
 */
export function m2aRowCollection(
  row: Record<string, unknown> | null | undefined,
  discriminator: string | null,
  fallback: string | null
): string | null {
  if (!discriminator || !row) return fallback
  const v = row[discriminator]
  if (typeof v !== 'string' || !v.trim()) return fallback
  const c = v.trim()
  return c === 'directus_users' || c === 'nivaro_users' ? 'nivaro_users' : c
}

/** A linked record labelled by its OWN collection's display template (an M2A
 *  link outside the picker's table, e.g. an external email: `{{email}}`). */
export function OwnCollectionLabel({ collection, id }: { collection: string; id: unknown }) {
  const client = useNivaroClient()
  const { data: meta } = useQuery({
    queryKey: ['col-meta', collection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${collection}`))
        .then((r) => r.data),
    staleTime: 300_000,
    retry: false
  })
  return (
    <span data-m2a-collection={collection}>
      <RelatedItemLabel collection={collection} id={id} displayTemplate={meta?.display_template} />
    </span>
  )
}

/** How many collections an M2A companion leg allows (0 for a plain M2M). */
export function m2aAllowedCount(otherRel: CMSRelation | undefined): number {
  if (!otherRel || otherRel.one_collection) return 0
  return allowedList(otherRel).length
}

export function resolveM2MRelatedCollection(otherRel: CMSRelation | undefined): string | null {
  if (!otherRel) return null
  if (otherRel.one_collection) return otherRel.one_collection
  const allowed = allowedList(otherRel)
  if (allowed.length === 0) return null
  if (allowed.some((c) => c === 'directus_users' || c === 'nivaro_users')) return 'nivaro_users'
  return allowed[0]
}

/** For an M2A junction insert: the collection-discriminator column + the value
 *  to write (keeps the legacy allowed name, e.g. 'directus_users', so existing
 *  readers of the junction stay correct). Null for plain M2M. */
export function m2aWriteMeta(
  otherRel: CMSRelation | undefined
): { field: string; value: string } | null {
  if (!otherRel || otherRel.one_collection) return null
  const allowed = allowedList(otherRel)
  if (allowed.length === 0) return null
  const value = allowed.includes('directus_users')
    ? 'directus_users'
    : allowed.includes('nivaro_users')
      ? 'nivaro_users'
      : allowed[0]
  return { field: otherRel.one_collection_field ?? 'collection', value }
}

/** One spelling per linked id (GUIDs compare case-blind). */
export function m2mIdKey(id: unknown): string {
  return String(id).toLowerCase()
}

// ─── M2MCombobox (multi-select) ────────────────────────────────────────────────

export function M2MCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
  optionSort,
  requiredParent,
  onCountChange,
  drilldown
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
  optionSort?: string
  requiredParent?: string
  onCountChange?: (count: number) => void
  /** When set (and a DrilldownContext is provided), chips open the record's detail sheet. */
  drilldown?: { layout_id?: number | null; width?: number | string | null } | null
}) {
  const client = useNivaroClient()
  const drill = useDrilldown()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const otherRel = allRelations.find(
    (r) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = resolveM2MRelatedCollection(otherRel)
  const junctionField = relation.junction_field ?? ''
  const manyField = relation.many_field ?? ''
  const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`
  // M2A: each link names its own collection (a person OR an external email).
  const disc = m2aDiscriminator(otherRel)

  const { data: colMeta } = useQuery({
    queryKey: ['col-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    enabled: !!relatedCollection,
    staleTime: 300_000,
    retry: false
  })

  const { data: junctionItems = [] } = useQuery<Record<string, unknown>[]>({
    // An M2A read carries the discriminator: its own key (same prefix, so every
    // ['m2m-items', junction, …] invalidation still refreshes it).
    queryKey: [
      'm2m-items',
      relation.many_collection,
      manyField,
      parentId,
      ...(disc ? ['m2a'] : [])
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 200,
            fields: `id,${junctionField}${disc ? `,${disc}` : ''}`
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000,
    enabled: !!parentId && parentId !== 'new'
  })
  const rowCollection = (ji: Record<string, unknown>) =>
    m2aRowCollection(ji, disc, relatedCollection)

  // nivaro_users options mirror listUsers(): redacted accounts never appear
  // and suspended users are not pickable (committed values still display).
  const viewerIsAdmin = useItemEditAuth().isAdmin
  const redactionFilter =
    relatedCollection === 'nivaro_users' ? userOptionFilter(viewerIsAdmin) : null
  const onlineUsers = useOnlineUsers(relatedCollection === 'nivaro_users')
  const effectiveFilter = extraFilter
    ? redactionFilter
      ? { _and: [extraFilter, redactionFilter] }
      : extraFilter
    : redactionFilter
  const filterParam = effectiveFilter ? JSON.stringify(effectiveFilter) : undefined
  const serverSort = optionSort && !/^-?label$/.test(optionSort) ? optionSort : undefined
  const templateNestedFields = (() => {
    const tmpl2 = colMeta?.display_template
    if (!tmpl2 || !tmpl2.includes('.')) return null
    const tokens = [...tmpl2.matchAll(/\{\{([^}]+)\}\}/g)].map((mm) => mm[1].trim())
    if (tokens.length === 0) return null
    return ['id', ...tokens].join(',')
  })()
  const {
    options,
    isLoading: isLoadingOptions,
    localSearch,
    closeMatches
  } = useM2MOptions({
    client,
    relatedCollection,
    search,
    filterParam,
    serverSort,
    templateNestedFields,
    enabled: open && !!relatedCollection,
    labelOf: getLabel
  })
  const guessSelection = useGuessSelection(!!closeMatches, search)

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()
  const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id))
  const committedIds = new Set(committedItems.map((i) => String(i[junctionField])))
  // Only links into the picker's own table can be checked against its options
  // (an external email is never "no longer an available option" for people).
  const committedIdsList = [
    ...new Set(
      committedItems
        .filter((i) => rowCollection(i) === relatedCollection)
        .map((i) => String(i[junctionField]))
    )
  ]

  const multiAvailabilityFilter = extraFilter
    ? JSON.stringify({ _and: [{ id: { _in: committedIdsList } }, extraFilter] })
    : JSON.stringify({ id: { _in: committedIdsList } })

  const { data: availableForFilter } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-avail', relatedCollection, committedIdsList.join(','), filterParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: multiAvailabilityFilter,
            picker: '1',
            limit: 200,
            fields: 'id'
          })
        )
        .then((r) => r.data ?? []),
    enabled: !!relatedCollection && committedIdsList.length > 0,
    staleTime: 30_000
  })
  const availableIdSet = new Set((availableForFilter ?? []).map((i) => String(i.id)))
  const staleCommittedIds =
    availableForFilter !== undefined
      ? new Set(committedIdsList.filter((id) => !availableIdSet.has(id)))
      : new Set<string>()
  // Ids compare case-blind: a person id arrives upper-case from the picker and
  // lower-case from an import's email lookup — the same person must not be
  // linked twice ("Peter Moniz, Peter Moniz", army9 b02).
  const stagedLinkIds = new Set(stagedLinks.map(m2mIdKey))
  const allSelectedIds = new Set([...[...committedIds].map(m2mIdKey), ...stagedLinkIds])

  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange
  useEffect(() => {
    onCountChangeRef.current?.(allSelectedIds.size)
  }, [allSelectedIds.size])

  function handleToggle(optId: unknown) {
    const strId = m2mIdKey(optId)
    if (stagedLinkIds.has(strId)) {
      staging?.unstageLink(stagingKey, optId)
      return
    }
    const existing = junctionItems.find((i) => m2mIdKey(i[junctionField]) === strId)
    if (existing) {
      if (stagedUnlinks.has(existing.id)) staging?.unstageUnlink(stagingKey, existing.id)
      else staging?.stageUnlink(stagingKey, existing.id)
      return
    }
    staging?.stageLink(stagingKey, optId)
  }

  function getLabel(item: Record<string, unknown>) {
    const tmpl = colMeta?.display_template ?? null
    if (!tmpl) return String(item._display ?? item.id ?? '')
    // Dotted tokens ({{core_category.name}}) walk nested objects — the raw
    // per-key replace rendered every such option as '-'.
    return applyDisplayTemplate(tmpl, item)
  }

  if (requiredParent) {
    return (
      <button
        type='button'
        disabled
        className='flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm text-muted-foreground opacity-50 cursor-not-allowed'
      >
        <span className='truncate'>Select {requiredParent} first</span>
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
    )
  }

  return (
    <div>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          {/* div-with-role rather than <button>: the chips inside carry their own
              interactive ✕/drill buttons, which can't nest inside a button. */}
          <div
            role='button'
            tabIndex={0}
            onKeyDown={(e) => {
              // Typing on the closed picker opens it with that text searched,
              // like the single pickers (army11 f1: "Kristina Dav" was dropped
              // until the space, and "davison" did nothing). Keys that land
              // here after it opened are added, never dropped.
              const printable =
                e.key.length === 1 &&
                !e.ctrlKey &&
                !e.metaKey &&
                !e.altKey &&
                (open || search !== '' || e.key !== ' ')
              if (printable) {
                e.preventDefault()
                const typed = e.key
                setSearch((q) => (typed === ' ' && (q === '' || q.endsWith(' ')) ? q : q + typed))
                if (!open) setOpen(true)
              } else if (e.key === 'Enter' || e.key === ' ' || (!open && e.key === 'ArrowDown')) {
                e.preventDefault()
                setOpen((v) => !v)
              }
            }}
            className='flex min-h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-1 text-sm text-left font-normal hover:bg-muted'
          >
            {allSelectedIds.size > 0 ? (
              <span
                className='flex min-w-0 flex-1 flex-wrap items-center gap-1'
                onClick={(e) => {
                  // Chip ✕ / drill clicks shouldn't toggle the popover
                  if ((e.target as HTMLElement).closest('button')) e.stopPropagation()
                }}
              >
                {committedItems.map((ji) => {
                  const relId = ji[junctionField]
                  const own = rowCollection(ji)
                  const foreign = own !== relatedCollection
                  const isStaleTag = !foreign && staleCommittedIds.has(String(relId))
                  return (
                    <span
                      key={String(ji.id)}
                      title={
                        isStaleTag ? 'This record is no longer an available option' : undefined
                      }
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1.5 py-0.5 text-[12px]',
                        isStaleTag
                          ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-400'
                          : 'border-slate-200 bg-slate-50 text-slate-700 dark:border-border dark:bg-muted dark:text-slate-200'
                      )}
                    >
                      {isStaleTag && <AlertTriangle className='h-3 w-3 shrink-0 text-amber-500' />}
                      {own &&
                        (foreign ? (
                          // An external email (or another allowed kind): its own
                          // table, its own label — never read as a person.
                          <OwnCollectionLabel collection={own} id={relId} />
                        ) : drilldown && drill ? (
                          <button
                            type='button'
                            title='Open detail panel'
                            onClick={() =>
                              drill.open({
                                collection: own,
                                itemId: String(relId),
                                layoutId: drilldown.layout_id,
                                width: drilldown.width
                              })
                            }
                            className='underline decoration-slate-300 decoration-dotted underline-offset-2 hover:text-[#172940] hover:decoration-nvr-cyan dark:hover:text-nvr-cyan'
                          >
                            <RelatedItemLabel
                              collection={own}
                              id={relId}
                              displayTemplate={colMeta?.display_template}
                            />
                          </button>
                        ) : (
                          <RelatedItemLabel
                            collection={own}
                            id={relId}
                            displayTemplate={colMeta?.display_template}
                          />
                        ))}
                      <button
                        type='button'
                        aria-label='Remove'
                        onClick={() => staging?.stageUnlink(stagingKey, ji.id)}
                        className='rounded-full p-0.5 text-slate-400 hover:text-red-500'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </span>
                  )
                })}
                {stagedLinks.map((relId) => (
                  <span
                    key={String(relId)}
                    className='inline-flex items-center gap-1 rounded-full border border-dashed border-nvr-cyan/50 bg-nvr-cyan/5 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-600 dark:text-slate-300'
                  >
                    {relatedCollection ? (
                      <RelatedItemLabel
                        collection={relatedCollection}
                        id={relId}
                        displayTemplate={colMeta?.display_template}
                      />
                    ) : (
                      String(relId)
                    )}
                    <button
                      type='button'
                      aria-label='Remove'
                      onClick={() => staging?.unstageLink(stagingKey, relId)}
                      className='rounded-full p-0.5 text-slate-400 hover:text-red-500'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </span>
                ))}
              </span>
            ) : (
              <span className='truncate text-muted-foreground'>Select items…</span>
            )}
            <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
          </div>
        </PopoverTrigger>
        <PopoverContent className='w-[320px] p-0' align='start'>
          <Command
            shouldFilter={false}
            // Close matches are guesses: none is highlighted, so Enter never
            // picks one — the person arrows or clicks (army11 typo pass).
            {...guessSelection}
          >
            <CommandInput
              placeholder='Search…'
              value={search}
              onValueChange={setSearch}
              className='h-9 text-[13px]'
            />
            <CommandList>
              {isLoadingOptions ? (
                <div className='flex items-center justify-center py-4'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                </div>
              ) : (
                <CommandEmpty className='py-3 text-left text-[12px] text-muted-foreground px-3'>
                  No results
                </CommandEmpty>
              )}
              {!isLoadingOptions && closeMatches && (
                <p
                  data-picker-close-matches
                  className='px-3 pb-1 pt-2 text-[11.5px] text-muted-foreground'
                >
                  No exact match for “{search.trim()}” — did you mean:
                </p>
              )}
              <CommandGroup>
                {!isLoadingOptions &&
                  (serverSort
                    ? [...narrowM2MOptions(options, search, localSearch, getLabel)]
                    : [...narrowM2MOptions(options, search, localSearch, getLabel)].sort((a, b) =>
                        compareByMatch(getLabel(a), getLabel(b), search, optionSort === '-label')
                      )
                  ).map((opt) => {
                    const optId = String(opt.id)
                    const isSelected = allSelectedIds.has(m2mIdKey(optId))
                    return (
                      <CommandItem
                        key={optId}
                        value={optId}
                        onSelect={() => handleToggle(opt.id)}
                        className='flex items-center gap-2 text-[13px]'
                      >
                        <div
                          className={cn(
                            'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                            isSelected
                              ? 'border-nvr-cyan bg-nvr-cyan'
                              : 'border-slate-300 dark:border-slate-500'
                          )}
                        >
                          {isSelected && <Check className='h-2.5 w-2.5 text-white' />}
                        </div>
                        {relatedCollection === 'nivaro_users' && (
                          <UserAvatar
                            userId={optId}
                            className='h-4 w-4'
                            fallback={
                              <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>
                                {labelInitials(getLabel(opt))}
                              </span>
                            }
                          />
                        )}
                        {relatedCollection === 'nivaro_users' &&
                          onlineUsers.has(optId.toUpperCase()) && (
                            <span
                              className='h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
                              data-tip='Online now'
                            />
                          )}
                        <span className='truncate'>{getLabel(opt)}</span>
                      </CommandItem>
                    )
                  })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

// ─── Option list (both M2M pickers) ────────────────────────────────────────────

/** A picker's options. When the whole unsearched list fits in one page (a
 *  short lookup: funding years, categories) typing narrows THAT list by its
 *  labels here — the server's text search never reads a number-keyed row's
 *  label, so "2026" found nothing in a Funding Year list showing 2026
 *  (army8 b09). Longer lists search on the server as before. The caller
 *  narrows by label when `localSearch` is true (see narrowM2MOptions).
 *  When the labels match nothing, the server search answers instead: it
 *  also reads the collection's search fields (an Expenditure Type typed by
 *  its Oracle code — army8 review M2). */
function useM2MOptions(args: {
  client: ReturnType<typeof useNivaroClient>
  relatedCollection: string | null | undefined
  search: string
  filterParam: string | undefined
  serverSort: string | undefined
  templateNestedFields: string | null
  enabled: boolean
  labelOf: (o: Record<string, unknown>) => string
}): {
  options: Record<string, unknown>[]
  isLoading: boolean
  localSearch: boolean
  /** Every row is a typo-pass guess (fix11-search `fuzzy`): the exact search found nothing. */
  closeMatches?: boolean
} {
  const { client, relatedCollection, search, filterParam, serverSort, templateNestedFields } = args
  const fetchOptions = (text: string) =>
    client
      .request<{ data: Record<string, unknown>[] }>(
        get(`/items/${relatedCollection}`, {
          limit: M2M_OPTION_PAGE,
          search: text || undefined,
          // Typo pass (fix11-search): close matches only when the exact search finds nothing.
          ...(text ? { typo: '1' } : {}),
          filter: filterParam,
          picker: '1',
          // A dotted display template ({{core_category.name}}) needs the
          // nested expansion — a bare row only carries the FK id.
          ...(templateNestedFields ? { fields: templateNestedFields } : {}),
          ...(serverSort ? { sort: serverSort } : {})
        })
      )
      .then((r) => r.data ?? [])
  const keyFor = (text: string) => [
    'm2m-options',
    relatedCollection,
    text,
    filterParam,
    serverSort ?? '',
    templateNestedFields ?? ''
  ]
  const staleTime = filterParam ? 0 : 30_000
  const { data: base, isFetching: baseFetching } = useQuery<Record<string, unknown>[]>({
    queryKey: keyFor(''),
    queryFn: () => fetchOptions(''),
    enabled: args.enabled,
    staleTime
  })
  const askServer = m2mAsksServer(base, search, args.labelOf)
  const { data: searched, isFetching: searching } = useQuery<Record<string, unknown>[]>({
    queryKey: keyFor(search),
    queryFn: () => fetchOptions(search),
    enabled: args.enabled && askServer,
    staleTime
  })
  if (!askServer)
    return { options: base ?? [], isLoading: !base && baseFetching, localSearch: !!search }
  return {
    options: searched ?? [],
    isLoading: !searched && searching,
    localSearch: false,
    closeMatches: onlyCloseMatches(searched)
  }
}

const M2M_OPTION_PAGE = 200

/** Whether typed text goes to the server search: always for a list longer
 *  than one page; for a fully read list only when no label matches. */
export function m2mAsksServer<T>(
  base: T[] | undefined,
  search: string,
  labelOf: (o: T) => string
): boolean {
  if (!search.trim()) return false
  if (!base || base.length >= M2M_OPTION_PAGE) return true
  return narrowM2MOptions(base, search, true, labelOf).length === 0
}

/** The listed options for what is typed: narrowed by label when the whole
 *  list was read once (useM2MOptions `localSearch`). */
export function narrowM2MOptions<T>(
  options: T[],
  search: string,
  localSearch: boolean,
  labelOf: (o: T) => string
): T[] {
  if (!localSearch || !search.trim()) return options
  return options.filter((o) => matchesAllTokens(labelOf(o), search))
}

// ─── M2MSingleSelectCombobox (max_values=1) ────────────────────────────────────

export function M2MSingleSelectCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
  optionSort,
  requiredParent,
  onCountChange,
  readOnly
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
  optionSort?: string
  requiredParent?: string
  onCountChange?: (count: number) => void
  readOnly?: boolean
}) {
  const client = useNivaroClient()
  const readRow = useRecordReader()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const otherRel = allRelations.find(
    (r) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = resolveM2MRelatedCollection(otherRel)
  const junctionField = relation.junction_field ?? ''
  const manyField = relation.many_field ?? ''
  const stagingKey = relation.one_field ?? `${relation.many_collection}.${junctionField}`

  const { data: colMeta } = useQuery({
    queryKey: ['col-meta', relatedCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${relatedCollection}`))
        .then((r) => r.data),
    enabled: !!relatedCollection,
    staleTime: 300_000,
    retry: false
  })

  // M2A: the link names its own collection (a person OR an external email).
  const disc = m2aDiscriminator(otherRel)
  const { data: junctionItems = [], isFetching: isLoadingJunction } = useQuery<
    Record<string, unknown>[]
  >({
    queryKey: [
      'm2m-items',
      relation.many_collection,
      manyField,
      parentId,
      ...(disc ? ['m2a'] : [])
    ],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 1,
            fields: `id,${junctionField}${disc ? `,${disc}` : ''}`
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000,
    enabled: !!parentId && parentId !== 'new'
  })

  // nivaro_users options mirror listUsers(): redacted accounts never appear
  // and suspended users are not pickable (committed values still display).
  const viewerIsAdmin = useItemEditAuth().isAdmin
  const redactionFilter =
    relatedCollection === 'nivaro_users' ? userOptionFilter(viewerIsAdmin) : null
  const onlineUsers = useOnlineUsers(relatedCollection === 'nivaro_users')
  const effectiveFilter = extraFilter
    ? redactionFilter
      ? { _and: [extraFilter, redactionFilter] }
      : extraFilter
    : redactionFilter
  const filterParam = effectiveFilter ? JSON.stringify(effectiveFilter) : undefined
  const serverSort = optionSort && !/^-?label$/.test(optionSort) ? optionSort : undefined
  const templateNestedFields = (() => {
    const tmpl2 = colMeta?.display_template
    if (!tmpl2 || !tmpl2.includes('.')) return null
    const tokens = [...tmpl2.matchAll(/\{\{([^}]+)\}\}/g)].map((mm) => mm[1].trim())
    if (tokens.length === 0) return null
    return ['id', ...tokens].join(',')
  })()
  const {
    options,
    isLoading: isLoadingOptions,
    localSearch,
    closeMatches
  } = useM2MOptions({
    client,
    relatedCollection,
    search,
    filterParam,
    serverSort,
    templateNestedFields,
    enabled: open && !!relatedCollection,
    labelOf: getLabel
  })
  const guessSelection = useGuessSelection(!!closeMatches, search)

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()

  const committedItem = junctionItems.find((i) => !stagedUnlinks.has(i.id)) ?? null
  const committedRelatedId = committedItem ? committedItem[junctionField] : null
  const stagedRelatedId = stagedLinks.length > 0 ? stagedLinks[stagedLinks.length - 1] : null
  const currentRelatedId = stagedRelatedId ?? committedRelatedId
  const isPendingChange = stagedLinks.length > 0 || stagedUnlinks.size > 0

  const singleOnCountChangeRef = useRef(onCountChange)
  singleOnCountChangeRef.current = onCountChange
  useEffect(() => {
    singleOnCountChangeRef.current?.(currentRelatedId != null ? 1 : 0)
  }, [currentRelatedId])

  // A picked value is always from the picker's table; the stored link names its own.
  const currentCollection =
    stagedRelatedId != null
      ? relatedCollection
      : m2aRowCollection(committedItem, disc, relatedCollection)
  const currentForeign = currentCollection !== relatedCollection
  const { data: ownMeta } = useQuery({
    queryKey: ['col-meta', currentCollection],
    queryFn: () =>
      client
        .request<{ data: { display_template?: string } }>(get(`/collections/${currentCollection}`))
        .then((r) => r.data),
    enabled: currentForeign && !!currentCollection,
    staleTime: 300_000,
    retry: false
  })
  const { data: currentItemData } = useQuery<Record<string, unknown>>({
    queryKey: ['relation-single', currentCollection, String(currentRelatedId)],
    queryFn: () =>
      readRow(currentCollection as string, currentRelatedId as string | number) as Promise<
        Record<string, unknown>
      >,
    enabled: !!currentCollection && currentRelatedId != null,
    staleTime: 60_000
  })

  const singleAvailabilityFilter = extraFilter
    ? JSON.stringify({ _and: [{ id: { _eq: currentRelatedId } }, extraFilter] })
    : JSON.stringify({ id: { _eq: currentRelatedId } })

  const { data: singleAvailabilityData } = useQuery<Record<string, unknown>[]>({
    queryKey: ['relation-avail', relatedCollection, String(currentRelatedId), filterParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            filter: singleAvailabilityFilter,
            picker: '1',
            limit: 1,
            fields: 'id'
          })
        )
        .then((r) => r.data ?? []),
    enabled:
      !!relatedCollection && !currentForeign && currentRelatedId != null && !!currentItemData,
    staleTime: 30_000
  })
  const isSingleStale =
    !currentForeign && singleAvailabilityData !== undefined && singleAvailabilityData.length === 0
  const singleStaleTip = useStaleTip(isSingleStale)

  // Reads colMeta, not a const declared below: useM2MOptions calls it first.
  function getLabel(item: Record<string, unknown>) {
    const tmpl = colMeta?.display_template ?? null
    return tmpl
      ? applyDisplayTemplate(tmpl, item)
      : String(item.name ?? item.title ?? item.label ?? item.id ?? '')
  }
  const currentOpt = currentForeign
    ? currentItemData
    : (options.find((o) => String(o.id) === String(currentRelatedId)) ?? currentItemData)
  const isLoadingLabel = currentRelatedId != null && !currentItemData && !currentOpt
  const currentLabel = currentOpt
    ? currentForeign
      ? applyDisplayTemplate(ownMeta?.display_template ?? null, currentOpt)
      : getLabel(currentOpt)
    : null

  if (readOnly) {
    return (
      <span className='block truncate text-[12px] text-slate-700 dark:text-slate-200'>
        {isLoadingLabel ? '…' : (currentLabel ?? '—')}
      </span>
    )
  }

  function handleSelect(optId: unknown) {
    for (const id of stagedLinks) staging?.unstageLink(stagingKey, id)
    if (committedItem && !stagedUnlinks.has(committedItem.id))
      staging?.stageUnlink(stagingKey, committedItem.id)
    if (String(optId) === String(committedRelatedId) && committedItem) {
      staging?.unstageUnlink(stagingKey, committedItem.id)
    } else if (String(optId) !== String(currentRelatedId)) {
      staging?.stageLink(stagingKey, optId)
    }
    setOpen(false)
    setSearch('')
  }

  function handleClear() {
    for (const id of stagedLinks) staging?.unstageLink(stagingKey, id)
    if (committedItem) staging?.stageUnlink(stagingKey, committedItem.id)
    setOpen(false)
  }

  if (requiredParent) {
    return (
      <button
        type='button'
        disabled
        className='w-full h-9 px-3 text-[12px] border border-input rounded-md bg-background text-left flex items-center justify-between opacity-50 cursor-not-allowed'
      >
        <span className='truncate text-muted-foreground'>Select {requiredParent} first</span>
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
      </button>
    )
  }

  return (
    <div {...singleStaleTip.bind}>
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          <button
            type='button'
            className={cn(
              'w-full h-9 px-3 text-[12px] border rounded-md bg-background text-left flex items-center justify-between hover:bg-muted cursor-pointer transition-colors disabled:pointer-events-none disabled:opacity-50',
              isSingleStale
                ? 'border-amber-300 dark:border-amber-600'
                : isPendingChange
                  ? 'border-nvr-cyan/50'
                  : 'border-input'
            )}
          >
            {isLoadingLabel ||
            (isLoadingJunction && stagedRelatedId == null && parentId !== 'new') ? (
              <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
            ) : (
              <span
                className={cn(
                  'flex items-center gap-1.5 truncate min-w-0',
                  currentLabel
                    ? isPendingChange
                      ? 'text-nvr-cyan'
                      : 'text-slate-800 dark:text-slate-100'
                    : 'text-muted-foreground'
                )}
              >
                {isSingleStale && <AlertTriangle className='h-3.5 w-3.5 shrink-0 text-amber-500' />}
                <span className='truncate'>{currentLabel ?? 'Select…'}</span>
              </span>
            )}
            <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
          </button>
        </PopoverTrigger>
        <PopoverContent className='w-[320px] p-0' align='start'>
          <Command
            shouldFilter={false}
            // Close matches are guesses: none is highlighted, so Enter never
            // picks one — the person arrows or clicks (army11 typo pass).
            {...guessSelection}
          >
            <CommandInput
              placeholder='Search…'
              value={search}
              onValueChange={setSearch}
              className='h-9 text-[12px]'
            />
            {currentRelatedId != null && (
              <button
                type='button'
                onClick={() => {
                  handleClear()
                  setOpen(false)
                }}
                className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 hover:bg-muted border-b border-slate-100 dark:text-slate-400 dark:border-border'
              >
                <X className='h-3.5 w-3.5 text-slate-400' />
                Clear selection
              </button>
            )}
            <CommandList>
              {isLoadingOptions ? (
                <div className='flex items-center justify-center py-4'>
                  <Loader2 className='h-4 w-4 animate-spin text-muted-foreground' />
                </div>
              ) : (
                <CommandEmpty className='py-3 text-left text-[12px] text-muted-foreground px-3'>
                  No results
                </CommandEmpty>
              )}
              {!isLoadingOptions && closeMatches && (
                <p
                  data-picker-close-matches
                  className='px-3 pb-1 pt-2 text-[11.5px] text-muted-foreground'
                >
                  No exact match for “{search.trim()}” — did you mean:
                </p>
              )}
              {!isLoadingOptions && (
                <CommandGroup>
                  {[...narrowM2MOptions(options, search, localSearch, getLabel)]
                    .sort((a, b) =>
                      serverSort
                        ? 0
                        : compareByMatch(getLabel(a), getLabel(b), search, optionSort === '-label')
                    )
                    .map((opt) => {
                      const optId = String(opt.id)
                      const isSelected = String(currentRelatedId) === optId
                      return (
                        <CommandItem
                          key={optId}
                          value={optId}
                          onSelect={() => handleSelect(opt.id)}
                          className='flex items-center gap-2 text-[12px]'
                        >
                          <div
                            className={cn(
                              'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                              isSelected
                                ? 'border-nvr-cyan bg-nvr-cyan'
                                : 'border-slate-300 dark:border-slate-500'
                            )}
                          >
                            {isSelected && <Check className='h-2.5 w-2.5 text-white' />}
                          </div>
                          {relatedCollection === 'nivaro_users' && (
                            <UserAvatar
                              userId={optId}
                              className='h-4 w-4'
                              fallback={
                                <span className='flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-nvr-cyan/20 text-[8px] font-bold text-nvr-navy dark:text-nvr-cyan'>
                                  {labelInitials(getLabel(opt))}
                                </span>
                              }
                            />
                          )}
                          {relatedCollection === 'nivaro_users' &&
                            onlineUsers.has(optId.toUpperCase()) && (
                              <span
                                className='h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500'
                                data-tip='Online now'
                              />
                            )}
                          <span className='truncate'>{getLabel(opt)}</span>
                        </CommandItem>
                      )
                    })}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {singleStaleTip.tip}
    </div>
  )
}

/** cmdk selection for a list of close matches: nothing highlighted until the
 *  person moves (arrow keys or the pointer), and Enter picks nothing before
 *  that. cmdk selects its first item on its own and keeps that in its store
 *  even when `value` is controlled, so an unasked selection is answered by
 *  flipping the controlled value between '' and ' ' (both trim to nothing),
 *  which makes cmdk read it again. A new search starts over. */
function useGuessSelection(
  guesses: boolean,
  search: string
): {
  value?: string
  onValueChange?: (v: string) => void
  onKeyDownCapture?: (e: KeyboardEvent<HTMLDivElement>) => void
  onPointerMoveCapture?: () => void
} {
  const [picked, setPicked] = useState<string | null>(null)
  const [flip, setFlip] = useState(false)
  const armed = useRef(false)
  useEffect(() => {
    setPicked(null)
    armed.current = false
  }, [search])
  if (!guesses) return {}
  return {
    value: picked ?? (flip ? ' ' : ''),
    onValueChange: (v) => {
      if (armed.current) setPicked(v)
      else setFlip((f) => !f)
    },
    onKeyDownCapture: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') armed.current = true
      else if (e.key === 'Enter' && !armed.current) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onPointerMoveCapture: () => {
      armed.current = true
    }
  }
}
