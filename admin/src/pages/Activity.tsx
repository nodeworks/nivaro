import { ActivityFeed, readableTitle, useActivityLabels } from '@nivaro/shared'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
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
import { type ActivityEntry, api } from '@/lib/api'
import { formatNumber } from '@/lib/utils'

/**
 * The audit trail as sentences (migration 516): "Pat moved PO 4471 from Draft to Approved",
 * who really did it (View-as, API key, assistant, import, flow, scheduled job), why (reason,
 * transition note, approval) and bursts folded into one expandable line. Record labels are
 * read as the viewer in one batch per page (POST /activity/labels).
 */
export function ActivityPage() {
  const navigate = useNavigate()
  // `?group_key=` (an entry's "See the whole burst"): one bulk action / import / flow run.
  const [params, setParams] = useSearchParams()
  const groupKey = params.get('group_key') ?? ''
  const [collection, setCollection] = useState('')
  const [action, setAction] = useState('')
  const [page, setPage] = useState(1)
  const limit = 50

  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get('/collections').then((r) => r.data.data)
  })

  const { data: actionsData } = useQuery({
    queryKey: ['activity-actions'],
    queryFn: () => api.get('/activity/actions').then((r) => r.data.data as string[])
  })

  const { data, isLoading } = useQuery({
    queryKey: ['activity', collection, action, groupKey, page],
    queryFn: () =>
      api
        .get('/activity', {
          params: {
            collection: collection || undefined,
            action: action || undefined,
            group_key: groupKey || undefined,
            limit,
            offset: (page - 1) * limit
          }
        })
        .then((r) => r.data as { data: ActivityEntry[]; total: number })
  })

  const rows: ActivityEntry[] = data?.data ?? []
  const labels = useActivityLabels(rows)
  const total: number = data?.total ?? 0
  const totalPages = Math.ceil(total / limit)

  const changeFilter = (setter: (v: string) => void) => (v: string) => {
    setter(v === '__all__' ? '' : v)
    setPage(1)
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar
        description='Everything that happened, newest first, in plain sentences. Bulk changes, imports and automations fold into one line — open it to see each record. Open an entry for its full detail.'
        actions={
          <>
            <Select value={collection || '__all__'} onValueChange={changeFilter(setCollection)}>
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

            <Select value={action || '__all__'} onValueChange={changeFilter(setAction)}>
              <SelectTrigger className='h-8 w-44 text-[12px]' aria-label='Action'>
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
          </>
        }
      />

      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        {groupKey && (
          <div className='mb-3 flex items-center gap-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
            <span>Showing every entry of one bulk change, import or automation run.</span>
            <Button
              variant='outline'
              size='sm'
              className='h-7'
              onClick={() => {
                const next = new URLSearchParams(params)
                next.delete('group_key')
                setParams(next, { replace: true })
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
                <Skeleton key={i} className='h-9 w-full' />
              ))}
            </div>
          ) : (
            <>
              <ActivityFeed
                className='px-2 py-1'
                entries={rows}
                labels={labels}
                onOpen={(e) => e.id != null && navigate(`/activity/${e.id}`)}
                empty={
                  <p className='py-12 text-center text-sm text-muted-foreground'>
                    No activity recorded yet.
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
