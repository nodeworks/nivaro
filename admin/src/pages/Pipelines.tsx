import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, GitBranch, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, exportPipeline, importPipeline, type PipelineTemplate } from '@/lib/api'
import { cn, formatDate, formatRelative } from '@/lib/utils'

// ─── List item ────────────────────────────────────────────────────────────────

function PipelineListItem({
  template,
  selected,
  onClick
}: {
  template: PipelineTemplate
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
          {template.color ? (
            <span
              className='h-1.5 w-1.5 shrink-0 rounded-full'
              style={{ backgroundColor: template.color }}
            />
          ) : (
            <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300 dark:bg-slate-600' />
          )}
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected
                ? 'text-slate-900 dark:text-foreground'
                : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {template.name}
          </span>
        </div>
        <div className='flex items-center gap-2 pl-3.5'>
          <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            {template.state_count ?? 0} states
          </span>
          {(template.collections ?? []).length > 0 && (
            <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>
              · {(template.collections ?? []).length} collection
              {(template.collections ?? []).length !== 1 ? 's' : ''}
            </span>
          )}
          {template.updated_at && (
            <span className='ml-auto text-[11px] text-slate-400 dark:text-muted-foreground'>
              {formatRelative(template.updated_at)}
            </span>
          )}
        </div>
      </button>
    </li>
  )
}

// ─── No-selection state ───────────────────────────────────────────────────────

function NoPipelineSelected() {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <GitBranch className='h-5 w-5 text-slate-400' />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
        Select a pipeline
      </p>
      <p className='mt-0.5 text-[12px] text-slate-400 dark:text-muted-foreground'>
        Choose a pipeline to view details and open the editor
      </p>
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function PipelineDetail({
  template,
  pendingDelete,
  onEdit,
  onExport,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
  isDeleting
}: {
  template: PipelineTemplate
  pendingDelete: boolean
  onEdit: () => void
  onExport: () => void
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
  isDeleting: boolean
}) {
  const collections = template.collections ?? []

  return (
    <div className='p-8'>
      <div className='max-w-xl'>
        <div className='mb-7'>
          {template.color && (
            <div className='mb-2'>
              <span
                className='inline-block h-3 w-3 rounded-full'
                style={{ backgroundColor: template.color }}
              />
            </div>
          )}
          <h2 className='text-[20px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
            {template.name}
          </h2>
          {template.description && (
            <p className='mt-1.5 text-[13px] leading-relaxed text-slate-500 dark:text-muted-foreground'>
              {template.description}
            </p>
          )}
        </div>

        <div className='mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
          <div className='bg-white px-4 py-3.5 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              States
            </p>
            <span className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
              {template.state_count ?? 0}
            </span>
          </div>
          <div className='bg-white px-4 py-3.5 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Collections
            </p>
            {collections.length === 0 ? (
              <span className='text-[13px] text-slate-400 dark:text-muted-foreground'>
                None bound
              </span>
            ) : (
              <div className='flex flex-wrap gap-1'>
                {collections.slice(0, 3).map((c) => (
                  <span
                    key={c}
                    className='font-mono text-[11px] text-slate-600 dark:text-slate-400'
                  >
                    {c}
                  </span>
                ))}
                {collections.length > 3 && (
                  <span className='text-[11px] text-slate-400'>+{collections.length - 3}</span>
                )}
              </div>
            )}
          </div>
          <div className='bg-white px-4 py-3.5 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Last updated
            </p>
            <span className='text-[13px] text-slate-700 dark:text-foreground'>
              {template.updated_at ? formatDate(template.updated_at) : '—'}
            </span>
          </div>
          <div className='bg-white px-4 py-3.5 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Pipeline ID
            </p>
            <code className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {template.id.slice(0, 20)}…
            </code>
          </div>
        </div>

        <div className='flex items-center gap-2'>
          <Button onClick={onEdit}>Open editor</Button>
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
                <Trash2 className='mr-1.5 h-3.5 w-3.5' /> Delete
              </Button>
            )}
          </div>
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
  const [selectedId, setSelectedId] = useState<string | null>(null)
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

  const selectedTemplate = templates.find((t) => t.id === selectedId) ?? null

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
      if (selectedId === pendingDelete) setSelectedId(null)
      setPendingDelete(null)
      toast.success('Pipeline deleted')
    },
    onError: () => toast.error('Failed to delete pipeline')
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

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='shrink-0 border-b border-slate-100 p-3 dark:border-border'>
            <div className='relative'>
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
              <div className='space-y-px p-3'>
                {[1, 2, 3].map((k) => (
                  <div key={k} className='rounded-lg p-3'>
                    <Skeleton className='mb-2 h-4 w-3/4' />
                    <Skeleton className='h-3 w-1/2' />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className='flex flex-col items-center justify-center p-8 text-center'>
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
                  <PipelineListItem
                    key={t.id}
                    template={t}
                    selected={selectedId === t.id}
                    onClick={() => {
                      setSelectedId(t.id)
                      setPendingDelete(null)
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {selectedTemplate ? (
            <PipelineDetail
              template={selectedTemplate}
              pendingDelete={pendingDelete === selectedTemplate.id}
              onEdit={() => navigate(`/pipelines/${selectedTemplate.id}`)}
              onExport={async () => {
                try {
                  await exportPipeline(selectedTemplate.id)
                } catch {
                  toast.error('Export failed')
                }
              }}
              onRequestDelete={() => setPendingDelete(selectedTemplate.id)}
              onCancelDelete={() => setPendingDelete(null)}
              onConfirmDelete={() => deleteTemplate.mutate(selectedTemplate.id)}
              isDeleting={deleteTemplate.isPending}
            />
          ) : (
            <NoPipelineSelected />
          )}
        </div>
      </div>
    </div>
  )
}
