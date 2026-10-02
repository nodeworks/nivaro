/**
 * Search (#1208): one box in the Traffic Map toolbar that opens any level by what you have in hand
 * — a request / chain / recording / trace / person id, an activity / job / issue / partner push /
 * AI call number, an email, a record id (CR26-80329, workflows/123) or a route path. Enter opens the
 * first result as a new investigation. `/` and ⌘K / Ctrl-K focus it while the map page has focus
 * (elsewhere they keep opening the admin command palette).
 *
 * A credential-shaped entry (API key, static token) is refused here and never sent — the API log
 * keeps request query strings.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { Search as SearchIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { inspectErrorOf, useInspectDetail } from '../../inspect/api'
import { InspectLink } from '../../inspect/InspectLink'
import { openInspect } from '../../inspect/stack'
import type { InspectPanelProps, InspectRef } from '../../registry/inspectables'
import { type SearchData, type SearchResult, useInspectSearch } from './api'
import { CREDENTIAL_MESSAGE, looksLikeCredential, pageHasFocus, searchKey } from './logic'
import { PanelSkeleton } from './parts'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

const keyOf = (r: SearchResult) => `${r.ref.kind}:${r.ref.id}`

export function SearchBox() {
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const q = useDebounced(text, 250)
  const refusedLocally = looksLikeCredential(text)
  const search = useInspectSearch(q)
  const settled = q.trim() === text.trim()
  const results = settled && !refusedLocally ? (search.data?.results ?? []) : []
  // Enter pressed with nothing settled yet (the debounce or the fetch is still running): the
  // entry it was pressed on; the first result opens as soon as it lands. The core flow is paste
  // an id, press Enter — it must not need a second press.
  const [pendingEnter, setPendingEnter] = useState<string | null>(null)

  // `/` and ⌘K focus the box while the Traffic Map page has focus (capture: before the admin-wide
  // shortcut handlers, which then never see the key). Elsewhere the global keys are untouched.
  useEffect(() => {
    let lastPointerInPage = false
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Element | null
      lastPointerInPage = !!t?.closest?.('.traffic-map')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const k = searchKey(e)
      if (!k) return
      if (!pageHasFocus(document.activeElement, lastPointerInPage)) return
      const input = inputRef.current
      if (!input?.isConnected) return
      e.preventDefault()
      e.stopPropagation()
      input.focus()
      input.select()
    }
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  const choose = (ref: InspectRef) => {
    setPendingEnter(null)
    openInspect(ref, { root: true })
    setOpen(false)
    inputRef.current?.blur()
  }
  const first = results[0]
  const current = results.find((r) => keyOf(r) === active) ?? first
  const term = text.trim()

  useEffect(() => {
    if (pendingEnter == null) return
    if (pendingEnter !== term || refusedLocally || search.isError) {
      setPendingEnter(null)
      return
    }
    if (!settled || search.isFetching || !search.data) return
    const hit = search.data.results[0]
    setPendingEnter(null)
    // A result → open it; none → the search level says what was looked for and why nothing matched.
    openInspect(hit ? hit.ref : { kind: 'search', id: term, label: `Search “${term}”` }, {
      root: true
    })
    setOpen(false)
    inputRef.current?.blur()
  }, [pendingEnter, term, settled, refusedLocally, search.isFetching, search.isError, search.data])

  return (
    <PopoverPrimitive.Root open={open && text.trim().length > 0} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor asChild>
        <div ref={anchorRef} className='relative'>
          <SearchIcon
            className='pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--tm-muted)]'
            aria-hidden='true'
          />
          <input
            ref={inputRef}
            type='text'
            value={text}
            placeholder='Find a request, record, person…'
            aria-label='Search requests, records, people and more'
            aria-keyshortcuts='/ Control+K Meta+K'
            data-tm-inspect-search=''
            autoComplete='off'
            spellCheck={false}
            className='h-7 w-[220px] rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] pl-7 pr-2 text-[12px] text-[var(--tm-fg)] placeholder:text-[var(--tm-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onChange={(e) => {
              setText(e.target.value)
              setActive('')
              setOpen(true)
              setPendingEnter(null)
            }}
            onFocus={() => text.trim() && setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (current) choose(current.ref)
                else if (term && !refusedLocally) setPendingEnter(term)
              } else if (e.key === 'Escape') {
                setOpen(false)
                setPendingEnter(null)
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (results.length === 0) return
                e.preventDefault()
                setOpen(true)
                const i = current ? results.indexOf(current) : -1
                const next =
                  e.key === 'ArrowDown' ? Math.min(results.length - 1, i + 1) : Math.max(0, i - 1)
                setActive(keyOf(results[next]))
              }
            }}
          />
        </div>
      </PopoverPrimitive.Anchor>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align='start'
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
          }}
          className='traffic-map z-50 w-[380px] rounded-md border border-[var(--tm-line)] bg-[var(--tm-card)] p-1 text-[var(--tm-fg)] shadow-md'
          data-tm-inspect-search-results=''
        >
          <SearchResults
            text={text}
            refusedLocally={refusedLocally}
            loading={!settled || search.isFetching}
            error={search.isError ? inspectErrorOf(search.error).message : null}
            data={settled ? (search.data ?? null) : null}
            results={results}
            active={current ? keyOf(current) : ''}
            onActive={setActive}
            onChoose={choose}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function SearchResults({
  text,
  refusedLocally,
  loading,
  error,
  data,
  results,
  active,
  onActive,
  onChoose
}: {
  text: string
  refusedLocally: boolean
  loading: boolean
  error: string | null
  data: SearchData | null
  results: SearchResult[]
  active: string
  onActive: (k: string) => void
  onChoose: (ref: InspectRef) => void
}) {
  if (refusedLocally)
    return (
      <p
        className='px-2 py-1.5 text-[12px] text-[var(--tm-fg-2)]'
        data-tm-inspect-search-refused=''
      >
        {CREDENTIAL_MESSAGE}
      </p>
    )
  if (data?.refused)
    return (
      <p
        className='px-2 py-1.5 text-[12px] text-[var(--tm-fg-2)]'
        data-tm-inspect-search-refused=''
      >
        {data.refused}
      </p>
    )
  if (error)
    return (
      <p
        className='px-2 py-1.5 text-[12px] text-[var(--tm-error-ink)]'
        data-tm-inspect-search-error=''
      >
        Search failed: {error}
      </p>
    )
  if (loading && results.length === 0)
    return (
      <div className='px-2 py-1.5'>
        <PanelSkeleton rows={[80, 60]} />
      </div>
    )
  return (
    <Command
      shouldFilter={false}
      value={active}
      onValueChange={onActive}
      className='bg-transparent text-[var(--tm-fg)]'
    >
      <CommandList className='max-h-[320px]'>
        <CommandEmpty className='px-2 py-1.5 text-[12px] text-[var(--tm-muted)]'>
          Nothing matched “{text.trim()}”. {data?.hint ?? ''}
        </CommandEmpty>
        {results.map((r) => (
          <CommandItem
            key={keyOf(r)}
            value={keyOf(r)}
            onSelect={() => onChoose(r.ref)}
            className='flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-[12px] data-[selected=true]:bg-[var(--tm-card-2)]'
            data-tm-inspect-search-result={keyOf(r)}
          >
            <span className='w-[64px] shrink-0 text-[11px] text-[var(--tm-muted)]'>
              {r.ref.kind}
            </span>
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[var(--tm-accent-ink)]'>{r.label}</span>
              {r.hint && (
                <span className='block truncate text-[11px] text-[var(--tm-muted)]'>{r.hint}</span>
              )}
            </span>
          </CommandItem>
        ))}
      </CommandList>
      {results.length > 0 && (
        <div className='flex items-baseline justify-between gap-2 border-t border-[var(--tm-line-2)] px-2 pb-0.5 pt-1 text-[11px] text-[var(--tm-muted)]'>
          <span>Enter opens {results.length > 1 ? 'the highlighted result' : 'it'}</span>
          <button
            type='button'
            className='rounded-sm text-[var(--tm-accent-ink)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
            onClick={() =>
              onChoose({ kind: 'search', id: text.trim(), label: `Search “${text.trim()}”` })
            }
            data-tm-inspect-search-panel-open=''
          >
            Show in the panel
          </button>
        </div>
      )}
    </Command>
  )
}

/** The `search` level: the same results inside the investigation panel (each drills in place). */
export function SearchPanel({ inspectRef, anchor, windowSec }: InspectPanelProps) {
  const refused = looksLikeCredential(inspectRef.id)
  const q = useInspectDetail<SearchData>(refused ? null : inspectRef, anchor, windowSec)
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  if (refused)
    return (
      <p className='text-[12.5px] text-[var(--tm-fg-2)]' data-tm-inspect-search-refused=''>
        {CREDENTIAL_MESSAGE}
      </p>
    )
  if (q.isLoading) return <PanelSkeleton />
  if (q.isError)
    return (
      <p className='text-[12.5px] text-[var(--tm-muted)]'>
        Search failed: {inspectErrorOf(q.error).message}
      </p>
    )
  const d = q.data
  if (d?.refused) return <p className='text-[12.5px] text-[var(--tm-fg-2)]'>{d.refused}</p>
  return (
    <div className='grid gap-2' data-tm-inspect-search-panel=''>
      {rows.length === 0 ? (
        <p className='text-[12.5px] text-[var(--tm-muted)]'>Nothing matched. {d?.hint ?? ''}</p>
      ) : (
        <ul className='grid gap-1'>
          {rows.map((r) => (
            <li key={keyOf(r)} className={cn('flex min-w-0 items-baseline gap-2 text-[12.5px]')}>
              <span className='w-[64px] shrink-0 text-[11px] text-[var(--tm-muted)]'>
                {r.ref.kind}
              </span>
              <span className='min-w-0 flex-1'>
                <InspectLink inspectRef={r.ref}>{r.label}</InspectLink>
                {r.hint && (
                  <span className='block truncate text-[11px] text-[var(--tm-muted)]'>
                    {r.hint}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
