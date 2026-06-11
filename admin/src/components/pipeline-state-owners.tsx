import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Settings, Trash2, UserPlus, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FieldPicker, type PickedField } from '@/components/field-picker'
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
import { api, type CMSField, type CMSRelation, type PipelineOwnerGroup, type User } from '@/lib/api'
import { findM2ORelation, findO2MRelation, renderDisplayTemplate } from '@/lib/relations'

type FilterRow = { field: string; op: string; value: string }

interface PipelineStateOwnersProps {
  stateId: string
  stateName: string
  templateId: string
  collection?: string
}

const OPS_BY_FIELD_TYPE: Record<string, { label: string; value: string }[]> = {
  string: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' }
  ],
  text: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' }
  ],
  integer: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' },
    { label: '<', value: 'lt' },
    { label: '≤', value: 'lte' },
    { label: '>', value: 'gt' },
    { label: '≥', value: 'gte' }
  ],
  decimal: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' },
    { label: '<', value: 'lt' },
    { label: '≤', value: 'lte' },
    { label: '>', value: 'gt' },
    { label: '≥', value: 'gte' }
  ],
  float: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' },
    { label: '<', value: 'lt' },
    { label: '≤', value: 'lte' },
    { label: '>', value: 'gt' },
    { label: '≥', value: 'gte' }
  ],
  boolean: [
    { label: '= true', value: 'eq' },
    { label: '= false', value: 'neq' }
  ],
  date: [
    { label: '=', value: 'eq' },
    { label: 'before', value: 'lt' },
    { label: 'after', value: 'gt' }
  ],
  datetime: [
    { label: '=', value: 'eq' },
    { label: 'before', value: 'lt' },
    { label: 'after', value: 'gt' }
  ],
  timestamp: [
    { label: '=', value: 'eq' },
    { label: 'before', value: 'lt' },
    { label: 'after', value: 'gt' }
  ],
  uuid: [
    { label: '=', value: 'eq' },
    { label: '≠', value: 'neq' }
  ]
}

function getFieldOps(type: string) {
  return OPS_BY_FIELD_TYPE[type] ?? OPS_BY_FIELD_TYPE.string
}

interface OwnerFilterRowProps {
  row: FilterRow
  fields: CMSField[]
  relations: CMSRelation[]
  collection: string
  onChange: (row: FilterRow) => void
  onRemove: () => void
}

