import { useQuery } from '@tanstack/react-query'
import { Loader2, Pencil, Play, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { api } from '@/lib/api'

interface BulkActionBarProps {
  collection: string
  selectedIds: string[]
  onClear: () => void
  onSuccess: () => void
  hasPipeline?: boolean
  availableTransitions?: Array<{ id: string; label: string; color: string | null }>
}

export function BulkActionBar({
  collection,
  selectedIds,
  onClear,
  onSuccess,
  hasPipeline = false,
  availableTransitions = []
}: BulkActionBarProps) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [showUpdate, setShowUpdate] = useState(false)
  const [showTransition, setShowTransition] = useState(false)
  const [field, setField] = useState('')
  const [value, setValue] = useState('')
  const [transitionId, setTransitionId] = useState('')
  const [busy, setBusy] = useState(false)
  const [runningAction, setRunningAction] = useState<string | null>(null)

  const { data: extActions = [] } = useQuery({
    queryKey: ['ext-bulk-actions', collection],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string; label: string; icon?: string }> }>(
          '/bulk-actions/registered',
          { params: { collection } }
        )
        .then((r) => r.data.data),
    staleTime: 60_000
  })

  const count = selectedIds.length
  const label = `${count} item${count === 1 ? '' : 's'} selected`

  const resetForms = () => {
    setConfirmDelete(false)
    setShowUpdate(false)
    setShowTransition(false)
    setField('')
    setValue('')
    setTransitionId('')
  }

  const handleDelete = async () => {
    setBusy(true)
    try {
      const res = await api.post(`/items/${collection}/bulk-delete`, { ids: selectedIds })
      const deleted = (res.data as { deleted?: number })?.deleted ?? 0
      toast.success(`Deleted ${deleted} item${deleted === 1 ? '' : 's'}`)
      resetForms()
      onSuccess()
      onClear()
    } catch {
      toast.error('Bulk delete failed')
    } finally {
      setBusy(false)
    }
  }

  const handleUpdate = async () => {
    if (!field.trim()) {
      toast.error('Field name is required')
      return
    }
    setBusy(true)
    try {
      const res = await api.post(`/items/${collection}/bulk-update`, {
        ids: selectedIds,
        data: { [field.trim()]: value }
      })
      const updated = (res.data as { updated?: number })?.updated ?? 0
      toast.success(`Updated ${updated} item${updated === 1 ? '' : 's'}`)
      resetForms()
      onSuccess()
      onClear()
    } catch {
      toast.error('Bulk update failed')
    } finally {
      setBusy(false)
    }
  }

  const handleTransition = async () => {
    if (!transitionId) {
      toast.error('Select a transition')
      return
    }
    setBusy(true)
    try {
      const res = await api.post(`/items/${collection}/bulk-transition`, {
        ids: selectedIds,
        transition_id: transitionId
      })
      const { succeeded = 0, failed = 0 } = (res.data ?? {}) as {
        succeeded?: number
        failed?: number
      }
      if (failed > 0) {
        toast.warning(`Transitioned ${succeeded}, ${failed} failed`)
      } else {
        toast.success(`Transitioned ${succeeded} item${succeeded === 1 ? '' : 's'}`)
      }
      resetForms()
      onSuccess()
      onClear()
    } catch {
      toast.error('Bulk transition failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className='fixed bottom-0 left-[220px] right-0 z-30 border-t border-nvr-navy/40 bg-nvr-navy px-6 py-3 text-white shadow-[0_-2px_12px_rgba(0,0,0,0.25)]'>
        <div className='flex items-center gap-3'>
          <button
            type='button'
            onClick={onClear}
            className='rounded p-1 text-white/70 transition-colors hover:bg-white/10 hover:text-white'
            aria-label='Clear selection'
          >
            <X className='h-4 w-4' />
          </button>
          <span className='text-[13px] font-medium text-nvr-cyan'>{label}</span>

          <div className='flex-1' />

          {showUpdate && (
            <div className='flex items-center gap-2'>
              <Input
                className='h-8 w-36 border-white/20 bg-white/10 text-[13px] text-white placeholder:text-white/40'
                placeholder='Field name'
                value={field}
                onChange={(e) => setField(e.target.value)}
              />
              <Input
                className='h-8 w-36 border-white/20 bg-white/10 text-[13px] text-white placeholder:text-white/40'
                placeholder='Value'
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
              <Button
                size='sm'
                className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                onClick={handleUpdate}
                disabled={busy}
              >
                {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Apply'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-white/70 hover:bg-white/10 hover:text-white'
                onClick={() => setShowUpdate(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          )}

          {showTransition && (
            <div className='flex items-center gap-2'>
              <Select value={transitionId} onValueChange={setTransitionId}>
                <SelectTrigger className='h-8 w-48 border-white/20 bg-white/10 text-[13px] text-white'>
                  <SelectValue placeholder='Select transition' />
                </SelectTrigger>
                <SelectContent>
                  {availableTransitions.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size='sm'
                className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
                onClick={handleTransition}
                disabled={busy}
              >
                {busy ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Run'}
              </Button>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-white/70 hover:bg-white/10 hover:text-white'
                onClick={() => setShowTransition(false)}
                disabled={busy}
              >
                Cancel
              </Button>
            </div>
          )}

          {!showUpdate && !showTransition && (
            <div className='flex items-center gap-2'>
              <Button
                size='sm'
                variant='ghost'
                className='h-8 text-white/90 hover:bg-white/10 hover:text-white'
                onClick={() => {
                  resetForms()
                  setShowUpdate(true)
                }}
              >
                <Pencil className='mr-1.5 h-3.5 w-3.5' />
                Update Field
              </Button>
              {hasPipeline && availableTransitions.length > 0 && (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-8 text-white/90 hover:bg-white/10 hover:text-white'
                  onClick={() => {
                    resetForms()
                    setShowTransition(true)
                  }}
                >
                  Transition
                </Button>
              )}
              {extActions.map((action) => (
                <Button
                  key={action.id}
                  size='sm'
                  variant='ghost'
                  className='h-8 text-white/90 hover:bg-white/10 hover:text-white'
                  disabled={busy || runningAction !== null}
                  onClick={async () => {
                    setRunningAction(action.id)
                    try {
                      const res = await api.post<{ data: { message: string } }>(
                        `/bulk-actions/${action.id}/execute`,
                        { collection, ids: selectedIds }
                      )
                      toast.success(res.data.data.message)
                      onSuccess()
                      onClear()
                    } catch {
                      toast.error(`${action.label} failed`)
                    } finally {
                      setRunningAction(null)
                    }
                  }}
                >
                  {runningAction === action.id ? (
                    <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <Play className='mr-1.5 h-3.5 w-3.5' />
                  )}
                  {action.label}
                </Button>
              ))}
              <Button
                size='sm'
                className='h-8 bg-red-600 text-white hover:bg-red-700'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className='mr-1.5 h-3.5 w-3.5' />
                Delete
              </Button>
            </div>
          )}
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={(o) => !busy && setConfirmDelete(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {count} item{count === 1 ? '' : 's'}?
            </DialogTitle>
            <DialogDescription>
              This permanently deletes the selected records. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant='outline' onClick={() => setConfirmDelete(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              className='bg-red-600 text-white hover:bg-red-700'
              onClick={handleDelete}
              disabled={busy}
            >
              {busy ? <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
