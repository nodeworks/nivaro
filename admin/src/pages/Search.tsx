import { openAskPanel, TipLayer } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  Bookmark,
  BookmarkPlus,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Lightbulb,
  Search as SearchIcon,
  Sparkles,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import {
  ALT_KEY,
  type CollectionCount,
  collectionLabel,
  type GlobalSearchResponse,
  Hi,
  MOD_KEY,
  personFlag,
  personLine,
  personName,
  type SearchPerson,
  searchTabs,
  withExactFirst
} from '@/components/command-palette'
import {
  sendSearchClick,
  useDeleteSavedSearch,
  useRecentRecordLabels,
  useSavedSearches,
  useSaveSearch
} from '@/components/global-search-api'
import {
  altDigit,
  type ExtraHit,
  extraHref,
  extraTabs,
  forgetRecentSearch,
  isExtraTab,
  pushRecentRecord,
  pushRecentSearch,
  queryChips,
  readRecentRecords,
  readRecentSearches,
  recordLabel,
  recordPath,
  recordsCsv,
  type SearchRecord,
  type SearchSort,
  sortRecords,
  toCsv,
  whyMatched
} from '@/components/global-search-helpers'
import { ScrollTabs } from '@/components/scroll-tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatRelative, titleCase } from '@/lib/utils'
import { AddSynonymButton } from './SearchSynonyms'

/**
 * Full search results (#12) — what "See all results" in Cmd+K opens. One tab per
 * collection with matches (counted as the caller), People and the extra kinds
 * (comments, files, …); a collection tab pages through GET /global-search/records.
 * The URL holds the search (`?q=&tab=&sort=&page=`), so a result list can be
 * shared or reloaded. Sort, export and saved searches work on what the API sends;
 * every newer answer field is optional.
 */

const PAGE_SIZE = 50
const EXPORT_CAP = 2000
const PEOPLE_TAB = '__people__'

