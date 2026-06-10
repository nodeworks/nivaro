import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Clock,
  Download,
  GitBranch,
  Globe,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  Workflow,
  Zap
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, exportFlow, importFlow } from '@/lib/api'
import { cn, formatDate, formatRelative } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

type Flow = {
  id: string
  name: string
  description: string | null
  status: 'active' | 'inactive'
  trigger: 'schedule' | 'event' | 'manual' | 'webhook'
  operation_count: number
  updated_at: string
  next_run?: string | null
}

// ─── Trigger config ───────────────────────────────────────────────────────────

const TRIGGER_CONFIG: Record<string, { label: string; badgeCls: string; icon: React.ElementType }> =
  {
    schedule: {
      label: 'Schedule',
      badgeCls:
        'bg-[#00ceff]/10 text-[#0097c0] border-[#00ceff]/30 dark:bg-[#00ceff]/[0.08] dark:text-[#00ceff] dark:border-[#00ceff]/20',
      icon: Clock
    },
    event: {
      label: 'Event',
      badgeCls:
        'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/20 dark:text-violet-400 dark:border-violet-800',
      icon: Zap
    },
    manual: {
      label: 'Manual',
      badgeCls:
        'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/20 dark:text-orange-400 dark:border-orange-800',
      icon: Play
    },
    webhook: {
      label: 'Webhook',
      badgeCls:
        'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800',
      icon: Globe
    }
  }

function TriggerBadge({ trigger }: { trigger: string }) {
  const cfg = TRIGGER_CONFIG[trigger] ?? {
    label: trigger,
    badgeCls: 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400',
    icon: GitBranch
  }
  const Icon = cfg.icon as React.ElementType
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold',
        cfg.badgeCls
      )}
    >
      <Icon className='h-2.5 w-2.5' />
      {cfg.label}
    </span>
  )
}

// ─── List item ────────────────────────────────────────────────────────────────

