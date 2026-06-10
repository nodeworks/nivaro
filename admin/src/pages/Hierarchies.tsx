import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  GitBranch,
  Layers,
  Network,
  Plus,
  Save,
  Trash2,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { cn, formatDate } from '@/lib/utils'

// ─── Types ──────────────────────────────────────────────────────────────────

interface HierarchyLevel {
  collection: string
  label_field: string
  parent_fk: string | null
  junction_table?: string | null
  junction_child_fk?: string | null
  junction_parent_fk?: string | null
}

interface HierarchyConfig {
  id: number
  name: string
  description: string | null
  levels: HierarchyLevel[]
  created_at: string
  created_by: number | null
}

// ─── List item ────────────────────────────────────────────────────────────────

function HierarchyListItem({ config, selected }: { config: HierarchyConfig; selected: boolean }) {
  const count = config.levels?.length ?? 0
  return (
    <li>
      <Link
        to={`/hierarchies/${config.id}`}
        className={cn(
          'block w-full px-4 py-3 text-left transition-colors',
          selected
            ? 'bg-nvr-cyan/10 dark:bg-nvr-cyan/[0.07]'
            : 'hover:bg-slate-50 dark:hover:bg-muted/50'
        )}
      >
        <div className='mb-0.5 flex items-center gap-2'>
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected ? 'text-nvr-navy dark:text-nvr-cyan' : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {config.name}
          </span>
          <span className='flex shrink-0 items-center gap-1 text-[11px] text-slate-400 dark:text-muted-foreground'>
            <Layers className='h-3 w-3' />
            {count}
          </span>
        </div>
        {config.description && (
          <p className='truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
            {config.description}
          </p>
        )}
      </Link>
    </li>
  )
}

// ─── Combobox helper ────────────────────────────────────────────────────────

