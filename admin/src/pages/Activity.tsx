import { AgentBadge } from '@nivaro/shared'
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
import { Badge } from '@/components/ui/badge'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api, type CMSField, type Collection } from '@/lib/api'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'
import { formatDate, formatDateTime, formatNumber, titleCase } from '@/lib/utils'

type ActivityRow = {
  id: number
  action: string
  user: string | null
  timestamp: string
  collection: string | null
  item: string | null
  comment: string | null
  first_name: string | null
  last_name: string | null
  user_email: string | null
  /** #3213 — written by an AI assistant through MCP: the badge text. */
  via_agent?: string | null
}

const ACTION_VARIANTS: Record<string, 'default' | 'success' | 'destructive' | 'secondary'> = {
  create: 'success',
  delete: 'destructive',
  update: 'default',
  login: 'secondary',
  logout: 'secondary',
  'pipeline-transition': 'default',
  'pipeline-start': 'success'
}

const PIPELINE_ACTIONS = new Set(['pipeline-transition', 'pipeline-start'])

function formatAction(action: string): string {
  return action.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function userName(row: ActivityRow): string {
  if (row.first_name || row.last_name) {
    return [row.first_name, row.last_name].filter(Boolean).join(' ')
  }
  return row.user_email ?? row.user?.slice(0, 8) ?? '—'
}

function collectionLabel(name: string, collections: Collection[]): string {
  const found = collections.find((c) => c.collection === name)
  if (found?.display_name) return found.display_name
  return titleCase(name.replace(/^nivaro_/, '').replace(/_/g, ' '))
}

const LABEL_FALLBACKS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

function ItemLabel({
  collection,
  item,
  action
}: {
  collection: string
  item: string
  action?: string
}) {
  // Skip the label lookup for delete rows — the record is gone by definition,
  // and legacy-import history references many long-deleted items. 404s on
  // create/update rows of since-deleted items still fall back to the raw id.
  const isSystem =
    !collection ||
    collection.startsWith('nivaro_') ||
    collection.startsWith('directus_') ||
    action === 'delete'

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    staleTime: 120_000,
    enabled: !isSystem,
    retry: false
  })

  const displayTemplate: string | null = colMeta?.display_template ?? null
  const actualFields: string[] = (colMeta?.fields ?? []).map((f: CMSField) => f.field)
  const wantedFields = [
    ...new Set(['id', ...extractTemplateFields(displayTemplate), ...LABEL_FALLBACKS])
  ]
  const safeFields = actualFields.length
    ? wantedFields.filter((f) => f === 'id' || actualFields.includes(f)).join(',')
    : null

  const { data: itemData } = useQuery({
    queryKey: ['activity-item-label', collection, item, safeFields],
    queryFn: () =>
      api
        .get(`/items/${collection}/${item}`, { params: { fields: safeFields } })
        .then((r) => r.data.data),
    staleTime: 120_000,
    enabled: !isSystem && !!safeFields,
    retry: false
  })

  const label = itemData ? renderDisplayTemplate(displayTemplate, itemData) : null
  const hasLabel = label && label !== item && label.trim() !== ''

  return hasLabel ? (
    <span title={item}>{label}</span>
  ) : (
    <span className='font-mono text-muted-foreground'>{item}</span>
  )
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
  const [searchParams] = useSearchParams()
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
    queryKey: ['activity', filters, page],
    queryFn: () =>
      api
        .get('/activity', {
          params: { ...activityParams(filters), limit, offset: (page - 1) * limit }
        })
        .then((r) => r.data)
  })

  const rows: ActivityRow[] = data?.data ?? []
  const total: number = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  const changeFilter = (key: 'collections' | 'actions') => (v: string) =>
    setFilters({ ...filters, [key]: v === '__all__' ? [] : [v] })
  const windowFrom: string | null = data?.window_from ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Every create, update, delete and workflow move, newest first. Open a row for its full detail and what changed.'
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
                    {formatAction(a)}
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Collection</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const isPipeline = PIPELINE_ACTIONS.has(row.action)
                    return (
                      <TableRow
                        key={row.id}
                        className='cursor-pointer hover:bg-slate-50'
                        onClick={() => navigate(`/activity/${row.id}`)}
                      >
                        <TableCell className='text-sm text-muted-foreground whitespace-nowrap'>
                          {formatDateTime(row.timestamp)}
                        </TableCell>
                        <TableCell className='text-sm'>
                          <span className='inline-flex flex-wrap items-center gap-1.5'>
                            {userName(row)}
                            <AgentBadge label={row.via_agent} />
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={ACTION_VARIANTS[row.action] ?? 'secondary'}
                            className='text-xs whitespace-nowrap'
                          >
                            {formatAction(row.action)}
                          </Badge>
                        </TableCell>
                        <TableCell className='text-sm text-slate-600'>
                          {row.collection
                            ? collectionLabel(row.collection, collectionsData ?? [])
                            : '—'}
                        </TableCell>
                        <TableCell className='max-w-xs text-sm text-slate-600'>
                          {isPipeline && row.comment ? (
                            <span className='block truncate' title={row.comment}>
                              {row.comment}
                            </span>
                          ) : row.collection && row.item ? (
                            <ItemLabel
                              collection={row.collection}
                              item={row.item}
                              action={row.action}
                            />
                          ) : (
                            <span className='font-mono text-muted-foreground'>
                              {row.item ?? '—'}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className='text-center text-muted-foreground py-12'>
                        {Object.keys(filters).length
                          ? 'Nothing matches these filters.'
                          : 'No activity recorded yet.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>

              {total > 0 && (
                <div className='flex items-center justify-between px-4 py-3 border-t'>
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
