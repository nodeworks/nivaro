import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'

// ─── Types ───────────────────────────────────────────────────────────────────

interface FieldWatch {
  id: number
  name: string
  collection: string
  field: string
  is_active: boolean
  subscriber_count: number
  is_subscribed: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

// ─── Watch Form ───────────────────────────────────────────────────────────────

interface WatchFormProps {
  initial?: Partial<FieldWatch>
  onSave: (data: { name: string; collection: string; field: string; is_active: boolean }) => void
  onCancel: () => void
  saving: boolean
}

function WatchForm({ initial, onSave, onCancel, saving }: WatchFormProps) {
  const [name, setName] = useState(initial?.name ?? '')
  const [collection, setCollection] = useState(initial?.collection ?? '')
  const [field, setField] = useState(initial?.field ?? '')
  const [isActive, setIsActive] = useState(initial?.is_active ?? true)

  const valid = name.trim() !== '' && collection.trim() !== '' && field.trim() !== ''

  return (
    <div className='space-y-4 px-6 pb-6'>
      <div className='space-y-1.5'>
        <Label htmlFor='fw-name'>Name</Label>
        <Input
          id='fw-name'
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='Budget Status Changes'
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='fw-collection'>Collection</Label>
        <Input
          id='fw-collection'
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          placeholder='articles'
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='fw-field'>Field</Label>
        <Input
          id='fw-field'
          value={field}
          onChange={(e) => setField(e.target.value)}
          placeholder='status'
        />
      </div>
      <div className='flex items-center gap-3'>
        <Switch id='fw-active' checked={isActive} onCheckedChange={setIsActive} />
        <Label htmlFor='fw-active'>Active</Label>
      </div>
      <DialogFooter>
        <Button variant='outline' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button
          onClick={() => onSave({ name, collection, field, is_active: isActive })}
          disabled={saving || !valid}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogFooter>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function FieldWatchesPage() {
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false
  const qc = useQueryClient()

  const { data: watchesData, isLoading } = useQuery({
    queryKey: ['field-watches'],
    queryFn: () => api.get<{ data: FieldWatch[] }>('/field-watches').then((r) => r.data.data)
  })
  const watches = watchesData ?? []

  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<FieldWatch | null>(null)
  const [deleting, setDeleting] = useState<FieldWatch | null>(null)

  // ── Create ────────────────────────────────────────────────────────────────
  const createMut = useMutation({
    mutationFn: (body: { name: string; collection: string; field: string; is_active: boolean }) =>
      api.post('/field-watches', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-watches'] })
      setCreateOpen(false)
      toast.success('Watch created')
    },
    onError: () => toast.error('Failed to create watch')
  })

  // ── Update ────────────────────────────────────────────────────────────────
  const updateMut = useMutation({
    mutationFn: ({
      id,
      body
    }: {
      id: number
      body: { name: string; collection: string; field: string; is_active: boolean }
    }) => api.patch(`/field-watches/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-watches'] })
      setEditing(null)
      toast.success('Watch updated')
    },
    onError: () => toast.error('Failed to update watch')
  })

  // ── Toggle active inline ──────────────────────────────────────────────────
  const toggleMut = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      api.patch(`/field-watches/${id}`, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-watches'] })
    },
    onError: () => toast.error('Failed to update watch')
  })

  // ── Delete ────────────────────────────────────────────────────────────────
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/field-watches/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['field-watches'] })
      setDeleting(null)
      toast.success('Watch deleted')
    },
    onError: () => toast.error('Failed to delete watch')
  })

  // ── Subscribe / Unsubscribe ───────────────────────────────────────────────
  const subscribeMut = useMutation({
    mutationFn: ({ id, subscribed }: { id: number; subscribed: boolean }) =>
      subscribed
        ? api.delete(`/field-watches/${id}/subscribe`)
        : api.post(`/field-watches/${id}/subscribe`, {}),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['field-watches'] })
      toast.success(vars.subscribed ? 'Unsubscribed' : 'Subscribed')
    },
    onError: () => toast.error('Failed to update subscription')
  })

  return (
    <div className='flex flex-col h-full'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-border px-6 py-4 shrink-0'>
        <div>
          <h1 className='text-lg font-semibold'>Field Watches</h1>
          <p className='text-sm text-muted-foreground'>
            Get notified when specific fields change on any record
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className='h-4 w-4 mr-1.5' />
            New Watch
          </Button>
        )}
      </div>

      {/* Body */}
      <div className='flex-1 overflow-auto p-6'>
        {isLoading ? (
          <div className='space-y-3'>
            {[1, 2, 3].map((i) => (
              <div key={i} className='h-16 rounded-lg bg-muted animate-pulse' />
            ))}
          </div>
        ) : watches.length === 0 ? (
          <div className='flex flex-col items-center justify-center py-24 text-center'>
            <Bell className='h-10 w-10 text-muted-foreground mb-3' />
            <p className='text-sm font-medium'>No field watches</p>
            <p className='text-sm text-muted-foreground mt-1'>
              {isAdmin
                ? 'Create a watch to get notified when a field changes.'
                : 'You have no active field watch subscriptions.'}
            </p>
          </div>
        ) : (
          <div className='rounded-lg border border-border overflow-hidden'>
            <table className='w-full text-sm'>
              <thead className='bg-muted/50 border-b border-border'>
                <tr>
                  <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>Name</th>
                  <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>
                    Collection
                  </th>
                  <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>Field</th>
                  {isAdmin && (
                    <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>
                      Active
                    </th>
                  )}
                  {isAdmin && (
                    <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>
                      Subscribers
                    </th>
                  )}
                  <th className='text-left px-4 py-2.5 font-medium text-muted-foreground'>
                    Subscription
                  </th>
                  {isAdmin && (
                    <th className='text-right px-4 py-2.5 font-medium text-muted-foreground'>
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className='divide-y divide-border'>
                {watches.map((watch) => (
                  <tr key={watch.id} className='bg-card hover:bg-muted/30 transition-colors'>
                    <td className='px-4 py-3 font-medium'>{watch.name}</td>
                    <td className='px-4 py-3'>
                      <code className='text-xs bg-muted px-1.5 py-0.5 rounded'>
                        {watch.collection}
                      </code>
                    </td>
                    <td className='px-4 py-3'>
                      <code className='text-xs bg-muted px-1.5 py-0.5 rounded'>{watch.field}</code>
                    </td>
                    {isAdmin && (
                      <td className='px-4 py-3'>
                        <Switch
                          checked={watch.is_active}
                          onCheckedChange={(v) => toggleMut.mutate({ id: watch.id, is_active: v })}
                          disabled={toggleMut.isPending}
                        />
                      </td>
                    )}
                    {isAdmin && (
                      <td className='px-4 py-3 text-muted-foreground'>{watch.subscriber_count}</td>
                    )}
                    <td className='px-4 py-3'>
                      {watch.is_subscribed ? (
                        <div className='flex items-center gap-2'>
                          <Badge className='bg-green-500/10 text-green-700 dark:text-green-400 dark:bg-green-500/15 border-0'>
                            Subscribed
                          </Badge>
                          <Button
                            variant='ghost'
                            size='sm'
                            className='h-7 text-xs text-muted-foreground'
                            onClick={() => subscribeMut.mutate({ id: watch.id, subscribed: true })}
                            disabled={subscribeMut.isPending}
                          >
                            Unsubscribe
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant='outline'
                          size='sm'
                          className='h-7 text-xs'
                          onClick={() => subscribeMut.mutate({ id: watch.id, subscribed: false })}
                          disabled={subscribeMut.isPending}
                        >
                          Subscribe
                        </Button>
                      )}
                    </td>
                    {isAdmin && (
                      <td className='px-4 py-3'>
                        <div className='flex items-center justify-end gap-1'>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8'
                            onClick={() => setEditing(watch)}
                          >
                            <Pencil className='h-3.5 w-3.5' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='icon'
                            className='h-8 w-8 text-destructive hover:text-destructive'
                            onClick={() => setDeleting(watch)}
                          >
                            <Trash2 className='h-3.5 w-3.5' />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Field Watch</DialogTitle>
          </DialogHeader>
          <WatchForm
            onSave={(body) => createMut.mutate(body)}
            onCancel={() => setCreateOpen(false)}
            saving={createMut.isPending}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editing}
        onOpenChange={(o) => {
          if (!o) setEditing(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Field Watch</DialogTitle>
          </DialogHeader>
          {editing && (
            <WatchForm
              initial={editing}
              onSave={(body) => updateMut.mutate({ id: editing.id, body })}
              onCancel={() => setEditing(null)}
              saving={updateMut.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog
        open={!!deleting}
        onOpenChange={(o) => {
          if (!o) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Field Watch</DialogTitle>
          </DialogHeader>
          <p className='text-sm text-muted-foreground px-6'>
            Are you sure you want to delete{' '}
            <span className='font-medium text-foreground'>{deleting?.name}</span>? All subscriptions
            will also be removed. This cannot be undone.
          </p>
          <DialogFooter className='px-6 pb-4'>
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
