import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
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
import { type CMSField, type Collection, api } from '@/lib/api'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'
import { formatDateTime, formatNumber, titleCase } from '@/lib/utils'

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

function ItemLabel({ collection, item }: { collection: string; item: string }) {
  const isSystem = !collection || collection.startsWith('nivaro_') || collection.startsWith('directus_')

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    staleTime: 120_000,
    enabled: !isSystem,
    retry: false
  })

  const displayTemplate: string | null = colMeta?.display_template ?? null
  const actualFields: string[] = (colMeta?.fields ?? []).map((f: CMSField) => f.field)
  const wantedFields = [...new Set(['id', ...extractTemplateFields(displayTemplate), ...LABEL_FALLBACKS])]
  const safeFields = actualFields.length
    ? wantedFields.filter((f) => f === 'id' || actualFields.includes(f)).join(',')
    : null

  const { data: itemData } = useQuery({
    queryKey: ['activity-item-label', collection, item, safeFields],
    queryFn: () =>
      api.get(`/items/${collection}/${item}`, { params: { fields: safeFields } }).then((r) => r.data.data),
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

export function ActivityPage() {
  const navigate = useNavigate()
  const [collection, setCollection] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
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
    queryKey: ['activity', collection, action, page],
    queryFn: () =>
      api
        .get('/activity', {
          params: {
            collection: collection || undefined,
            action: action || undefined,
            limit,
            offset: (page - 1) * limit
          }
        })
        .then((r) => r.data)
  })

  const rows: ActivityRow[] = data?.data ?? []
  const total: number = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  const changeFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v === '__all__' ? '' : v)
    setPage(1)
  }

  return (
    <div className='p-8'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-slate-900'>Activity Log</h1>
        <p className='text-muted-foreground mt-1'>Audit trail of all CMS actions.</p>
      </div>

      {/* Filters */}
      <div className='flex items-center gap-3 mb-4'>
        <Select value={collection || '__all__'} onValueChange={changeFilter(setCollection)}>
          <SelectTrigger className='w-52'>
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

        <Select value={action || '__all__'} onValueChange={changeFilter(setAction)}>
          <SelectTrigger className='w-40'>
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
      </div>

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
                    <TableCell className='text-sm'>{userName(row)}</TableCell>
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
                        <span className='block truncate' title={row.comment}>{row.comment}</span>
                      ) : row.collection && row.item ? (
                        <ItemLabel collection={row.collection} item={row.item} />
                      ) : (
                        <span className='font-mono text-muted-foreground'>{row.item ?? '—'}</span>
                      )}
                    </TableCell>
                  </TableRow>
                  )
                })}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className='text-center text-muted-foreground py-12'>
                      No activity recorded yet.
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
  )
}
