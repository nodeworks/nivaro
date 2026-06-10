import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useNavigate, useParams } from 'react-router'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActivityEntry, api } from '@/lib/api'
import { formatDateTime } from '@/lib/utils'

const ACTION_VARIANTS: Record<string, 'default' | 'success' | 'destructive' | 'secondary'> = {
  create: 'success',
  delete: 'destructive',
  update: 'default',
  login: 'secondary',
  logout: 'secondary'
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
              <Field label='Time' value={formatDateTime(entry.timestamp)} />
              <Field label='User' value={userName(entry)} />
              <Field
                label='Collection'
                value={
                  entry.collection ? (
                    <span className='font-mono text-slate-600'>{entry.collection}</span>
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
                      className='font-mono text-nvr-cyan hover:underline'
                    >
                      {entry.item}
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
              {entry.comment && <Field label='Comment' value={entry.comment} />}
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
