// Data-model panels used by the collection editor (TableEditor, /data-model/:table):
// tree hierarchy + tree permissions. The old /data-model list page was folded into
// /collections (2026-10-29); /data-model redirects there.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  GitBranch,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { TreePicker } from '@/components/tree-picker'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, } from '@/lib/utils'

interface TreeConfig {
  id: number
  collection: string
  parent_field: string
  label_field: string
  order_field: string | null
  maintain_path?: boolean
}

interface TreePermissionRule {
  id: number
  collection: string
  node_id: string
  role: string
  action: 'read' | 'update' | 'delete' | '*'
  allow: boolean
  role_name: string | null
}

interface RoleOption {
  id: string
  name: string
}

// ─── Table list item ──────────────────────────────────────────────────────────

// ─── Tree permissions ─────────────────────────────────────────────────────────

const TREE_ACTIONS = [
  { value: '*', label: 'All actions' },
  { value: 'read', label: 'Read' },
  { value: 'update', label: 'Update' },
  { value: 'delete', label: 'Delete' }
] as const

const ACTION_BADGE_CLS: Record<string, string> = {
  '*': 'bg-slate-100 text-slate-600 dark:bg-muted dark:text-muted-foreground',
  read: 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
  update: 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  delete: 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
}

function PermCombobox({
  value,
  onChange,
  options,
  placeholder,
  searchable = false
}: {
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: string }>
  placeholder: string
  searchable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-7 w-full justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.label ?? placeholder}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[--radix-popover-trigger-width] p-0' align='start'>
        <Command>
          {searchable && <CommandInput placeholder='Search…' className='h-8 text-[12px]' />}
          <CommandList>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(o.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === o.value ? 'opacity-100' : 'opacity-0')}
                  />
                  {o.label}
                </CommandItem>
              ))}
              {options.length === 0 && (
                <p className='px-3 py-2 text-[12px] text-slate-400'>No options</p>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TreePermissionsSection({ collection }: { collection: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [nodeId, setNodeId] = useState<string | number | null>(null)
  const [roleId, setRoleId] = useState('')
  const [action, setAction] = useState('*')
  const [allow, setAllow] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['tree-permissions', collection],
    queryFn: () =>
      api
        .get<{ data: TreePermissionRule[] }>('/tree-permissions', { params: { collection } })
        .then((r) => r.data.data)
  })

  const { data: roles = [] } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: RoleOption[] }>('/roles').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: treeNodes = [] } = useQuery({
    queryKey: ['tree-nodes', collection],
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string | number; label: string }> }>(`/tree/${collection}/nodes`)
        .then((r) => r.data.data),
    staleTime: 30_000
  })

  const nodeLabel = (nid: string) =>
    treeNodes.find((n) => String(n.id) === String(nid))?.label ?? `#${nid}`

  const resetForm = () => {
    setAdding(false)
    setNodeId(null)
    setRoleId('')
    setAction('*')
    setAllow(false)
  }

  const createRule = useMutation({
    mutationFn: () =>
      api.post('/tree-permissions', { collection, node_id: nodeId, role: roleId, action, allow }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tree-permissions', collection] })
      resetForm()
      toast.success('Tree permission added')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to add permission')
    }
  })

  const deleteRule = useMutation({
    mutationFn: (id: number) => api.delete(`/tree-permissions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tree-permissions', collection] })
      setConfirmDelete(null)
      toast.success('Permission removed')
    },
    onError: () => toast.error('Failed to remove permission')
  })

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-border'>
        <h3 className='flex items-center gap-1.5 text-[13px] font-medium text-slate-800 dark:text-foreground'>
          <ShieldCheck className='h-3.5 w-3.5 text-slate-400' />
          Node permissions
        </h3>
        {!adding && (
          <Button
            size='sm'
            variant='outline'
            className='h-6 text-[11px]'
            onClick={() => setAdding(true)}
          >
            <Plus className='mr-1 h-3 w-3' />
            Add rule
          </Button>
        )}
      </div>

      <p className='border-b border-slate-100 px-4 py-2.5 text-[11px] leading-relaxed text-slate-400 dark:border-border'>
        Rules apply to a node and all descendants. Deepest match wins; deny overrides allow at the
        same depth.
      </p>

      {/* Rules table */}
      {isLoading ? (
        <div className='px-4 py-3'>
          <Skeleton className='h-8 w-full rounded' />
        </div>
      ) : rules.length === 0 && !adding ? (
        <p className='px-4 py-4 text-center text-[11px] text-slate-400'>
          No node permission rules defined.
        </p>
      ) : rules.length > 0 ? (
        <table className='w-full text-[11px]'>
          <thead>
            <tr className='border-b border-slate-100 text-left dark:border-border'>
              <th className='px-4 py-2 text-[10px] font-medium text-slate-500'>Node</th>
              <th className='py-2 pr-3 text-[10px] font-medium text-slate-500'>Role</th>
              <th className='py-2 pr-3 text-[10px] font-medium text-slate-500'>Action</th>
              <th className='py-2 pr-3 text-[10px] font-medium text-slate-500'>Effect</th>
              <th className='w-12 py-2' />
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr
                key={rule.id}
                className='border-b border-slate-50 last:border-0 dark:border-border/50'
              >
                <td className='max-w-[120px] truncate px-4 py-2 text-slate-700 dark:text-foreground'>
                  {nodeLabel(rule.node_id)}
                </td>
                <td className='max-w-[100px] truncate py-2 pr-3 text-slate-600 dark:text-slate-300'>
                  {rule.role_name ?? rule.role}
                </td>
                <td className='py-2 pr-3'>
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                      ACTION_BADGE_CLS[rule.action] ?? ACTION_BADGE_CLS['*']
                    )}
                  >
                    {rule.action === '*' ? 'all' : rule.action}
                  </span>
                </td>
                <td className='py-2 pr-3'>
                  {rule.allow ? (
                    <span className='rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'>
                      Allow
                    </span>
                  ) : (
                    <span className='rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:bg-red-950/40 dark:text-red-400'>
                      Deny
                    </span>
                  )}
                </td>
                <td className='py-2 pr-3 text-right'>
                  {confirmDelete === rule.id ? (
                    <span className='inline-flex items-center gap-1'>
                      <button
                        type='button'
                        disabled={deleteRule.isPending}
                        onClick={() => deleteRule.mutate(rule.id)}
                        className='text-[10px] font-medium text-red-500 hover:text-red-600 disabled:opacity-50'
                      >
                        Confirm
                      </button>
                      <button
                        type='button'
                        onClick={() => setConfirmDelete(null)}
                        className='rounded p-0.5 text-slate-400 hover:text-slate-600'
                        aria-label='Cancel delete'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </span>
                  ) : (
                    <button
                      type='button'
                      onClick={() => setConfirmDelete(rule.id)}
                      className='rounded p-0.5 text-slate-300 hover:text-red-500'
                      aria-label='Delete rule'
                    >
                      <Trash2 className='h-3 w-3' />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      {/* Inline add form */}
      {adding && (
        <div className='space-y-2.5 p-4'>
          <div className='space-y-1.5'>
            <Label className='text-[11px]'>Node</Label>
            <TreePicker
              collection={collection}
              value={nodeId}
              onChange={setNodeId}
              placeholder='Select node…'
            />
          </div>
          <div className='grid grid-cols-2 gap-2'>
            <div className='space-y-1.5'>
              <Label className='text-[11px]'>Role</Label>
              <PermCombobox
                value={roleId}
                onChange={setRoleId}
                options={roles.map((r) => ({ value: r.id, label: r.name }))}
                placeholder='Select role…'
                searchable
              />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-[11px]'>Action</Label>
              <PermCombobox
                value={action}
                onChange={setAction}
                options={TREE_ACTIONS.map((a) => ({ value: a.value, label: a.label }))}
                placeholder='Action'
              />
            </div>
          </div>
          <div className='flex items-center justify-between'>
            <div className='inline-flex overflow-hidden rounded-md border border-slate-200 dark:border-border'>
              <button
                type='button'
                onClick={() => setAllow(true)}
                className={cn(
                  'px-2.5 py-1 text-[11px] font-medium transition-colors',
                  allow
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                    : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-background dark:text-slate-400'
                )}
              >
                Allow
              </button>
              <button
                type='button'
                onClick={() => setAllow(false)}
                className={cn(
                  'border-l border-slate-200 px-2.5 py-1 text-[11px] font-medium transition-colors dark:border-border',
                  !allow
                    ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                    : 'bg-white text-slate-500 hover:bg-slate-50 dark:bg-background dark:text-slate-400'
                )}
              >
                Deny
              </button>
            </div>
            <div className='flex gap-2'>
              <Button size='sm' variant='ghost' className='h-7 text-[12px]' onClick={resetForm}>
                Cancel
              </Button>
              <Button
                size='sm'
                className='h-7 text-[12px]'
                disabled={nodeId == null || !roleId || createRule.isPending}
                onClick={() => createRule.mutate()}
              >
                {createRule.isPending ? 'Adding…' : 'Add rule'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tree config row ──────────────────────────────────────────────────────────

function _TreeConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className='flex items-center justify-between px-4 py-2.5'>
      <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>{label}</span>
      <code className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11.5px] text-slate-800 dark:bg-muted dark:text-foreground'>
        {value}
      </code>
    </div>
  )
}

// ─── Field picker combobox (used in tree forms) ───────────────────────────────

function FieldCombobox({
  value,
  onChange,
  fields,
  placeholder,
  allowEmpty
}: {
  value: string
  onChange: (v: string) => void
  fields: { field: string; type: string }[]
  placeholder?: string
  allowEmpty?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = fields.find((f) => f.field === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? `${selected.field} (${selected.type})` : (placeholder ?? 'Select field…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search fields…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandGroup>
              {allowEmpty && (
                <CommandItem
                  value=''
                  onSelect={() => {
                    onChange('')
                    setOpen(false)
                  }}
                  className='font-mono text-[12px] text-slate-400'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === '' ? 'opacity-100' : 'opacity-0')}
                  />
                  — none —
                </CommandItem>
              )}
              {fields.map((f) => (
                <CommandItem
                  key={f.field}
                  value={f.field}
                  onSelect={(v) => {
                    onChange(v)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === f.field ? 'opacity-100' : 'opacity-0')}
                  />
                  {f.field}
                  <span className='ml-auto text-[11px] text-slate-400'>{f.type}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Tree enable form ─────────────────────────────────────────────────────────

function TreeEnableForm({
  collection,
  onSuccess,
  onCancel
}: {
  collection: string
  onSuccess: () => void
  onCancel: () => void
}) {
  const [parentField, setParentField] = useState('')
  const [labelField, setLabelField] = useState('')
  const [orderField, setOrderField] = useState('')
  const [maintainPath, setMaintainPath] = useState(false)

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection,
    staleTime: 10 * 60 * 1000
  })

  const fields: { field: string; type: string }[] = (colMeta?.fields ?? []).filter(
    (f: { hidden?: boolean }) => !f.hidden
  )

  const createTree = useMutation({
    mutationFn: () =>
      api.post('/tree-configs', {
        collection,
        parent_field: parentField || 'parent_id',
        label_field: labelField || 'name',
        order_field: orderField || undefined,
        maintain_path: maintainPath
      }),
    onSuccess: () => {
      toast.success('Tree enabled')
      onSuccess()
    },
    onError: () => toast.error('Failed to enable tree')
  })

  return (
    <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='border-b border-slate-100 px-4 py-3 dark:border-border'>
        <h3 className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
          Enable tree navigation
        </h3>
        <p className='mt-0.5 text-[11px] text-slate-400'>
          Configure the columns that define the tree structure.
        </p>
      </div>
      <div className='space-y-3 p-4'>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Parent field</Label>
          <FieldCombobox
            value={parentField}
            onChange={setParentField}
            fields={fields}
            placeholder='parent_id'
          />
          <p className='text-[11px] text-slate-400'>Column storing the parent record ID</p>
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>Label field</Label>
          <FieldCombobox
            value={labelField}
            onChange={setLabelField}
            fields={fields}
            placeholder='name'
          />
        </div>
        <div className='space-y-1.5'>
          <Label className='text-[12px]'>
            Order field <span className='font-normal text-slate-400'>(optional)</span>
          </Label>
          <FieldCombobox
            value={orderField}
            onChange={setOrderField}
            fields={fields}
            placeholder='sort_order'
            allowEmpty
          />
        </div>
        <div className='flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5 dark:border-border dark:bg-muted/30'>
          <div>
            <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
              Maintain path column
            </p>
            <p className='mt-0.5 text-[11px] text-slate-400'>
              Adds <code className='font-mono'>path</code> +{' '}
              <code className='font-mono'>depth</code> columns kept in sync
            </p>
          </div>
          <Switch checked={maintainPath} onCheckedChange={setMaintainPath} />
        </div>
      </div>
      <div className='flex gap-2 border-t border-slate-100 px-4 py-3 dark:border-border'>
        <Button size='sm' disabled={createTree.isPending} onClick={() => createTree.mutate()}>
          {createTree.isPending ? 'Enabling…' : 'Enable tree'}
        </Button>
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

// ─── Tree section ─────────────────────────────────────────────────────────────

export function TreeSection({ collection, isAdmin }: { collection: string; isAdmin: boolean }) {
  const [showForm, setShowForm] = useState(false)

  const { data: treeConfig, refetch: refetchTree } = useQuery({
    queryKey: ['tree-config', collection],
    queryFn: () =>
      api
        .get<{ data: TreeConfig | null }>(`/tree-configs/by-collection/${collection}`)
        .then((r) => r.data.data)
  })

  const updateTree = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Partial<TreeConfig> }) =>
      api.patch(`/tree-configs/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      refetchTree()
      toast.success('Tree config updated')
    },
    onError: () => toast.error('Failed to update')
  })

  const deleteTree = useMutation({
    mutationFn: (id: number) => api.delete(`/tree-configs/${id}`),
    onSuccess: () => {
      refetchTree()
      toast.success('Tree disabled')
    },
    onError: () => toast.error('Failed to disable tree')
  })

  const rebuildPaths = useMutation({
    mutationFn: (id: number) => api.post(`/tree-configs/${id}/rebuild-paths`),
    onSuccess: () => toast.success('Paths rebuilt'),
    onError: () => toast.error('Failed to rebuild paths')
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!treeConfig && !!collection,
    staleTime: 10 * 60 * 1000
  })
  const colFields: { field: string; type: string }[] = (colMeta?.fields ?? []).filter(
    (f: { hidden?: boolean }) => !f.hidden
  )

  // No tree config
  if (!treeConfig) {
    if (showForm) {
      return (
        <TreeEnableForm
          collection={collection}
          onSuccess={() => {
            setShowForm(false)
            refetchTree()
          }}
          onCancel={() => setShowForm(false)}
        />
      )
    }
    return (
      <div className='flex flex-col items-center justify-center py-14 text-center'>
        <div className='flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
          <GitBranch className='h-5 w-5 text-slate-400' />
        </div>
        <p className='mt-3 text-[13px] font-medium text-slate-700 dark:text-foreground'>
          Tree navigation disabled
        </p>
        <p className='mt-1 max-w-[260px] text-[12px] leading-relaxed text-slate-400'>
          Enable hierarchical browsing for this collection — parent/child navigation and per-node
          role restrictions.
        </p>
        <Button
          size='sm'
          variant='outline'
          className='mt-4 text-[12px]'
          onClick={() => setShowForm(true)}
        >
          Enable tree
        </Button>
      </div>
    )
  }

  return (
    <div className='space-y-4'>
      <div className='overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-border'>
          <h3 className='text-[13px] font-medium text-slate-800 dark:text-foreground'>
            Configuration
          </h3>
          <Button
            size='sm'
            variant='ghost'
            className='h-6 text-[11px] text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
            disabled={deleteTree.isPending}
            onClick={() => deleteTree.mutate(treeConfig.id)}
          >
            Disable
          </Button>
        </div>

        <div className='divide-y divide-slate-100 dark:divide-border'>
          <div className='flex items-center justify-between gap-4 px-4 py-2.5'>
            <span className='shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Parent field
            </span>
            <div className='w-[200px]'>
              <FieldCombobox
                value={treeConfig.parent_field}
                onChange={(v) =>
                  v && updateTree.mutate({ id: treeConfig.id, body: { parent_field: v } })
                }
                fields={colFields}
              />
            </div>
          </div>
          <div className='flex items-center justify-between gap-4 px-4 py-2.5'>
            <span className='shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Label field
            </span>
            <div className='w-[200px]'>
              <FieldCombobox
                value={treeConfig.label_field}
                onChange={(v) =>
                  v && updateTree.mutate({ id: treeConfig.id, body: { label_field: v } })
                }
                fields={colFields}
              />
            </div>
          </div>
          <div className='flex items-center justify-between gap-4 px-4 py-2.5'>
            <span className='shrink-0 text-[12px] text-slate-500 dark:text-muted-foreground'>
              Order field <span className='text-slate-400'>(optional)</span>
            </span>
            <div className='w-[200px]'>
              <FieldCombobox
                value={treeConfig.order_field ?? ''}
                onChange={(v) =>
                  updateTree.mutate({ id: treeConfig.id, body: { order_field: v || null } })
                }
                fields={colFields}
                allowEmpty
              />
            </div>
          </div>

          <div className='flex items-center justify-between px-4 py-3'>
            <div>
              <p className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
                Maintain path column
              </p>
              <p className='mt-0.5 text-[11px] text-slate-400'>
                Adds real <code className='font-mono'>path</code> +{' '}
                <code className='font-mono'>depth</code> columns kept in sync
              </p>
            </div>
            <Switch
              checked={!!treeConfig.maintain_path}
              disabled={updateTree.isPending}
              onCheckedChange={(checked) =>
                updateTree.mutate({ id: treeConfig.id, body: { maintain_path: checked } })
              }
            />
          </div>

          {!!treeConfig.maintain_path && (
            <div className='px-4 py-3'>
              <Button
                size='sm'
                variant='outline'
                className='h-7 text-[12px]'
                disabled={rebuildPaths.isPending}
                onClick={() => rebuildPaths.mutate(treeConfig.id)}
              >
                <RefreshCw
                  className={cn('mr-1.5 h-3 w-3', rebuildPaths.isPending && 'animate-spin')}
                />
                {rebuildPaths.isPending ? 'Rebuilding…' : 'Rebuild paths'}
              </Button>
            </div>
          )}
        </div>
      </div>

      {isAdmin && <TreePermissionsSection collection={collection} />}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
