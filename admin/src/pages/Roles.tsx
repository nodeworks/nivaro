import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Filter,
  Plus,
  Search,
  Shield,
  Trash2,
  Users,
  X
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type User = {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  status: string
  last_access: string | null
}
type Role = {
  id: string
  name: string
  description: string | null
  admin_access: boolean
  app_access: boolean
}
type RowCondition = { field: string; op: string; value?: string }
type Policy = {
  id: number
  role: string
  collection: string
  action: string
  row_filter?: RowCondition[] | null
}
type Collection = { collection: string; display_name: string | null }
type ActiveTab = 'permissions' | 'members'

const ACTIONS = ['create', 'read', 'update', 'delete'] as const
type Action = (typeof ACTIONS)[number]
const ACTION_LABELS: Record<Action, string> = { create: 'C', read: 'R', update: 'U', delete: 'D' }
const ACTION_TITLES: Record<Action, string> = {
  create: 'Create',
  read: 'Read',
  update: 'Update',
  delete: 'Delete'
}

function initials(u: User): string {
  const f = u.first_name?.charAt(0) ?? ''
  const l = u.last_name?.charAt(0) ?? ''
  return (f + l).toUpperCase() || u.email.charAt(0).toUpperCase()
}

function statusClass(status: string): string {
  if (status === 'active') return 'bg-emerald-100 text-emerald-700'
  if (status === 'suspended') return 'bg-red-100 text-red-700'
  return 'bg-slate-100 text-slate-500'
}

// ─── Members Tab ──────────────────────────────────────────────────────────────

function MembersTab({ roleId }: { roleId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['role-users', roleId],
    queryFn: () => api.get<{ data: User[] }>(`/roles/${roleId}/users`).then((r) => r.data.data)
  })
  const users = data ?? []

  if (isLoading) {
    return (
      <div className='space-y-2 py-1'>
        {[...Array(3)].map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
          <div key={i} className='h-11 rounded-lg bg-slate-100 animate-pulse dark:bg-muted' />
        ))}
      </div>
    )
  }
  if (users.length === 0) {
    return (
      <div className='flex flex-col items-center gap-2 py-10 text-slate-400'>
        <Users className='h-8 w-8 opacity-40' />
        <p className='text-[13px]'>No members assigned to this role</p>
      </div>
    )
  }
  return (
    <div className='divide-y divide-slate-100 rounded-xl border overflow-hidden dark:divide-border dark:border-border'>
      {users.map((u) => (
        <div
          key={u.id}
          className='flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50 transition-colors dark:hover:bg-muted/50'
        >
          <div className='flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-nvr-navy text-nvr-cyan text-xs font-bold select-none'>
            {initials(u)}
          </div>
          <div className='flex-1 min-w-0'>
            <p className='text-[13px] font-medium text-slate-900 truncate dark:text-foreground'>
              {[u.first_name, u.last_name].filter(Boolean).join(' ') || '—'}
            </p>
            <p className='text-[11px] text-slate-500 truncate dark:text-muted-foreground'>
              {u.email}
            </p>
          </div>
          <span
            className={cn(
              'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize',
              statusClass(u.status)
            )}
          >
            {u.status}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── Row-Level Security ───────────────────────────────────────────────────────

const RLS_OPS: { value: string; label: string }[] = [
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'not equals' },
  { value: 'gt', label: 'greater than' },
  { value: 'gte', label: 'greater or equal' },
  { value: 'lt', label: 'less than' },
  { value: 'lte', label: 'less or equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'in (comma list)' },
  { value: 'null', label: 'is empty' },
  { value: 'nnull', label: 'is not empty' }
]

const NO_VALUE_OPS = new Set(['null', 'nnull'])

function OpCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const selected = RLS_OPS.find((o) => o.value === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-[150px] justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : 'Operator…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[170px] p-0' align='start'>
        <Command>
          <CommandList>
            <CommandGroup>
              {RLS_OPS.map((opt) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    onChange(opt.value)
                    setOpen(false)
                  }}
                  className='text-[12px]'
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

function RowFilterEditor({ roleId, policy }: { roleId: string; policy: Policy }) {
  const queryClient = useQueryClient()
  const [conditions, setConditions] = useState<RowCondition[]>(policy.row_filter ?? [])

  const save = useMutation({
    mutationFn: (rowFilter: RowCondition[] | null) =>
      api.patch(`/roles/policies/${policy.id}`, { row_filter: rowFilter }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['role', roleId] })
      toast.success('Row filter saved')
    },
    onError: () => toast.error('Failed to save row filter')
  })

  const update = (idx: number, patch: Partial<RowCondition>) =>
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)))
  const remove = (idx: number) => setConditions((prev) => prev.filter((_, i) => i !== idx))

  const isValid = conditions.every((c) => c.field.trim().length > 0 && c.op.length > 0)

  return (
    <div className='space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
      {conditions.length === 0 ? (
        <p className='text-[12px] text-slate-400 dark:text-muted-foreground'>
          No conditions — this policy applies to all rows.
        </p>
      ) : (
        conditions.map((c, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional editor rows
          <div key={idx} className='flex items-center gap-1.5'>
            <Input
              value={c.field}
              onChange={(e) => update(idx, { field: e.target.value })}
              placeholder='field'
              className='h-8 w-[140px] font-mono text-[12px]'
            />
            <OpCombobox value={c.op} onChange={(op) => update(idx, { op })} />
            {!NO_VALUE_OPS.has(c.op) && (
              <Input
                value={c.value ?? ''}
                onChange={(e) => update(idx, { value: e.target.value })}
                placeholder='value or $CURRENT_USER'
                className='h-8 flex-1 font-mono text-[12px]'
              />
            )}
            <Button
              variant='ghost'
              size='icon'
              className='h-8 w-8 shrink-0 text-slate-400 hover:text-red-500'
              onClick={() => remove(idx)}
            >
              <X className='h-3.5 w-3.5' />
            </Button>
          </div>
        ))
      )}
      <p className='text-[11px] text-slate-400 dark:text-muted-foreground'>
        Conditions are ANDed. Use <code className='font-mono'>$CURRENT_USER</code> or{' '}
        <code className='font-mono'>$CURRENT_ROLE</code> as dynamic values.
      </p>
      <div className='flex items-center gap-2 pt-1'>
        <Button
          size='sm'
          variant='outline'
          className='h-7 text-[12px]'
          onClick={() => setConditions((prev) => [...prev, { field: '', op: 'eq', value: '' }])}
        >
          <Plus className='mr-1 h-3 w-3' /> Add condition
        </Button>
        {conditions.length > 0 && (
          <Button
            size='sm'
            variant='ghost'
            className='h-7 text-[12px] text-slate-500'
            onClick={() => setConditions([])}
          >
            Clear all
          </Button>
        )}
        <div className='flex-1' />
        <Button
          size='sm'
          className='h-7 text-[12px]'
          disabled={!isValid || save.isPending}
          onClick={() => save.mutate(conditions.length ? conditions : null)}
        >
          {save.isPending ? 'Saving…' : 'Save filter'}
        </Button>
      </div>
    </div>
  )
}

