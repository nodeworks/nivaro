import { Search } from 'lucide-react'
import { useState } from 'react'
import { useDebounced } from '../../../hooks/useDebounced'
import { cn } from '../../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Skeleton } from '../../ui/skeleton'
import { WIDTH_LABELS } from '../field-zones'
import { useLayoutEditorHost } from '../host'
import { btnOutline } from '../overview/OverviewActions'
import { type FieldPlacementHit, type FieldSearchHit, useFieldSearch } from './crossform-api'

// Find a field across all forms (#2658): every layout in every collection that
// places it, with its section and width there, linking into the editor.

const TYPE_WORDS: Record<string, string> = {
  grouped: 'form',
  summary: 'summary',
  detail: 'detail',
  file: 'PDF',
  addendum: 'addendum',
  table: 'grid columns'
}

function PlacementLine({
  hit,
  p,
  onOpen
}: {
  hit: FieldSearchHit
  p: FieldPlacementHit
  onOpen: ((hit: FieldSearchHit, p: FieldPlacementHit) => void) | null
}) {
  const facts = [
    p.section ?? 'No section',
    WIDTH_LABELS[p.width] ?? 'Full',
    p.label_hidden ? 'label hidden' : p.label ? `labelled “${p.label}”` : null,
    p.visible ? null : 'hidden',
    p.inherited_from ? `from ${p.inherited_from}` : null
  ].filter(Boolean)
  const name = (
    <>
      <span className='font-medium text-slate-800 group-hover:text-[#0089ad] dark:text-foreground dark:group-hover:text-nvr-cyan'>
        {p.layout_name}
      </span>
      {p.layout_type !== 'grouped' && (
        <span className='ml-1 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {TYPE_WORDS[p.layout_type] ?? p.layout_type}
        </span>
      )}
    </>
  )
  return (
    <li>
      {onOpen ? (
        <button
          type='button'
          data-field-placement={p.layout_id}
          onClick={() => onOpen(hit, p)}
          className='group block w-full rounded px-2 py-1 text-left hover:bg-muted'
        >
          {name}
          <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {facts.join(' · ')}
          </span>
        </button>
      ) : (
        <div className='px-2 py-1'>
          {name}
          <span className='block text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {facts.join(' · ')}
          </span>
        </div>
      )}
    </li>
  )
}

export function FindFieldButton({
  collection,
  onOpen
}: {
  collection: string
  onOpen: (layoutId: number) => void
}) {
  const host = useLayoutEditorHost()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const q = useDebounced(text.trim(), 250)
  const { data, isFetching, isError } = useFieldSearch(open ? q : '')

  const openHit = (hit: FieldSearchHit, p: FieldPlacementHit) => {
    setOpen(false)
    if (hit.collection === collection) onOpen(p.layout_id)
    else if (host.layoutLink) host.navigate(host.layoutLink(hit.collection, p.layout_id))
  }
  const canOpen = (hit: FieldSearchHit) => hit.collection === collection || !!host.layoutLink

  // This collection first: it is where the search started.
  const fields = [...(data?.fields ?? [])].sort(
    (a, b) => Number(b.collection === collection) - Number(a.collection === collection)
  )

  let body = null
  if (q.length < 2) {
    body = (
      <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Type a field name or label. Every collection is searched.
      </p>
    )
  } else if (isError) {
    body = <p className='px-3 py-3 text-[12px] text-red-600 dark:text-red-400'>Could not search.</p>
  } else if (!data && isFetching) {
    body = (
      <div className='space-y-1.5 p-3'>
        <Skeleton className='h-4 w-2/3' />
        <Skeleton className='h-4 w-1/2' />
      </div>
    )
  } else if (fields.length === 0) {
    body = (
      <p className='px-3 py-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
        No field matches “{q}”.
      </p>
    )
  } else {
    body = (
      <ul className='divide-y divide-slate-100 dark:divide-border/60'>
        {fields.map((hit) => (
          <li
            key={`${hit.collection}.${hit.field}`}
            data-field-hit={`${hit.collection}.${hit.field}`}
            className='px-1 py-2'
          >
            <div className='flex flex-wrap items-baseline gap-x-2 px-2'>
              <span className='text-[12.5px] font-semibold text-slate-900 dark:text-foreground'>
                {hit.label}
              </span>
              <span className='font-mono text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {hit.collection}.{hit.field}
              </span>
              <span className='ml-auto text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                {hit.placements.length === 0
                  ? 'on no form'
                  : `on ${hit.placements.length} ${hit.placements.length === 1 ? 'form' : 'forms'}`}
              </span>
            </div>
            {hit.placements.length > 0 && (
              <ul className='mt-0.5'>
                {hit.placements.map((p) => (
                  <PlacementLine
                    key={`${p.layout_id}`}
                    hit={hit}
                    p={p}
                    onOpen={canOpen(hit) ? openHit : null}
                  />
                ))}
              </ul>
            )}
          </li>
        ))}
        {data?.truncated && (
          <li className='px-3 py-2 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            More fields match. Type more of the name to narrow the list.
          </li>
        )}
      </ul>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={btnOutline}
          data-tip='Find a field on every form, in every collection'
        >
          <Search className='h-3.5 w-3.5' />
          Find a field
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' side='bottom' className='w-[400px] p-0'>
        <div className='border-b border-slate-100 p-2 dark:border-border'>
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover opens to type a name
            autoFocus
            aria-label='Find a field on every form'
            placeholder='Field name or label'
            value={text}
            onChange={(e) => setText(e.target.value)}
            className={cn(
              'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan',
              'dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
            )}
          />
        </div>
        <div className='max-h-[420px] overflow-y-auto overscroll-contain'>{body}</div>
      </PopoverContent>
    </Popover>
  )
}
