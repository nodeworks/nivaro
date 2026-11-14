import {
  ErrorExplanation,
  type IntegrationErrorExplanation,
  queryKeys,
  toastError
} from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown, ChevronRight, ChevronsUpDown, RotateCw, Search } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { ErpStatus, ErpSubmission as ErpSubmissionBase } from '@/components/erp-status-badge'
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
import { SimpleSelect } from '@/components/ui/simple-select'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type Collection } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatRelative, titleCase } from '@/lib/utils'

/** #18 — the list routes add each failed push in plain words + its Fix it target. */
type ErpSubmission = ErpSubmissionBase & {
  explanation?: IntegrationErrorExplanation | null
  external_api_name?: string | null
}

/** Statuses the manual override may set (`sending` is only ever written by a send). */
const ERP_STATUSES: ErpStatus[] = ['submitted', 'pending', 'accepted', 'rejected', 'failed']

const STATUS_STYLES: Record<ErpStatus, string> = {
  submitted: 'bg-slate-500/10 text-slate-600 border-slate-500/20 dark:text-slate-400',
  pending: 'bg-amber-500/10 text-amber-700 border-amber-500/20 dark:text-amber-400',
  accepted: 'bg-green-500/10 text-green-700 border-green-500/20 dark:text-green-400',
  rejected: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400',
  failed: 'bg-red-500/10 text-red-700 border-red-500/20 dark:text-red-400',
  // Written before the partner call and never answered: past its time it may have landed.
  sending: 'bg-orange-500/10 text-orange-700 border-orange-500/25 dark:text-orange-300'
}

function StatusBadge({ sub }: { sub: Pick<ErpSubmission, 'status' | 'unanswered'> }) {
  const inFlight = sub.status === 'sending' && sub.unanswered?.stale !== true
  return (
    <Badge
      variant='outline'
      className={cn(
        'whitespace-nowrap text-[11px]',
        inFlight
          ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
          : STATUS_STYLES[sub.status]
      )}
    >
      {sub.status === 'sending' ? (inFlight ? 'sending…' : 'no answer') : sub.status}
    </Badge>
  )
}

type Settle = 'received' | 'not_received'

/** The Received / Not received button whose settle row is open. */
const PRESSED =
  'border-nvr-cyan bg-nvr-cyan/10 text-foreground hover:bg-nvr-cyan/15 dark:border-nvr-cyan dark:bg-nvr-cyan/15 dark:text-foreground'

/**
 * A send that got no answer, past its time: an administrator checked the partner and says
 * what happened (POST /erp-submissions/:id/resolve-unanswered). The first press opens this
 * row; the button here is the second.
 */