function RowFilterSection({ roleId, policies }: { roleId: string; policies: Policy[] }) {
  const [open, setOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const sorted = [...policies].sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.action.localeCompare(b.action)
  )
  const filteredCount = policies.filter((p) => (p.row_filter?.length ?? 0) > 0).length

  return (
    <div className='rounded-xl border dark:border-border'>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className='flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-slate-50 transition-colors dark:hover:bg-muted/40'
      >
        {open ? (
          <ChevronDown className='h-3.5 w-3.5 text-slate-400' />
        ) : (
          <ChevronRight className='h-3.5 w-3.5 text-slate-400' />
        )}
        <Filter className='h-3.5 w-3.5 text-slate-400' />
        <span className='text-[13px] font-medium text-slate-700 dark:text-foreground'>
          Row-level security
        </span>
        <span className='text-[11px] text-slate-400 dark:text-muted-foreground'>optional</span>
        {filteredCount > 0 && (
          <Badge className='text-[10px] bg-[#00ceff]/10 text-nvr-navy border-[#00ceff]/20 dark:text-[#00ceff]'>
            {filteredCount} filtered
          </Badge>
        )}
      </button>
      {open && (
        <div className='border-t border-slate-100 p-3 space-y-1.5 dark:border-border'>
          {sorted.length === 0 ? (
            <p className='text-[12px] text-slate-400 py-2 text-center dark:text-muted-foreground'>
              No permissions yet — grant a permission above first, then restrict it to specific rows
              here.
            </p>
          ) : (
            sorted.map((p) => {
              const hasFilter = (p.row_filter?.length ?? 0) > 0
              const expanded = expandedId === p.id
              return (
                <div key={p.id}>
                  <button
                    type='button'
                    onClick={() => setExpandedId(expanded ? null : p.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                      expanded
                        ? 'bg-[#00ceff]/10 dark:bg-[#00ceff]/[0.07]'
                        : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                    )}
                  >
                    {expanded ? (
                      <ChevronDown className='h-3 w-3 text-slate-400 shrink-0' />
                    ) : (
                      <ChevronRight className='h-3 w-3 text-slate-400 shrink-0' />
                    )}
                    <span className='font-mono text-[12px] text-slate-700 dark:text-slate-300'>
                      {p.collection}
                    </span>
                    <span className='text-[11px] uppercase tracking-wide text-slate-400'>
                      {p.action}
                    </span>
                    {hasFilter && (
                      <Badge className='text-[10px] bg-[#00ceff]/10 text-nvr-navy border-[#00ceff]/20 dark:text-[#00ceff]'>
                        <Filter className='mr-1 h-2.5 w-2.5' />
                        {p.row_filter?.length}
                      </Badge>
                    )}
                  </button>
                  {expanded && (
                    <div className='mt-1.5 ml-5'>
                      <RowFilterEditor key={`editor-${p.id}`} roleId={roleId} policy={p} />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ─── Permissions Matrix ───────────────────────────────────────────────────────

function PermissionsMatrix({
  roleId,
  isAdmin,
  policies,
  collections
}: {
  roleId: string
  isAdmin: boolean
  policies: Policy[]
  collections: Collection[]
}) {
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')

  const policyMap = new Map<string, number>()
  const filteredKeys = new Set<string>()
  for (const p of policies) {
    policyMap.set(`${p.collection}:${p.action}`, p.id)
    if ((p.row_filter?.length ?? 0) > 0) filteredKeys.add(`${p.collection}:${p.action}`)
  }

  const addPolicy = useMutation({
    mutationFn: ({ collection, action }: { collection: string; action: string }) =>
      api.post<{ data: Policy }>(`/roles/${roleId}/policies`, { collection, action }),
    onMutate: async ({ collection, action }) => {
      await queryClient.cancelQueries({ queryKey: ['role', roleId] })
      const prev = queryClient.getQueryData<Role & { policies: Policy[] }>(['role', roleId])
      if (prev) {
        queryClient.setQueryData(['role', roleId], {
          ...prev,
          policies: [...prev.policies, { id: -Date.now(), role: roleId, collection, action }]
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['role', roleId], ctx.prev)
      toast.error('Failed to add permission')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['role', roleId] })
  })

  const removePolicy = useMutation({
    mutationFn: (policyId: number) => api.delete(`/roles/policies/${policyId}`),
    onMutate: async (policyId) => {
      await queryClient.cancelQueries({ queryKey: ['role', roleId] })
      const prev = queryClient.getQueryData<Role & { policies: Policy[] }>(['role', roleId])
      if (prev) {
        queryClient.setQueryData(['role', roleId], {
          ...prev,
          policies: prev.policies.filter((p) => p.id !== policyId)
        })
      }
      return { prev }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['role', roleId], ctx.prev)
      toast.error('Failed to remove permission')
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['role', roleId] })
  })

  const handleToggle = (collection: string, action: Action, currentlyChecked: boolean) => {
    if (isAdmin) return
    if (currentlyChecked) {
      const id = policyMap.get(`${collection}:${action}`)
      if (id !== undefined) removePolicy.mutate(id)
    } else {
      addPolicy.mutate({ collection, action })
    }
  }

  const q = search.toLowerCase().trim()
  const filteredCollections = q
    ? collections.filter(
        (c) =>
          c.collection.toLowerCase().includes(q) || (c.display_name ?? '').toLowerCase().includes(q)
      )
    : collections

  type MatrixRow = { key: string; displayName: string | null }
  const allRows: MatrixRow[] = [
    { key: '*', displayName: null },
    ...filteredCollections.map((c) => ({ key: c.collection, displayName: c.display_name }))
  ]
  const visibleRows = q ? allRows.filter((r) => r.key !== '*') : allRows
  const isBusy = addPolicy.isPending || removePolicy.isPending

  return (
    <div className='space-y-3'>
      <div className='relative'>
        <Search className='absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none' />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder='Filter collections…'
          className='pl-8 h-8 text-[12px]'
        />
      </div>
      {isAdmin && (
        <div className='flex items-center gap-2 rounded-lg bg-[#00ceff]/10 border border-[#00ceff]/30 px-3 py-2'>
          <Shield className='h-3.5 w-3.5 text-[#00ceff] shrink-0' />
          <p className='text-[12px] text-slate-700 dark:text-foreground'>
            Admin roles have full access to all collections.
          </p>
        </div>
      )}
      <div className='rounded-xl border overflow-hidden dark:border-border'>
        <table className='w-full text-xs border-collapse'>
          <thead>
            <tr className='bg-slate-50 border-b border-slate-200 dark:bg-muted/30 dark:border-border'>
              <th className='text-left px-3 py-2 text-slate-500 font-medium text-[11px]'>
                Collection
              </th>
              {ACTIONS.map((a) => (
                <th
                  key={a}
                  title={ACTION_TITLES[a]}
                  className='px-3 py-2 text-center text-slate-500 font-semibold tracking-widest uppercase w-10 min-w-[2.5rem] select-none text-[11px]'
                >
                  {ACTION_LABELS[a]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={5} className='px-3 py-6 text-center text-[12px] text-slate-400'>
                  No collections match &quot;{search}&quot;
                </td>
              </tr>
            ) : (
              visibleRows.map((row, idx) => {
                const isWildcard = row.key === '*'
                return (
                  <tr
                    key={row.key}
                    className={cn(
                      'border-b border-slate-100 last:border-0 transition-colors hover:bg-blue-50/40 dark:border-border',
                      idx % 2 === 0 ? 'bg-white dark:bg-card' : 'bg-slate-50/60 dark:bg-muted/20'
                    )}
                  >
                    <td className='px-3 py-1.5'>
                      <span
                        className={cn(
                          'font-mono',
                          isWildcard
                            ? 'text-nvr-navy font-semibold dark:text-[#00ceff]'
                            : 'text-slate-700 dark:text-slate-300'
                        )}
                      >
                        {row.key}
                      </span>
                      {!isWildcard && row.displayName && (
                        <span className='ml-2 text-slate-400 font-sans text-[11px]'>
                          {row.displayName}
                        </span>
                      )}
                      {isWildcard && (
                        <span className='ml-2 text-slate-400 font-sans text-[11px]'>
                          all collections
                        </span>
                      )}
                    </td>
                    {ACTIONS.map((action) => {
                      const checked = isAdmin || policyMap.has(`${row.key}:${action}`)
                      const hasFilter = filteredKeys.has(`${row.key}:${action}`)
                      return (
                        <td key={action} className='px-3 py-1.5 text-center'>
                          <span className='relative inline-flex'>
                            <input
                              type='checkbox'
                              checked={checked}
                              disabled={isAdmin || isBusy}
                              onChange={() => handleToggle(row.key, action, checked)}
                              className='h-4 w-4 rounded accent-nvr-cyan cursor-pointer disabled:cursor-not-allowed disabled:opacity-60'
                              aria-label={`${ACTION_TITLES[action]} on ${row.key}`}
                            />
                            {hasFilter && (
                              <Filter
                                className='absolute -right-3 top-0.5 h-2.5 w-2.5 text-[#00ceff]'
                                aria-label='Row filter active'
                              />
                            )}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {!isAdmin && <RowFilterSection roleId={roleId} policies={policies} />}
    </div>
  )
}

// ─── List item ────────────────────────────────────────────────────────────────

function RoleListItem({
  role,
  selected,
  onClick
}: {
  role: Role
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
        <div className='flex items-center gap-2 mb-0.5'>
          <span
            className={cn(
              'flex-1 truncate text-[13px] font-medium',
              selected
                ? 'text-slate-900 dark:text-foreground'
                : 'text-slate-700 dark:text-slate-300'
            )}
          >
            {role.name}
          </span>
          {role.admin_access && (
            <Badge className='text-[10px] bg-[#00ceff]/10 text-nvr-navy border-[#00ceff]/20 dark:text-[#00ceff]'>
              Admin
            </Badge>
          )}
        </div>
        {role.description && (
          <p className='truncate text-[11px] text-slate-400 dark:text-muted-foreground'>
            {role.description}
          </p>
        )}
      </button>
    </li>
  )
}

// ─── Role detail panel ────────────────────────────────────────────────────────

function RoleDetail({ role, onDelete }: { role: Role; onDelete: () => void }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('permissions')
  const [confirmDelete, setConfirmDelete] = useState(false)

  const deleteRole = useMutation({
    mutationFn: () => api.delete(`/roles/${role.id}`),
    onSuccess: () => {
      onDelete()
      toast.success('Role deleted')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to delete role')
      setConfirmDelete(false)
    }
  })

  const { data: roleDetail, isLoading: detailLoading } = useQuery({
    queryKey: ['role', role.id],
    queryFn: () =>
      api.get<{ data: Role & { policies: Policy[] } }>(`/roles/${role.id}`).then((r) => r.data.data)
  })

  const { data: collectionsData, isLoading: collectionsLoading } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api.get<{ data: Collection[] }>('/collections?tables_only=true').then((r) => r.data.data)
  })

  const policies: Policy[] = roleDetail?.policies ?? []
  const collections: Collection[] = collectionsData ?? []

  return (
    <div className='flex flex-col h-full'>
      {/* Role header */}
      <div className='shrink-0 border-b border-slate-100 px-6 py-4 dark:border-border'>
        <div className='flex items-center gap-2.5'>
          <div className='flex h-8 w-8 items-center justify-center rounded-lg bg-nvr-navy shrink-0'>
            <Shield className='h-3.5 w-3.5 text-nvr-cyan' />
          </div>
          <div className='flex-1 min-w-0'>
            <div className='flex items-center gap-2'>
              <h2 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
                {role.name}
              </h2>
              {role.admin_access && (
                <Badge className='text-[10px] bg-[#00ceff]/10 text-nvr-navy border-[#00ceff]/20 dark:text-[#00ceff]'>
                  Admin
                </Badge>
              )}
              {!role.app_access && (
                <Badge variant='secondary' className='text-[10px]'>
                  No app access
                </Badge>
              )}
            </div>
            {role.description && (
              <p className='text-[12px] text-muted-foreground mt-0.5'>{role.description}</p>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className='shrink-0 flex border-b border-slate-100 bg-slate-50/50 dark:bg-muted/20 dark:border-border'>
        {(['permissions', 'members'] as ActiveTab[]).map((tab) => (
          <button
            key={tab}
            type='button'
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-5 py-2.5 text-[13px] font-medium capitalize transition-colors border-b-2 -mb-px',
              activeTab === tab
                ? 'border-[#00ceff] text-nvr-navy bg-white dark:text-foreground dark:bg-card'
                : 'border-transparent text-slate-500 hover:text-slate-700 hover:bg-white/60 dark:hover:text-slate-300'
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className='flex-1 overflow-y-auto p-5'>
        {activeTab === 'permissions' ? (
          detailLoading || collectionsLoading ? (
            <div className='space-y-2'>
              {[...Array(5)].map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton
                <div key={i} className='h-8 rounded bg-slate-100 animate-pulse dark:bg-muted' />
              ))}
            </div>
          ) : (
            <PermissionsMatrix
              roleId={role.id}
              isAdmin={role.admin_access}
              policies={policies}
              collections={collections}
            />
          )
        ) : (
          <MembersTab roleId={role.id} />
        )}
      </div>

      {/* Delete zone */}
      <div className='shrink-0 border-t border-slate-100 px-5 py-3 flex justify-end bg-slate-50/50 dark:border-border dark:bg-muted/20'>
        {confirmDelete ? (
          <div className='flex items-center gap-2 text-[13px]'>
            <span className='text-slate-600 dark:text-slate-400'>Delete this role?</span>
            <Button
              size='sm'
              variant='destructive'
              onClick={() => deleteRole.mutate()}
              disabled={deleteRole.isPending}
            >
              {deleteRole.isPending ? 'Deleting…' : 'Confirm'}
            </Button>
            <Button size='sm' variant='outline' onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size='sm'
            variant='ghost'
            className='text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30'
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className='h-3.5 w-3.5 mr-1' /> Delete Role
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Create role panel ────────────────────────────────────────────────────────

function CreateRolePanel({
  onSave,
  onCancel,
  saving
}: {
  onSave: (data: { name: string; description: string; admin_access: boolean }) => void
  onCancel: () => void
  saving: boolean
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [adminAccess, setAdminAccess] = useState(false)

  return (
    <div className='p-6'>
      <div className='max-w-sm'>
        <h2 className='mb-5 text-[15px] font-semibold text-slate-900 dark:text-foreground'>
          New role
        </h2>
        <div className='space-y-4'>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. Editor'
              className='h-8 text-[13px]'
            />
          </div>
          <div className='space-y-1.5'>
            <Label className='text-[12px]'>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='Optional'
              className='h-8 text-[13px]'
            />
          </div>
          <div className='flex items-center gap-2'>
            <input
              type='checkbox'
              id='admin_access_new'
              checked={adminAccess}
              onChange={(e) => setAdminAccess(e.target.checked)}
              className='h-4 w-4 accent-nvr-cyan'
            />
            <Label htmlFor='admin_access_new' className='text-[13px] font-normal cursor-pointer'>
              Admin access — full control over all collections
            </Label>
          </div>
          <div className='flex gap-2 pt-1'>
            <Button
              size='sm'
              disabled={!name.trim() || saving}
              onClick={() => onSave({ name, description, admin_access: adminAccess })}
            >
              {saving ? 'Creating…' : 'Create role'}
            </Button>
            <Button size='sm' variant='ghost' onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function NoRoleSelected({ onCreate }: { onCreate: () => void }) {
  return (
    <div className='flex h-full flex-col items-center justify-center p-8 text-center'>
      <div className='flex h-12 w-12 items-center justify-center rounded-xl bg-slate-100 dark:bg-muted'>
        <Shield className='h-5 w-5 text-slate-400' />
      </div>
      <p className='mt-3 text-[13px] font-medium text-slate-600 dark:text-foreground'>
        Select a role
      </p>
      <button
        type='button'
        onClick={onCreate}
        className='mt-2 text-[11px] text-[#00ceff] hover:underline'
      >
        Or create a new one
      </button>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function RolesPage() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [search, setSearch] = useState('')

  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })

  const createRole = useMutation({
    mutationFn: (body: { name: string; description: string; admin_access: boolean }) =>
      api.post<{ data: Role }>('/roles', body).then((r) => r.data.data),
    onSuccess: (role) => {
      queryClient.invalidateQueries({ queryKey: ['roles'] })
      setIsCreating(false)
      setSelectedId(role.id)
      toast.success('Role created')
    },
    onError: () => toast.error('Failed to create role')
  })

  const roles = data ?? []
  const filtered = search.trim()
    ? roles.filter(
        (r) =>
          r.name.toLowerCase().includes(search.toLowerCase()) ||
          (r.description ?? '').toLowerCase().includes(search.toLowerCase())
      )
    : roles

  const selectedRole = roles.find((r) => r.id === selectedId) ?? null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <div className='sticky top-0 z-10 shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <h1 className='text-[17px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Roles &amp; Permissions
            </h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500 dark:bg-muted dark:text-muted-foreground'>
                {roles.length}
              </span>
            )}
          </div>
          <Button
            size='sm'
            onClick={() => {
              setIsCreating(true)
              setSelectedId(null)
            }}
          >
            <Plus className='mr-1.5 h-3.5 w-3.5' /> New Role
          </Button>
        </div>
      </div>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='flex w-[272px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='shrink-0 border-b border-slate-100 p-3 dark:border-border'>
            <div className='relative'>
              <Search className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
              <Input
                className='h-8 pl-8 text-[13px]'
                placeholder='Filter roles…'
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          <div className='flex-1 overflow-y-auto'>
            {isLoading ? (
              <div className='p-3 space-y-px'>
                {[1, 2, 3].map((k) => (
                  <div key={k} className='rounded p-3'>
                    <Skeleton className='mb-1.5 h-4 w-2/3' />
                    <Skeleton className='h-3 w-1/2' />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className='flex flex-col items-center justify-center p-8 text-center'>
                <Shield className='mb-2 h-7 w-7 text-slate-300 dark:text-slate-600' />
                <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
                  {search ? 'No matching roles' : 'No roles yet'}
                </p>
              </div>
            ) : (
              <ul className='divide-y divide-slate-100 dark:divide-border'>
                {filtered.map((role) => (
                  <RoleListItem
                    key={role.id}
                    role={role}
                    selected={!isCreating && selectedId === role.id}
                    onClick={() => {
                      setSelectedId(role.id)
                      setIsCreating(false)
                    }}
                  />
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className='flex-1 overflow-hidden bg-slate-50 dark:bg-background'>
          {isCreating ? (
            <CreateRolePanel
              onSave={(body) => createRole.mutate(body)}
              onCancel={() => setIsCreating(false)}
              saving={createRole.isPending}
            />
          ) : selectedRole ? (
            <RoleDetail
              role={selectedRole}
              onDelete={() => {
                queryClient.invalidateQueries({ queryKey: ['roles'] })
                setSelectedId(null)
              }}
            />
          ) : (
            <NoRoleSelected onCreate={() => setIsCreating(true)} />
          )}
        </div>
      </div>
    </div>
  )
}
