import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Settings2, Star, Trash2, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ActiveFilter } from '@/components/filter-bar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavedViewState {
  filters: ActiveFilter[]
  sort: string
  columns: string[]
}

interface SavedView {
  id: number
  collection: string
  name: string
  filters: ActiveFilter[] | null
  sort: string | null
  columns: string[] | null
  user: string
  is_shared: boolean
  role: string | null
  created_at: string
}

// ─── Component ────────────────────────────────────────────────────────────────

export function SavedViews({
  collection,
  currentState,
  onApply
}: {
  collection: string
  currentState: SavedViewState
  onApply: (state: SavedViewState) => void
}) {
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<number | null>(null)

  // Save popover state
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [saveShared, setSaveShared] = useState(false)

  // Manage popover state
  const [manageOpen, setManageOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)

  // Reset active view when navigating to another collection
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on collection change
  useEffect(() => {
    setActiveId(null)
    setSaveOpen(false)
    setManageOpen(false)
    setEditingId(null)
    setConfirmDeleteId(null)
  }, [collection])

  const { data: views } = useQuery({
    queryKey: ['saved-views', collection],
    queryFn: () =>
      api
        .get<{ data: SavedView[] }>('/saved-views', { params: { collection } })
        .then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 30_000
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['saved-views', collection] })

  const createMut = useMutation({
    mutationFn: (body: {
      collection: string
      name: string
      filters: ActiveFilter[]
      sort: string
      columns: string[]
      is_shared: boolean
    }) => api.post<{ data: SavedView }>('/saved-views', body).then((r) => r.data.data),
    onSuccess: (view) => {
      invalidate()
      setActiveId(view.id)
      setSaveOpen(false)
      setSaveName('')
      setSaveShared(false)
      toast.success('View saved')
    },
    onError: () => toast.error('Failed to save view')
  })

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.patch(`/saved-views/${id}`, { name }),
    onSuccess: () => {
      invalidate()
      setEditingId(null)
      toast.success('View renamed')
    },
    onError: () => toast.error('Failed to rename view')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/saved-views/${id}`),
    onSuccess: (_d, id) => {
      invalidate()
      if (activeId === id) setActiveId(null)
      setConfirmDeleteId(null)
      toast.success('View deleted')
    },
    onError: () => toast.error('Failed to delete view')
  })

  function applyView(view: SavedView) {
    setActiveId(view.id)
    onApply({
      filters: view.filters ?? [],
      sort: view.sort ?? '',
      columns: view.columns ?? []
    })
  }

  const list = views ?? []

  return (
    <div className='flex flex-wrap items-center gap-1.5'>
      {/* View pills */}
      {list.map((view) => (
        <button
          key={view.id}
          type='button'
          onClick={() => applyView(view)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-[12px] transition-colors',
            activeId === view.id
              ? 'border-nvr-cyan/40 bg-nvr-cyan/10 text-nvr-navy dark:bg-nvr-cyan/15 dark:text-nvr-cyan'
              : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-border dark:bg-background dark:text-slate-300 dark:hover:bg-muted'
          )}
        >
          {view.is_shared && <Users className='h-3 w-3 opacity-60' />}
          {view.name}
        </button>
      ))}

      {/* Save current view */}
      <Popover open={saveOpen} onOpenChange={setSaveOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='ghost'
            size='icon'
            className='h-6 w-6 text-slate-400 hover:text-nvr-cyan'
            title='Save current view'
          >
            <Star className='h-3.5 w-3.5' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[260px] p-3' align='start'>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!saveName.trim()) return
              createMut.mutate({
                collection,
                name: saveName.trim(),
                filters: currentState.filters,
                sort: currentState.sort,
                columns: currentState.columns,
                is_shared: saveShared
              })
            }}
            className='space-y-3'
          >
            <div className='space-y-1.5'>
              <Label htmlFor='sv-name' className='text-[12px]'>
                Save current view
              </Label>
              <Input
                id='sv-name'
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder='View name'
                className='h-8 text-[13px]'
                autoFocus
              />
            </div>
            <div className='flex items-center justify-between'>
              <Label htmlFor='sv-shared' className='text-[12px] text-muted-foreground'>
                Share with everyone
              </Label>
              <Switch id='sv-shared' checked={saveShared} onCheckedChange={setSaveShared} />
            </div>
            <Button
              type='submit'
              size='sm'
              className='h-7 w-full text-[12px]'
              disabled={!saveName.trim() || createMut.isPending}
            >
              {createMut.isPending ? 'Saving…' : 'Save view'}
            </Button>
          </form>
        </PopoverContent>
      </Popover>

      {/* Manage views */}
      {list.length > 0 && (
        <Popover
          open={manageOpen}
          onOpenChange={(o) => {
            setManageOpen(o)
            if (!o) {
              setEditingId(null)
              setConfirmDeleteId(null)
            }
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant='ghost'
              size='icon'
              className='h-6 w-6 text-slate-400 hover:text-slate-600'
              title='Manage views'
            >
              <Settings2 className='h-3.5 w-3.5' />
            </Button>
          </PopoverTrigger>
          <PopoverContent className='w-[280px] p-2' align='start'>
            <p className='px-1 pb-1.5 text-[11px] font-medium text-muted-foreground'>
              Manage views
            </p>
            <div className='space-y-0.5'>
              {list.map((view) => (
                <div
                  key={view.id}
                  className='flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60'
                >
                  {editingId === view.id ? (
                    <form
                      className='flex flex-1 items-center gap-1'
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (!editName.trim()) return
                        renameMut.mutate({ id: view.id, name: editName.trim() })
                      }}
                    >
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className='h-6 flex-1 text-[12px]'
                        autoFocus
                      />
                      <Button
                        type='submit'
                        variant='ghost'
                        size='icon'
                        className='h-6 w-6 text-emerald-600'
                        disabled={!editName.trim() || renameMut.isPending}
                      >
                        <Check className='h-3 w-3' />
                      </Button>
                    </form>
                  ) : (
                    <>
                      <span className='flex-1 truncate text-[12px]'>
                        {view.name}
                        {view.is_shared && (
                          <Users className='ml-1 inline h-3 w-3 text-muted-foreground' />
                        )}
                      </span>
                      <Button
                        variant='ghost'
                        size='icon'
                        className='h-6 w-6 text-slate-400 hover:text-slate-600'
                        onClick={() => {
                          setEditingId(view.id)
                          setEditName(view.name)
                          setConfirmDeleteId(null)
                        }}
                      >
                        <Pencil className='h-3 w-3' />
                      </Button>
                      {confirmDeleteId === view.id ? (
                        <Button
                          variant='ghost'
                          size='sm'
                          className='h-6 px-1.5 text-[11px] text-destructive hover:text-destructive'
                          onClick={() => deleteMut.mutate(view.id)}
                          disabled={deleteMut.isPending}
                        >
                          Confirm
                        </Button>
                      ) : (
                        <Button
                          variant='ghost'
                          size='icon'
                          className='h-6 w-6 text-slate-400 hover:text-destructive'
                          onClick={() => {
                            setConfirmDeleteId(view.id)
                            setEditingId(null)
                          }}
                        >
                          <Trash2 className='h-3 w-3' />
                        </Button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