function download(name: string, csv: string) {
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const fileSlug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'search'

export function SearchPage() {
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const [params, setParams] = useSearchParams()
  const q = (params.get('q') ?? '').trim()
  const tab = params.get('tab') || null
  const sort: SearchSort = params.get('sort') === 'newest' ? 'newest' : 'relevance'
  const page = Math.max(0, Number(params.get('page') ?? '0') || 0)
  const live = q.length >= 2

  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [k, v] of Object.entries(patch)) {
          if (v == null || v === '') next.delete(k)
          else next.set(k, v)
        }
        return next
      },
      { replace: true }
    )

  // The box: typed text settles into ?q= after a pause, Enter at once.
  const [draft, setDraft] = useState(q)
  const inputRef = useRef<HTMLInputElement>(null)
  // Follow the URL (back/forward, chips).
  useEffect(() => setDraft(q), [q])
  // biome-ignore lint/correctness/useExhaustiveDependencies: set is rebuilt each render
  useEffect(() => {
    const t = draft.trim()
    if (t === q) return
    const id = setTimeout(() => set({ q: t, tab: null, page: null }), 400)
    return () => clearTimeout(id)
  }, [draft])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    set({ q: draft.trim(), tab: null, page: null })
  }

  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ['global-search', q],
    queryFn: () =>
      api
        .get<{ data: GlobalSearchResponse }>('/global-search', { params: { q } })
        .then((r) => r.data.data),
    enabled: live,
    staleTime: 15_000
  })
  useEffect(() => {
    if (live) pushRecentSearch(q)
  }, [live, q])

  const { data: collections } = useQuery({
    queryKey: ['command-palette-collections'],
    queryFn: () =>
      api
        .get<{ data: { collection: string; display_name?: string | null }[] }>('/collections')
        .then((r) => r.data.data),
    staleTime: 60_000
  })
  const scopeLabel = (scope: string) => {
    if (scope === PEOPLE_TAB) return 'People'
    const c = collections?.find((x) => x.collection === scope)
    return c ? collectionLabel(c) : titleCase(scope)
  }

  const records = live ? withExactFirst(data?.records ?? [], data?.exact) : []
  const people: SearchPerson[] = live ? (data?.people ?? []) : []
  const extras = live ? extraTabs(data?.extra) : []
  const suggestions = (data?.suggestions ?? []).filter((s) => s.toLowerCase() !== q.toLowerCase())
  const chips = live ? queryChips(q, data?.query, scopeLabel) : []

  const hitCollections = [...new Set(records.map((r) => r.collection))].sort().join(',')
  const { data: counts } = useQuery({
    queryKey: ['global-search-counts', q, hitCollections],
    queryFn: () =>
      api
        .get<{ data: CollectionCount[] }>('/global-search/counts', {
          params: { q, collections: hitCollections }
        })
        .then((r) => (Array.isArray(r.data.data) ? r.data.data : [])),
    enabled: live && hitCollections !== '',
    staleTime: 15_000
  })
  const tabs = searchTabs(records, counts)
  const tabOrder: Array<{ key: string | null; label: string; count: string }> = [
    { key: null, label: 'All', count: '' },
    ...tabs.map((t) => ({ key: t.collection as string | null, label: t.label, count: t.count })),
    ...(people.length
      ? [{ key: PEOPLE_TAB as string | null, label: 'People', count: String(people.length) }]
      : []),
    ...extras.map((t) => ({ key: t.key as string | null, label: t.label, count: t.count }))
  ]
  const collectionTab = tab && tab !== PEOPLE_TAB && !isExtraTab(tab) ? tab : null
  const activeExtra = isExtraTab(tab) ? extras.find((x) => x.key === tab) : undefined

  const tabQuery = useQuery({
    queryKey: ['global-search-page', q, collectionTab, sort, page],
    queryFn: () =>
      api
        .get<{ data: SearchRecord[]; total: number | null }>('/global-search/records', {
          params: {
            q,
            collection: collectionTab,
            offset: page * PAGE_SIZE,
            limit: PAGE_SIZE,
            ...(sort === 'newest' ? { sort: 'newest' } : {})
          }
        })
        .then((r) => r.data),
    enabled: live && !!collectionTab,
    staleTime: 15_000,
    placeholderData: (prev) => prev
  })
  const tabRows = sortRecords(tabQuery.data?.data ?? [], sort)
  const tabTotal = tabQuery.data?.total ?? null

  // Alt/Option+1…9 picks a tab, "/" jumps to the box (re-bound every render: it reads
  // the current tab order).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = altDigit(e)
      if (d != null && live && d < tabOrder.length) {
        e.preventDefault()
        set({ tab: tabOrder[d].key, page: null })
        return
      }
      const el = e.target as HTMLElement | null
      const typing = !!el?.closest?.('input, textarea, [contenteditable="true"]')
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const { saved, available: savedAvailable } = useSavedSearches(true)
  const alreadySaved = saved.some((s) => s.q === q && (s.scope ?? null) === collectionTab)
  const removeSaved = useDeleteSavedSearch()
  const [naming, setNaming] = useState<string | null>(null)
  const saveSearch = useSaveSearch(() => setNaming(null))

  const [recentSearches, setRecentSearches] = useState<string[]>(() => readRecentSearches())
  const recentRecords = readRecentRecords()

  const onOpenRecord = (r: SearchRecord, position: number) => {
    pushRecentRecord({
      collection: r.collection,
      id: String(r.id),
      label: r.label,
      kind: collectionLabel(r)
    })
    sendSearchClick({ q, collection: r.collection, id: r.id, position })
  }

  // ── Export the tab as CSV ──
  const [exporting, setExporting] = useState(false)
  const exportCsv = async () => {
    const stem = `search-${fileSlug(q)}`
    if (collectionTab) {
      setExporting(true)
      try {
        const rows: SearchRecord[] = []
        for (let offset = 0; offset < EXPORT_CAP; offset += 100) {
          const r = await api.get<{ data: SearchRecord[]; total: number | null }>(
            '/global-search/records',
            {
              params: {
                q,
                collection: collectionTab,
                offset,
                limit: 100,
                ...(sort === 'newest' ? { sort: 'newest' } : {})
              }
            }
          )
          const batch = r.data.data ?? []
          rows.push(...batch)
          if (batch.length < 100 || (r.data.total != null && rows.length >= r.data.total)) break
        }
        download(`${stem}-${fileSlug(collectionTab)}.csv`, recordsCsv(sortRecords(rows, sort)))
        if (rows.length >= EXPORT_CAP)
          toast.message(`Exported the first ${EXPORT_CAP} results`, {
            description: 'Narrow the search to export the rest.'
          })
      } catch {
        toast.error('The export did not finish')
      } finally {
        setExporting(false)
      }
      return
    }
    if (tab === PEOPLE_TAB) {
      download(
        `${stem}-people.csv`,
        toCsv(
          ['Name', 'Email', 'Title', 'Role', 'Zones', 'Department'],
          people.map((p) => [
            personName(p),
            p.email,
            p.title,
            p.role_name ?? '',
            (p.zones ?? []).join('; '),
            p.department
          ])
        )
      )
      return
    }
    if (activeExtra) {
      download(
        `${stem}-${activeExtra.kind}.csv`,
        toCsv(
          ['Kind', 'Label', 'Snippet', 'Collection', 'Item', 'Link'],
          activeExtra.hits.map((h) => [
            h.kind,
            h.label,
            h.snippet ?? '',
            h.collection ?? '',
            h.item ?? '',
            extraHref(h) ?? ''
          ])
        )
      )
      return
    }
    download(`${stem}.csv`, recordsCsv(sortRecords(records, sort)))
  }

  const nothing =
    live &&
    !!data &&
    !isFetching &&
    records.length === 0 &&
    people.length === 0 &&
    extras.length === 0 &&
    (data.pages?.length ?? 0) === 0

  const exportable = collectionTab
    ? tabRows.length > 0
    : tab === PEOPLE_TAB
      ? people.length > 0
      : activeExtra
        ? activeExtra.hits.length > 0
        : records.length > 0

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <TipLayer />
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 pt-4 dark:border-border dark:bg-card'>
        <div className='flex flex-wrap items-center gap-3'>
          <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            Search
          </h1>
          <form onSubmit={submit} className='relative min-w-[240px] flex-1'>
            <SearchIcon className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-muted-foreground' />
            <Input
              ref={inputRef}
              autoFocus={!q}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder='Search records, people, comments, files…'
              aria-label='Search'
              className='h-9 pl-8 pr-14 text-[13px]'
              data-search-page-input
            />
            <span className='pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-slate-200 px-1 font-mono text-[10px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              /
            </span>
          </form>
          {live && (
            <fieldset className='m-0 flex min-w-0 rounded-md border border-slate-200 p-0.5 dark:border-border'>
              <legend className='sr-only'>Sort</legend>

              {(
                [
                  ['relevance', 'Relevance'],
                  ['newest', 'Newest']
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type='button'
                  aria-pressed={sort === v}
                  onClick={() => set({ sort: v === 'relevance' ? null : v, page: null })}
                  className={`rounded px-2 py-1 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan ${
                    sort === v
                      ? 'bg-accent text-foreground'
                      : 'text-slate-600 hover:bg-muted dark:text-muted-foreground'
                  }`}
                >
                  {label}
                </button>
              ))}
            </fieldset>
          )}
          {live && savedAvailable && naming == null && (
            <Button
              variant='outline'
              size='sm'
              className={`h-8 gap-1.5 text-[12px] ${alreadySaved ? 'cursor-not-allowed opacity-50' : ''}`}
              onClick={() => {
                if (!alreadySaved) setNaming(q)
              }}
              aria-disabled={alreadySaved ? 'true' : undefined}
              data-tip={alreadySaved ? 'Already saved' : undefined}
            >
              <BookmarkPlus className='h-3.5 w-3.5' />
              Save search
            </Button>
          )}
          {naming != null && (
            <form
              className='flex items-center gap-1.5'
              onSubmit={(e) => {
                e.preventDefault()
                if (!naming.trim()) return
                saveSearch.mutate({ name: naming.trim(), q, scope: collectionTab })
              }}
            >
              <Input
                autoFocus
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setNaming(null)
                  }
                }}
                aria-label='Name this search'
                className='h-8 w-[200px] text-[12px]'
              />
              <Button
                type='submit'
                size='sm'
                disabled={!naming.trim() || saveSearch.isPending}
                className='h-8 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
              >
                {saveSearch.isPending ? 'Saving…' : 'Save'}
              </Button>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='h-8 text-[12px]'
                onClick={() => setNaming(null)}
              >
                Cancel
              </Button>
            </form>
          )}
          {live && (
            <Button
              variant='outline'
              size='sm'
              className='h-8 gap-1.5 text-[12px]'
              disabled={!exportable || exporting}
              onClick={() => void exportCsv()}
              data-tip='Download this tab as CSV'
            >
              <Download className='h-3.5 w-3.5' />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </Button>
          )}
        </div>

        {chips.length > 0 && (
          <div className='mt-2 flex flex-wrap items-center gap-1.5' data-search-chips>
            <span className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Searching
            </span>
            {chips.map((c) => (
              <span
                key={c.key}
                className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[12px] ${
                  c.kind === 'scope'
                    ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-foreground'
                    : 'border-slate-200 bg-slate-50 text-foreground dark:border-border dark:bg-muted'
                }`}
              >
                {c.kind === 'scope' && <span className='text-muted-foreground'>in</span>}
                {c.label}
                {c.without != null && (
                  <button
                    type='button'
                    aria-label={`Remove ${c.label}`}
                    data-tip={`Remove ${c.label}`}
                    onClick={() => set({ q: c.without ?? '', tab: null, page: null })}
                    className='-mr-0.5 rounded p-0.5 text-muted-foreground hover:bg-white hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:hover:bg-background'
                  >
                    <X className='h-3 w-3' />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {live && tabOrder.length > 1 ? (
          <div className='mt-2 flex items-center'>
            <ScrollTabs
              role='tablist'
              aria-label='Search results by kind'
              activeKey={tab}
              className='-mb-px'
            >
              {tabOrder.map((t, i) => {
                const on = tab === t.key
                return (
                  <button
                    key={t.key ?? '__all__'}
                    type='button'
                    role='tab'
                    aria-selected={on}
                    aria-keyshortcuts={i < 9 ? `Alt+${i + 1}` : undefined}
                    data-tip={i < 9 ? `${ALT_KEY}${i + 1}` : undefined}
                    onClick={() => set({ tab: t.key, page: null })}
                    className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 pb-2 pt-1 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan ${
                      on
                        ? 'border-nvr-cyan text-slate-900 dark:text-foreground'
                        : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground'
                    }`}
                  >
                    {t.label}
                    {t.count && (
                      <span className='rounded bg-slate-100 px-1 font-mono text-[10.5px] tabular-nums text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                        {t.count}
                      </span>
                    )}
                  </button>
                )
              })}
            </ScrollTabs>
          </div>
        ) : (
          <div className='h-3' />
        )}
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='space-y-5 px-6 py-5'>
          {!live && (
            <StartPanel
              saved={saved}
              savedAvailable={savedAvailable}
              onRemoveSaved={(id) => removeSaved.mutate(id)}
              recentSearches={recentSearches}
              onForget={(s) => setRecentSearches(forgetRecentSearch(s))}
              recentRecords={recentRecords}
              onPick={(s, scope) => set({ q: s, tab: scope, page: null })}
              short={q.length === 1}
            />
          )}

          {live && isError && (
            <div className='flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[12.5px] text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'>
              <p>The search did not finish. Try again in a moment.</p>
              <Button
                variant='outline'
                size='sm'
                className='h-7 shrink-0 text-[12px]'
                onClick={() => void refetch()}
              >
                Try again
              </Button>
            </div>
          )}

          {live && !data && isFetching && <ResultsSkeleton />}

          {nothing && (
            <ZeroResults
              q={q}
              suggestions={suggestions}
              isAdmin={isAdmin}
              openSynonym={params.get('synonym') === '1'}
              onSuggest={(s) => set({ q: s, tab: null, page: null, synonym: null })}
            />
          )}

          {live && data && !nothing && collectionTab && (
            <section aria-label={scopeLabel(collectionTab)}>
              <RecordsTable
                rows={tabRows}
                q={q}
                loading={tabQuery.isFetching && !tabQuery.data}
                showCollection={false}
                onOpen={(r, i) => onOpenRecord(r, page * PAGE_SIZE + i)}
              />
              <Pager
                page={page}
                shown={tabRows.length}
                total={tabTotal}
                busy={tabQuery.isFetching}
                hasNext={
                  tabTotal != null
                    ? (page + 1) * PAGE_SIZE < tabTotal
                    : tabRows.length === PAGE_SIZE
                }
                onPage={(p) => set({ page: p ? String(p) : null })}
              />
            </section>
          )}

          {live && data && !nothing && tab === PEOPLE_TAB && <PeopleList people={people} q={q} />}

          {live && data && !nothing && activeExtra && <ExtraList hits={activeExtra.hits} q={q} />}

          {live && data && !nothing && !tab && (
            <AllResults
              records={sortRecords(records, sort)}
              tabs={tabs}
              people={people}
              extras={extras}
              q={q}
              onTab={(t) => set({ tab: t, page: null })}
              onOpen={onOpenRecord}
            />
          )}

          {live && data && !nothing && (
            <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Not what you wanted?{' '}
              <button
                type='button'
                onClick={() => openAskPanel(q)}
                className='font-medium text-slate-700 underline-offset-2 hover:underline dark:text-foreground'
              >
                Ask AI about “{q}”
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function AllResults({
  records,
  tabs,
  people,
  extras,
  q,
  onTab,
  onOpen
}: {
  records: SearchRecord[]
  tabs: Array<{ collection: string; label: string; count: string }>
  people: SearchPerson[]
  extras: ReturnType<typeof extraTabs>
  q: string
  onTab: (t: string) => void
  onOpen: (r: SearchRecord, position: number) => void
}) {
  const exact = records.find((r) => r.exact)
  const groups = tabs
    .map((t) => ({ ...t, rows: records.filter((r) => r.collection === t.collection && !r.exact) }))
    .filter((g) => g.rows.length > 0)
  return (
    <>
      {exact && (
        <Link
          to={recordPath(exact.collection, exact.id)}
          onClick={() => onOpen(exact, 0)}
          className='flex items-center gap-3 rounded-lg border border-nvr-cyan/40 bg-white px-4 py-3 hover:bg-nvr-cyan/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:bg-card dark:hover:bg-nvr-cyan/10'
          data-search-exact
        >
          <span className='rounded bg-nvr-cyan/15 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground'>
            Exact ID
          </span>
          <span className='min-w-0 flex-1'>
            <span className='block truncate text-[13px] font-medium text-slate-900 dark:text-foreground'>
              {recordLabel(exact)}
            </span>
            <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              {collectionLabel(exact)}
            </span>
          </span>
          <ArrowRight className='h-4 w-4 text-slate-400 dark:text-muted-foreground' />
        </Link>
      )}
      {groups.map((g) => (
        <section key={g.collection} aria-label={g.label}>
          <div className='mb-1.5 flex items-center gap-2'>
            <h2 className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              {g.label}
            </h2>
            <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {g.count}
            </span>
            <button
              type='button'
              onClick={() => onTab(g.collection)}
              className='ml-auto flex items-center gap-1 rounded text-[12px] font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:text-foreground'
            >
              See all <ArrowRight className='h-3 w-3' />
            </button>
          </div>
          <RecordsTable
            rows={g.rows}
            q={q}
            showCollection={false}
            onOpen={(r) => onOpen(r, records.indexOf(r))}
          />
        </section>
      ))}
      {people.length > 0 && (
        <section aria-label='People'>
          <h2 className='mb-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
            People
          </h2>
          <PeopleList people={people.slice(0, 6)} q={q} />
        </section>
      )}
      {extras.map((x) => (
        <section key={x.key} aria-label={x.label}>
          <div className='mb-1.5 flex items-center gap-2'>
            <h2 className='text-[12.5px] font-semibold text-slate-800 dark:text-foreground'>
              {x.label}
            </h2>
            <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {x.count}
            </span>
            {x.hits.length > 5 && (
              <button
                type='button'
                onClick={() => onTab(x.key)}
                className='ml-auto flex items-center gap-1 rounded text-[12px] font-medium text-slate-700 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:text-foreground'
              >
                See all <ArrowRight className='h-3 w-3' />
              </button>
            )}
          </div>
          <ExtraList hits={x.hits.slice(0, 5)} q={q} />
        </section>
      ))}
    </>
  )
}

function PeopleList({ people, q }: { people: SearchPerson[]; q: string }) {
  return (
    <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
      {people.map((p) => {
        const flag = personFlag(p)
        const sub = personLine(p)
        return (
          <li key={p.id}>
            <Link
              to={`/users/${encodeURIComponent(p.id)}`}
              className='flex items-center gap-3 px-3 py-2 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-muted dark:focus-visible:bg-muted'
            >
              <UserRound className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
              <span className='min-w-0 flex-1'>
                <span className='block truncate text-[12.5px] text-slate-900 dark:text-foreground'>
                  <Hi text={personName(p)} q={q} />
                </span>
                {sub && (
                  <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {sub}
                  </span>
                )}
              </span>
              {flag && (
                <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                  {flag}
                </span>
              )}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}

function ZeroResults({
  q,
  suggestions,
  isAdmin,
  openSynonym,
  onSuggest
}: {
  q: string
  suggestions: string[]
  isAdmin: boolean
  openSynonym: boolean
  onSuggest: (s: string) => void
}) {
  const synonymRef = useRef<HTMLDivElement>(null)
  // From the palette's "Add a synonym": open the popover straight away.
  useEffect(() => {
    if (openSynonym) synonymRef.current?.querySelector('button')?.click()
  }, [openSynonym])
  const linkBtn =
    'inline-flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-muted'
  return (
    <div
      className='rounded-lg border border-slate-200 bg-white px-5 py-5 dark:border-border dark:bg-card'
      data-search-zero
    >
      <p className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
        Nothing matched “{q}”
      </p>
      <p className='mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-slate-600 dark:text-muted-foreground'>
        Search looks at the fields you can read. Try fewer words, a record number, or a filter such
        as{' '}
        <code className='rounded bg-slate-100 px-1 font-mono text-[11.5px] text-slate-800 dark:bg-muted dark:text-foreground'>
          field:value
        </code>
        .
      </p>
      {suggestions.length > 0 && (
        <div className='mt-3 flex flex-wrap items-center gap-1.5'>
          <span className='flex items-center gap-1 text-[12px] text-slate-600 dark:text-muted-foreground'>
            <Lightbulb className='h-3.5 w-3.5 text-amber-600 dark:text-amber-400' />
            Did you mean
          </span>
          {suggestions.map((s) => (
            <button key={s} type='button' onClick={() => onSuggest(s)} className={linkBtn}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className='mt-4 flex flex-wrap items-center gap-2'>
        <button type='button' onClick={() => openAskPanel(q)} className={linkBtn}>
          <Sparkles className='h-3.5 w-3.5 text-nvr-cyan' />
          Ask AI instead
        </button>
        {isAdmin && (
          <>
            <div ref={synonymRef} className='contents'>
              <AddSynonymButton query={q} collection={null} className={linkBtn} />
            </div>
            <Link to='/analytics/search' className={linkBtn}>
              Manage synonyms
            </Link>
          </>
        )}
      </div>
    </div>
  )
}

function RecordsTable({
  rows,
  q,
  loading,
  showCollection,
  onOpen
}: {
  rows: SearchRecord[]
  q: string
  loading?: boolean
  showCollection: boolean
  onOpen: (r: SearchRecord, index: number) => void
}) {
  if (loading)
    return (
      <div className='space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className='h-5 w-full' />
        ))}
      </div>
    )
  if (rows.length === 0)
    return (
      <p className='rounded-lg border border-slate-200 bg-white px-4 py-6 text-center text-[12.5px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground'>
        No records on this page.
      </p>
    )
  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <table className='w-full table-fixed text-[12px]'>
        <thead className='border-b border-slate-200 bg-slate-50 text-left text-[11px] font-medium text-slate-600 dark:border-border dark:bg-muted/50 dark:text-muted-foreground'>
          <tr>
            <th className='w-[38%] px-3 py-1.5 font-medium'>Record</th>
            {showCollection && <th className='w-[14%] px-3 py-1.5 font-medium'>Collection</th>}
            <th className='hidden px-3 py-1.5 font-medium sm:table-cell'>Why it matched</th>
            <th className='hidden w-[110px] px-3 py-1.5 font-medium md:table-cell'>Updated</th>
          </tr>
        </thead>
        <tbody className='divide-y divide-slate-100 dark:divide-border'>
          {rows.map((r, i) => {
            const why = whyMatched(r) ?? (r.snippet && r.snippet !== r.label ? r.snippet : '')
            return (
              <tr
                key={`${r.collection}-${r.id}`}
                className='hover:bg-slate-50 dark:hover:bg-muted/60'
              >
                <td className='px-3 py-1.5'>
                  <Link
                    to={recordPath(r.collection, r.id)}
                    onClick={() => onOpen(r, i)}
                    className='flex min-w-0 items-center gap-2 rounded text-slate-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
                  >
                    <span className='truncate'>
                      <Hi text={recordLabel(r)} q={q} />
                    </span>
                    {r.exact && (
                      <span className='shrink-0 rounded bg-nvr-cyan/15 px-1 text-[10px] font-medium text-foreground'>
                        Exact
                      </span>
                    )}
                  </Link>
                  {why && (
                    <span className='mt-0.5 block truncate text-[11px] text-slate-600 sm:hidden dark:text-muted-foreground'>
                      {why}
                    </span>
                  )}
                </td>
                {showCollection && (
                  <td className='truncate px-3 py-1.5 text-slate-600 dark:text-muted-foreground'>
                    {collectionLabel(r)}
                  </td>
                )}
                <td className='hidden truncate px-3 py-1.5 text-slate-600 sm:table-cell dark:text-muted-foreground'>
                  {r.matched_value && !r.exact ? (
                    <>
                      <span className='text-slate-500 dark:text-muted-foreground'>
                        {r.matched_label || titleCase(r.matched_field ?? '')}:
                      </span>{' '}
                      <span className='text-slate-800 dark:text-foreground'>
                        <Hi text={r.matched_value} q={q} />
                      </span>
                    </>
                  ) : (
                    why
                  )}
                </td>
                <td className='hidden px-3 py-1.5 text-slate-500 tabular-nums md:table-cell dark:text-muted-foreground'>
                  {r.updated_at ? formatRelative(r.updated_at) : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Pager({
  page,
  shown,
  total,
  busy,
  hasNext,
  onPage
}: {
  page: number
  shown: number
  total: number | null
  busy: boolean
  hasNext: boolean
  onPage: (p: number) => void
}) {
  const from = shown ? page * PAGE_SIZE + 1 : 0
  const to = page * PAGE_SIZE + shown
  if (page === 0 && !hasNext) return null
  return (
    <div className='mt-2 flex items-center gap-2 text-[12px] text-slate-600 dark:text-muted-foreground'>
      <span className='tabular-nums'>
        {from}–{to}
        {total != null ? ` of ${total}` : ''}
      </span>
      <div className='ml-auto flex items-center gap-1'>
        <Button
          variant='outline'
          size='sm'
          className='h-7 gap-1 text-[12px]'
          disabled={page === 0 || busy}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft className='h-3.5 w-3.5' /> Previous
        </Button>
        <Button
          variant='outline'
          size='sm'
          className='h-7 gap-1 text-[12px]'
          disabled={!hasNext || busy}
          onClick={() => onPage(page + 1)}
        >
          Next <ChevronRight className='h-3.5 w-3.5' />
        </Button>
      </div>
    </div>
  )
}

function ExtraList({ hits, q }: { hits: ExtraHit[]; q: string }) {
  return (
    <ul className='divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
      {hits.map((h) => (
        <li key={`${h.kind}-${h.id}`}>
          <Link
            to={extraHref(h) ?? ''}
            className='flex items-center gap-3 px-3 py-2 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-muted dark:focus-visible:bg-muted'
          >
            <span className='min-w-0 flex-1'>
              <span className='block truncate text-[12.5px] text-slate-900 dark:text-foreground'>
                <Hi text={h.label} q={q} />
              </span>
              {h.snippet && (
                <span className='block truncate text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                  <Hi text={h.snippet} q={q} />
                </span>
              )}
            </span>
            {h.collection && (
              <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                {titleCase(h.collection)}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  )
}

function ResultsSkeleton() {
  return (
    <div className='space-y-3' aria-hidden>
      <Skeleton className='h-4 w-40' />
      <div className='space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className='h-5 w-full' />
        ))}
      </div>
    </div>
  )
}

/** Before a search: saved searches, recent searches and records, and how to search. */
function StartPanel({
  saved,
  savedAvailable,
  onRemoveSaved,
  recentSearches,
  onForget,
  recentRecords,
  onPick,
  short
}: {
  saved: Array<{ id: string; name: string; q: string; scope: string | null }>
  savedAvailable: boolean
  onRemoveSaved: (id: string) => void
  recentSearches: string[]
  onForget: (s: string) => void
  recentRecords: ReturnType<typeof readRecentRecords>
  onPick: (q: string, scope: string | null) => void
  short: boolean
}) {
  // Recents stored without a label (or an old pk-only one) are named as the viewer.
  const recentLabels = useRecentRecordLabels(recentRecords, recentRecords.length > 0)
  const row = 'group flex items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-muted'
  const box =
    'divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'
  const h2 = 'mb-1.5 text-[12.5px] font-semibold text-slate-800 dark:text-foreground'
  return (
    <div className='grid gap-5 lg:grid-cols-2'>
      {short && (
        <p className='text-[12.5px] text-slate-600 lg:col-span-2 dark:text-muted-foreground'>
          Type at least two characters.
        </p>
      )}
      {savedAvailable && (
        <section aria-label='Saved searches'>
          <h2 className={h2}>Saved searches</h2>
          {saved.length === 0 ? (
            <p className='rounded-lg border border-dashed border-slate-300 px-3 py-4 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              Search, then <span className='font-medium'>Save search</span> to keep it here and in
              {MOD_KEY}+K.
            </p>
          ) : (
            <ul className={box}>
              {saved.map((s) => (
                <li key={s.id} className={row}>
                  <Bookmark className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
                  <button
                    type='button'
                    onClick={() =>
                      onPick(s.q, s.scope && !s.scope.startsWith('__') ? s.scope : null)
                    }
                    className='min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
                  >
                    <span className='block truncate text-[12.5px] text-slate-900 dark:text-foreground'>
                      {s.name}
                    </span>
                    {s.name !== s.q && (
                      <span className='block truncate font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
                        {s.q}
                      </span>
                    )}
                  </button>
                  <button
                    type='button'
                    aria-label={`Remove saved search ${s.name}`}
                    data-tip='Remove'
                    onClick={() => onRemoveSaved(s.id)}
                    className='opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-background dark:hover:text-red-400'
                  >
                    <Trash2 className='h-3.5 w-3.5' />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {recentSearches.length > 0 && (
        <section aria-label='Recent searches'>
          <h2 className={h2}>Recent searches</h2>
          <ul className={box}>
            {recentSearches.map((s) => (
              <li key={s} className={row}>
                <History className='h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-muted-foreground' />
                <button
                  type='button'
                  onClick={() => onPick(s, null)}
                  className='min-w-0 flex-1 truncate rounded text-left text-[12.5px] text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
                >
                  {s}
                </button>
                <button
                  type='button'
                  aria-label={`Forget ${s}`}
                  data-tip='Forget'
                  onClick={() => onForget(s)}
                  className='opacity-0 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:bg-background dark:hover:text-foreground'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {recentRecords.length > 0 && (
        <section aria-label='Recently opened'>
          <h2 className={h2}>Recently opened</h2>
          <ul className={box}>
            {recentRecords.map((r) => (
              <li key={`${r.collection}-${r.id}`}>
                <Link
                  to={recordPath(r.collection, r.id)}
                  className='flex items-center gap-2 px-3 py-2 hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-muted dark:focus-visible:bg-muted'
                >
                  <span className='min-w-0 flex-1 truncate text-[12.5px] text-slate-900 dark:text-foreground'>
                    {recentLabels[`${r.collection}:${r.id}`] ?? recordLabel(r)}
                  </span>
                  <span className='shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                    {r.kind ?? titleCase(r.collection)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section aria-label='How to search' className='lg:col-span-2'>
        <h2 className={h2}>How to search</h2>
        <dl className='grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[max-content_1fr]'>
          <dt className='font-mono text-slate-800 dark:text-foreground'>4512</dt>
          <dd className='text-slate-600 dark:text-muted-foreground'>
            A record number jumps straight to that record.
          </dd>
          <dt className='font-mono text-slate-800 dark:text-foreground'>field:value</dt>
          <dd className='text-slate-600 dark:text-muted-foreground'>
            Narrows to records whose field holds the value, e.g.{' '}
            <span className='font-mono'>vendor:acme</span> or{' '}
            <span className='font-mono'>amount:12.5k</span>.
          </dd>
          <dt className='font-mono text-slate-800 dark:text-foreground'>@name</dt>
          <dd className='text-slate-600 dark:text-muted-foreground'>Searches people only.</dd>
          <dt className='font-mono text-slate-800 dark:text-foreground'>{ALT_KEY}1–9</dt>
          <dd className='text-slate-600 dark:text-muted-foreground'>
            Switch result tabs. <span className='font-mono'>/</span> jumps to the search box.
          </dd>
        </dl>
      </section>
    </div>
  )
}
