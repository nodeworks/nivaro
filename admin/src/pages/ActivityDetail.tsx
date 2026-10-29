import {
  activityWhy,
  actorName,
  actorOf,
  collectionNouns,
  HIDDEN_RECORD,
  readableTitle,
  recordPhrase,
  renderActivitySentence,
  useActivityLabels
} from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { type ActivityEntry, api } from '@/lib/api'
import { useGoBack } from '@/lib/nav'
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

const ACTOR_KIND_LABEL: Record<string, string> = {
  person: 'Person',
  view_as: 'Administrator viewing as someone',
  api_key: 'API key',
  mcp: 'AI assistant (MCP)',
  import: 'Import',
  flow: 'Flow',
  cron: 'Scheduled job',
  system: 'System'
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='flex items-start justify-between gap-4 border-b border-slate-100 py-2.5 last:border-0 dark:border-border'>
      <span className='w-32 shrink-0 text-sm text-slate-500 dark:text-slate-400'>{label}</span>
      <span className='break-all text-right text-sm text-slate-800 dark:text-slate-200'>
        {value ?? <span className='text-slate-300 dark:text-slate-600'>—</span>}
      </span>
    </div>
  )
}

export function ActivityDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const goBack = useGoBack('/activity')

  const { data: entry, isLoading } = useQuery({
    queryKey: ['activity', id],
    queryFn: () => api.get(`/activity/${id}`).then((r) => r.data.data as ActivityEntry),
    enabled: !!id
  })
  const entries = useMemo(() => (entry ? [entry] : []), [entry])
  const labels = useActivityLabels(entries)
  const why = entry ? activityWhy(entry) : null
  const actor = entry ? actorOf(entry) : null
  const record = entry ? recordPhrase(entry.collection, entry.item, labels) : null

  return (
    <div className='max-w-3xl p-8'>
      <div className='mb-8 flex items-center gap-4'>
        <Button variant='ghost' size='icon' onClick={goBack} aria-label='Back'>
          <ArrowLeft className='h-4 w-4' />
        </Button>
        <div className='min-w-0'>
          <h1 className='text-2xl font-bold text-slate-900 dark:text-slate-100'>Activity Event</h1>
          {entry ? (
            <p className='mt-0.5 text-sm text-slate-600 dark:text-slate-300' data-activity-sentence>
              {renderActivitySentence(entry, labels)}
            </p>
          ) : (
            <p className='mt-0.5 font-mono text-sm text-muted-foreground'>#{id}</p>
          )}
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
                  className='text-xs'
                  title={entry.action}
                >
                  {readableTitle(entry.action) || entry.action}
                </Badge>
                <CardTitle className='text-sm font-medium text-slate-500 dark:text-slate-400'>
                  Details
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              {why && (why.note || why.reason || why.approval) && (
                <div className='mb-3 space-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] text-slate-700 dark:border-border dark:bg-muted/40 dark:text-slate-200'>
                  {why.note && <p className='italic'>“{why.note}”</p>}
                  {why.reason && <p>Reason: {why.reason}</p>}
                  {why.approval && <p>Approval: {why.approval}</p>}
                </div>
              )}
              <Field label='Time' value={formatDateTime(entry.timestamp)} />
              <Field label='Who' value={actorName(entry, labels)} />
              {actor && actor.kind !== 'person' && (
                <Field label='Acting as' value={ACTOR_KIND_LABEL[actor.kind] ?? actor.kind} />
              )}
              <Field
                label='Collection'
                value={
                  entry.collection ? (
                    <span title={entry.collection}>
                      {collectionNouns(entry.collection, labels).plural}
                    </span>
                  ) : null
                }
              />
              <Field
                label='Record'
                value={
                  entry.item && entry.collection && record && record !== HIDDEN_RECORD ? (
                    <button
                      type='button'
                      onClick={() => navigate(`/collections/${entry.collection}/${entry.item}`)}
                      className='text-nvr-cyan hover:underline'
                      title={entry.item}
                    >
                      {record}
                    </button>
                  ) : (
                    record
                  )
                }
              />
              {entry.group_key && (
                <Field
                  label='Part of'
                  value={
                    <button
                      type='button'
                      onClick={() =>
                        navigate(`/activity?group_key=${encodeURIComponent(entry.group_key ?? '')}`)
                      }
                      className='text-nvr-cyan hover:underline'
                      title={entry.group_key}
                    >
                      See every entry of this run
                    </button>
                  }
                />
              )}
              <Field label='IP' value={entry.ip} />
              <Field
                label='User Agent'
                value={
                  entry.user_agent ? (
                    <span className='font-mono text-[11px] text-slate-500 dark:text-slate-400'>
                      {entry.user_agent}
                    </span>
                  ) : null
                }
              />
              {entry.comment && <Field label='Stored note' value={entry.comment} />}
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