function SettleRow({
  sub,
  outcome,
  onCancel,
  onDone
}: {
  sub: ErpSubmission
  outcome: Settle
  onCancel: () => void
  onDone: () => void
}) {
  const [orderRef, setOrderRef] = useState('')
  const [note, setNote] = useState('')
  const partner = sub.external_api_name?.trim() || 'the partner'
  const received = outcome === 'received'
  const settle = useMutation({
    mutationFn: () =>
      api
        .post<{ data: ErpSubmission; message?: string }>(
          `/erp-submissions/${sub.id}/resolve-unanswered`,
          {
            outcome,
            ...(received && orderRef.trim() ? { order_ref: orderRef.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {})
          }
        )
        .then((r) => r.data),
    onSuccess: (r) => {
      toast.success(r.message ?? (received ? 'Marked as received' : 'Marked as not received'), {
        duration: 8000
      })
      onDone()
    },
    onError: (err) => toastError(err, 'Could not mark this send')
  })
  return (
    <tr
      data-erp-settle={outcome}
      className='border-b border-slate-100 bg-orange-50/60 dark:border-border dark:bg-orange-500/[0.05]'
    >
      <td colSpan={8} className='px-4 py-3'>
        <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
          {received
            ? `Mark #${sub.id} as received by ${partner}?`
            : `Mark #${sub.id} as not received by ${partner}?`}
        </p>
        <p className='mt-0.5 max-w-[72ch] text-[12px] leading-snug text-slate-600 dark:text-slate-300'>
          {received
            ? `Only when ${partner} has this order. The record itself is not changed: set its order number and status there afterwards.`
            : `Only when ${partner} has no such order. The next press of the move sends it again.`}
        </p>
        <div className='mt-2.5 flex flex-wrap items-end gap-2'>
          {received && (
            <div>
              <Label
                htmlFor={`settle-ref-${sub.id}`}
                className='mb-1 block text-[11px] text-slate-500 dark:text-slate-400'
              >
                Order number at {partner} (optional)
              </Label>
              <Input
                id={`settle-ref-${sub.id}`}
                value={orderRef}
                onChange={(e) => setOrderRef(e.target.value)}
                placeholder='e.g. SO-104233'
                className='h-7 w-44 font-mono text-[12px]'
              />
            </div>
          )}
          <div className='min-w-[220px] flex-1'>
            <Label
              htmlFor={`settle-note-${sub.id}`}
              className='mb-1 block text-[11px] text-slate-500 dark:text-slate-400'
            >
              Note (optional)
            </Label>
            <Input
              id={`settle-note-${sub.id}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={received ? 'Where you saw it' : 'What you checked'}
              className='h-7 max-w-[420px] text-[12px]'
            />
          </div>
          <Button
            size='sm'
            className='h-7 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/85'
            disabled={settle.isPending}
            onClick={() => settle.mutate()}
            data-erp-settle-confirm
          >
            {settle.isPending ? 'Saving…' : received ? 'Mark received' : 'Mark not received'}
          </Button>
          <Button
            size='sm'
            variant='outline'
            className='h-7 text-[12px]'
            disabled={settle.isPending}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </td>
    </tr>
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
  onRefetch,
  highlighted = false
}: {
  sub: ErpSubmission
  isAdmin: boolean
  onRefetch: () => void
  /** Opened from a link to this send (`?submission=<id>`): marked and scrolled to. */
  highlighted?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const [settling, setSettling] = useState<Settle | null>(null)
  const rowRef = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (highlighted) rowRef.current?.scrollIntoView({ block: 'center' })
  }, [highlighted])
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
  const sending = sub.status === 'sending'
  const unanswered = sending && sub.unanswered?.stale === true
  const partner = sub.external_api_name?.trim() || 'the partner'

  return (
    <>
      <tr
        ref={rowRef}
        data-erp-submission={sub.id}
        className={cn(
          'border-b border-slate-100 last:border-0 dark:border-border',
          highlighted && 'bg-nvr-cyan/[0.06] dark:bg-nvr-cyan/[0.08]'
        )}
      >
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
          <StatusBadge sub={sub} />
        </td>
        <td className='px-3 py-2 text-center font-mono text-[12px] text-slate-600 dark:text-slate-300'>
          {sub.attempts}
        </td>
        <td className='px-3 py-2 font-mono text-[12px] text-slate-500'>
          {sub.external_ref ?? '—'}
        </td>
        <td className='max-w-[420px] px-3 py-2'>
          <span className='block font-mono text-[11px] text-slate-400'>
            {sub.endpoint_path ?? '—'}
          </span>
          {sub.explanation && (
            <ErrorExplanation explanation={sub.explanation} compact className='mt-0.5' />
          )}
          {sending && (
            <p
              data-erp-unanswered={unanswered ? 'stale' : 'in-flight'}
              className={cn(
                'mt-0.5 text-[12px] leading-snug',
                unanswered
                  ? 'text-orange-800 dark:text-orange-300'
                  : 'text-slate-500 dark:text-slate-400'
              )}
            >
              {unanswered
                ? `No answer — ${partner} may have received it. Check there, then mark it.`
                : `Waiting for ${partner} to answer.`}
            </p>
          )}
        </td>
        <td
          className='px-3 py-2 font-mono text-[11px] text-slate-400'
          title={String(sub.updated_at)}
        >
          {formatRelative(String(sub.updated_at))}
        </td>
        <td className='px-3 py-2'>
          <div className='flex items-center justify-end gap-1.5'>
            {unanswered && isAdmin && (
              <>
                <Button
                  size='sm'
                  variant='outline'
                  className={cn('h-6 px-2 text-[11px]', settling === 'received' && PRESSED)}
                  aria-pressed={settling === 'received'}
                  onClick={() => setSettling((v) => (v === 'received' ? null : 'received'))}
                  data-erp-settle-open='received'
                >
                  Received
                </Button>
                <Button
                  size='sm'
                  variant='outline'
                  className={cn('h-6 px-2 text-[11px]', settling === 'not_received' && PRESSED)}
                  aria-pressed={settling === 'not_received'}
                  onClick={() => setSettling((v) => (v === 'not_received' ? null : 'not_received'))}
                  data-erp-settle-open='not_received'
                >
                  Not received
                </Button>
              </>
            )}
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
            {isAdmin && !overriding && !sending && (
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

      {settling && (
        <SettleRow
          sub={sub}
          outcome={settling}
          onCancel={() => setSettling(null)}
          onDone={() => {
            setSettling(null)
            onRefetch()
          }}
        />
      )}

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
              {sub.last_error && sub.explanation && (
                <ErrorExplanation explanation={sub.explanation} raw={sub.last_error} />
              )}
              {sub.last_error && !sub.explanation && (
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

/** `embedded`: rendered as the Integrations console's ERP submissions tab (no page chrome). */
export function ErpSubmissionsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  // A record's file chips deep-link here as ?collection=&item= (#1288) — the
  // lookup seeds from them so the history is already loaded on arrival.
  const [searchParams] = useSearchParams()
  const seedCollection = searchParams.get('collection') ?? ''
  const seedItem = searchParams.get('item') ?? ''
  // A link to one send (the record's "Check first", api pipelines route) marks its row.
  const highlightId = Number(searchParams.get('submission') ?? '') || null
  const [collection, setCollection] = useState(seedCollection)
  const [itemId, setItemId] = useState(seedItem)
  const [applied, setApplied] = useState<{ collection: string; item: string } | null>(
    seedCollection && seedItem ? { collection: seedCollection, item: seedItem } : null
  )

  const { data: collections = [] } = useQuery({
    queryKey: queryKeys.collections(),
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

  // Bulk retry (#79): every failed/rejected row in the loaded history in one
  // click — the server retries sequentially and reports what landed.
  const failedIds = (submissions ?? [])
    .filter((x) => x.status === 'failed' || x.status === 'rejected')
    .map((x) => x.id)
  const bulkRetry = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { recovered: number; results: Array<{ id: number; status: string }> } }>(
          '/erp-submissions/bulk-retry',
          { ids: failedIds }
        )
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Retried ${failedIds.length} — ${d.recovered} landed`)
      refetch()
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'Bulk retry failed')
  })

  const load = () => {
    if (!collection || !itemId.trim()) return
    setApplied({ collection, item: itemId.trim() })
  }

  // #80 — payload search: find every submission whose payload / response /
  // error / external ref carries a term, across all records.
  const [searchTerm, setSearchTerm] = useState('')
  const [searchStatus, setSearchStatus] = useState('')
  const [searchApplied, setSearchApplied] = useState<{ q: string; status: string } | null>(null)
  const search = useQuery({
    queryKey: ['erp-submissions-search', searchApplied?.q, searchApplied?.status],
    queryFn: () =>
      api
        .get<{
          data: Array<ErpSubmission & { external_api_name: string | null; matched: string[] }>
        }>('/erp-submissions/search', {
          params: { q: searchApplied!.q, status: searchApplied!.status || undefined, limit: 100 }
        })
        .then((r) => r.data.data),
    enabled: !!searchApplied
  })

  return (
    <div className={embedded ? undefined : 'flex flex-1 min-h-0 flex-col'}>
      {!embedded && (
        <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
          <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
            ERP Submissions
          </h1>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Inspect, retry and override the submission history of a record sent to an external ERP
            system.
          </p>
        </header>
      )}

      <div
        className={
          embedded ? undefined : 'flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'
        }
      >
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
          <Button
            type='submit'
            size='sm'
            className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90 text-[12px]'
            disabled={!collection || !itemId.trim()}
          >
            <Search className='mr-1.5 h-3.5 w-3.5' />
            Load history
          </Button>
        </form>

        {/* Payload search (#80) */}
        <form
          data-erp-search
          className='mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 dark:border-border dark:bg-card'
          onSubmit={(e) => {
            e.preventDefault()
            if (searchTerm.trim().length >= 2)
              setSearchApplied({ q: searchTerm.trim(), status: searchStatus })
          }}
        >
          <div className='min-w-[240px] flex-1'>
            <Label className='mb-1 block text-[11px] text-slate-500'>
              Search payloads, responses and errors
            </Label>
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder='order number, SKU, error text…'
              className='h-8 font-mono text-[12.5px]'
            />
          </div>
          <div>
            <Label className='mb-1 block text-[11px] text-slate-500'>Status</Label>
            <SimpleSelect
              value={searchStatus}
              onChange={setSearchStatus}
              ariaLabel='Status'
              className='h-8 w-auto rounded-md border-slate-200 bg-white px-2 text-[12.5px] dark:border-border dark:bg-background'
              options={[
                { value: '', label: 'Any' },
                ...['submitted', 'pending', 'accepted', 'rejected', 'failed'].map((st) => ({
                  value: st,
                  label: titleCase(st)
                })),
                { value: 'sending', label: 'No answer yet' }
              ]}
            />
          </div>
          <Button
            type='submit'
            size='sm'
            variant='outline'
            className='h-8'
            disabled={searchTerm.trim().length < 2}
          >
            <Search className='mr-1.5 h-3.5 w-3.5' />
            Search
          </Button>
          {searchApplied && (
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-8'
              onClick={() => {
                setSearchApplied(null)
                setSearchTerm('')
              }}
            >
              Clear
            </Button>
          )}
          {searchApplied && (
            <div className='w-full' data-erp-search-results>
              {search.isLoading ? (
                <Skeleton className='mt-2 h-8 rounded' />
              ) : (search.data ?? []).length === 0 ? (
                <p className='mt-2 text-[12px] text-slate-400'>
                  Nothing in the last 90 days mentions “{searchApplied.q}”.
                </p>
              ) : (
                <div className='mt-2 divide-y divide-slate-100 dark:divide-border'>
                  {(search.data ?? []).map((row) => (
                    <button
                      type='button'
                      key={row.id}
                      data-erp-search-row={row.id}
                      onClick={() => {
                        setCollection(row.collection)
                        setItemId(row.item)
                        setApplied({ collection: row.collection, item: row.item })
                      }}
                      className='flex w-full flex-wrap items-center gap-2 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/40'
                    >
                      <Badge variant='outline' className='h-5 px-1.5 text-[10px]'>
                        {row.status === 'sending' ? 'No answer yet' : titleCase(row.status)}
                      </Badge>
                      <span className='font-mono text-slate-700 dark:text-foreground'>
                        {row.collection}/{row.item}
                      </span>
                      {row.external_api_name && (
                        <span className='text-slate-500'>· {row.external_api_name}</span>
                      )}
                      <span className='text-slate-400'>
                        matched in {row.matched.join(', ') || 'row'}
                      </span>
                      <span className='ml-auto text-[11px] text-slate-400'>
                        {formatRelative(row.created_at)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
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
              <div className='flex items-center gap-1.5'>
                {failedIds.length > 1 && (
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 px-2 text-[11px]'
                    disabled={bulkRetry.isPending}
                    onClick={() => bulkRetry.mutate()}
                  >
                    <RotateCw
                      className={cn('mr-1 h-3 w-3', bulkRetry.isPending && 'animate-spin')}
                    />
                    Retry all {failedIds.length} failed
                  </Button>
                )}
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
                    highlighted={highlightId === sub.id}
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
