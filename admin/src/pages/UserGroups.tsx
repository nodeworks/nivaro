import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, UserPlus, Users2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { api, type User } from '@/lib/api'
import { useAuth } from '@/lib/auth'

/**
 * User groups (#682) — named user sets, mentionable in comments as
 * "@<slug>". Master-detail: group list left, detail (meta + members) right.
 * Management is admin-only; the API enforces it, the UI hides the controls.
 */

interface UserGroup {
  id: number
  name: string
  slug: string
  description: string | null
  member_count: number
}

interface GroupMember {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
}

function memberLabel(u: { first_name: string | null; last_name: string | null; email: string }) {
  const name = [u.first_name, u.last_name].filter(Boolean).join(' ')
  return name || u.email
}

/** Popover + Command user search — never a native select. */
function AddMemberPicker({
  excludeIds,
  onPick,
  disabled
}: {
  excludeIds: Set<string>
  onPick: (userId: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const { data: users } = useQuery<User[]>({
    queryKey: ['users', 'combobox'],
    queryFn: () => api.get<{ data: User[] }>('/users?limit=200').then((r) => r.data.data),
    enabled: open
  })
  const options = (users ?? []).filter((u) => !excludeIds.has(u.id))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size='sm'
          variant='outline'
          disabled={disabled}
          className='h-7 gap-1.5 text-[12px]'
          data-add-member
        >
          <UserPlus className='h-3.5 w-3.5' /> Add member
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[320px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search users…' className='h-9 text-[13px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No users found
            </CommandEmpty>
            <CommandGroup>
              {options.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.first_name ?? ''} ${u.last_name ?? ''} ${u.email}`}
                  onSelect={() => {
                    onPick(u.id)
                    setOpen(false)
                  }}
                  className='text-[13px]'
                >
                  {memberLabel(u)}
                  <span className='ml-1 truncate text-[11px] text-muted-foreground'>{u.email}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function UserGroupsPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const isAdmin = Boolean(user?.is_admin)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)

  const { data: groups = [], isLoading } = useQuery<UserGroup[]>({
    queryKey: ['user-groups'],
    queryFn: () => api.get<{ data: UserGroup[] }>('/user-groups').then((r) => r.data.data)
  })
  const selected = groups.find((g) => g.id === selectedId) ?? null

  const invalidate = () => qc.invalidateQueries({ queryKey: ['user-groups'] })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between gap-3'>
          <div className='flex items-center gap-3'>
            <Users2 className='h-4 w-4 text-slate-400' />
            <div>
              <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
                User Groups
              </h1>
              <p className='text-[12px] text-muted-foreground'>
                Named user sets — mention a group in comments as @its-slug to notify every member.
              </p>
            </div>
          </div>
          {isAdmin && (
            <Button
              size='sm'
              className='gap-1.5 text-[12px]'
              onClick={() => {
                setCreating(true)
                setSelectedId(null)
              }}
            >
              <Plus className='h-3.5 w-3.5' /> New group
            </Button>
          )}
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          {isLoading ? (
            <p className='p-4 text-[12.5px] text-slate-400'>Loading…</p>
          ) : groups.length === 0 ? (
            <p className='p-4 text-[12.5px] text-slate-400'>No groups yet.</p>
          ) : (
            groups.map((g) => (
              <button
                key={g.id}
                type='button'
                onClick={() => {
                  setSelectedId(g.id)
                  setCreating(false)
                }}
                className={`block w-full border-b border-slate-100 px-4 py-2.5 text-left dark:border-border/60 ${
                  selectedId === g.id ? 'bg-nvr-cyan/10' : 'hover:bg-slate-50 dark:hover:bg-muted/40'
                }`}
              >
                <p className='truncate text-[13px] font-medium text-slate-800 dark:text-foreground'>
                  {g.name}
                </p>
                <p
                  className={`text-[11px] ${selectedId === g.id ? 'text-nvr-navy/70 dark:text-nvr-cyan/80' : 'text-slate-400'}`}
                >
                  @{g.slug} · {g.member_count} member{g.member_count === 1 ? '' : 's'}
                </p>
              </button>
            ))
          )}
        </aside>

        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {creating && isAdmin ? (
            <CreateGroupForm
              onCreated={(id) => {
                setCreating(false)
                setSelectedId(id)
                invalidate()
              }}
              onCancel={() => setCreating(false)}
            />
          ) : selected ? (
            <GroupDetail
              key={selected.id}
              group={selected}
              isAdmin={isAdmin}
              onChanged={invalidate}
              onDeleted={() => {
                setSelectedId(null)
                invalidate()
              }}
            />
          ) : (
            <div className='pt-24 text-center text-slate-400'>
              <Users2 className='mx-auto h-8 w-8 opacity-40' />
              <p className='mt-3 text-[13px]'>
                {groups.length === 0
                  ? isAdmin
                    ? 'Create your first group to get started.'
                    : 'No groups have been created yet.'
                  : 'Select a group to view its members.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function CreateGroupForm({
  onCreated,
  onCancel
}: {
  onCreated: (id: number) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [description, setDescription] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api
        .post<{ data: UserGroup }>('/user-groups', {
          name: name.trim(),
          ...(slug.trim() ? { slug: slug.trim() } : {}),
          ...(description.trim() ? { description: description.trim() } : {})
        })
        .then((r) => r.data.data),
    onSuccess: (g) => {
      toast.success(`Created ${g.name}`)
      onCreated(g.id)
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Create failed')
  })

  return (
    <div className='mx-auto max-w-xl p-6'>
      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>New group</h2>
        <div className='mt-3 space-y-3'>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='ug-name'>
              Name
            </label>
            <Input
              id='ug-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Field Techs'
              className='h-8 text-[13px]'
            />
          </div>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='ug-slug'>
              Slug <span className='font-normal text-slate-400'>(mention handle — blank derives from the name)</span>
            </label>
            <Input
              id='ug-slug'
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder='field-techs'
              className='h-8 font-mono text-[12.5px]'
            />
          </div>
          <div>
            <label className='mb-1 block text-[11.5px] font-medium text-slate-500' htmlFor='ug-desc'>
              Description
            </label>
            <Textarea
              id='ug-desc'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className='text-[13px]'
            />
          </div>
          <div className='flex items-center gap-2 pt-1'>
            <Button
              size='sm'
              className='text-[12px]'
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Create group
            </Button>
            <Button size='sm' variant='ghost' className='text-[12px]' onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function GroupDetail({
  group,
  isAdmin,
  onChanged,
  onDeleted
}: {
  group: UserGroup
  isAdmin: boolean
  onChanged: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(group.name)
  const [slug, setSlug] = useState(group.slug)
  const [description, setDescription] = useState(group.description ?? '')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Keep the editor in sync when the server row changes underneath (rename saved).
  useEffect(() => {
    setName(group.name)
    setSlug(group.slug)
    setDescription(group.description ?? '')
  }, [group.name, group.slug, group.description])

  const { data: members = [] } = useQuery<GroupMember[]>({
    queryKey: ['user-group-members', group.id],
    queryFn: () =>
      api.get<{ data: GroupMember[] }>(`/user-groups/${group.id}/members`).then((r) => r.data.data)
  })

  const dirty =
    name.trim() !== group.name ||
    slug.trim() !== group.slug ||
    description.trim() !== (group.description ?? '')

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/user-groups/${group.id}`, {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim() || null
      }),
    onSuccess: () => {
      toast.success('Group updated')
      onChanged()
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Update failed')
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/user-groups/${group.id}`),
    onSuccess: () => {
      toast.success(`Deleted ${group.name}`)
      onDeleted()
    },
    onError: () => toast.error('Delete failed')
  })

  const addMember = useMutation({
    mutationFn: (userId: string) =>
      api.post(`/user-groups/${group.id}/members`, { user_ids: [userId] }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user-group-members', group.id] })
      onChanged()
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Could not add member')
  })

  const removeMember = useMutation({
    mutationFn: (userId: string) => api.delete(`/user-groups/${group.id}/members/${userId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['user-group-members', group.id] })
      onChanged()
    },
    onError: () => toast.error('Could not remove member')
  })

  return (
    <div className='mx-auto max-w-2xl space-y-4 p-6'>
      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        {isAdmin ? (
          <div className='space-y-3'>
            <div className='grid grid-cols-2 gap-3'>
              <div>
                <label
                  className='mb-1 block text-[11.5px] font-medium text-slate-500'
                  htmlFor='ugd-name'
                >
                  Name
                </label>
                <Input
                  id='ugd-name'
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className='h-8 text-[13px]'
                />
              </div>
              <div>
                <label
                  className='mb-1 block text-[11.5px] font-medium text-slate-500'
                  htmlFor='ugd-slug'
                >
                  Slug
                </label>
                <Input
                  id='ugd-slug'
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  className='h-8 font-mono text-[12.5px]'
                />
              </div>
            </div>
            <div>
              <label
                className='mb-1 block text-[11.5px] font-medium text-slate-500'
                htmlFor='ugd-desc'
              >
                Description
              </label>
              <Textarea
                id='ugd-desc'
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className='text-[13px]'
              />
            </div>
            <div className='flex items-center justify-between pt-1'>
              <div className='flex items-center gap-2'>
                {dirty && (
                  <Button
                    size='sm'
                    className='text-[12px]'
                    disabled={!name.trim() || !slug.trim() || save.isPending}
                    onClick={() => save.mutate()}
                  >
                    Save changes
                  </Button>
                )}
                <span className='text-[11.5px] text-slate-400'>
                  Mention as <span className='font-mono'>@{group.slug}</span>
                </span>
              </div>
              {confirmDelete ? (
                <span className='flex items-center gap-2'>
                  <span className='text-[11.5px] text-slate-500'>Delete this group?</span>
                  <Button
                    size='sm'
                    variant='destructive'
                    className='h-6 text-[11px]'
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    Yes, delete
                  </Button>
                  <Button
                    size='sm'
                    variant='outline'
                    className='h-6 text-[11px]'
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size='sm'
                  variant='ghost'
                  className='text-[12px] text-slate-400 hover:text-red-500'
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete group
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div>
            <h2 className='text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              {group.name}
            </h2>
            <p className='text-[11.5px] text-slate-400'>
              Mention as <span className='font-mono'>@{group.slug}</span>
            </p>
            {group.description && (
              <p className='mt-2 text-[12.5px] text-slate-600 dark:text-slate-300'>
                {group.description}
              </p>
            )}
          </div>
        )}
      </div>

      <div className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <h3 className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            Members{' '}
            <span className='font-normal text-slate-400 tabular-nums'>({members.length})</span>
          </h3>
          {isAdmin && (
            <AddMemberPicker
              excludeIds={new Set(members.map((m) => m.id))}
              onPick={(id) => addMember.mutate(id)}
              disabled={addMember.isPending}
            />
          )}
        </div>
        <div className='mt-3'>
          {members.length === 0 ? (
            <p className='text-[12.5px] text-slate-400'>No members yet.</p>
          ) : (
            members.map((m) => (
              <div
                key={m.id}
                className='flex items-center gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-border/60'
              >
                <div className='min-w-0 flex-1'>
                  <p className='truncate text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>
                    {memberLabel(m)}
                  </p>
                  <p className='truncate text-[11px] text-slate-400'>{m.email}</p>
                </div>
                {isAdmin && (
                  <button
                    type='button'
                    disabled={removeMember.isPending}
                    onClick={() => removeMember.mutate(m.id)}
                    className='rounded p-1 text-slate-300 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30'
                    aria-label={`Remove ${memberLabel(m)}`}
                  >
                    <X className='h-3.5 w-3.5' />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
