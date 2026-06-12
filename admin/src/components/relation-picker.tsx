import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api } from '@/lib/api'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'

interface RelationPickerProps {
  relatedCollection: string
  value: unknown
  onChange: (id: unknown) => void
  disabled?: boolean
  extraFilter?: Record<string, unknown>
  placeholder?: string
}

export function RelationPicker({
  relatedCollection,
  value,
  onChange,
  disabled,
  extraFilter,
  placeholder
}: RelationPickerProps) {
  const [open, setOpen] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 200)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [searchInput])

  // nivaro_users is a system table — use the /users endpoint instead of /items
  const isUserRelation = relatedCollection === 'nivaro_users'

  const { data: colMeta, isError: colError } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data),
    staleTime: 10 * 60 * 1000,
    retry: false,
    enabled: !isUserRelation
  })

  const displayTemplate = isUserRelation
    ? '{{first_name}} {{last_name}}'
    : (colMeta?.display_template ?? null)
  const fields = extractTemplateFields(displayTemplate)

  const hasValue = value !== null && value !== undefined && value !== ''

  const { data: currentItem, isLoading: labelLoading } = useQuery({
    queryKey: ['relation-item', relatedCollection, String(value)],
    queryFn: async () => {
      const url = isUserRelation ? `/users/${value}` : `/items/${relatedCollection}/${value}`
      const res = await api.get(url, { params: isUserRelation ? undefined : { fields: '*' } })
      return res.data.data as Record<string, unknown>
    },
    enabled: hasValue,
    staleTime: 30 * 60 * 1000,
    retry: false
  })

  const searchFields = colMeta ? fields.join(',') : '*'
  const pickerFilter = !isUserRelation
    ? (colMeta?.picker_filter as Record<string, unknown> | null | undefined)
    : null
  const clauses = [pickerFilter, extraFilter].filter(Boolean) as Record<string, unknown>[]
  const filterParam = clauses.length > 0
    ? JSON.stringify(clauses.length === 1 ? clauses[0] : { _and: clauses })
    : undefined

  const { data: searchResults, isLoading: searchLoading } = useQuery({
    queryKey: ['relation-search', relatedCollection, searchFields, debouncedSearch, filterParam],
    queryFn: async () => {
      if (isUserRelation) {
        const res = await api.get('/users', {
          params: { limit: 200, search: debouncedSearch || undefined }
        })
        return (res.data.data ?? []) as Record<string, unknown>[]
      }
      const res = await api.get(`/items/${relatedCollection}`, {
        params: { limit: 200, fields: searchFields, search: debouncedSearch || undefined, filter: filterParam, picker: '1' }
      })
      return (res.data.data ?? []) as Record<string, unknown>[]
    },
    enabled: open,
    staleTime: 30 * 1000
  })

  const currentLabel = hasValue
    ? currentItem
      ? renderDisplayTemplate(displayTemplate, currentItem)
      : String(value)
    : null

  if (colError) {
    return (
      <Input
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className='h-9 text-[13px]'
        placeholder='Unknown collection'
      />
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          disabled={disabled}
          className='w-full h-9 px-3 text-[13px] border border-slate-200 rounded-md bg-white text-left flex items-center justify-between hover:bg-slate-50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed'
        >
          {labelLoading ? (
            <span className='text-slate-400 text-[12px]'>Loading…</span>
          ) : currentLabel !== null ? (
            <span className='text-slate-800 truncate'>{currentLabel}</span>
          ) : (
            <span className='text-slate-400'>{placeholder ?? 'Select…'}</span>
          )}
          <ChevronDown className='h-3.5 w-3.5 text-slate-400 shrink-0 ml-2' />
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-2' align='start'>
        <div className='mb-2'>
          <Input
            placeholder='Search…'
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className='h-8 text-[13px]'
            autoFocus
          />
        </div>
        <ScrollArea className='h-[200px]'>
          <div className='space-y-0.5'>
            {/* Clear option */}
            <button
              type='button'
              onClick={() => {
                onChange(null)
                setOpen(false)
              }}
              className='flex items-center gap-2 px-3 py-2 text-[13px] text-slate-400 hover:bg-slate-50 cursor-pointer rounded-md w-full text-left'
            >
              Clear selection
            </button>

            {searchLoading && <div className='px-3 py-2 text-[13px] text-slate-400'>Loading…</div>}

            {!searchLoading && searchResults?.length === 0 && (
              <div className='px-3 py-2 text-[13px] text-slate-400'>No results</div>
            )}

            {!searchLoading &&
              [...(searchResults ?? [])].sort((a, b) =>
                renderDisplayTemplate(displayTemplate, a).localeCompare(
                  renderDisplayTemplate(displayTemplate, b)
                )
              ).map((item) => {
                const itemId = item.id
                const label = renderDisplayTemplate(displayTemplate, item)
                const isSelected = String(itemId) === String(value)
                return (
                  <button
                    type='button'
                    key={String(itemId)}
                    onClick={() => {
                      onChange(itemId)
                      setOpen(false)
                    }}
                    className='flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-slate-50 cursor-pointer rounded-md w-full text-left'
                  >
                    <Check
                      className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-nvr-cyan' : 'text-transparent'}`}
                    />
                    <span className='truncate text-slate-800'>{label}</span>
                  </button>
                )
              })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
