import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, GitBranch, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, exportPipeline, importPipeline, type PipelineTemplate } from '@/lib/api'
import { formatRelative } from '@/lib/utils'

// ─── List row ─────────────────────────────────────────────────────────────────
// Clicking a row opens the editor directly — export/delete ride the row as
// hover actions (they used to live on a detail panel behind an extra click).

function PipelineRow({
  template,
  onOpen,
  onExport,
  onRequestDelete
}: {
  template: PipelineTemplate
  onOpen: () => void
  onExport: () => void
  onRequestDelete: () => void
}) {
  const collections = template.collections ?? []
  return (
    <li className='group/row relative'>
      <button
        type='button'
        onClick={onOpen}
        className='w-full px-6 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-muted/50'
      >
        <div className='mb-1 flex items-center gap-2'>
          <span
            className='h-1.5 w-1.5 shrink-0 rounded-full'
            style={{ backgroundColor: template.color || '#cbd5e1' }}
          />
          <span className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {template.name}
          </span>
        </div>
        <div className='flex items-center gap-2 pl-3.5'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            {template.state_count ?? 0} states
          </span>
          {collections.length > 0 && (
            <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              · {collections.length} collection{collections.length !== 1 ? 's' : ''}
            </span>
          )}
          {template.description && (
            <span className='truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
              · {template.description}
            </span>
          )}
          {template.updated_at && (
            <span className='ml-auto shrink-0 pr-24 text-[11px] text-slate-400 dark:text-muted-foreground'>
              {formatRelative(template.updated_at)}
            </span>
          )}
        </div>
      </button>

      {/* Row actions — hover-revealed, or the inline delete confirm strip */}
      <span
        className='absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1'
        onClick={(e) => e.stopPropagation()}
      >
        <span className='hidden items-center gap-0.5 group-hover/row:flex'>
          <button
            type='button'
            title='Export pipeline'
            onClick={onExport}
            className='rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-muted'
          >
            <Download className='h-3.5 w-3.5' />
          </button>
          <button
            type='button'
            title='Delete pipeline'
            onClick={onRequestDelete}
            className='rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20'
          >
            <Trash2 className='h-3.5 w-3.5' />
          </button>
        </span>
      </span>
    </li>
  )
}

// ─── Delete confirm dialog ────────────────────────────────────────────────────
// Deleting a pipeline cascades: instances, history, owner groups, SLA rules,
// states, routes and bindings all go with it. This dialog shows exactly what
// before the destructive click — never a browser confirm().

interface DeleteImpact {
  name: string
  open_instances: number
  completed_instances: number
  history: number
  states: number
  transitions: number
  bindings: number
  owner_groups: number
  sla_rules: number
}

function ImpactRow({ label, value }: { label: string; value: number }) {
  if (!value) return null
  return (
    <div className='flex items-center justify-between py-1'>
      <span className='text-[12px] text-slate-600 dark:text-slate-300'>{label}</span>
      <span className='text-[12px] font-semibold tabular-nums text-slate-900 dark:text-foreground'>
        {value.toLocaleString()}
      </span>
    </div>
  )
}

