import { ActivityFeed, readableTitle, UndoButton, useActivityLabels } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import {
  ActivityFilterChips,
  type ActivityFilters,
  ActivitySearchBox,
  activityParams,
  cleanFilters,
  type PersonCandidate
} from '@/components/activity/activity-search'
import { SavedViewsMenu } from '@/components/activity/saved-views'
import { HubToolbar } from '@/components/hub-page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActivityEntry, api, type Collection } from '@/lib/api'
import { formatDate, formatNumber, titleCase } from '@/lib/utils'

function collectionLabel(name: string, collections: Collection[]): string {
  const found = collections.find((c) => c.collection === name)
  if (found?.display_name) return found.display_name
  return titleCase(name.replace(/^nivaro_/, '').replace(/_/g, ' '))
}

function filtersFromUrl(p: URLSearchParams): ActivityFilters {
  const list = (k: string) =>
    p
      .getAll(k)
      .flatMap((v) => v.split(','))
      .map((v) => v.trim())
      .filter(Boolean)
  return cleanFilters({
    user: p.get('user'),
    actions: list('action'),
    collections: list('collection'),
    item: p.get('item'),
    range: p.get('range'),
    from: p.get('from'),
    to: p.get('to'),
    q: p.get('q')
  })
}

export function ActivityPage() {
  const navigate = useNavigate()
  // #10/#11 — one filter set, from the controls, the search box or a saved view.
  // Deep links (`/activity?collection=&item=` from a config screen's History) open filtered.
  const [searchParams, setSearchParams] = useSearchParams()
  // `?group_key=` (an entry's "See the whole burst"): one bulk action / import / flow run.
  const groupKey = searchParams.get('group_key') ?? ''
  const [filters, setFiltersState] = useState<ActivityFilters>(() => filtersFromUrl(searchParams))
  const [userLabel, setUserLabel] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<PersonCandidate[] | undefined>()
  const [searchNote, setSearchNote] = useState<string | null>(null)
  const [activeViewId, setActiveViewId] = useState<number | null>(null)
  const [page, setPage] = useState(1)
  const setFilters = (next: ActivityFilters, meta?: { userLabel?: string | null }) => {
    const clean = cleanFilters(next)
    if (clean.user !== filters.user || meta?.userLabel !== undefined) {
      setUserLabel(meta?.userLabel ?? null)
      if (clean.user !== filters.user) setCandidates(undefined)
    }
    setFiltersState(clean)
    setPage(1)
  }
  const collection = filters.collections?.length === 1 ? filters.collections[0] : ''
  const action = filters.actions?.length === 1 ? filters.actions[0] : ''
  const limit = 25

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const { data: actionsData } = useQuery({
    queryKey: ['activity-actions'],
    queryFn: () => api.get('/activity/actions').then((r) => r.data.data as string[])
  })

  const { data, isLoading } = useQuery({
    queryKey: ['activity', filters, groupKey, page],
    queryFn: () =>
      api
        .get('/activity', {
          params: {
            ...activityParams(filters),
            group_key: groupKey || undefined,
            limit,
            offset: (page - 1) * limit
          }
        })
        .then((r) => r.data)
  })

  const rows: ActivityEntry[] = data?.data ?? []
  const labels = useActivityLabels(rows)
  const total: number = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  const changeFilter = (key: 'collections' | 'actions') => (v: string) =>
    setFilters({ ...filters, [key]: v === '__all__' ? [] : [v] })
  const windowFrom: string | null = data?.window_from ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Everything that happened, newest first, in plain sentences. Bulk changes, imports and automations fold into one line — open it to see each record. Open an entry for its full detail.'
        actions={
          <>
            <ActivitySearchBox
              onParsed={(r) => {
                setActiveViewId(null)
                setFilters(r.filters, { userLabel: r.user_label ?? null })
                setCandidates(r.person_candidates)
                setSearchNote(
                  r.note ??
                    (r.unmatched_person
                      ? `No one named “${r.unmatched_person}” — searching the words.`
                      : null)
                )
              }}
            />
            <Select value={collection || '__all__'} onValueChange={changeFilter('collections')}>
              <SelectTrigger className='h-8 w-52 text-[12px]' aria-label='Collection'>
                <SelectValue placeholder='All Collections' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__all__'>All Collections</SelectItem>
                {(collectionsData ?? []).map(
                  (c: { collection: string; display_name: string | null }) => (
                    <SelectItem key={c.collection} value={c.collection}>
                      {c.display_name ?? c.collection}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>

            <Select value={action || '__all__'} onValueChange={changeFilter('actions')}>
              <SelectTrigger className='h-8 w-40 text-[12px]' aria-label='Action'>
                <SelectValue placeholder='All Actions' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='__all__'>All Actions</SelectItem>
                {(actionsData ?? []).map((a) => (
                  <SelectItem key={a} value={a}>
                    {readableTitle(a) || a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <SavedViewsMenu
              filters={filters}
              activeId={activeViewId}
              onApply={(v) => {
                setActiveViewId(v?.id ?? null)
                setSearchNote(null)
                setFilters(v ? v.filters : {})
              }}
            />
          </>
        }
      >
        <div className='mt-2 empty:hidden'>
          <ActivityFilterChips
            filters={filters}
            onChange={(next, meta) => {
              setSearchNote(null)
              setFilters(next, meta)
            }}
            userLabel={userLabel}
            candidates={candidates}
            collectionLabel={(c) => collectionLabel(c, collectionsData ?? [])}
            note={
              searchNote ??
              (windowFrom ? `Text search reads back to ${formatDate(windowFrom)}.` : null)
            }
          />
        </div>
      </HubToolbar>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {groupKey && (
          <div className='mb-3 flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
            <span>Showing every entry of one bulk change, import or automation run.</span>
            <Button
              variant='outline'
              size='sm'
              className='h-7'
              onClick={() => {
                const next = new URLSearchParams(searchParams)
                next.delete('group_key')
                setSearchParams(next, { replace: true })
                setPage(1)
              }}
            >
              Show all activity
            </Button>
          </div>
        )}
        <Card>
          {isLoading ? (
            <div className='p-6 space-y-3'>
              {[...Array(8)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : (
            <>
              <ActivityFeed
                className='px-2 py-1'
                entries={rows}
                labels={labels}
                onOpen={(e) => e.id != null && navigate(`/activity/${e.id}`)}
                actionsFor={(g) =>
                  g.entries[0]?.id != null ? <UndoButton activityId={g.entries[0].id} /> : null
                }
                empty={
                  <p className='py-12 text-center text-sm text-muted-foreground'>
                    {Object.keys(filters).length || groupKey
                      ? 'Nothing matches these filters.'
                      : 'No activity recorded yet.'}
                  </p>
                }
              />

              {total > 0 && (
                <div className='flex items-center justify-between px-4 py-3 border-t dark:border-border'>
                  <p className='text-sm text-muted-foreground'>{formatNumber(total)} events</p>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={page <= 1}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      Previous
                    </Button>
                    <span className='text-sm text-muted-foreground'>
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={page >= totalPages}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
