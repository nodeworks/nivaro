import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, GitBranch } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActivityEntry, type CMSField, api } from '@/lib/api'
import { extractTemplateFields, renderDisplayTemplate } from '@/lib/relations'
import { formatDateTime } from '@/lib/utils'

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
const LABEL_FALLBACKS = ['name', 'title', 'label', 'display_name', 'subject', 'email', 'slug']

function useItemLabel(collection: string | null, item: string | null) {
  const isSystem = !collection || collection.startsWith('nivaro_') || collection.startsWith('directus_')
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    staleTime: 120_000,
    enabled: !isSystem && !!collection,
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
    enabled: !isSystem && !!safeFields && !!item,
    retry: false
  })
  const label = itemData ? renderDisplayTemplate(displayTemplate, itemData) : null
  return label && label !== item && label.trim() !== '' ? label : null
}

function userName(entry: ActivityEntry): string {
  if (entry.first_name || entry.last_name)
    return [entry.first_name, entry.last_name].filter(Boolean).join(' ')
  return entry.user_email ?? entry.user?.slice(0, 8) ?? '—'
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='flex items-start justify-between py-2.5 border-b last:border-0 border-slate-100 gap-4'>
      <span className='text-sm text-slate-500 shrink-0 w-32'>{label}</span>
      <span className='text-sm text-slate-800 text-right break-all'>
        {value ?? <span className='text-slate-300'>—</span>}
      </span>
    </div>
  )
}

export function ActivityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data: entry, isLoading } = useQuery({
    queryKey: ['activity', id],
    queryFn: () => api.get(`/activity/${id}`).then((r) => r.data.data as ActivityEntry),
    enabled: !!id
  })
  const itemLabel = useItemLabel(entry?.collection ?? null, entry?.item ?? null)
  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', entry?.collection],
    queryFn: () => api.get(`/collections/${entry!.collection}`).then((r) => r.data.data),
    staleTime: 120_000,
    enabled: !!entry?.collection && !entry.collection.startsWith('nivaro_'),
    retry: false
  })
  const collectionDisplayName = colMeta?.display_name
    ?? (entry?.collection
      ? entry.collection.replace(/^nivaro_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
      : null)

  return (
    <div className='p-8 max-w-3xl'>
      <div className='flex items-center gap-4 mb-8'>
        <Button variant='ghost' size='icon' onClick={() => navigate('/activity')}>
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div>
          <h1 className='text-2xl font-bold text-slate-900'>Activity Event</h1>
          <p className='text-muted-foreground text-sm font-mono mt-0.5'>#{id}</p>
        </div>
      </div>

      {isLoading ? (
        <div className='space-y-4'>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className='h-16 rounded-xl' />
          ))}
        </div>
      ) : !entry ? (
        <p className='text-muted-foreground'>Event not found.</p>
      ) : (
        <div className='space-y-6'>
          <Card>
            <CardHeader className='pb-2'>
              <div className='flex items-center gap-3'>
                <Badge
                  variant={ACTION_VARIANTS[entry.action] ?? 'secondary'}
                  className='text-xs capitalize'
                >
                  {entry.action}
                </Badge>
                <CardTitle className='text-sm font-medium text-slate-500'>Details</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {/* Pipeline transition summary banner */}
              {PIPELINE_ACTIONS.has(entry.action) && entry.comment && (
                <div className='mb-3 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5'>
                  <GitBranch className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                  <span className='text-[13px] font-medium text-slate-700'>{entry.comment}</span>
                </div>
              )}
              <Field label='Time' value={formatDateTime(entry.timestamp)} />
              <Field label='User' value={userName(entry)} />
              <Field
                label='Collection'
                value={
                  entry.collection ? (
                    <span className='text-slate-600' title={entry.collection}>
                      {collectionDisplayName ?? entry.collection}
                    </span>
                  ) : null
                }
              />
              <Field
                label='Item'
                value={
                  entry.item && entry.collection ? (
                    <button
                      type='button'
                      onClick={() => navigate(`/collections/${entry.collection}/${entry.item}`)}
                      className='text-nvr-cyan hover:underline'
                    >
                      {itemLabel ?? <span className='font-mono'>{entry.item}</span>}
                    </button>
                  ) : entry.item ? (
                    <span className='font-mono'>{entry.item}</span>
                  ) : null
                }
              />
              <Field label='IP' value={entry.ip} />
              <Field
                label='User Agent'
                value={
                  entry.user_agent ? (
                    <span className='font-mono text-[11px] text-slate-500'>{entry.user_agent}</span>
                  ) : null
                }
              />
              {entry.comment && !PIPELINE_ACTIONS.has(entry.action) && (
                <Field label='Comment' value={entry.comment} />
              )}
            </CardContent>
          </Card>

          {entry.collection && entry.item && (
            <RevisionsPanel collection={entry.collection} item={entry.item} />
          )}
        </div>
      )}
    </div>
  )
}
