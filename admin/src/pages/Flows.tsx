import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Clock,
  Download,
  GitBranch,
  Globe,
  Play,
  Plus,
  Sparkles,
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
  DialogBody,
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
import { cn, formatRelative } from '@/lib/utils'

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

// ─── List row ─────────────────────────────────────────────────────────────────
// Clicking a row opens the flow editor directly — export/delete ride the row
// as hover actions (they used to live on a detail panel behind an extra click).

function FlowRow({
  flow,
  pendingDelete,
  isDeleting,
  onOpen,
  onExport,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete
}: {
  flow: Flow
  pendingDelete: boolean
  isDeleting: boolean
  onOpen: () => void
  onExport: () => void
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}) {
  return (
    <li className='group/row relative'>
      <button
        type='button'
        onClick={onOpen}
        className='w-full px-6 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
      >
        <div className='mb-1 flex items-center gap-2'>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              flow.status === 'active' ? 'bg-emerald-400' : 'bg-slate-300 dark:bg-slate-600'
            )}
          />
          <span className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {flow.name}
          </span>
          <TriggerBadge trigger={flow.trigger} />
        </div>
        <div className='flex items-center gap-2 pl-3.5'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            {flow.operation_count ?? 0} ops
          </span>
          {flow.description && (
            <span className='truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
              · {flow.description}
            </span>
          )}
          {flow.updated_at && (
            <span className='ml-auto shrink-0 pr-24 text-[11px] text-slate-400 dark:text-muted-foreground'>
              {formatRelative(flow.updated_at)}
            </span>
          )}
        </div>
      </button>

      {/* Row actions — hover-revealed, or the inline delete confirm strip */}
      <span
        className='absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1'
        onClick={(e) => e.stopPropagation()}
      >
        {pendingDelete ? (
          <span className='flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1 dark:border-red-900/40 dark:bg-red-900/15'>
            <span className='text-[11px] font-medium text-red-600 dark:text-red-400'>Delete?</span>
            <button
              type='button'
              disabled={isDeleting}
              onClick={onConfirmDelete}
              className='rounded bg-red-600 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-red-700 disabled:opacity-50'
            >
              {isDeleting ? 'Deleting…' : 'Confirm'}
            </button>
            <button
              type='button'
              onClick={onCancelDelete}
              className='rounded px-1.5 py-0.5 text-[11px] font-medium text-red-700 hover:bg-white dark:text-red-300 dark:hover:bg-muted'
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className='hidden items-center gap-0.5 group-hover/row:flex'>
            <button
              type='button'
              title='Export flow'
              onClick={onExport}
              className='rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted'
            >
              <Download className='h-3.5 w-3.5' />
            </button>
            <button
              type='button'
              title='Delete flow'
              onClick={onRequestDelete}
              className='rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20'
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          </span>
        )}
      </span>
    </li>
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
          <DialogBody>
            <div className='space-y-4'>
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
          </DialogBody>

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
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [aiOpen, setAiOpen] = useState(false)
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  async function buildWithAi() {
    if (!aiPrompt.trim()) return
    setAiBusy(true)
    try {
      const r = await api.post<{ data: { id: string } }>('/ai/flow-build', { prompt: aiPrompt })
      toast.success('Draft created (inactive) — review it before activating')
      queryClient.invalidateQueries({ queryKey: ['flows'] })
      navigate(`/flows/${r.data.data.id}`)
    } catch (e) {
      toast.error(
        (e as { response?: { data?: { error?: string } } }).response?.data?.error ?? 'AI build failed'
      )
    } finally {
      setAiBusy(false)
    }
  }
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

  const deleteFlow = useMutation({
    mutationFn: (id: string) => api.delete(`/flows/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['flows'] })
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
            <Button size='sm' variant='outline' className='gap-1.5' onClick={() => setAiOpen((v) => !v)}>
              <Sparkles className='h-3.5 w-3.5' /> Build with AI
            </Button>
            <Button size='sm' onClick={() => setShowCreate(true)}>
              <Plus className='mr-1.5 h-3.5 w-3.5' /> Create Flow
            </Button>
          </div>
        </div>
      </div>

      {aiOpen && (
        <div className='border-b border-slate-200 bg-white px-6 py-3 dark:border-border dark:bg-card'>
          {/* AI flow builder (#447): prose → an INACTIVE drafted flow, opened
              in the editor for review — nothing runs until activated. */}
          <form
            className='flex items-center gap-2'
            onSubmit={(e) => {
              e.preventDefault()
              void buildWithAi()
            }}
          >
            <Input
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder='e.g. "When an invoice is created over $50k, read its workflow and email the internal contact"'
              className='h-9 flex-1 text-[13px]'
              autoFocus
            />
            <Button type='submit' size='sm' disabled={aiBusy || !aiPrompt.trim()}>
              {aiBusy ? 'Drafting…' : 'Draft flow'}
            </Button>
          </form>
          <p className='mt-1 text-[11px] text-slate-400'>
            The draft is created INACTIVE with wired steps — review every operation in the editor
            before activating.
          </p>
        </div>
      )}

      {/* ── Full-width list — rows open the editor directly ───── */}
      <div className='flex flex-1 min-h-0 flex-col overflow-hidden bg-white dark:bg-card'>
        <div className='shrink-0 border-b border-slate-100 px-6 py-3 dark:border-border'>
          <div className='relative max-w-xs'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <Input
              className='h-8 pl-8 text-[13px]'
              placeholder='Filter flows…'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-px p-6'>
              {[1, 2, 3, 4].map((k) => (
                <div key={k} className='rounded-lg py-3'>
                  <Skeleton className='mb-2 h-4 w-1/3' />
                  <Skeleton className='h-3 w-1/4' />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className='flex flex-col items-center justify-center p-12 text-center'>
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
                <FlowRow
                  key={flow.id}
                  flow={flow}
                  pendingDelete={pendingDelete === flow.id}
                  isDeleting={deleteFlow.isPending && pendingDelete === flow.id}
                  onOpen={() => navigate(`/flows/${flow.id}`)}
                  onExport={async () => {
                    try {
                      await exportFlow(flow.id)
                    } catch {
                      toast.error('Export failed')
                    }
                  }}
                  onRequestDelete={() => setPendingDelete(flow.id)}
                  onCancelDelete={() => setPendingDelete(null)}
                  onConfirmDelete={() => deleteFlow.mutate(flow.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <CreateFlowDialog open={showCreate} onOpenChange={setShowCreate} />
    </div>
  )
}
