import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, RotateCw, Search } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { ErpStatus, ErpSubmission } from '@/components/erp-status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative, titleCase } from '@/lib/utils'

const ERP_STATUSES: ErpStatus[] = ['submitted', 'pending', 'accepted', 'rejected', 'failed']

const STATUS_STYLES: Record<ErpStatus, string> = {
  submitted: 'bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-400',
  pending: 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400',
  accepted: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400',
  rejected: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400',
  failed: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400'
}

function StatusBadge({ status }: { status: ErpStatus }) {
  return (
    <Badge variant='outline' className={cn('text-[11px]', STATUS_STYLES[status])}>
      {status}
    </Badge>
  )
}

function CollectionCombobox({
  collections,
  value,
  onChange
}: {
  collections: Collection[]
  value: string
  onChange: (v: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = collections.find((c) => c.collection === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-[240px] justify-between text-[13px] font-normal'
        >
          <span className={value ? '' : 'text-muted-foreground'}>
            {selected ? (selected.display_name ?? titleCase(selected.collection)) : 'Collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3.5 w-3.5 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[240px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty>No collections found</CommandEmpty>
            <CommandGroup>
              {collections.map((c) => (
                <CommandItem
                  key={c.collection}
                  value={c.collection}
                  onSelect={() => {
                    onChange(c.collection === value ? '' : c.collection)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3.5 w-3.5',
                      value === c.collection ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span>{c.display_name ?? titleCase(c.collection)}</span>
                  <span className='ml-1.5 font-mono text-[10px] text-slate-400'>
                    {c.collection}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function StatusCombobox({
  value,
  onChange
}: {
  value: ErpStatus | ''
  onChange: (v: ErpStatus) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-7 w-32 justify-between text-[12px] font-normal'
        >
          <span className={value ? '' : 'text-muted-foreground'}>{value || 'Status…'}</span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-32 p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {ERP_STATUSES.map((s) => (
                <CommandItem
                  key={s}
                  value={s}
                  onSelect={() => {
                    onChange(s)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3.5 w-3.5', value === s ? 'opacity-100' : 'opacity-0')}
                  />
                  {s}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function SubmissionRow({
  sub,
  isAdmin,
  onRefetch
}: {
  sub: ErpSubmission
  isAdmin: boolean
  onRefetch: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [overrideStatus, setOverrideStatus] = useState<ErpStatus | ''>('')
  const [overrideRef, setOverrideRef] = useState(sub.external_ref ?? '')

  const retryMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ErpSubmission }>(`/erp-submissions/${sub.id}/retry`)
        .then((r) => r.data.data),
    onSuccess: (updated) => {
      onRefetch()
      if (updated.status === 'failed') {
        toast.error(`Retry failed${updated.last_error ? `: ${updated.last_error}` : ''}`)
      } else {
        toast.success(`Resubmitted — status: ${updated.status}`)
      }
    },
    onError: () => toast.error('Retry failed')
  })

  const overrideMut = useMutation({
    mutationFn: () =>
      api.patch(`/erp-submissions/${sub.id}/status`, {
        status: overrideStatus,
        external_ref: overrideRef || null
      }),
    onSuccess: () => {
      onRefetch()
      setOverriding(false)
      toast.success('Status updated')
    },
    onError: () => toast.error('Failed to update status')
  })

  const canRetry = sub.status === 'failed' || sub.status === 'rejected'
  const hasDetail = !!sub.last_error || !!sub.payload

  return (
    <>
      <tr className='border-b border-slate-100 last:border-0 dark:border-border'>
        <td className='px-3 py-2'>
          {hasDetail ? (
            <button
              type='button'
              onClick={() => setExpanded((e) => !e)}
              className='text-slate-400 transition-colors hover:text-slate-600'
              aria-label={expanded ? 'Collapse detail' : 'Expand detail'}
            >
              {expanded ? (
                <ChevronDown className='h-3.5 w-3.5' />
              ) : (
                <ChevronRight className='h-3.5 w-3.5' />
              )}
            </button>
          ) : null}
        </td>
        <td className='px-3 py-2 font-mono text-[12px] text-slate-500'>#{sub.id}</td>
        <td className='px-3 py-2'>
          <StatusBadge status={sub.status} />
        </td>
        <td className='px-3 py-2 text-center font-mono text-[12px] text-slate-600 dark:text-slate-300'>
          {sub.attempts}
        </td>
        <td className='px-3 py-2 font-mono text-[12px] text-slate-500'>
          {sub.external_ref ?? '—'}
        </td>
        <td className='px-3 py-2 font-mono text-[11px] text-slate-400'>
          {sub.endpoint_path ?? '—'}
        </td>
        <td
          className='px-3 py-2 font-mono text-[11px] text-slate-400'
          title={String(sub.updated_at)}
        >
          {formatRelative(String(sub.updated_at))}
        </td>
        <td className='px-3 py-2'>
          <div className='flex items-center justify-end gap-1.5'>
            {canRetry && (
              <Button
                size='sm'
                variant='outline'
                className='h-6 px-2 text-[11px]'
                disabled={retryMut.isPending}
                onClick={() => retryMut.mutate()}
              >
                <RotateCw className={cn('mr-1 h-3 w-3', retryMut.isPending && 'animate-spin')} />
                Retry
              </Button>
            )}
            {isAdmin && !overriding && (
              <Button
                size='sm'
                variant='ghost'
                className='h-6 px-2 text-[11px] text-slate-500'
                onClick={() => {
                  setOverriding(true)
                  setOverrideStatus(sub.status)
                  setOverrideRef(sub.external_ref ?? '')
                }}
              >
                Override
              </Button>
            )}
          </div>
        </td>
      </tr>

      {/* Admin status override — inline form row */}
      {overriding && (
        <tr className='border-b border-slate-100 bg-nvr-cyan/[0.04] dark:border-border'>
          <td colSpan={8} className='px-4 py-2.5'>
            <div className='flex flex-wrap items-end gap-2'>
              <div>
                <Label className='mb-1 block text-[10px] uppercase tracking-wide text-slate-400'>
                  New status
                </Label>
                <StatusCombobox value={overrideStatus} onChange={setOverrideStatus} />
              </div>
              <div>
                <Label className='mb-1 block text-[10px] uppercase tracking-wide text-slate-400'>
                  External ref
                </Label>
                <Input
                  value={overrideRef}
                  onChange={(e) => setOverrideRef(e.target.value)}
                  placeholder='ERP reference…'
                  className='h-7 w-44 font-mono text-[12px]'
                />
              </div>
              <Button
                size='sm'
                className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/80'
                disabled={!overrideStatus || overrideMut.isPending}
                onClick={() => overrideMut.mutate()}
              >
                {overrideMut.isPending ? 'Saving…' : 'Apply'}
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                onClick={() => setOverriding(false)}
              >
                Cancel
              </Button>
              <span className='text-[11px] text-slate-400'>
                Manual override — use when the ERP reported a result out-of-band.
              </span>
            </div>
          </td>
        </tr>
      )}

      {/* Expanded detail row */}
      {expanded && hasDetail && (
        <tr className='border-b border-slate-100 bg-slate-50/60 dark:border-border dark:bg-muted/30'>
          <td colSpan={8} className='px-4 py-3'>
            <div className='space-y-2'>
              {sub.last_error && (
                <div>
                  <p className='text-[10px] font-medium uppercase tracking-wide text-red-400'>
                    Last error
                  </p>
                  <pre className='mt-0.5 whitespace-pre-wrap break-all rounded-md border border-red-100 bg-red-50 p-2 font-mono text-[11px] text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300'>
                    {sub.last_error}
                  </pre>
                </div>
              )}
              {sub.payload && (
                <div>
                  <p className='text-[10px] font-medium uppercase tracking-wide text-slate-400'>
                    Stored payload
                  </p>
                  <pre className='mt-0.5 max-h-48 overflow-auto rounded-md border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'>
                    {JSON.stringify(sub.payload, null, 2)}
                  </pre>
                </div>
              )}
              <p className='text-[11px] text-slate-400'>
                Created {formatRelative(String(sub.created_at))} · external api #{sub.external_api}
              </p>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

export function ErpSubmissionsPage() {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const [collection, setCollection] = useState('')
  const [itemId, setItemId] = useState('')
  const [applied, setApplied] = useState<{ collection: string; item: string } | null>(null)

  const { data: collections = [] } = useQuery({
    queryKey: ['collections'],
    queryFn: () => api.get<{ data: Collection[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const {
    data: submissions,
    isLoading,
    isFetching
  } = useQuery({
    queryKey: ['erp-submissions', applied?.collection, applied?.item],
    queryFn: () =>
      api
        .get<{ data: ErpSubmission[] }>(
          `/erp-submissions/${encodeURIComponent(applied!.collection)}/${encodeURIComponent(applied!.item)}`
        )
        .then((r) => r.data.data),
    enabled: !!applied
  })

  const refetch = () =>
    queryClient.invalidateQueries({
      queryKey: ['erp-submissions', applied?.collection, applied?.item]
    })

  const load = () => {
    if (!collection || !itemId.trim()) return
    setApplied({ collection, item: itemId.trim() })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Page header */}
      <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
          ERP Submissions
        </h1>
        <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
          Inspect, retry and override the submission history of a record sent to an external ERP
          system.
        </p>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        {/* Lookup bar */}
        <form
          className='mb-4 flex flex-wrap items-end gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            load()
          }}
        >
          <div>
            <Label className='mb-1 block text-[11px] text-slate-500'>Collection</Label>
            <CollectionCombobox
              collections={collections.filter((c) => !c.collection.startsWith('nivaro_'))}
              value={collection}
              onChange={setCollection}
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px] text-slate-500'>Item ID</Label>
            <Input
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              placeholder='Record id…'
              className='h-8 w-44 font-mono text-[13px]'
            />
          </div>
          <Button type='submit' size='sm' className='h-8' disabled={!collection || !itemId.trim()}>
            <Search className='mr-1.5 h-3.5 w-3.5' />
            Load history
          </Button>
        </form>

        {/* Results */}
        {!applied ? (
          <div className='rounded-lg border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-border dark:bg-card'>
            <p className='text-[13px] text-slate-400'>
              Pick a collection and enter a record id to view its ERP submission history.
            </p>
            <p className='mt-1 text-[11px] text-slate-300 dark:text-slate-500'>
              Tip: the latest submission status also appears as a badge on the item edit page.
            </p>
          </div>
        ) : isLoading ? (
          <div className='space-y-2'>
            {[1, 2, 3].map((k) => (
              <Skeleton key={k} className='h-10 rounded-lg' />
            ))}
          </div>
        ) : (submissions ?? []).length === 0 ? (
          <div className='rounded-lg border border-slate-200 bg-white px-6 py-10 text-center dark:border-border dark:bg-card'>
            <p className='text-[13px] text-slate-400'>
              No ERP submissions recorded for{' '}
              <code className='font-mono text-[12px]'>
                {applied.collection}/{applied.item}
              </code>
            </p>
          </div>
        ) : (
          <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
            <div className='flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-border'>
              <p className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
                {submissions?.length} submission{submissions?.length === 1 ? '' : 's'} for{' '}
                <code className='font-mono'>
                  {applied.collection}/{applied.item}
                </code>
              </p>
              <Button
                size='sm'
                variant='ghost'
                className='h-6 px-2 text-[11px] text-slate-400'
                onClick={refetch}
                disabled={isFetching}
              >
                <RotateCw className={cn('mr-1 h-3 w-3', isFetching && 'animate-spin')} />
                Refresh
              </Button>
            </div>
            <table className='w-full text-[12px]'>
              <thead>
                <tr className='border-b border-slate-200 bg-slate-50 text-left dark:border-border dark:bg-muted/40'>
                  <th className='w-8 px-3 py-2' />
                  <th className='px-3 py-2 font-medium text-slate-500'>ID</th>
                  <th className='px-3 py-2 font-medium text-slate-500'>Status</th>
                  <th className='px-3 py-2 text-center font-medium text-slate-500'>Attempts</th>
                  <th className='px-3 py-2 font-medium text-slate-500'>External ref</th>
                  <th className='px-3 py-2 font-medium text-slate-500'>Endpoint</th>
                  <th className='px-3 py-2 font-medium text-slate-500'>Updated</th>
                  <th className='px-3 py-2' />
                </tr>
              </thead>
              <tbody>
                {submissions?.map((sub) => (
                  <SubmissionRow
                    key={sub.id}
                    sub={sub}
                    isAdmin={!!user?.is_admin}
                    onRefetch={refetch}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