function M2OValuePicker({
  relatedCollection,
  value,
  onChange
}: {
  relatedCollection: string
  value: string
  onChange: (v: string) => void
}) {
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [inputVal, setInputVal] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const { data: relMeta } = useQuery({
    queryKey: ['collection-meta', relatedCollection],
    queryFn: () => api.get(`/collections/${relatedCollection}`).then((r) => r.data.data)
  })
  const displayTemplate: string | null = relMeta?.display_template ?? null

  function getItemLabel(item: Record<string, unknown>): string {
    return renderDisplayTemplate(displayTemplate, item)
  }

  const { data: items, isLoading } = useQuery({
    queryKey: ['items-picker', relatedCollection, search],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown>[] }>(`/items/${relatedCollection}`, {
          params: { limit: 30, search: search || undefined }
        })
        .then((r) => r.data.data),
    enabled: open
  })

  const { data: currentItem } = useQuery({
    queryKey: ['item-single', relatedCollection, value],
    queryFn: () =>
      api
        .get<{ data: Record<string, unknown> }>(`/items/${relatedCollection}/${value}`)
        .then((r) => r.data.data),
    enabled: !!value
  })

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className='relative' ref={containerRef}>
      <Input
        value={open ? inputVal : currentItem ? getItemLabel(currentItem) : value}
        onChange={(e) => {
          setInputVal(e.target.value)
          setSearch(e.target.value)
        }}
        onFocus={() => {
          setOpen(true)
          setInputVal('')
        }}
        placeholder='Search…'
        className='h-8 text-[12px] w-[160px]'
      />
      {open && (
        <div className='absolute z-50 top-full mt-0.5 max-h-48 w-full min-w-[200px] overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg'>
          {isLoading ? (
            <div className='flex items-center justify-center py-3'>
              <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />
            </div>
          ) : (items ?? []).length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            (items ?? []).map((item) => (
              <button
                key={String(item.id)}
                type='button'
                onClick={() => {
                  onChange(String(item.id))
                  setOpen(false)
                  setInputVal('')
                  setSearch('')
                }}
                className='w-full px-3 py-1.5 text-left text-[13px] text-slate-700 hover:bg-slate-50'
              >
                {getItemLabel(item)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function OwnerFilterRow({
  row,
  fields,
  relations,
  collection,
  onChange,
  onRemove
}: OwnerFilterRowProps) {
  const selectedField = fields.find((f) => f.field === row.field)
  const m2oRel =
    row.field && collection ? (findM2ORelation(relations, collection, row.field) ?? null) : null
  const m2mRel =
    !m2oRel && row.field && collection
      ? (relations.find(
          (r) =>
            r.many_collection === collection &&
            r.many_field === row.field &&
            r.junction_field !== null
        ) ?? null)
      : null
  const o2mRel =
    !m2oRel && !m2mRel && row.field && collection
      ? (findO2MRelation(relations, collection, row.field) ?? null)
      : null
  const relatedCollection =
    m2oRel?.one_collection ?? m2mRel?.one_collection ?? o2mRel?.many_collection ?? null
  const effectiveType = relatedCollection ? 'uuid' : (selectedField?.type ?? 'string')

  return (
    <div className='flex flex-wrap items-center gap-2'>
      <FieldPicker
        collection={collection}
        fields={fields}
        relations={relations}
        value={row.field}
        onChange={(picked: PickedField) => {
          const fieldName = picked.path.join('.')
          onChange({ field: fieldName, op: 'eq', value: '' })
        }}
      />

      <select
        value={row.op}
        onChange={(e) => onChange({ ...row, op: e.target.value })}
        className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[13px] w-[70px]'
      >
        {getFieldOps(effectiveType).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {effectiveType === 'boolean' ? (
        <select
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          className='h-8 rounded-md border border-slate-200 bg-white px-2 text-[13px]'
        >
          <option value=''>Select…</option>
          <option value='true'>True</option>
          <option value='false'>False</option>
        </select>
      ) : effectiveType === 'integer' ||
        effectiveType === 'decimal' ||
        effectiveType === 'float' ? (
        <Input
          type='number'
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          className='h-8 text-[12px] w-[100px]'
        />
      ) : effectiveType === 'date' ||
        effectiveType === 'datetime' ||
        effectiveType === 'timestamp' ? (
        <Input
          type='date'
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          className='h-8 text-[12px] w-[140px]'
        />
      ) : relatedCollection ? (
        <M2OValuePicker
          relatedCollection={relatedCollection}
          value={row.value}
          onChange={(v) => onChange({ ...row, value: v })}
        />
      ) : (
        <Input
          value={row.value}
          onChange={(e) => onChange({ ...row, value: e.target.value })}
          placeholder='value'
          className='h-8 text-[12px]'
        />
      )}

      <button
        type='button'
        onClick={onRemove}
        className='rounded p-1 text-slate-400 hover:text-red-500'
      >
        <Trash2 className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}

function userLabel(u: { first_name: string | null; last_name: string | null; email: string }) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name || u.email
}

function userSelectLabel(u: {
  first_name: string | null
  last_name: string | null
  email: string
}) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
  return name ? `${name} (${u.email})` : u.email
}

function UserCombobox({
  value,
  onChange,
  users,
  placeholder = 'Select a user…'
}: {
  value: string
  onChange: (v: string) => void
  users: User[]
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = users.find((u) => u.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-8 w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 hover:border-slate-300'
        >
          <span
            className={selected ? 'flex-1 truncate text-left' : 'flex-1 text-left text-slate-400'}
          >
            {selected ? userSelectLabel(selected) : placeholder}
          </span>
          <svg
            className='h-3.5 w-3.5 shrink-0 text-slate-400'
            fill='none'
            viewBox='0 0 24 24'
            stroke='currentColor'
            aria-hidden='true'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M8 9l4-4 4 4M16 15l-4 4-4-4'
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent className='w-[280px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search users…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No users found
            </CommandEmpty>
            <CommandGroup>
              {users.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${userSelectLabel(u)} ${u.email}`}
                  onSelect={() => {
                    onChange(value === u.id ? '' : u.id)
                    setOpen(false)
                  }}
                  className='text-[12px]'
                >
                  <svg
                    className={`mr-2 h-3 w-3 shrink-0 ${value === u.id ? 'opacity-100' : 'opacity-0'}`}
                    fill='none'
                    viewBox='0 0 24 24'
                    stroke='currentColor'
                    aria-hidden='true'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M5 13l4 4L19 7'
                    />
                  </svg>
                  {userSelectLabel(u)}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function initials(u: { first_name: string | null; last_name: string | null; email: string }) {
  const first = u.first_name?.[0] ?? ''
  const last = u.last_name?.[0] ?? ''
  const combined = `${first}${last}`.trim()
  return (combined || u.email[0] || '?').toUpperCase()
}

function filterSummary(filters: PipelineOwnerGroup['filters']) {
  if (!filters || filters.length === 0) return 'All records'
  return filters.map((f) => `${f.field} ${f.op} ${String(f.value ?? '')}`).join(', ')
}

export function PipelineStateOwners({
  stateId,
  stateName,
  templateId,
  collection
}: PipelineStateOwnersProps) {
  const queryClient = useQueryClient()
  void templateId
  void stateName

  const { data: colMeta } = useQuery({
    queryKey: ['collection-meta', collection],
    queryFn: () => api.get(`/collections/${collection}`).then((r) => r.data.data),
    enabled: !!collection
  })

  const colFields: CMSField[] = colMeta?.fields?.filter((f: CMSField) => !f.hidden) ?? []
  const colRelations: CMSRelation[] = colMeta?.relations ?? []

  const groupsKey = ['pipeline-owner-groups', stateId]

  const { data: groups, isLoading } = useQuery<PipelineOwnerGroup[]>({
    queryKey: groupsKey,
    queryFn: () =>
      api
        .get<{ data: PipelineOwnerGroup[] }>(`/pipelines/states/${stateId}/owner-groups`)
        .then((r) => r.data.data)
  })

  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'picker'],
    queryFn: () =>
      api
        .get<{ data: User[]; total: number }>('/users', { params: { limit: 200 } })
        .then((r) => r.data.data)
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: groupsKey })

  // ─── Per-group edit state ───────────────────────────────────────────────
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editIsDefault, setEditIsDefault] = useState(false)
  const [editFilters, setEditFilters] = useState<FilterRow[]>([])
  const [addUserId, setAddUserId] = useState('')

  // ─── New group form state ───────────────────────────────────────────────
  const [addingGroup, setAddingGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupIsDefault, setNewGroupIsDefault] = useState(false)
  const [newGroupFilters, setNewGroupFilters] = useState<FilterRow[]>([])
  const [newGroupUserId, setNewGroupUserId] = useState('')

  const openEditor = (g: PipelineOwnerGroup) => {
    setExpandedGroupId(g.id)
    setEditName(g.name ?? '')
    setEditIsDefault(g.is_default)
    setEditFilters(
      (g.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: String(f.value ?? '') }))
    )
    setAddUserId('')
  }

  const closeEditor = () => {
    setExpandedGroupId(null)
    setAddUserId('')
  }

  const resetNewGroup = () => {
    setNewGroupName('')
    setNewGroupIsDefault(false)
    setNewGroupFilters([])
    setNewGroupUserId('')
    setAddingGroup(false)
  }

  const toFilterPayload = (rows: FilterRow[]) =>
    rows
      .filter((f) => f.field.trim())
      .map((f) => ({ field: f.field.trim(), op: f.op, value: f.value }))

  // ─── Mutations ──────────────────────────────────────────────────────────

  const createGroup = useMutation({
    mutationFn: async () => {
      const filters = toFilterPayload(newGroupFilters)
      const created = await api
        .post<{ data: PipelineOwnerGroup }>(`/pipelines/states/${stateId}/owner-groups`, {
          name: newGroupName.trim() || undefined,
          is_default: newGroupIsDefault,
          filters: filters.length > 0 ? filters : undefined
        })
        .then((r) => r.data.data)
      if (newGroupUserId) {
        await api.post(`/pipelines/owner-groups/${created.id}/users`, { user: newGroupUserId })
      }
    },
    onSuccess: () => {
      invalidate()
      resetNewGroup()
      toast.success('Group created')
    },
    onError: () => toast.error('Failed to create group')
  })

  const updateGroup = useMutation({
    mutationFn: (groupId: string) =>
      api.patch(`/pipelines/owner-groups/${groupId}`, {
        name: editName.trim() || null,
        is_default: editIsDefault,
        filters: toFilterPayload(editFilters)
      }),
    onSuccess: () => {
      invalidate()
      toast.success('Group updated')
    },
    onError: () => toast.error('Failed to update group')
  })

  const deleteGroup = useMutation({
    mutationFn: (groupId: string) => api.delete(`/pipelines/owner-groups/${groupId}`),
    onSuccess: () => {
      invalidate()
      closeEditor()
      toast.success('Group deleted')
    },
    onError: () => toast.error('Failed to delete group')
  })

  const addUser = useMutation({
    mutationFn: ({ groupId, user }: { groupId: string; user: string }) =>
      api.post(`/pipelines/owner-groups/${groupId}/users`, { user }),
    onSuccess: () => {
      invalidate()
      setAddUserId('')
    },
    onError: () => toast.error('Failed to add user')
  })

  const removeUser = useMutation({
    mutationFn: (linkId: number) => api.delete(`/pipelines/owner-group-users/${linkId}`),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Failed to remove user')
  })

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between'>
        <span className='text-[12px] font-medium text-slate-600'>Owner Groups</span>
      </div>

      {isLoading ? (
        <p className='text-[12px] text-slate-400'>Loading groups…</p>
      ) : !groups || groups.length === 0 ? (
        <p className='text-[12px] text-slate-400'>
          No owner groups configured — any authenticated user can act as owner for skip evaluation.
        </p>
      ) : (
        <div className='space-y-2'>
          {groups.map((g, idx) => {
            const isExpanded = expandedGroupId === g.id
            return (
              <div key={g.id} className='rounded-lg border border-slate-200 bg-white'>
                <div className='group flex items-start gap-3 px-3 py-2.5'>
                  <div className='min-w-0 flex-1 space-y-1.5'>
                    <div className='flex items-center gap-2 flex-wrap'>
                      <span className='text-[13px] font-medium text-slate-800'>
                        {g.name || `Group ${idx + 1}`}
                      </span>
                      {g.is_default && (
                        <span className='rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-cyan'>
                          default
                        </span>
                      )}
                    </div>
                    <p className='font-mono text-[11px] text-slate-400'>
                      {filterSummary(g.filters)}
                    </p>
                    {g.users.length > 0 && (
                      <div className='flex items-center gap-1 flex-wrap pt-0.5'>
                        {g.users.map((u) => (
                          <span
                            key={u.link_id}
                            title={userSelectLabel(u)}
                            className='flex h-7 w-7 items-center justify-center rounded-full bg-nvr-cyan/10 text-[11px] font-medium text-nvr-cyan'
                          >
                            {initials(u)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
                    <button
                      type='button'
                      onClick={() => (isExpanded ? closeEditor() : openEditor(g))}
                      className='rounded p-1 text-slate-400 hover:text-slate-700'
                      title='Edit group'
                    >
                      <Settings className='h-3.5 w-3.5' />
                    </button>
                    <button
                      type='button'
                      onClick={() => {
                        if (confirm(`Delete group "${g.name || `Group ${idx + 1}`}"?`))
                          deleteGroup.mutate(g.id)
                      }}
                      className='rounded p-1 text-slate-400 hover:text-red-500'
                      title='Delete group'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className='space-y-3 border-t border-slate-100 bg-slate-50 px-3 py-3'>
                    <div className='space-y-1.5'>
                      <Label className='text-[12px]'>Name</Label>
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder='Group name (optional)'
                        className='h-8 text-[13px]'
                      />
                    </div>

                    <label className='flex items-center gap-1.5 cursor-pointer text-[13px]'>
                      <input
                        type='checkbox'
                        checked={editIsDefault}
                        onChange={(e) => setEditIsDefault(e.target.checked)}
                        className='rounded'
                      />
                      Default group
                    </label>

                    <div className='space-y-1.5'>
                      <div className='flex items-center justify-between'>
                        <Label className='text-[12px]'>Filter conditions</Label>
                        <Button
                          type='button'
                          size='sm'
                          variant='ghost'
                          className='h-6 gap-1 text-[11px]'
                          onClick={() =>
                            setEditFilters((f) => [...f, { field: '', op: 'eq', value: '' }])
                          }
                        >
                          <Plus className='h-3 w-3' />
                          Add Filter
                        </Button>
                      </div>
                      {editFilters.length === 0 && (
                        <p className='text-[11px] text-slate-400'>
                          No filters — applies to all records.
                        </p>
                      )}
                      {editFilters.map((f, fi) => (
                        <OwnerFilterRow
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional filter rows
                          key={fi}
                          row={f}
                          fields={colFields}
                          relations={colRelations}
                          collection={collection ?? ''}
                          onChange={(updated) =>
                            setEditFilters((rows) => rows.map((r, i) => (i === fi ? updated : r)))
                          }
                          onRemove={() => setEditFilters((rows) => rows.filter((_, i) => i !== fi))}
                        />
                      ))}
                    </div>

                    <div className='space-y-1.5'>
                      <Label className='text-[12px]'>Users</Label>
                      {g.users.length === 0 ? (
                        <p className='text-[11px] text-slate-400'>No users in this group yet.</p>
                      ) : (
                        <div className='space-y-1'>
                          {g.users.map((u) => (
                            <div
                              key={u.link_id}
                              className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5'
                            >
                              <span className='flex h-6 w-6 items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-medium text-nvr-cyan'>
                                {initials(u)}
                              </span>
                              <span className='min-w-0 flex-1 truncate text-[12px] text-slate-700'>
                                {userLabel(u)}
                              </span>
                              <span className='text-[11px] text-slate-400'>{u.email}</span>
                              <button
                                type='button'
                                onClick={() => removeUser.mutate(u.link_id)}
                                className='rounded p-0.5 text-slate-400 hover:text-red-500'
                                title='Remove user'
                              >
                                <X className='h-3.5 w-3.5' />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className='flex gap-2'>
                        <UserCombobox
                          value={addUserId}
                          onChange={setAddUserId}
                          users={users ?? []}
                          placeholder='Add a user…'
                        />
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          className='h-8 shrink-0 gap-1 text-[12px]'
                          disabled={!addUserId || addUser.isPending}
                          onClick={() => addUser.mutate({ groupId: g.id, user: addUserId })}
                        >
                          <UserPlus className='h-3.5 w-3.5' />
                          Add
                        </Button>
                      </div>
                    </div>

                    <div className='flex items-center justify-end gap-2'>
                      <Button
                        type='button'
                        size='sm'
                        variant='ghost'
                        className='text-[12px]'
                        onClick={closeEditor}
                      >
                        Cancel
                      </Button>
                      <Button
                        type='button'
                        size='sm'
                        className='text-[12px]'
                        disabled={updateGroup.isPending}
                        onClick={() => updateGroup.mutate(g.id)}
                      >
                        {updateGroup.isPending ? (
                          <Loader2 className='h-3.5 w-3.5 animate-spin' />
                        ) : (
                          'Save Group'
                        )}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {addingGroup ? (
        <div className='space-y-3 rounded-lg border border-slate-200 bg-white p-3'>
          <p className='text-[12px] text-slate-500'>New owner group</p>

          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Name</Label>
            <Input
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              placeholder='Group name (optional)'
              className='h-8 text-[13px]'
            />
          </div>

          <label className='flex items-center gap-1.5 cursor-pointer text-[13px]'>
            <input
              type='checkbox'
              checked={newGroupIsDefault}
              onChange={(e) => setNewGroupIsDefault(e.target.checked)}
              className='rounded'
            />
            Default group
          </label>

          <div className='space-y-1.5'>
            <div className='flex items-center justify-between'>
              <Label className='text-[12px]'>Filter conditions</Label>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-6 gap-1 text-[11px]'
                onClick={() =>
                  setNewGroupFilters((f) => [...f, { field: '', op: 'eq', value: '' }])
                }
              >
                <Plus className='h-3 w-3' />
                Add Filter
              </Button>
            </div>
            {newGroupFilters.length === 0 && (
              <p className='text-[11px] text-slate-400'>No filters — applies to all records.</p>
            )}
            {newGroupFilters.map((f, fi) => (
              <OwnerFilterRow
                // biome-ignore lint/suspicious/noArrayIndexKey: positional filter rows
                key={fi}
                row={f}
                fields={colFields}
                relations={colRelations}
                collection={collection ?? ''}
                onChange={(updated) =>
                  setNewGroupFilters((rows) => rows.map((r, i) => (i === fi ? updated : r)))
                }
                onRemove={() => setNewGroupFilters((rows) => rows.filter((_, i) => i !== fi))}
              />
            ))}
          </div>

          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Initial user (optional)</Label>
            <UserCombobox
              value={newGroupUserId}
              onChange={setNewGroupUserId}
              users={users ?? []}
              placeholder='Select a user…'
            />
          </div>

          <div className='flex items-center justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='text-[12px]'
              onClick={resetNewGroup}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='text-[12px]'
              disabled={createGroup.isPending}
              onClick={() => createGroup.mutate()}
            >
              {createGroup.isPending ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                'Create Group'
              )}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='h-7 gap-1 text-[12px]'
          onClick={() => setAddingGroup(true)}
        >
          <Plus className='h-3 w-3' />
          Add Group
        </Button>
      )}
    </div>
  )
}
