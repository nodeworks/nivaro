import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArchiveRestore, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

/**
 * Trash bin — records deleted through the items service, restorable for 30
 * days with their original ids. Admins see everything; others see their own
 * deletions.
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

export function TrashPage() {
  const queryClient = useQueryClient()
  const [collection, setCollection] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [confirmPurge, setConfirmPurge] = useState<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['trash', collection, page],
    queryFn: () =>
      api
        .get<{ data: TrashEntry[]; total: number; limit: number }>('/trash', {
          params: { ...(collection ? { collection } : {}), page, limit: 50 }
        })
        .then((r) => r.data)
  })
  const entries = data?.data ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.limit ?? 50)))
  const collections = [...new Set(entries.map((e) => e.collection))].sort()

  const restore = useMutation({
    mutationFn: (id: number) => api.post(`/trash/${id}/restore`),
    onSuccess: (_r, id) => {
      const entry = entries.find((e) => e.id === id)
      toast.success(`Restored ${entry?.label ?? 'record'}`)
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Restore failed')
  })

  const purge = useMutation({
    mutationFn: (id: number) => api.delete(`/trash/${id}`),
    onSuccess: () => {
      toast.success('Permanently deleted')
      setConfirmPurge(null)
      queryClient.invalidateQueries({ queryKey: ['trash'] })
    },
    onError: () => toast.error('Purge failed')
  })

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

          {isLoading ? (
            <p className='pt-16 text-center text-[13px] text-slate-400'>Loading…</p>
          ) : entries.length === 0 ? (
            <div className='pt-16 text-center text-slate-400'>
              <Trash2 className='mx-auto h-8 w-8 opacity-40' />
              <p className='mt-3 text-[13px]'>Trash is empty.</p>
            </div>
          ) : (
            <div className='space-y-1'>
              {entries.map((e) => (
                <div
                  key={e.id}
                  className='flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-2.5 dark:border-border dark:bg-card'
                >
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