function FieldCombobox({
  value,
  onChange,
  options,
  placeholder,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          disabled={disabled}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder ?? 'Select…')}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={(current) => {
                    onChange(current === value ? '' : current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn(
                      'mr-2 h-3 w-3',
                      value === opt.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  {opt.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Field combobox with label + hint ─────────────────────────────────────────

function FieldComboboxField({
  label,
  value,
  onChange,
  fields,
  placeholder,
  disabled,
  hint
}: {
  label: string
  value: string
  onChange: (v: string) => void
  fields: { field: string; type: string }[]
  placeholder?: string
  disabled?: boolean
  hint?: React.ReactNode
}) {
  const hasFields = fields.length > 0
  return (
    <div className='space-y-1'>
      <Label className='text-[11px] text-slate-500'>{label}</Label>
      <FieldCombobox
        value={value}
        onChange={onChange}
        options={fields.map((f) => ({ value: f.field, label: `${f.field} (${f.type})` }))}
        placeholder={hasFields ? (placeholder ?? 'Select field…') : 'Select collection first'}
        disabled={disabled || !hasFields}
      />
      {hint}
    </div>
  )
}

// ─── Level row ────────────────────────────────────────────────────────────────

function LevelRow({
  level,
  index,
  isRoot,
  isLast,
  isAdmin,
  onUpdate,
  onRemove,
  onMove
}: {
  level: HierarchyLevel
  index: number
  isRoot: boolean
  isLast: boolean
  isAdmin: boolean
  onUpdate: (patch: Partial<HierarchyLevel>) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
}) {
  const { data: collectionsData } = useQuery({
    queryKey: ['collections'],
    queryFn: () =>
      api.get<{ data: { collection: string }[] }>('/collections').then((r) => r.data.data),
    staleTime: 60_000
  })

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', level.collection],
    queryFn: () =>
      api
        .get<{ data: { fields: { field: string; type: string; hidden?: boolean }[] } }>(
          `/collections/${level.collection}`
        )
        .then((r) => r.data.data),
    enabled: !!level.collection,
    staleTime: 30_000
  })

  const collections = collectionsData ?? []
  const allFields = (colMeta?.fields ?? []).filter((f) => !f.hidden)

  return (
    <div className='rounded-lg border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/20'>
      <div className='mb-2 flex items-center gap-2'>
        <span className='flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-nvr-navy text-[11px] font-bold text-nvr-cyan'>
          {index}
        </span>
        <span className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
          {isRoot ? 'Root level' : `Level ${index}`}
        </span>
        <div className='ml-auto flex items-center gap-1'>
          {isAdmin && (
            <>
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7'
                disabled={index === 0}
                onClick={() => onMove(-1)}
                aria-label='Move level up'
              >
                <ArrowUp className='h-3.5 w-3.5' />
              </Button>
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7'
                disabled={isLast}
                onClick={() => onMove(1)}
                aria-label='Move level down'
              >
                <ArrowDown className='h-3.5 w-3.5' />
              </Button>
              <Button
                size='icon'
                variant='ghost'
                className='h-7 w-7 text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
                onClick={onRemove}
                aria-label='Remove level'
              >
                <X className='h-3.5 w-3.5' />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Collection + Label field (always shown) */}
      <div className='grid grid-cols-2 gap-2'>
        <div className='space-y-1'>
          <Label className='text-[11px] text-slate-500'>Collection</Label>
          <FieldCombobox
            value={level.collection}
            onChange={(v) =>
              onUpdate({
                collection: v,
                label_field: '',
                parent_fk: isRoot ? null : '',
                junction_table: null,
                junction_child_fk: null,
                junction_parent_fk: null
              })
            }
            options={collections.map((c) => ({ value: c.collection, label: c.collection }))}
            placeholder='Select collection…'
            disabled={!isAdmin}
          />
        </div>
        <FieldComboboxField
          label='Label field'
          value={level.label_field}
          onChange={(v) => onUpdate({ label_field: v })}
          fields={allFields}
          placeholder='e.g. name'
          disabled={!isAdmin}
        />
      </div>

      {/* Relationship type for non-root levels */}
      {!isRoot && (
        <div className='mt-2 space-y-2'>
          <div className='flex items-center gap-2'>
            <Label className='text-[11px] text-slate-500'>Relationship to parent</Label>
            {isAdmin && (
              <div className='ml-auto flex overflow-hidden rounded-md border border-slate-200 text-[11px] font-medium dark:border-border'>
                {(['M2O', 'M2M'] as const).map((mode) => {
                  const isM2M = !!level.junction_table
                  const active = mode === 'M2M' ? isM2M : !isM2M
                  return (
                    <button
                      key={mode}
                      type='button'
                      onClick={() => {
                        if (mode === 'M2M') {
                          onUpdate({
                            parent_fk: null,
                            junction_table: '',
                            junction_child_fk: '',
                            junction_parent_fk: ''
                          })
                        } else {
                          onUpdate({
                            parent_fk: '',
                            junction_table: null,
                            junction_child_fk: null,
                            junction_parent_fk: null
                          })
                        }
                      }}
                      className={cn(
                        'px-2.5 py-1 transition-colors',
                        active
                          ? 'bg-nvr-navy text-nvr-cyan'
                          : 'text-slate-500 hover:bg-slate-50 dark:hover:bg-muted/50'
                      )}
                    >
                      {mode === 'M2O' ? 'FK (M2O)' : 'Junction (M2M)'}
                    </button>
                  )
                })}
              </div>
            )}
            {!isAdmin && (
              <span className='ml-auto text-[11px] text-slate-400'>
                {level.junction_table ? 'Junction (M2M)' : 'FK (M2O)'}
              </span>
            )}
          </div>

          {/* M2O: single parent FK */}
          {!level.junction_table && (
            <FieldComboboxField
              label='Parent FK column'
              value={level.parent_fk ?? ''}
              onChange={(v) => onUpdate({ parent_fk: v || null })}
              fields={allFields}
              placeholder='e.g. division'
              disabled={!isAdmin}
              hint={
                <p className='text-[10px] text-slate-400'>
                  Column on <code>{level.collection || 'this collection'}</code> that holds the
                  parent id.
                </p>
              }
            />
          )}

          {/* M2M: junction table fields */}
          {level.junction_table != null ? (
            <div className='grid grid-cols-3 gap-2'>
              <div className='space-y-1'>
                <Label className='text-[11px] text-slate-500'>Junction table</Label>
                <Input
                  value={level.junction_table ?? ''}
                  onChange={(e) => onUpdate({ junction_table: e.target.value || null })}
                  placeholder='e.g. workflow_divisions'
                  className='h-8 font-mono text-[12px]'
                  disabled={!isAdmin}
                />
              </div>
              <FieldComboboxField
                label='Child FK'
                value={level.junction_child_fk ?? ''}
                onChange={(v) => onUpdate({ junction_child_fk: v || null })}
                fields={allFields}
                placeholder='e.g. workflow_id'
                disabled={!isAdmin}
              />
              <FieldComboboxField
                label='Parent FK'
                value={level.junction_parent_fk ?? ''}
                onChange={(v) => onUpdate({ junction_parent_fk: v || null })}
                fields={allFields}
                placeholder='e.g. division_id'
                disabled={!isAdmin}
              />
              <p className='col-span-3 text-[10px] text-slate-400'>
                Junction child FK → <code>{level.collection || 'this collection'}</code>.id
                &nbsp;·&nbsp; Junction parent FK → parent collection's id.
              </p>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ─── Levels editor ──────────────────────────────────────────────────────────

function LevelsEditor({
  configId,
  initialLevels,
  isAdmin
}: {
  configId: number
  initialLevels: HierarchyLevel[]
  isAdmin: boolean
}) {
  const qc = useQueryClient()
  const [levels, setLevels] = useState<HierarchyLevel[]>(initialLevels)

  useEffect(() => {
    setLevels(initialLevels)
  }, [initialLevels])

  const saveLevels = useMutation({
    mutationFn: (next: HierarchyLevel[]) =>
      api
        .patch<{ data: HierarchyConfig }>(`/hierarchy-configs/${configId}`, { levels: next })
        .then((r) => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hierarchy-config', configId] })
      qc.invalidateQueries({ queryKey: ['hierarchy-configs'] })
      toast.success('Levels saved')
    },
    onError: () => toast.error('Failed to save levels')
  })

  function updateLevel(index: number, patch: Partial<HierarchyLevel>) {
    setLevels((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  function addLevel() {
    setLevels((prev) => [
      ...prev,
      {
        collection: '',
        label_field: 'name',
        parent_fk: prev.length === 0 ? null : '',
        junction_table: null,
        junction_child_fk: null,
        junction_parent_fk: null
      }
    ])
  }

  function removeLevel(index: number) {
    setLevels((prev) => {
      const next = prev.filter((_, i) => i !== index)
      // level 0 is always root
      if (next.length > 0) next[0] = { ...next[0], parent_fk: null }
      return next
    })
  }

  function moveLevel(index: number, dir: -1 | 1) {
    setLevels((prev) => {
      const target = index + dir
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      ;[next[index], next[target]] = [next[target], next[index]]
      // re-normalize: level 0 = root (no parent_fk)
      return next.map((l, i) => (i === 0 ? { ...l, parent_fk: null } : l))
    })
  }

  const dirty = JSON.stringify(levels) !== JSON.stringify(initialLevels)

  return (
    <div className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
      <div className='flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-border'>
        <div className='flex items-center gap-2'>
          <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
            Hierarchy Levels
          </h3>
          <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
            {levels.length}
          </span>
        </div>
        {isAdmin && (
          <Button size='sm' variant='outline' onClick={addLevel}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> Add Level
          </Button>
        )}
      </div>

      <div className='p-4'>
        {levels.length === 0 ? (
          <div className='flex flex-col items-center gap-2 py-8 text-slate-400'>
            <Layers className='h-7 w-7 opacity-40' />
            <p className='text-[12px]'>No levels defined yet</p>
            {isAdmin && (
              <button
                type='button'
                onClick={addLevel}
                className='text-[11px] text-nvr-cyan hover:underline'
              >
                Add the root level
              </button>
            )}
          </div>
        ) : (
          <div className='space-y-2'>
            {levels.map((level, index) => (
              <LevelRow
                // biome-ignore lint/suspicious/noArrayIndexKey: level rows are positional
                key={index}
                level={level}
                index={index}
                isRoot={index === 0}
                isLast={index === levels.length - 1}
                isAdmin={isAdmin}
                onUpdate={(patch) => updateLevel(index, patch)}
                onRemove={() => removeLevel(index)}
                onMove={(dir) => moveLevel(index, dir)}
              />
            ))}
          </div>
        )}

        {isAdmin && levels.length > 0 && (
          <div className='mt-4 flex items-center gap-2'>
            <Button
              size='sm'
              onClick={() => saveLevels.mutate(levels)}
              disabled={!dirty || saveLevels.isPending}
            >
              <Save className='mr-1.5 h-3.5 w-3.5' />
              {saveLevels.isPending ? 'Saving…' : 'Save Levels'}
            </Button>
            {dirty && (
              <Button
                size='sm'
                variant='ghost'
                onClick={() => setLevels(initialLevels)}
                disabled={saveLevels.isPending}
              >
                Reset
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Detail panel ─────────────────────────────────────────────────────────────

function HierarchyDetail({
  config,
  isAdmin,
  onDelete
}: {
  config: HierarchyConfig
  isAdmin: boolean
  onDelete: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(config.name)
  const [description, setDescription] = useState(config.description ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setName(config.name)
    setDescription(config.description ?? '')
    setConfirmDelete(false)
  }, [config.name, config.description])

  const updateConfig = useMutation({
    mutationFn: (body: { name: string; description: string | null }) =>
      api
        .patch<{ data: HierarchyConfig }>(`/hierarchy-configs/${config.id}`, body)
        .then((r) => r.data.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['hierarchy-config', config.id] })
      qc.invalidateQueries({ queryKey: ['hierarchy-configs'] })
      toast.success('Hierarchy updated')
    },
    onError: () => toast.error('Failed to update hierarchy')
  })

  const deleteConfig = useMutation({
    mutationFn: () => api.delete(`/hierarchy-configs/${config.id}`),
    onSuccess: () => {
      toast.success('Hierarchy deleted')
      onDelete()
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to delete hierarchy')
      setConfirmDelete(false)
    }
  })

  const detailsDirty =
    name !== config.name || (description || null) !== (config.description ?? null)

  function saveDetails() {
    if (!name.trim()) return
    updateConfig.mutate({ name: name.trim(), description: description.trim() || null })
  }

  return (
    <div className='flex h-full flex-col'>
      {/* Header bar */}
      <div className='flex shrink-0 items-center gap-3 border-b border-slate-100 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-nvr-navy'>
          <GitBranch className='h-3.5 w-3.5 text-nvr-cyan' />
        </div>
        <div className='min-w-0 flex-1'>
          <h2 className='truncate text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            {config.name}
          </h2>
          <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
            Created {formatDate(config.created_at)}
          </p>
        </div>
        <Button size='sm' variant='outline' asChild>
          <Link to={`/hierarchies/${config.id}/tree`}>
            <Network className='mr-1.5 h-3.5 w-3.5' /> View Tree
          </Link>
        </Button>
        {isAdmin &&
          (confirmDelete ? (
            <div className='flex items-center gap-2 text-[13px]'>
              <span className='text-slate-600 dark:text-slate-400'>Delete?</span>
              <Button
                size='sm'
                variant='destructive'
                onClick={() => deleteConfig.mutate()}
                disabled={deleteConfig.isPending}
              >
                {deleteConfig.isPending ? 'Deleting…' : 'Yes'}
              </Button>
              <Button size='sm' variant='outline' onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size='sm'
              variant='ghost'
              className='text-red-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/30'
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className='mr-1 h-3.5 w-3.5' /> Delete
            </Button>
          ))}
      </div>

      {/* Body */}
      <div className='flex-1 space-y-5 overflow-y-auto p-6'>
        {/* Edit form */}
        <div className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='border-b border-slate-100 px-4 py-3 dark:border-border'>
            <h3 className='text-[13px] font-semibold text-slate-900 dark:text-foreground'>
              Details
            </h3>
          </div>
          <div className='space-y-4 p-4'>
            <div className='space-y-1.5'>
              <Label className='text-[12px]'>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => {
                  if (isAdmin && detailsDirty && name.trim()) saveDetails()
                }}
                placeholder='Hierarchy name'
                className='h-8 text-[13px]'
                disabled={!isAdmin}
              />
            </div>
            <div className='space-y-1.5'>
              <Label className='text-[12px]'>Description</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => {
                  if (isAdmin && detailsDirty) saveDetails()
                }}
                placeholder='Optional description'
                rows={2}
                className='text-[13px]'
                disabled={!isAdmin}
              />
            </div>
            {isAdmin && (
              <div className='flex items-center gap-2'>
                <Button
                  size='sm'
                  onClick={saveDetails}
                  disabled={!detailsDirty || !name.trim() || updateConfig.isPending}
                >
                  <Save className='mr-1.5 h-3.5 w-3.5' />
                  {updateConfig.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Levels editor */}
        <LevelsEditor configId={config.id} initialLevels={config.levels ?? []} isAdmin={isAdmin} />
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoHierarchySelected({ isAdmin, onCreate }: { isAdmin: boolean; onCreate: () => void }) {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <Network className='h-5 w-5 text-slate-400' />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
        Select a hierarchy or create one
      </p>
      {isAdmin && (
        <button
          type='button'
          onClick={onCreate}
          className='mt-2 text-[11px] text-nvr-cyan hover:underline'
        >
          Or create a new one
        </button>
      )}
    </div>
  )
}

// ─── Create panel ─────────────────────────────────────────────────────────────

function CreateHierarchyPanel({
  onSave,
  onCancel,
  saving
}: {
  onSave: (data: { name: string; description: string | null }) => void
  onCancel: () => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  return (
    <div className='p-8'>
      <div className='max-w-md'>
        <h2 className='mb-6 text-[18px] font-semibold tracking-[-0.015em] text-slate-900 dark:text-foreground'>
          New hierarchy
        </h2>
        <div className='space-y-5'>
          <div className='space-y-1.5'>
            <Label className='text-[12px] font-medium'>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. Org Structure'
              className='h-8 text-[13px]'
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px] font-medium'>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='Optional'
              rows={2}
              className='text-[13px]'
            />
          </div>
          <div className='flex items-center gap-2 pt-1'>
            <Button
              size='sm'
              onClick={() => onSave({ name: name.trim(), description: description.trim() || null })}
              disabled={saving || !name.trim()}
            >
              {saving ? 'Creating…' : 'Create hierarchy'}
            </Button>
            <Button size='sm' variant='ghost' onClick={onCancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function HierarchiesPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = (user as { is_admin?: boolean } | null)?.is_admin ?? false

  const [isCreating, setIsCreating] = useState(false)

  const { data: configs, isLoading } = useQuery({
    queryKey: ['hierarchy-configs'],
    queryFn: () =>
      api.get<{ data: HierarchyConfig[] }>('/hierarchy-configs').then((r) => r.data.data)
  })

  const selectedId = id ? Number(id) : null

  const { data: selectedConfig, isLoading: detailLoading } = useQuery({
    queryKey: ['hierarchy-config', selectedId],
    queryFn: () =>
      api
        .get<{ data: HierarchyConfig }>(`/hierarchy-configs/${selectedId}`)
        .then((r) => r.data.data),
    enabled: selectedId != null
  })

  const createConfig = useMutation({
    mutationFn: (body: { name: string; description: string | null }) =>
      api
        .post<{ data: HierarchyConfig }>('/hierarchy-configs', { ...body, levels: [] })
        .then((r) => r.data.data),
    onSuccess: (cfg) => {
      qc.invalidateQueries({ queryKey: ['hierarchy-configs'] })
      setIsCreating(false)
      navigate(`/hierarchies/${cfg.id}`)
      toast.success('Hierarchy created')
    },
    onError: () => toast.error('Failed to create hierarchy')
  })

  const list = configs ?? []

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <div>
              <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
                Hierarchies
              </h1>
              <p className='text-[12px] text-slate-400 dark:text-muted-foreground'>
                Multi-collection trees linked by foreign keys
              </p>
            </div>
            {configs && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {list.length}
              </span>
            )}
          </div>
          {isAdmin && (
            <Button
              size='sm'
              onClick={() => {
                setIsCreating(true)
                navigate('/hierarchies')
              }}
            >
              <Plus className='mr-1.5 h-3.5 w-3.5' /> New Hierarchy
            </Button>
          )}
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
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
            ) : list.length === 0 ? (
              <div className='flex flex-col items-center justify-center p-8 text-center'>
                <Network className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  No hierarchies yet
                </p>
              </div>
            ) : (
              <ul className='divide-y divide-slate-100 dark:divide-border'>
                {list.map((cfg) => (
                  <HierarchyListItem
                    key={cfg.id}
                    config={cfg}
                    selected={!isCreating && selectedId === cfg.id}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <main className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {isCreating ? (
            <CreateHierarchyPanel
              onSave={(body) => createConfig.mutate(body)}
              onCancel={() => setIsCreating(false)}
              saving={createConfig.isPending}
            />
          ) : selectedId != null ? (
            detailLoading ? (
              <div className='space-y-4 p-6'>
                <Skeleton className='h-16 w-full' />
                <Skeleton className='h-40 w-full' />
                <Skeleton className='h-40 w-full' />
              </div>
            ) : selectedConfig ? (
              <HierarchyDetail
                config={selectedConfig}
                isAdmin={isAdmin}
                onDelete={() => {
                  qc.invalidateQueries({ queryKey: ['hierarchy-configs'] })
                  navigate('/hierarchies')
                }}
              />
            ) : (
              <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
                <Network className='mb-2 h-8 w-8 text-slate-300 dark:text-slate-600' />
                <p className='text-[13px] font-medium text-slate-600 dark:text-foreground'>
                  Hierarchy not found
                </p>
                <Link to='/hierarchies' className='mt-2 text-[11px] text-nvr-cyan hover:underline'>
                  Back to list
                </Link>
              </div>
            )
          ) : (
            <NoHierarchySelected isAdmin={isAdmin} onCreate={() => setIsCreating(true)} />
          )}
        </main>
      </div>
    </div>
  )
}