function FlowListItem({
  flow,
  selected,
  onClick
}: {
  flow: Flow
  selected: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onClick}
        className={cn(
          'w-full px-4 py-3 text-left transition-colors',
          selected
            ? 'bg-[#00ceff]/10 dark:bg-[#00ceff]/[0.07]'
            : 'hover:bg-slate-50 dark:hover:bg-muted/50'
        )}
      >
        <div className='mb-1.5 flex items-center gap-2'>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              flow.status === 'active' ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600'
            )}
          />
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected
                ? 'text-slate-900 dark:text-foreground'
                : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {flow.name}
          </span>
        </div>
        <div className='flex items-center gap-2 pl-3.5'>
          <TriggerBadge trigger={flow.trigger} />
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            {flow.operation_count ?? 0} ops
          </span>
          {flow.updated_at && (
            <span className='ml-auto text-[11px] text-slate-400 dark:text-muted-foreground'>
              {formatRelative(flow.updated_at)}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// ─── No-selection state ───────────────────────────────────────────────────────

function NoFlowSelected() {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <GitBranch className='h-5 w-5 text-slate-400' />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
        Select a flow
      </p>
      <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
        Choose a flow from the list to view details and actions
      </p>
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function FlowDetail({
  flow,
  pendingDelete,
  onEdit,
  onExport,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  isDeleting
}: {
  flow: Flow
  pendingDelete: boolean
  onEdit: () => void
  onExport: () => void
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  isDeleting: boolean
}) {
  const metaItems: { label: string; value: React.ReactNode }[] = [
    {
      label: 'Trigger',
      value: <TriggerBadge trigger={flow.trigger} />
    },
    {
      label: 'Operations',
      value: (
        <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
          {flow.operation_count ?? 0}
          <span className='ml-1 text-[12px] font-normal text-slate-400 dark:text-muted-foreground'>
            steps
          </span>
        </span>
      )
    },
    {
      label: 'Last updated',
      value: (
        <span className='text-[13px] text-slate-700 dark:text-foreground'>
          {flow.updated_at ? formatDate(flow.updated_at) : '—'}
        </span>
      )
    },
    flow.next_run
      ? {
          label: 'Next run',
          value: (
            <span className='font-mono text-[12px] text-slate-700 dark:text-foreground'>
              {formatDate(flow.next_run)}
            </span>
          )
        }
      : {
          label: 'Flow ID',
          value: (
            <code className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {flow.id.slice(0, 20)}…
            </code>
          )
        }
  ]

  return (
    <div className='p-8'>
      <div className='max-w-xl'>
        {/* ── Title block ─────────────────────────────────────────── */}
        <div className='mb-7'>
          <div className='mb-2 flex items-center gap-2'>
            <TriggerBadge trigger={flow.trigger} />
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                flow.status === 'active'
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  flow.status === 'active' ? 'bg-emerald-500' : 'bg-slate-400'
                )}
              />
              {flow.status === 'active' ? 'Active' : 'Inactive'}
            </span>
          </div>
          <h2 className='text-[20px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            {flow.name}
          </h2>
          {flow.description && (
            <p className='mt-1.5 text-[13px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              {flow.description}
            </p>
          )}
        </div>

        {/* ── Meta grid ───────────────────────────────────────────── */}
        <div className='mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
          {metaItems.map(({ label, value }) => (
            <div key={label} className='bg-white px-4 py-3.5 dark:bg-card'>
              <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
                {label}
              </p>
              {value}
            </div>
          ))}
        </div>

        {/* ── Actions ─────────────────────────────────────────────── */}
        <div className='flex items-center gap-2'>
          <Button onClick={onEdit}>Edit flow</Button>
          <Button variant='outline' onClick={onExport}>
            <Download className='mr-1.5 h-3.5 w-3.5' /> Export
          </Button>
          <div className='ml-auto'>
            {pendingDelete ? (
              <div className='flex items-center gap-1.5'>
                <Button
                  variant='destructive'
                  size='sm'
                  onClick={onConfirmDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? 'Deleting…' : 'Confirm delete'}
                </Button>
                <Button variant='ghost' size='sm' onClick={onCancelDelete}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant='ghost'
                size='sm'
                className='text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                onClick={onRequestDelete}
              >
                <Trash2 className='mr-1.5 h-3.5 w-3.5' /> Delete flow
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Create dialog ────────────────────────────────────────────────────────────

type CreateFlowForm = {
  name: string
  trigger: string
  status: string
  description: string
}

function CreateFlowDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<CreateFlowForm>({
    name: '',
    trigger: 'manual',
    status: 'active',
    description: ''
  })

  const createFlow = useMutation({
    mutationFn: (body: CreateFlowForm) => api.post('/flows', body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      onOpenChange(false)
      setForm({ name: '', trigger: 'manual', status: 'active', description: '' })
      toast.success('Flow created')
    },
    onError: () => toast.error('Failed to create flow')
  })

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    createFlow.mutate(form)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Flow</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className='space-y-4 px-6 pb-6'>
            <div className='space-y-1.5'>
              <Label htmlFor='flow-name'>
                Name <span className='text-red-500'>*</span>
              </Label>
              <Input
                id='flow-name'
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder='e.g. Send welcome email'
                required
              />
            </div>

            <div className='grid grid-cols-2 gap-3'>
              <div className='space-y-1.5'>
                <Label htmlFor='flow-trigger'>Trigger</Label>
                <Select
                  value={form.trigger}
                  onValueChange={(v) => setForm((p) => ({ ...p, trigger: v }))}
                >
                  <SelectTrigger id='flow-trigger'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='manual'>Manual</SelectItem>
                    <SelectItem value='schedule'>Schedule</SelectItem>
                    <SelectItem value='event'>Event</SelectItem>
                    <SelectItem value='webhook'>Webhook</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='flow-status'>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}
                >
                  <SelectTrigger id='flow-status'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='active'>Active</SelectItem>
                    <SelectItem value='inactive'>Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className='space-y-1.5'>
              <Label htmlFor='flow-description'>Description</Label>
              <Textarea
                id='flow-description'
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                placeholder='What does this flow do?'
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type='submit' disabled={createFlow.isPending || !form.name.trim()}>
              {createFlow.isPending ? 'Creating…' : 'Create Flow'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function FlowsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const importInputRef = useRef<HTMLInputElement>(null)

  async function handleImportFlow(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const result = await importFlow(file)
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      toast.success(`Imported: ${result.name}`)
      navigate(`/flows/${result.id}`)
    } catch {
      toast.error('Import failed — check the file format')
    }
  }

  const { data, isLoading } = useQuery({
    queryKey: ['flows'],
    queryFn: () => api.get('/flows').then((r) => r.data)
  })

  const flows: Flow[] = data?.data ?? []
  const filtered = search.trim()
    ? flows.filter(
        (f) =>
          f.name.toLowerCase().includes(search.toLowerCase()) ||
          (f.description ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : flows

  const selectedFlow = flows.find((f) => f.id === selectedId) ?? null

  const deleteFlow = useMutation({
    mutationFn: (id: string) => api.delete(`/flows/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      if (selectedId === pendingDelete) setSelectedId(null)
      setPendingDelete(null)
      toast.success('Flow deleted')
    },
    onError: () => toast.error('Failed to delete flow')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* ── Page header ───────────────────────────────────────── */}
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Flows
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {flows.length}
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <input
              ref={importInputRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={handleImportFlow}
            />
            <Button size='sm' variant='outline' onClick={() => importInputRef.current?.click()}>
              <Upload className='mr-1.5 h-3.5 w-3.5' /> Import
            </Button>
            <Button size='sm' onClick={() => setShowCreate(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create Flow
            </Button>
          </div>
        </div>
      </div>

      {/* ── Master-detail body ────────────────────────────────── */}
      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* ── Left: list panel ───────────────────────────────── */}
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {/* Search bar */}
          <div className='shrink-0 border-b border-slate-100 p-3 dark:border-border'>
            <div className='relative'>
              <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <Input
                className='h-8 pl-8 text-[13px]'
                placeholder='Filter flows…'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {/* Flow list */}
          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='space-y-px p-3'>
                {[1, 2, 3, 4].map((k) => (
                  <div key={k} className='rounded-lg p-3'>
                    <Skeleton className='mb-2 h-4 w-3/4' />
                    <Skeleton className='h-3 w-1/2' />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className='flex flex-col items-center justify-center p-8 text-center'>
                <Workflow className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
                <p className='text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
                  {search ? 'No matching flows' : 'No flows yet'}
                </p>
                {!search && (
                  <button
                    type='button'
                    onClick={() => setShowCreate(true)}
                    className='mt-2 text-[11px] text-[#00ceff] hover:underline'
                  >
                    Create your first flow
                  </button>
                )}
              </div>
            ) : (
              <ul className='divide-y divide-slate-100 dark:divide-border'>
                {filtered.map((flow) => (
                  <FlowListItem
                    key={flow.id}
                    flow={flow}
                    selected={selectedId === flow.id}
                    onClick={() => {
                      setSelectedId(flow.id)
                      setPendingDelete(null)
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* ── Right: detail panel ────────────────────────────── */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {selectedFlow ? (
            <FlowDetail
              flow={selectedFlow}
              pendingDelete={pendingDelete === selectedFlow.id}
              onEdit={() => navigate(`/flows/${selectedFlow.id}`)}
              onExport={async () => {
                try {
                  await exportFlow(selectedFlow.id)
                } catch {
                  toast.error('Export failed')
                }
              }}
              onRequestDelete={() => setPendingDelete(selectedFlow.id)}
              onCancelDelete={() => setPendingDelete(null)}
              onConfirmDelete={() => deleteFlow.mutate(selectedFlow.id)}
              isDeleting={deleteFlow.isPending}
            />
          ) : (
            <NoFlowSelected />
          )}
        </div>
      </div>

      <CreateFlowDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  )
}
