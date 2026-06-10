import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, FileUp, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ImportJob {
  id: string
  collection: string
  file_name: string
  column_map: Record<string, string> | null
  duplicate_strategy: string
  id_field: string | null
  status: 'pending' | 'processing' | 'complete' | 'failed'
  total_rows: number | null
  processed_rows: number | null
  created_rows: number | null
  updated_rows: number | null
  skipped_rows: number | null
  error_rows: number | null
  errors: Array<{ row: number; error: string }> | null
  created_by: string | null
  created_at: string
  started_at: string | null
  completed_at: string | null
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_CLS: Record<string, string> = {
  pending:
    'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/40 dark:text-yellow-400 dark:border-yellow-900',
  processing:
    'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900',
  complete:
    'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900',
  failed:
    'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900'
}

function StatusBadge({ status }: { status: string }) {
  const isProcessing = status === 'processing'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        STATUS_CLS[status] ?? 'bg-muted text-muted-foreground border-border'
      )}
    >
      {isProcessing && (
        <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500 dark:bg-blue-400' />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  )
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ processed, total }: { processed: number | null; total: number | null }) {
  if (!total || total === 0) {
    return <span className='text-xs text-muted-foreground'>—</span>
  }
  const pct = Math.min(100, Math.round(((processed ?? 0) / total) * 100))
  return (
    <div className='flex items-center gap-2 min-w-[80px]'>
      <div className='flex-1 h-1.5 rounded-full bg-muted overflow-hidden'>
        <div
          className='h-full rounded-full bg-nvr-cyan transition-all duration-300'
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className='text-[11px] text-muted-foreground w-8 text-right'>{pct}%</span>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ImportsPage() {
  const qc = useQueryClient()

  const { data: jobsData, isLoading } = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api.get<{ data: ImportJob[] }>('/imports').then((r) => r.data.data)
  })

  const jobs = jobsData ?? []
  const hasProcessing = jobs.some((j) => j.status === 'pending' || j.status === 'processing')

  // Auto-refresh while jobs are in progress
  useEffect(() => {
    if (!hasProcessing) return
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: ['import-jobs'] })
    }, 3000)
    return () => clearInterval(interval)
  }, [hasProcessing, qc])

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/imports/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['import-jobs'] })
      toast.success('Import job deleted')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to delete job'
      toast.error(msg)
    }
  })

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='border-b border-border px-6 py-4 flex items-center justify-between shrink-0'>
        <div className='flex items-center gap-2.5'>
          <FileUp className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Data Imports</h1>
        </div>
        <Button size='sm' asChild>
          <Link to='/imports/new'>
            <FileUp className='h-4 w-4 mr-1.5' />
            New Import
          </Link>
        </Button>
      </div>

      {/* Table */}
      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className='h-12 w-full rounded-lg' />
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <FileUp className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium mb-1'>No import jobs yet</p>
            <p className='text-sm text-muted-foreground mb-4'>
              Upload a CSV file to import data into any collection.
            </p>
            <Button size='sm' asChild>
              <Link to='/imports/new'>New Import</Link>
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead className='text-right'>Created</TableHead>
                  <TableHead className='text-right'>Updated</TableHead>
                  <TableHead className='text-right'>Skipped</TableHead>
                  <TableHead className='text-right'>Errors</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className='w-[80px]'>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className='font-medium max-w-[160px]'>
                      <span className='truncate block' title={job.file_name}>
                        {job.file_name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant='outline' className='font-mono text-[11px]'>
                        {job.collection}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} />
                    </TableCell>
                    <TableCell>
                      <ProgressBar processed={job.processed_rows} total={job.total_rows} />
                    </TableCell>
                    <TableCell className='text-right text-sm'>{job.created_rows ?? 0}</TableCell>
                    <TableCell className='text-right text-sm'>{job.updated_rows ?? 0}</TableCell>
                    <TableCell className='text-right text-sm'>{job.skipped_rows ?? 0}</TableCell>
                    <TableCell className='text-right text-sm'>
                      {(job.error_rows ?? 0) > 0 ? (
                        <span className='text-red-600 dark:text-red-400 font-medium'>
                          {job.error_rows}
                        </span>
                      ) : (
                        0
                      )}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {job.started_at ? formatDate(job.started_at) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1'>
                        <Button variant='ghost' size='icon' className='h-8 w-8' asChild>
                          <Link to={`/imports/${job.id}`}>
                            <Eye className='h-3.5 w-3.5' />
                          </Link>
                        </Button>
                        {(job.status === 'complete' || job.status === 'failed') && (
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 text-destructive hover:text-destructive'
                            onClick={() => deleteMut.mutate(job.id)}
                            disabled={deleteMut.isPending}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
