import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Check, ChevronsUpDown, Gauge, LayoutTemplate, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, WORKSPACE_KEY, type Workspace } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatDate, formatNumber } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface WorkspaceQuotas {
  max_items?: number | null
  max_storage_mb?: number | null
  max_api_requests_per_day?: number | null
  max_users?: number | null
}

interface UsageRow {
  metric: string
  current: number
  limit: number | null
  period: string
}

interface WorkspaceTemplate {
  id: number
  name: string
  description: string | null
  source_workspace: string | null
  created_at: string
}

type WorkspaceWithQuotas = Workspace & { quotas?: string | null }

const QUOTA_FIELDS: Array<{ key: keyof WorkspaceQuotas; label: string }> = [
  { key: 'max_items', label: 'Max items' },
  { key: 'max_storage_mb', label: 'Max storage (MB)' },
  { key: 'max_api_requests_per_day', label: 'Max API requests / day' },
  { key: 'max_users', label: 'Max users' }
]

const USAGE_LABELS: Record<string, string> = {
  items: 'Items',
  storage_mb: 'Storage (MB)',
  api_requests: 'API requests (today)',
  users: 'Users'
}

// ─── Template combobox (shadcn Popover + Command) ─────────────────────────────

function TemplateCombobox({
  templates,
  value,
  onChange
}: {
  templates: WorkspaceTemplate[]
  value: number | null
  onChange: (v: number | null) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = templates.find((t) => t.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 text-[13px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.name : 'None (empty workspace)'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search templates…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No templates
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__none__'
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='text-[12px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', value === null ? 'opacity-100' : 'opacity-0')}
                />
                None (empty workspace)
              </CommandItem>
              {templates.map((t) => (
                <CommandItem
                  key={t.id}
                  value={t.name}
                  onSelect={() => {
                    onChange(t.id)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === t.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className='flex-1 truncate'>{t.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Form (create or edit) ────────────────────────────────────────────────────

function WorkspaceForm({
  initial,
  onSave,
  onCancel,
  saving,
  isNew,
  templates
}: {
  initial?: Partial<Workspace>
  onSave: (data: { name: string; slug: string; color: string; template_id?: number | null }) => void
  onCancel: () => void
  saving: boolean
  isNew?: boolean
  templates?: WorkspaceTemplate[]
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [slug, setSlug] = useState(initial?.slug ?? '')
  const [color, setColor] = useState(initial?.color ?? '#00ceff')
  const [templateId, setTemplateId] = useState<number | null>(null)

  function handleNameChange(v: string) {
    setName(v)
    if (!initial?.slug) {
      setSlug(
        v
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
      )
    }
  }

  return (
    <div className='space-y-5'>
      <div className='space-y-1.5'>
        <Label htmlFor='ws-name' className='text-[12px] font-medium'>
          Name
        </Label>
        <Input
          id='ws-name'
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          placeholder='My Workspace'
          className='h-8 text-[13px]'
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='ws-slug' className='text-[12px] font-medium'>
          Slug
        </Label>
        <Input
          id='ws-slug'
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder='my-workspace'
          className='h-8 font-mono text-[13px]'
        />
      </div>
      <div className='space-y-1.5'>
        <Label htmlFor='ws-color' className='text-[12px] font-medium'>
          Color
        </Label>
        <div className='flex items-center gap-2.5'>
          <input
            id='ws-color'
            type='color'
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className='h-8 w-10 cursor-pointer rounded border border-input bg-background p-0.5'
          />
          <code className='text-[12px] text-slate-500 dark:text-muted-foreground'>{color}</code>
        </div>
      </div>
      {isNew && templates && (
        <div className='space-y-1.5'>
          <Label className='text-[12px] font-medium'>From template</Label>
          <TemplateCombobox templates={templates} value={templateId} onChange={setTemplateId} />
          <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            Replays collections, roles and workflows from a saved template.
          </p>
        </div>
      )}
      <div className='flex items-center gap-2 pt-1'>
        <Button
          size='sm'
          onClick={() => onSave({ name, slug, color, template_id: isNew ? templateId : undefined })}
          disabled={saving || !name.trim() || !slug.trim()}
        >
          {saving ? 'Saving…' : isNew ? 'Create workspace' : 'Save changes'}
        </Button>
        <Button variant='ghost' size='sm' onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── List item ────────────────────────────────────────────────────────────────

function WorkspaceListItem({
  ws,
  isCurrent,
  selected,
  onClick
}: {
  ws: Workspace
  isCurrent: boolean
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
        <div className='mb-1 flex items-center gap-2.5'>
          <span
            className='h-2.5 w-2.5 shrink-0 rounded-full'
            style={{ backgroundColor: ws.color ?? '#00ceff' }}
          />
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected
                ? 'text-slate-900 dark:text-foreground'
                : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {ws.name}
          </span>
          {isCurrent && (
            <span className='flex shrink-0 items-center gap-0.5 rounded-full bg-[#00ceff]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#00ceff]'>
              <Check className='h-2.5 w-2.5' /> Active
            </span>
          )}
        </div>
        <p className='pl-5 text-[11px] text-slate-400 dark:text-muted-foreground'>/{ws.slug}</p>
      </button>
    </li>
  )
}

// ─── Usage card ───────────────────────────────────────────────────────────────

function UsageCard({ workspaceId }: { workspaceId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['workspace-usage', workspaceId],
    queryFn: () =>
      api
        .get<{ data: { quotas: WorkspaceQuotas; usage: UsageRow[] } }>(
          `/workspaces/${workspaceId}/usage`
        )
        .then((r) => r.data.data)
  })

  return (
    <div className='mb-7 rounded-lg border border-slate-200 p-5 dark:border-border'>
      <div className='mb-4 flex items-center gap-2'>
        <Gauge className='h-3.5 w-3.5 text-slate-400' />
        <p className='text-[13px] font-medium text-slate-700 dark:text-foreground'>Usage</p>
      </div>
      {isLoading ? (
        <div className='space-y-3'>
          {[1, 2, 3, 4].map((k) => (
            <Skeleton key={k} className='h-6 w-full' />
          ))}
        </div>
      ) : (
        <div className='space-y-4'>
          {(data?.usage ?? []).map((u) => {
            const pct =
              u.limit && u.limit > 0 ? Math.min(100, Math.round((u.current / u.limit) * 100)) : null
            return (
              <div key={u.metric}>
                <div className='mb-1 flex items-center justify-between'>
                  <span className='text-[12px] text-slate-600 dark:text-slate-300'>
                    {USAGE_LABELS[u.metric] ?? u.metric}
                  </span>
                  <span className='text-[11px] tabular-nums text-slate-400 dark:text-muted-foreground'>
                    {formatNumber(u.current)}
                    {u.limit != null ? ` / ${formatNumber(u.limit)}` : ' · unlimited'}
                  </span>
                </div>
                <div className='h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-muted'>
                  {pct !== null ? (
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-[#00ceff]'
                      )}
                      style={{ width: `${pct}%` }}
                    />
                  ) : (
                    <div className='h-full w-full bg-slate-200 dark:bg-muted-foreground/20' />
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Quotas card ──────────────────────────────────────────────────────────────

function QuotasCard({
  ws,
  onSave,
  saving
}: {
  ws: WorkspaceWithQuotas
  onSave: (quotas: WorkspaceQuotas) => void
  saving: boolean
}) {
  const initial: WorkspaceQuotas = (() => {
    try {
      return ws.quotas ? (JSON.parse(ws.quotas) as WorkspaceQuotas) : {}
    } catch {
      return {}
    }
  })()
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      QUOTA_FIELDS.map((f) => [f.key, initial[f.key] != null ? String(initial[f.key]) : ''])
    )
  )
  const [unlimited, setUnlimited] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(QUOTA_FIELDS.map((f) => [f.key, initial[f.key] == null]))
  )

  function handleSave() {
    const quotas: WorkspaceQuotas = {}
    for (const f of QUOTA_FIELDS) {
      if (unlimited[f.key]) {
        quotas[f.key] = null
      } else {
        const n = Number(values[f.key])
        quotas[f.key] = Number.isFinite(n) && n > 0 ? n : null
      }
    }
    onSave(quotas)
  }

  return (
    <div className='mb-7 rounded-lg border border-slate-200 p-5 dark:border-border'>
      <p className='mb-1 text-[13px] font-medium text-slate-700 dark:text-foreground'>Quotas</p>
      <p className='mb-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Limits applied to this workspace. Toggle unlimited to remove a limit.
      </p>
      <div className='space-y-3'>
        {QUOTA_FIELDS.map((f) => (
          <div key={f.key} className='flex items-center gap-3'>
            <span className='w-44 shrink-0 text-[12px] text-slate-600 dark:text-slate-300'>
              {f.label}
            </span>
            <Input
              type='number'
              min={0}
              value={values[f.key]}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              disabled={unlimited[f.key]}
              placeholder='—'
              className='h-8 w-32 text-[13px] tabular-nums'
            />
            <div className='flex items-center gap-1.5'>
              <Switch
                id={`quota-unlimited-${f.key}`}
                checked={unlimited[f.key]}
                onCheckedChange={(checked) =>
                  setUnlimited((u) => ({ ...u, [f.key]: checked === true }))
                }
              />
              <Label
                htmlFor={`quota-unlimited-${f.key}`}
                className='text-[11px] font-normal text-slate-500 dark:text-muted-foreground'
              >
                Unlimited
              </Label>
            </div>
          </div>
        ))}
      </div>
      <div className='mt-4'>
        <Button size='sm' variant='outline' onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save quotas'}
        </Button>
      </div>
    </div>
  )
}

// ─── Templates section ────────────────────────────────────────────────────────

function TemplatesSection({ ws }: { ws: Workspace }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const { data: templates = [], isLoading } = useQuery({
    queryKey: ['workspace-templates'],
    queryFn: () =>
      api.get<{ data: WorkspaceTemplate[] }>('/workspaces/templates').then((r) => r.data.data)
  })

  const createMut = useMutation({
    mutationFn: () =>
      api.post('/workspaces/templates', {
        name,
        description: description || undefined,
        source_workspace: ws.id
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-templates'] })
      setShowForm(false)
      setName('')
      setDescription('')
      toast.success('Template saved')
    },
    onError: () => toast.error('Failed to save template')
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/workspaces/templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-templates'] })
      setConfirmId(null)
      toast.success('Template deleted')
    },
    onError: () => toast.error('Failed to delete template')
  })

  return (
    <div className='mb-7 rounded-lg border border-slate-200 p-5 dark:border-border'>
      <div className='mb-1 flex items-center justify-between'>
        <div className='flex items-center gap-2'>
          <LayoutTemplate className='h-3.5 w-3.5 text-slate-400' />
          <p className='text-[13px] font-medium text-slate-700 dark:text-foreground'>Templates</p>
        </div>
        {!showForm && (
          <Button size='sm' variant='outline' onClick={() => setShowForm(true)}>
            <Plus className='mr-1 h-3 w-3' /> Save as template
          </Button>
        )}
      </div>
      <p className='mb-4 text-[12px] text-slate-500 dark:text-muted-foreground'>
        Snapshot this workspace's collections, roles and workflows for reuse when creating new
        workspaces.
      </p>

      {showForm && (
        <div className='mb-4 space-y-3 rounded-md border border-slate-200 p-4 dark:border-border'>
          <div className='space-y-1.5'>
            <Label htmlFor='tpl-name' className='text-[12px] font-medium'>
              Template name
            </Label>
            <Input
              id='tpl-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`${ws.name} template`}
              className='h-8 text-[13px]'
            />
          </div>
          <div className='space-y-1.5'>
            <Label htmlFor='tpl-desc' className='text-[12px] font-medium'>
              Description
            </Label>
            <Input
              id='tpl-desc'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='Optional'
              className='h-8 text-[13px]'
            />
          </div>
          <div className='flex items-center gap-2'>
            <Button
              size='sm'
              onClick={() => createMut.mutate()}
              disabled={createMut.isPending || !name.trim()}
            >
              {createMut.isPending ? 'Saving…' : 'Save template'}
            </Button>
            <Button size='sm' variant='ghost' onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Skeleton className='h-8 w-full' />
      ) : templates.length === 0 ? (
        <p className='text-[12px] text-slate-400 dark:text-muted-foreground'>
          No templates saved yet.
        </p>
      ) : (
        <ul className='divide-y divide-slate-100 dark:divide-border'>
          {templates.map((t) => (
            <li key={t.id} className='flex items-center gap-3 py-2'>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[13px] text-slate-700 dark:text-foreground'>{t.name}</p>
                <p className='truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
                  {t.description || formatDate(t.created_at)}
                </p>
              </div>
              {confirmId === t.id ? (
                <div className='flex shrink-0 items-center gap-1.5'>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-7 px-2 text-[11px]'
                    onClick={() => deleteMut.mutate(t.id)}
                    disabled={deleteMut.isPending}
                  >
                    {deleteMut.isPending ? 'Deleting…' : 'Confirm'}
                  </Button>
                  <Button
                    size='sm'
                    variant='ghost'
                    className='h-7 px-2 text-[11px]'
                    onClick={() => setConfirmId(null)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button
                  size='sm'
                  variant='ghost'
                  className='h-7 w-7 shrink-0 p-0 text-slate-400 hover:text-red-600'
                  onClick={() => setConfirmId(t.id)}
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Detail / edit panel ──────────────────────────────────────────────────────

function WorkspaceDetail({
  ws,
  isCurrent,
  isAdmin,
  onSwitch,
  onDelete,
  onSave,
  onSaveQuotas,
  switching,
  deleting,
  saving
}: {
  ws: WorkspaceWithQuotas
  isCurrent: boolean
  isAdmin: boolean
  onSwitch: () => void
  onDelete: () => void
  onSave: (data: { name: string; slug: string; color: string }) => void
  onSaveQuotas: (quotas: WorkspaceQuotas) => void
  switching: boolean
  deleting: boolean
  saving: boolean
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)

  return (
    <div className='p-8'>
      <div className='max-w-md'>
        <div className='mb-7 flex items-start gap-3'>
          <div
            className='flex h-10 w-10 shrink-0 items-center justify-center rounded-full'
            style={{ backgroundColor: ws.color ?? '#00ceff' }}
          >
            <Building2 className='h-4 w-4 text-white' />
          </div>
          <div>
            <h2 className='text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
              {ws.name}
            </h2>
            <p className='text-[12px] text-slate-400 dark:text-muted-foreground'>/{ws.slug}</p>
          </div>
          {isCurrent && (
            <span className='ml-auto flex items-center gap-1 rounded-full bg-[#00ceff]/10 px-2 py-0.5 text-[11px] font-medium text-[#00ceff]'>
              <Check className='h-3 w-3' /> Active workspace
            </span>
          )}
        </div>

        <div className='mb-7 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
          <div className='bg-white px-4 py-3 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Created
            </p>
            <span className='text-[13px] text-slate-700 dark:text-foreground'>
              {formatDate(ws.created_at)}
            </span>
          </div>
          <div className='bg-white px-4 py-3 dark:bg-card'>
            <p className='mb-1 text-[11px] font-medium text-slate-400 dark:text-muted-foreground'>
              Workspace ID
            </p>
            <code className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
              {ws.id.slice(0, 20)}…
            </code>
          </div>
        </div>

        {isAdmin && !editing && (
          <div className='mb-6 flex items-center gap-2'>
            <Button size='sm' variant='outline' onClick={() => setEditing(true)}>
              Edit workspace
            </Button>
            {!isCurrent && (
              <Button size='sm' onClick={onSwitch} disabled={switching}>
                {switching ? 'Switching…' : 'Switch to this workspace'}
              </Button>
            )}
          </div>
        )}

        {editing && (
          <div className='mb-7 rounded-lg border border-slate-200 p-5 dark:border-border'>
            <p className='mb-4 text-[13px] font-medium text-slate-700 dark:text-foreground'>
              Edit workspace
            </p>
            <WorkspaceForm
              initial={ws}
              onSave={(data) => {
                onSave(data)
                setEditing(false)
              }}
              onCancel={() => setEditing(false)}
              saving={saving}
            />
          </div>
        )}

        <UsageCard workspaceId={ws.id} />

        {isAdmin && (
          <QuotasCard
            key={`${ws.id}:${ws.quotas ?? ''}`}
            ws={ws}
            onSave={onSaveQuotas}
            saving={saving}
          />
        )}

        {isAdmin && <TemplatesSection ws={ws} />}

        {isAdmin && (
          <div className='rounded-lg border border-red-200 p-4 dark:border-red-900/50'>
            <p className='mb-1 text-[12px] font-medium text-red-700 dark:text-red-400'>
              Delete workspace
            </p>
            <p className='mb-3 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Removing a workspace is permanent and cannot be undone.
            </p>
            {confirmDelete ? (
              <div className='flex items-center gap-2'>
                <Button size='sm' variant='destructive' onClick={onDelete} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Confirm delete'}
                </Button>
                <Button size='sm' variant='ghost' onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size='sm'
                variant='outline'
                className='border-red-200 text-red-600 hover:bg-red-50 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/30'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className='mr-1.5 h-3.5 w-3.5' /> Delete workspace
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── New workspace panel ──────────────────────────────────────────────────────

function NewWorkspacePanel({
  onSave,
  onCancel,
  saving
}: {
  onSave: (data: { name: string; slug: string; color: string; template_id?: number | null }) => void
  onCancel: () => void
  saving: boolean
}) {
  const { data: templates = [] } = useQuery({
    queryKey: ['workspace-templates'],
    queryFn: () =>
      api.get<{ data: WorkspaceTemplate[] }>('/workspaces/templates').then((r) => r.data.data)
  })

  return (
    <div className='p-8'>
      <div className='max-w-md'>
        <h2 className='mb-6 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
          New workspace
        </h2>
        <WorkspaceForm
          onSave={onSave}
          onCancel={onCancel}
          saving={saving}
          isNew
          templates={templates}
        />
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoWorkspaceSelected({ isAdmin, onCreate }: { isAdmin: boolean; onCreate: () => void }) {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <Building2 className='h-5 w-5 text-slate-400' />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
        Select a workspace
      </p>
      {isAdmin && (
        <button
          type='button'
          onClick={onCreate}
          className='mt-2 text-[11px] text-[#00ceff] hover:underline'
        >
          Or create a new one
        </button>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function WorkspacesPage() {
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false
  const qc = useQueryClient()

  const { data: workspacesData, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: () => api.get<{ data: WorkspaceWithQuotas[] }>('/workspaces').then((r) => r.data.data)
  })
  const workspaces = workspacesData ?? []

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)

  const createMut = useMutation({
    mutationFn: (body: {
      name: string
      slug: string
      color: string
      template_id?: number | null
    }) =>
      api
        .post<{ data: Workspace & { template_errors?: string[] } }>('/workspaces', {
          ...body,
          template_id: body.template_id ?? undefined
        })
        .then((r) => r.data.data),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] })
      setIsCreating(false)
      setSelectedId(ws.id)
      if (ws.template_errors && ws.template_errors.length > 0) {
        toast.warning(
          `Workspace created — ${ws.template_errors.length} template item(s) failed to replay`
        )
      } else {
        toast.success('Workspace created')
      }
    },
    onError: () => toast.error('Failed to create workspace')
  })

  const updateMut = useMutation({
    mutationFn: ({
      id,
      body
    }: {
      id: string
      body: { name?: string; slug?: string; color?: string; quotas?: WorkspaceQuotas }
    }) => api.patch(`/workspaces/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] })
      qc.invalidateQueries({ queryKey: ['workspace-usage', vars.id] })
      toast.success('Workspace updated')
    },
    onError: () => toast.error('Failed to update workspace')
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/workspaces/${id}`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['workspaces'] })
      if (selectedId === id) setSelectedId(null)
      toast.success('Workspace deleted')
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
        'Failed to delete workspace'
      toast.error(msg)
    }
  })

  const switchMut = useMutation({
    mutationFn: (id: string) => api.post(`/workspaces/${id}/switch`),
    onSuccess: (_, id) => {
      localStorage.setItem(WORKSPACE_KEY, id)
      window.location.reload()
    },
    onError: () => toast.error('Failed to switch workspace')
  })

  const currentWorkspaceId = user?.current_workspace
  const selectedWs = workspaces.find((w) => w.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Workspaces
            </h1>
            {workspacesData && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {workspaces.length}
              </span>
            )}
          </div>
          {isAdmin && (
            <Button
              size='sm'
              onClick={() => {
                setIsCreating(true)
                setSelectedId(null)
              }}
            >
              <Plus className='mr-1.5 h-3.5 w-3.5' /> New Workspace
            </Button>
          )}
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='space-y-px p-3'>
                {[1, 2, 3].map((k) => (
                  <div key={k} className='rounded-lg p-3'>
                    <Skeleton className='mb-2 h-4 w-3/4' />
                    <Skeleton className='h-3 w-1/3' />
                  </div>
                ))}
              </div>
            ) : workspaces.length === 0 ? (
              <div className='flex flex-col items-center justify-center p-8 text-center'>
                <Building2 className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No workspaces
                </p>
              </div>
            ) : (
              <ul className='divide-y divide-slate-100 dark:divide-border'>
                {workspaces.map((ws) => (
                  <WorkspaceListItem
                    key={ws.id}
                    ws={ws}
                    isCurrent={ws.id === currentWorkspaceId}
                    selected={!isCreating && selectedId === ws.id}
                    onClick={() => {
                      setSelectedId(ws.id)
                      setIsCreating(false)
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {isCreating ? (
            <NewWorkspacePanel
              onSave={(body) => createMut.mutate(body)}
              onCancel={() => setIsCreating(false)}
              saving={createMut.isPending}
            />
          ) : selectedWs ? (
            <WorkspaceDetail
              ws={selectedWs}
              isCurrent={selectedWs.id === currentWorkspaceId}
              isAdmin={isAdmin}
              onSwitch={() => switchMut.mutate(selectedWs.id)}
              onDelete={() => deleteMut.mutate(selectedWs.id)}
              onSave={(body) => updateMut.mutate({ id: selectedWs.id, body })}
              onSaveQuotas={(quotas) => updateMut.mutate({ id: selectedWs.id, body: { quotas } })}
              switching={switchMut.isPending}
              deleting={deleteMut.isPending}
              saving={updateMut.isPending}
            />
          ) : (
            <NoWorkspaceSelected isAdmin={isAdmin} onCreate={() => setIsCreating(true)} />
          )}
        </div>
      </div>
    </div>
  )
}
