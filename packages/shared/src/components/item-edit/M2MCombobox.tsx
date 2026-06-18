import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronDown, ChevronsUpDown, Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
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
import { useM2MStaging } from './M2MStagingContext'
import { RelatedItemLabel } from './RelationCombobox'
import type { CMSRelation } from './types'

// ─── M2MCombobox (multi-select) ────────────────────────────────────────────────

export function M2MCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
  requiredParent,
  onCountChange
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
  requiredParent?: string
  onCountChange?: (count: number) => void
}) {
  const client = useNivaroClient()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const otherRel = allRelations.find(
    (r) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = otherRel?.one_collection ?? null
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

  const filterParam = extraFilter ? JSON.stringify(extraFilter) : undefined
  const { data: options = [], isFetching: isLoadingOptions } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-options', relatedCollection, search, filterParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            limit: 200,
            search: search || undefined,
            filter: filterParam,
            picker: '1'
          })
        )
        .then((r) => r.data ?? []),
    enabled: open && !!relatedCollection,
    staleTime: filterParam ? 0 : 30_000
  })

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()
  const committedItems = junctionItems.filter((i) => !stagedUnlinks.has(i.id))
  const committedIds = new Set(committedItems.map((i) => String(i[junctionField])))
  const committedIdsList = [...committedIds]

  const multiAvailabilityFilter = extraFilter
    ? JSON.stringify({ _and: [{ id: { _in: committedIdsList } }, extraFilter] })
    : JSON.stringify({ id: { _in: committedIdsList } })

  const { data: availableForFilter } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-avail', relatedCollection, committedIdsList.join(','), filterParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, { filter: multiAvailabilityFilter, picker: '1', limit: 200, fields: 'id' })
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
  const stagedLinkIds = new Set(stagedLinks.map(String))
  const allSelectedIds = new Set([...committedIds, ...stagedLinkIds])

  const onCountChangeRef = useRef(onCountChange)
  onCountChangeRef.current = onCountChange
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return }
    onCountChangeRef.current?.(allSelectedIds.size)
  }, [allSelectedIds.size])

  function handleToggle(optId: unknown) {
    const strId = String(optId)
    if (stagedLinkIds.has(strId)) {
      staging?.unstageLink(stagingKey, optId)
      return
    }
    const existing = junctionItems.find((i) => String(i[junctionField]) === strId)
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
    return tmpl.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => String(item[k.trim()] ?? ''))
  }

  if (requiredParent) {
    return (
      <button
        type='button'
        disabled
        className='flex h-8 w-full items-center gap-1.5 rounded-md border border-input bg-background px-3 text-[13px] text-muted-foreground opacity-50 cursor-not-allowed'
      >
        <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
        Select {requiredParent} first
      </button>
    )
  }

  return (
    <div className='space-y-1.5'>
      {allSelectedIds.size > 0 && (
        <div className='flex flex-wrap gap-1.5'>
          {committedItems.map((ji) => {
            const relId = ji[junctionField]
            const isStaleTag = staleCommittedIds.has(String(relId))
            return (
              <span
                key={String(ji.id)}
                title={isStaleTag ? 'This record is no longer an available option' : undefined}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border pl-2.5 pr-1.5 py-0.5 text-[12px]',
                  isStaleTag
                    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-600 dark:bg-amber-950/30 dark:text-amber-400'
                    : 'border-slate-200 bg-slate-50 text-slate-700'
                )}
              >
                {isStaleTag && <AlertTriangle className='h-3 w-3 shrink-0 text-amber-500' />}
                {relatedCollection && (
                  <RelatedItemLabel
                    collection={relatedCollection}
                    id={relId}
                    displayTemplate={colMeta?.display_template}
                  />
                )}
                <button
                  type='button'
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
              className='inline-flex items-center gap-1 rounded-full border border-dashed border-nvr-cyan/50 bg-nvr-cyan/5 pl-2.5 pr-1.5 py-0.5 text-[12px] text-slate-600'
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
                onClick={() => staging?.unstageLink(stagingKey, relId)}
                className='rounded-full p-0.5 text-slate-400 hover:text-red-500'
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o)
          if (!o) setSearch('')
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className='h-8 w-full justify-start gap-1.5 text-[13px] font-normal text-muted-foreground'
          >
            <ChevronDown className='h-4 w-4 shrink-0 opacity-50' />
            {allSelectedIds.size > 0
              ? `${allSelectedIds.size} selected — click to change`
              : 'Select items…'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[320px] p-0' align='start'>
          <Command shouldFilter={false}>
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
              <CommandGroup>
                {!isLoadingOptions && [...options]
                  .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))
                  .map((opt) => {
                    const optId = String(opt.id)
                    const isSelected = allSelectedIds.has(optId)
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
                            isSelected ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'
                          )}
                        >
                          {isSelected && <Check className='h-2.5 w-2.5 text-white' />}
                        </div>
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

// ─── M2MSingleSelectCombobox (max_values=1) ────────────────────────────────────

export function M2MSingleSelectCombobox({
  relation,
  parentId,
  allRelations,
  extraFilter,
  requiredParent,
  onCountChange
}: {
  relation: CMSRelation
  parentId: string
  allRelations: CMSRelation[]
  extraFilter?: Record<string, unknown>
  requiredParent?: string
  onCountChange?: (count: number) => void
}) {
  const client = useNivaroClient()
  const staging = useM2MStaging()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const otherRel = allRelations.find(
    (r) =>
      r.many_collection === relation.many_collection &&
      r.many_field === relation.junction_field &&
      r.id !== relation.id
  )
  const relatedCollection = otherRel?.one_collection ?? null
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

  const { data: junctionItems = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-items', relation.many_collection, manyField, parentId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relation.many_collection}`, {
            filter: JSON.stringify({ [manyField]: { _eq: parentId } }),
            limit: 1,
            fields: `id,${junctionField}`
          })
        )
        .then((r) => r.data ?? []),
    staleTime: 30_000,
    enabled: !!parentId && parentId !== 'new'
  })

  const filterParam = extraFilter ? JSON.stringify(extraFilter) : undefined
  const { data: options = [], isFetching: isLoadingOptions } = useQuery<Record<string, unknown>[]>({
    queryKey: ['m2m-options', relatedCollection, search, filterParam],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown>[] }>(
          get(`/items/${relatedCollection}`, {
            limit: 200,
            search: search || undefined,
            filter: filterParam,
            picker: '1'
          })
        )
        .then((r) => r.data ?? []),
    enabled: open && !!relatedCollection,
    staleTime: filterParam ? 0 : 30_000
  })

  const stagedLinks = staging?.getStagedLinks(stagingKey) ?? []
  const stagedUnlinks = staging?.getStagedUnlinks(stagingKey) ?? new Set()

  const committedItem = junctionItems.find((i) => !stagedUnlinks.has(i.id)) ?? null
  const committedRelatedId = committedItem ? committedItem[junctionField] : null
  const stagedRelatedId = stagedLinks.length > 0 ? stagedLinks[stagedLinks.length - 1] : null
  const currentRelatedId = stagedRelatedId ?? committedRelatedId
  const isPendingChange = stagedLinks.length > 0 || stagedUnlinks.size > 0

  const singleOnCountChangeRef = useRef(onCountChange)
  singleOnCountChangeRef.current = onCountChange
  const singleMountedRef = useRef(false)
  useEffect(() => {
    if (!singleMountedRef.current) { singleMountedRef.current = true; return }
    singleOnCountChangeRef.current?.(currentRelatedId != null ? 1 : 0)
  }, [currentRelatedId])

  const { data: currentItemData } = useQuery<Record<string, unknown>>({
    queryKey: ['relation-single', relatedCollection, String(currentRelatedId)],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> }>(
          get(`/items/${relatedCollection}/${currentRelatedId}`)
        )
        .then((r) => r.data),
    enabled: !!relatedCollection && currentRelatedId != null,
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
          get(`/items/${relatedCollection}`, { filter: singleAvailabilityFilter, picker: '1', limit: 1, fields: 'id' })
        )
        .then((r) => r.data ?? []),
    enabled: !!relatedCollection && currentRelatedId != null && !!currentItemData,
    staleTime: 30_000
  })
  const isSingleStale = singleAvailabilityData !== undefined && singleAvailabilityData.length === 0

  const tmpl = colMeta?.display_template ?? null
  function getLabel(item: Record<string, unknown>) {
    return tmpl
      ? tmpl.replace(/\{\{([^}]+)\}\}/g, (_, k: string) => String(item[k.trim()] ?? ''))
      : String(item.name ?? item.title ?? item.label ?? item.id ?? '')
  }
  const currentOpt =
    options.find((o) => String(o.id) === String(currentRelatedId)) ?? currentItemData
  const isLoadingLabel = currentRelatedId != null && !currentItemData && !currentOpt
  const currentLabel = currentOpt ? getLabel(currentOpt) : null

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
    <div>
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
            'w-full h-9 px-3 text-[12px] border rounded-md bg-white text-left flex items-center justify-between hover:bg-slate-50 cursor-pointer transition-colors',
            isSingleStale ? 'border-amber-300 dark:border-amber-600' : isPendingChange ? 'border-nvr-cyan/50' : 'border-slate-200'
          )}
        >
          {isLoadingLabel ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin text-muted-foreground' />
          ) : (
            <span
              className={cn(
                'flex items-center gap-1.5 truncate min-w-0',
                currentLabel
                  ? isPendingChange
                    ? 'text-nvr-cyan'
                    : 'text-slate-800'
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
        <Command shouldFilter={false}>
          <CommandInput
            placeholder='Search…'
            value={search}
            onValueChange={setSearch}
            className='h-9 text-[12px]'
          />
          {currentRelatedId != null && (
            <button
              type='button'
              onClick={() => { handleClear(); setOpen(false) }}
              className='flex w-full items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 hover:bg-slate-50 border-b border-slate-100'
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
            {!isLoadingOptions && (
            <CommandGroup>
              {[...options]
                .sort((a, b) => getLabel(a).localeCompare(getLabel(b)))
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
                          isSelected ? 'border-nvr-cyan bg-nvr-cyan' : 'border-slate-300'
                        )}
                      >
                        {isSelected && <Check className='h-2.5 w-2.5 text-white' />}
                      </div>
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
    {isSingleStale && (
      <p className='mt-0.5 flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400'>
        <AlertTriangle className='h-3 w-3 shrink-0' />
        Current value is not an available option — clear to pick another
      </p>
    )}
    </div>
  )
}
