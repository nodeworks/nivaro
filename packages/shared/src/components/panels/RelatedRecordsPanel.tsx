import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Link2, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient, useItemNavigation } from '../../context'
import { del, get, post } from '../../lib/commands'
import { RelationCombobox } from '../item-edit/RelationCombobox'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { SimpleSelect } from '../ui/SimpleSelect'

/**
 * Related records — manual typed links between records ("supersedes",
 * "blocks"…) with backlinks shown on both sides. Server: /record-links.
 */

const LINK_TYPES = ['relates to', 'supersedes', 'duplicates', 'blocks', 'caused by']

interface RecordLink {
  id: number
  direction: 'out' | 'in'
  type: string
  collection: string
  item: string
  label: string | null
}

export function RelatedRecordsPanel({
  collection,
  itemId,
  defaultExpanded = false
}: {
  collection: string
  itemId: string
  defaultExpanded?: boolean
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { open: openItem } = useItemNavigation()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [adding, setAdding] = useState(false)
  // Most links point at a sibling record — default to this collection.
  const [targetCollection, setTargetCollection] = useState(collection)
  const [collectionPickerOpen, setCollectionPickerOpen] = useState(false)
  const [targetItem, setTargetItem] = useState<string | number | null>(null)
  const [linkType, setLinkType] = useState('relates to')

  const { data: links = [] } = useQuery({
    queryKey: ['record-links', collection, itemId],
    queryFn: () =>
      client
        .request<{ data: RecordLink[] }>(
          get(`/record-links/${collection}/${encodeURIComponent(itemId)}`)
        )
        .then((r) => r.data ?? []),
    enabled: !!itemId,
    staleTime: 30_000
  })

  const { data: collections = [] } = useQuery({
    queryKey: ['record-links-collections'],
    queryFn: () =>
      client
        .request<{ data: Array<{ collection: string; display_name?: string | null; hidden?: boolean }> }>(
          get('/collections')
        )
        .then((r) =>
          (r.data ?? []).filter(
            (c) => !c.hidden && !c.collection.toLowerCase().startsWith('nivaro_')
          )
        ),
    enabled: adding,
    staleTime: 5 * 60_000
  })

  const create = useMutation({
    mutationFn: () =>
      client.request(
        post('/record-links', {
          from_collection: collection,
          from_item: String(itemId),
          to_collection: targetCollection,
          to_item: String(targetItem),
          link_type: linkType
        })
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['record-links'] })
      setAdding(false)
      setTargetItem(null)
      toast.success('Records linked')
    },
    onError: (err) =>
      toast.error(
        ((err as { response?: { error?: string } }).response?.error) ?? 'Could not link'
      )
  })

  const remove = useMutation({
    mutationFn: (id: number) => client.request(del(`/record-links/${id}`)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['record-links'] })
  })

  return (
    <div
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-related-records
    >
      <button
        type='button'
        onClick={() => setExpanded((e) => !e)}
        className='flex w-full items-center gap-2 px-3.5 py-2.5 text-left'
      >
        <Link2 className='h-3.5 w-3.5 text-slate-400' />
        <span className='text-[12.5px] font-semibold text-slate-700 dark:text-slate-200'>
          Related records
        </span>
        {links.length > 0 && (
          <span className='rounded-full bg-slate-100 px-1.5 text-[10.5px] font-semibold tabular-nums text-slate-500 dark:bg-muted dark:text-slate-400'>
            {links.length}
          </span>
        )}
        {expanded ? (
          <ChevronDown className='ml-auto h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronRight className='ml-auto h-3.5 w-3.5 text-slate-400' />
        )}
      </button>
      {expanded && (
        <div className='border-t border-slate-100 px-3.5 py-2.5 dark:border-border/60'>
          {links.length === 0 && !adding && (
            <p className='pb-1 text-[11.5px] text-slate-400'>
              Nothing linked yet — connect this record to the ones it relates to.
            </p>
          )}
          <div className='space-y-1'>
            {links.map((l) => (
              <div key={`${l.direction}-${l.id}`} className='group/link flex items-center gap-1.5'>
                <span className='shrink-0 text-[10.5px] italic text-slate-400'>{l.type}</span>
                <button
                  type='button'
                  onClick={() => openItem({ collection: l.collection, itemId: l.item })}
                  className='min-w-0 flex-1 truncate text-left text-[12px] font-medium text-[#00a5cc] underline-offset-2 hover:underline'
                >
                  {l.label ?? `${l.collection}/${l.item}`}
                </button>
                <button
                  type='button'
                  title='Unlink'
                  onClick={() => remove.mutate(l.id)}
                  className='shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-opacity hover:text-red-500 group-hover/link:opacity-100'
                >
                  <X className='h-3 w-3' />
                </button>
              </div>
            ))}
          </div>
          {adding ? (
            <div className='mt-2 space-y-1.5 rounded-md border border-slate-200 p-2 dark:border-border'>
              <SimpleSelect
                value={linkType}
                onChange={setLinkType}
                ariaLabel='Link type'
                options={LINK_TYPES.map((t) => ({ value: t, label: t }))}
              />
              <Popover open={collectionPickerOpen} onOpenChange={setCollectionPickerOpen}>
                <PopoverTrigger asChild>
                  <button
                    type='button'
                    className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'
                    aria-label='Collection'
                  >
                    <span className='truncate'>
                      {(() => {
                        const c = collections.find((x) => x.collection === targetCollection)
                        return c?.display_name || targetCollection.replace(/_/g, ' ') || 'Pick a collection…'
                      })()}
                    </span>
                    <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  </button>
                </PopoverTrigger>
                <PopoverContent className='w-[240px] p-0' align='start'>
                  <Command>
                    <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
                    <CommandList>
                      <CommandEmpty>No collection found.</CommandEmpty>
                      {[...collections]
                        .sort((a, b) =>
                          (a.display_name || a.collection).localeCompare(b.display_name || b.collection)
                        )
                        .map((c) => (
                          <CommandItem
                            key={c.collection}
                            value={c.display_name || c.collection}
                            onSelect={() => {
                              setTargetCollection(c.collection)
                              setTargetItem(null)
                              setCollectionPickerOpen(false)
                            }}
                          >
                            {c.display_name || c.collection.replace(/_/g, ' ')}
                          </CommandItem>
                        ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
              {targetCollection && (
                <RelationCombobox
                  collection={targetCollection}
                  value={targetItem}
                  onChange={(v) => setTargetItem(v == null ? null : (v as string | number))}
                  placeholder='Find the record…'
                />
              )}
              <div className='flex gap-1.5'>
                <button
                  type='button'
                  disabled={!targetCollection || targetItem == null || create.isPending}
                  onClick={() => create.mutate()}
                  className='h-7 flex-1 rounded-md bg-nvr-cyan text-[11.5px] font-medium text-white hover:brightness-110 disabled:opacity-40'
                >
                  {create.isPending ? 'Linking…' : 'Link'}
                </button>
                <button
                  type='button'
                  onClick={() => setAdding(false)}
                  className='h-7 rounded-md border border-slate-200 px-2 text-[11.5px] text-slate-500 dark:border-border'
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type='button'
              onClick={() => setAdding(true)}
              className='mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-[#00a5cc] hover:underline'
            >
              <Plus className='h-3 w-3' /> Link a record
            </button>
          )}
        </div>
      )}
    </div>
  )
}