function DeletePipelineDialog({
  templateId,
  templateName,
  isDeleting,
  onConfirm,
  onCancel
}: {
  templateId: string
  templateName: string
  isDeleting: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { data: impact, isLoading } = useQuery<DeleteImpact>({
    queryKey: ['pipeline-delete-impact', templateId],
    queryFn: () =>
      api
        .get<{ data: DeleteImpact }>(`/pipelines/${templateId}/delete-impact`)
        .then((r) => r.data.data)
  })
  const totalRecords = (impact?.open_instances ?? 0) + (impact?.completed_instances ?? 0)
  return (
    <div
      className='fixed inset-0 z-[130] flex items-center justify-center bg-black/40 p-4'
      onClick={onCancel}
    >
      <div
        className='w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-border dark:bg-card'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='mb-1 flex items-center gap-2'>
          <Trash2 className='h-4 w-4 text-red-500' />
          <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
            Delete “{templateName}”?
          </h2>
        </div>
        <p className='mb-3 text-[12px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
          This permanently removes the pipeline and everything attached to it. It cannot be undone.
        </p>
        {isLoading ? (
          <div className='mb-3 space-y-2'>
            <Skeleton className='h-3 w-2/3' />
            <Skeleton className='h-3 w-1/2' />
          </div>
        ) : impact ? (
          <div className='mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900/40 dark:bg-red-900/15'>
            {totalRecords > 0 && (
              <p className='mb-1.5 text-[12px] font-medium text-red-700 dark:text-red-300'>
                {totalRecords.toLocaleString()} record{totalRecords === 1 ? '' : 's'} lose their
                workflow — {impact.open_instances.toLocaleString()} still in progress.
              </p>
            )}
            <div className='divide-y divide-red-200/60 dark:divide-red-900/30'>
              <ImpactRow label='Records in progress' value={impact.open_instances} />
              <ImpactRow label='Completed records' value={impact.completed_instances} />
              <ImpactRow label='History entries' value={impact.history} />
              <ImpactRow label='States' value={impact.states} />
              <ImpactRow label='Routes' value={impact.transitions} />
              <ImpactRow label='Collection bindings' value={impact.bindings} />
              <ImpactRow label='Owner groups' value={impact.owner_groups} />
              <ImpactRow label='SLA rules' value={impact.sla_rules} />
            </div>
          </div>
        ) : null}
        <div className='flex justify-end gap-2'>
          <Button size='sm' variant='outline' onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            size='sm'
            variant='destructive'
            onClick={onConfirm}
            disabled={isDeleting || isLoading}
          >
            {isDeleting ? 'Deleting…' : 'Delete everything'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PipelinesPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const importInputRef = useRef<HTMLInputElement>(null)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  async function handleImportPipeline(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      const result = await importPipeline(file)
      queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
      toast.success(`Imported: ${result.name}`)
      navigate(`/pipelines/${result.id}`)
    } catch {
      toast.error('Import failed — check the file format')
    }
  }

  const { data, isLoading } = useQuery<PipelineTemplate[]>({
    queryKey: ['pipeline-templates'],
    queryFn: () => api.get<{ data: PipelineTemplate[] }>('/pipelines').then((r) => r.data.data)
  })

  const templates = data ?? []
  const filtered = search.trim()
    ? templates.filter(
        (t) =>
          t.name.toLowerCase().includes(search.toLowerCase()) ||
          (t.description ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : templates

  const createTemplate = useMutation({
    mutationFn: (name: string) =>
      api.post<{ data: PipelineTemplate }>('/pipelines', { name }).then((r) => r.data.data),
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
      navigate(`/pipelines/${t.id}`)
    },
    onError: () => toast.error('Failed to create pipeline')
  })

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.delete(`/pipelines/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pipeline-templates'] })
      setPendingDelete(null)
      toast.success('Pipeline deleted')
    },
    onError: (err) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg || 'Failed to delete pipeline', { duration: 9000 })
    }
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Pipelines
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {templates.length}
              </span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            <input
              ref={importInputRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={handleImportPipeline}
            />
            <Button size='sm' variant='outline' onClick={() => importInputRef.current?.click()}>
              <Upload className='mr-1.5 h-3.5 w-3.5' /> Import
            </Button>
            <Button
              size='sm'
              disabled={createTemplate.isPending}
              onClick={() => createTemplate.mutate(`New Pipeline ${templates.length + 1}`)}
            >
              <Plus className='mr-1.5 h-3.5 w-3.5' /> New Pipeline
            </Button>
          </div>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 flex-col overflow-hidden bg-white dark:bg-card'>
        <div className='shrink-0 border-b border-slate-100 px-6 py-3 dark:border-border'>
          <div className='relative max-w-xs'>
            <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <Input
              className='h-8 pl-8 text-[13px]'
              placeholder='Filter pipelines…'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className='flex-1 overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-px p-6'>
              {[1, 2, 3].map((k) => (
                <div key={k} className='rounded-lg py-3'>
                  <Skeleton className='mb-2 h-4 w-1/3' />
                  <Skeleton className='h-3 w-1/4' />
                </div>
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <div className='flex flex-col items-center justify-center p-12 text-center'>
              <GitBranch className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
              <p className='text-[12px] font-medium text-slate-500 dark:text-muted-foreground'>
                {search ? 'No matching pipelines' : 'No pipelines yet'}
              </p>
              {!search && (
                <button
                  type='button'
                  onClick={() => createTemplate.mutate('Pipeline 1')}
                  className='mt-2 text-[11px] text-[#00ceff] hover:underline'
                >
                  Create your first pipeline
                </button>
              )}
            </div>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border'>
              {filtered.map((t) => (
                <PipelineRow
                  key={t.id}
                  template={t}
                  onOpen={() => navigate(`/pipelines/${t.id}`)}
                  onExport={async () => {
                    try {
                      await exportPipeline(t.id)
                    } catch {
                      toast.error('Export failed')
                    }
                  }}
                  onRequestDelete={() => setPendingDelete(t.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {pendingDelete &&
        (() => {
          const t = templates.find((x) => x.id === pendingDelete)
          return t ? (
            <DeletePipelineDialog
              templateId={t.id}
              templateName={t.name}
              isDeleting={deleteTemplate.isPending}
              onConfirm={() => deleteTemplate.mutate(t.id)}
              onCancel={() => setPendingDelete(null)}
            />
          ) : null
        })()}
    </div>
  )
}
