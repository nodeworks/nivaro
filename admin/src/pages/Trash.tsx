import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

/**
 * Trash bin — records deleted through the items service, restorable for 30
 * days with their original ids. Admins see everything; others see their own
 * deletions. Filters (collection / search) are server-side; bulk restore
 * (#668) fans out the single-restore service per selected entry.
 */

interface TrashEntry {
  id: number
  collection: string
  item_id: string
  label: string
  deleted_by: string | null
  deleted_by_name: string | null
  deleted_at: string
}

interface BulkResult {
  id: number
  ok: boolean
  collection?: string
  item_id?: string
  error?: string
}

export function TrashPage() {
  const queryClient = useQueryClient()
  const [collection, setCollection] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [appliedSearch, setAppliedSearch] = useState('')
  const [page, setPage] = useState(1)
  const [confirmPurge, setConfirmPurge] = useState<number | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['trash', collection, appliedSearch, page],
    queryFn: () =>
      api
        .get<{ data: TrashEntry[]; collections?: string[]; total: number; limit: number }>(
          '/trash',
          {
            params: {
              ...(collection ? { collection } : {}),
              ...(appliedSearch ? { search: appliedSearch } : {}),
              page,
              limit: 50
            }
          }
        )
        .then((r) => r.data)
  })
  const entries = data?.data ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.limit ?? 50)))
  const collections = data?.collections ?? []

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['trash'] })

  const restore = useMutation({
    mutationFn: (id: number) => api.post(`/trash/${id}/restore`),
    onSuccess: (_r, id) => {
      const entry = entries.find((e) => e.id === id)
      toast.success(`Restored ${entry?.label ?? 'record'}`)
      setSelected((s) => {
        const next = new Set(s)
        next.delete(id)
        return next
      })
      invalidate()
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Restore failed')
  })

  const bulkRestore = useMutation({
    mutationFn: (ids: number[]) =>
      api
        .post<{ data: { results: BulkResult[]; restored: number; failed: number } }>(
          '/trash/bulk-restore',
          { ids }
        )
        .then((r) => r.data.data),
    onSuccess: (result) => {
      if (result.failed === 0) {
        toast.success(`Restored ${result.restored} record${result.restored === 1 ? '' : 's'}`)
      } else {
        const firstError = result.results.find((r) => !r.ok)?.error
        toast.warning(
          `Restored ${result.restored}, ${result.failed} failed${firstError ? ` — ${firstError}` : ''}`
        )
      }
      setSelected(new Set())
      invalidate()
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Bulk restore failed')
  })

  const purge = useMutation({
    mutationFn: (id: number) => api.delete(`/trash/${id}`),
    onSuccess: () => {
      toast.success('Permanently deleted')
      setConfirmPurge(null)
      invalidate()
    },
    onError: () => toast.error('Purge failed')
  })

  const toggleSelected = (id: number) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const pageIds = entries.map((e) => e.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Trash2 className='h-4 w-4 text-slate-400' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Trash
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Deleted records are restorable for 30 days, then purged automatically.
            </p>
          </div>
        </div>
      </header>

      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <div className='mx-auto max-w-4xl p-6'>
          <div className='mb-3 flex items-center gap-2'>
            <div className='relative flex-1'>
              <Search className='pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setAppliedSearch(search.trim())
                    setPage(1)
                  }
                }}
                placeholder='Search deleted records…'
                className='h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-2 text-[12.5px] dark:border-border dark:bg-card'
                data-trash-search
              />
            </div>
            <Button
              size='sm'
              variant='outline'
              className='h-8 text-[12px]'
              onClick={() => {
                setAppliedSearch(search.trim())
                setPage(1)
              }}
            >
              Search
            </Button>
            {appliedSearch && (
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-[12px] text-slate-400'
                onClick={() => {
                  setSearch('')
                  setAppliedSearch('')
                  setPage(1)
                }}
              >
                Clear
              </Button>
            )}
          </div>

          {collections.length > 1 && (
            <div className='mb-4 flex flex-wrap gap-1.5'>
              <button
                type='button'
                onClick={() => {
                  setCollection(null)
                  setPage(1)
                }}
                className={`rounded-full border px-2.5 py-0.5 text-[11.5px] ${collection === null ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan' : 'border-slate-200 bg-white text-slate-500 dark:border-border dark:bg-card'}`}
              >
                All
              </button>
              {collections.map((c) => (
                <button
                  key={c}
                  type='button'
                  onClick={() => {
                    setCollection(c)
                    setPage(1)
                  }}
                  className={`rounded-full border px-2.5 py-0.5 text-[11.5px] ${collection === c ? 'border-nvr-cyan bg-accent text-nvr-navy dark:text-nvr-cyan' : 'border-slate-200 bg-white text-slate-500 dark:border-border dark:bg-card'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          )}

          {selected.size > 0 && (
            <div className='mb-3 flex items-center gap-3 rounded-lg border border-nvr-cyan/40 bg-[#f0fbff] px-4 py-2 dark:bg-nvr-cyan/10'>
              <span className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                {selected.size} selected
              </span>
              <Button
                size='sm'
                className='gap-1.5 text-[12px]'
                disabled={bulkRestore.isPending}
                onClick={() => bulkRestore.mutate([...selected].slice(0, 100))}
                data-bulk-restore
              >
                <ArchiveRestore className='h-3.5 w-3.5' />
                {bulkRestore.isPending ? 'Restoring…' : 'Restore selected'}
              </Button>
              {selected.size > 100 && (
                <span className='text-[11px] text-amber-600'>First 100 per batch</span>
              )}
              <Button
                size='sm'
                variant='ghost'
                className='text-[12px] text-slate-400'
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
            </div>
          )}

          {isLoading ? (
            <p className='pt-16 text-center text-[13px] text-slate-400'>Loading…</p>
          ) : entries.length === 0 ? (
            <div className='pt-16 text-center text-slate-400'>
              <Trash2 className='mx-auto h-8 w-8 opacity-40' />
              <p className='mt-3 text-[13px]'>
                {appliedSearch || collection ? 'Nothing matches these filters.' : 'Trash is empty.'}
              </p>
            </div>
          ) : (
            <div className='space-y-1'>
              <div className='flex items-center gap-2 px-4 pb-1'>
                <Checkbox
                  checked={allPageSelected}
                  onCheckedChange={() =>
                    setSelected((s) => {
                      const next = new Set(s)
                      if (allPageSelected) for (const id of pageIds) next.delete(id)
                      else for (const id of pageIds) next.add(id)
                      return next
                    })
                  }
                  aria-label='Select all on page'
                />
                <span className='text-[11px] text-slate-400'>Select all on this page</span>
              </div>
              {entries.map((e) => (
                <div
                  key={e.id}
                  className='flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'
                >
                  <Checkbox
                    checked={selected.has(e.id)}
                    onCheckedChange={() => toggleSelected(e.id)}
                    aria-label={`Select ${e.label}`}
                  />
                  <div className='min-w-0 flex-1'>
                    <p className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                      {e.label}
                    </p>
                    <div className='text-[11px] text-slate-400'>
                      <Badge className='mr-1.5 h-4 px-1.5 text-[10px]'>{e.collection}</Badge>#
                      {e.item_id}
                      {e.deleted_by_name ? ` · deleted by ${e.deleted_by_name}` : ''} ·{' '}
                      {formatRelative(e.deleted_at)}
                    </div>
                  </div>
                  <Button
                    size='sm'
                    variant='outline'
                    className='gap-1.5 text-[12px]'
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(e.id)}
                  >
                    <ArchiveRestore className='h-3.5 w-3.5' /> Restore
                  </Button>
                  {confirmPurge === e.id ? (
                    <Button
                      size='sm'
                      variant='outline'
                      className='gap-1.5 text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50'
                      disabled={purge.isPending}
                      onClick={() => purge.mutate(e.id)}
                    >
                      Confirm delete forever
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='text-[12px] text-slate-400 hover:text-red-500'
                      onClick={() => setConfirmPurge(e.id)}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </Button>
                  )}
                </div>
              ))}
              {totalPages > 1 && (
                <div className='flex items-center justify-center gap-3 pt-3 text-[12px] text-slate-500'>
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={page <= 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Prev
                  </Button>
                  Page {page} / {totalPages}
                  <Button
                    size='sm'
                    variant='outline'
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
