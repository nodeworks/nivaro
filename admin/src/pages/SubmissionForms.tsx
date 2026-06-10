import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileInput, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { api } from '@/lib/api'
import { formatDate } from '@/lib/utils'

interface SubmissionForm {
  id: string
  name: string
  collection: string
  fields: string[]
  token: string
  expires_at: string | null
  rate_limit_per_hour: number
  is_active: boolean
  success_message: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  submission_count: number
}

export function SubmissionFormsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [deleting, setDeleting] = useState<SubmissionForm | null>(null)

  const { data: forms = [], isLoading } = useQuery({
    queryKey: ['submission-forms'],
    queryFn: () => api.get<{ data: SubmissionForm[] }>('/submission-forms').then((r) => r.data.data)
  })

  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      api.patch(`/submission-forms/${id}`, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submission-forms'] })
    },
    onError: () => toast.error('Failed to update form')
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/submission-forms/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submission-forms'] })
      setDeleting(null)
      toast.success('Form deleted')
    },
    onError: () => toast.error('Failed to delete form')
  })

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-border px-6 py-4 shrink-0'>
        <div className='flex items-center gap-2.5'>
          <FileInput className='h-5 w-5 text-muted-foreground' />
          <h1 className='text-lg font-semibold'>Submission Forms</h1>
        </div>
        <Button size='sm' onClick={() => navigate('/submission-forms/new')}>
          <Plus className='h-4 w-4 mr-1.5' />
          New Form
        </Button>
      </div>

      {/* Content */}
      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-12 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : forms.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <FileInput className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm text-muted-foreground'>No submission forms yet</p>
            <Button
              size='sm'
              variant='outline'
              className='mt-4'
              onClick={() => navigate('/submission-forms/new')}
            >
              Create your first form
            </Button>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <Table>
              <TableHeader>
                <TableRow className='bg-muted/40'>
                  <TableHead>Name</TableHead>
                  <TableHead>Collection</TableHead>
                  <TableHead>Submissions</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className='w-[90px]' />
                </TableRow>
              </TableHeader>
              <TableBody>
                {forms.map((form) => (
                  <TableRow key={form.id} className='group'>
                    <TableCell className='font-medium'>{form.name}</TableCell>
                    <TableCell>
                      <code className='text-xs bg-muted px-1.5 py-0.5 rounded'>
                        {form.collection}
                      </code>
                    </TableCell>
                    <TableCell>
                      <span className='text-sm tabular-nums'>{form.submission_count}</span>
                    </TableCell>
                    <TableCell>
                      <button
                        type='button'
                        onClick={() =>
                          toggleMut.mutate({ id: form.id, is_active: !form.is_active })
                        }
                        disabled={toggleMut.isPending}
                        className='focus:outline-none'
                        title={form.is_active ? 'Click to deactivate' : 'Click to activate'}
                      >
                        {form.is_active ? (
                          <Badge className='bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 hover:bg-emerald-200 cursor-pointer'>
                            Active
                          </Badge>
                        ) : (
                          <Badge
                            variant='outline'
                            className='text-muted-foreground hover:bg-muted cursor-pointer'
                          >
                            Inactive
                          </Badge>
                        )}
                      </button>
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {form.expires_at ? formatDate(form.expires_at) : '—'}
                    </TableCell>
                    <TableCell className='text-sm text-muted-foreground'>
                      {formatDate(form.created_at)}
                    </TableCell>
                    <TableCell>
                      <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity'>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7'
                          onClick={() => navigate(`/submission-forms/${form.id}`)}
                        >
                          <Pencil className='h-3.5 w-3.5' />
                        </Button>
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-7 w-7 text-destructive hover:text-destructive'
                          onClick={() => setDeleting(form)}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Submission Form</DialogTitle>
          </DialogHeader>
          <p className='px-6 pb-6 text-sm text-muted-foreground'>
            Are you sure you want to delete{' '}
            <span className='font-medium text-foreground'>{deleting?.name}</span>? All{' '}
            <span className='font-medium text-foreground'>{deleting?.submission_count}</span>{' '}
            submission{deleting?.submission_count !== 1 ? 's' : ''} will also be deleted. This
            cannot be undone.
          </p>
          <DialogFooter>
            <Button
              variant='outline'
              onClick={() => setDeleting(null)}
              disabled={deleteMut.isPending}
            >
              Cancel
            </Button>
            <Button
              variant='destructive'
              onClick={() => deleting && deleteMut.mutate(deleting.id)}
              disabled={deleteMut.isPending}
            >
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
