import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { Column } from '@/components/data-table'
import { DataTable } from '@/components/data-table'
import { Badge } from '@/components/ui/badge'
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
import { api, type User } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatNumber, formatRelative } from '@/lib/utils'

type Role = { id: string; name: string }

const STATUS_VARIANTS: Record<string, 'success' | 'destructive' | 'secondary'> = {
  active: 'success',
  suspended: 'destructive',
  inactive: 'secondary'
}

function initials(user: User): string {
  if (user.first_name && user.last_name)
    return `${user.first_name[0]}${user.last_name[0]}`.toUpperCase()
  if (user.first_name) return user.first_name.slice(0, 2).toUpperCase()
  return user.email.slice(0, 2).toUpperCase()
}

export function UsersPage() {
  const { user: authUser } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const limit = 25

  const [showCreate, setShowCreate] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['users', page, search, sort, statusFilter],
    queryFn: () =>
      api
        .get('/users', {
          params: {
            limit,
            offset: (page - 1) * limit,
            search: search || undefined,
            sort: sort || undefined,
            filter: statusFilter ? JSON.stringify({ status: { _eq: statusFilter } }) : undefined
          }
        })
        .then((r) => r.data)
  })

  const { data: rolesData } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })

  const roles: Role[] = rolesData ?? []
  const users: User[] = data?.data ?? []
  const total: number = data?.total ?? 0

  const roleName = (roleId: string | null) => roles.find((r) => r.id === roleId)?.name ?? '—'

  const createUser = useMutation({
    mutationFn: (body: { email: string; first_name: string; last_name: string; role: string }) =>
      api.post('/users', body).then((r) => r.data.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setShowCreate(false)
      toast.success('User created')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Failed to create user')
    }
  })

  const deleteUser = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['users'] })
      setPendingDelete(null)
      toast.success('User deleted')
    },
    onError: () => toast.error('Failed to delete user')
  })

  const handleCreateSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const role = fd.get('role') as string
    createUser.mutate({
      email: fd.get('email') as string,
      first_name: fd.get('first_name') as string,
      last_name: fd.get('last_name') as string,
      role: role === '__none__' ? '' : role
    })
  }

  const columns: Column<User>[] = [
    {
      key: 'name',
      header: 'User',
      sortable: false,
      render: (user) => (
        <div className='flex items-center gap-3'>
          <div className='flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-nvr-navy text-[10px] font-bold text-nvr-cyan'>
            {initials(user)}
          </div>
          <div>
            <p className='text-[13px] font-medium text-slate-800'>
              {[user.first_name, user.last_name].filter(Boolean).join(' ') || '—'}
            </p>
            <p className='text-[11px] text-slate-400'>{user.email}</p>
          </div>
        </div>
      )
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (user) => <span className='text-[13px] text-slate-600'>{roleName(user.role)}</span>
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: (user) => (
        <Badge
          variant={STATUS_VARIANTS[user.status] ?? 'secondary'}
          className='h-4 px-1.5 text-[10px] capitalize'
        >
          {user.status}
        </Badge>
      )
    },
    {
      key: 'last_access',
      header: 'Last Access',
      sortable: true,
      render: (user) => (
        <span className='text-[13px] text-slate-500'>
          {user.last_access ? formatRelative(String(user.last_access)) : 'Never'}
        </span>
      )
    },
    {
      key: 'actions',
      header: '',
      sortable: false,
      headerClassName: 'w-20',
      render: (user) => (
        <div className='flex items-center gap-1'>
          {pendingDelete === user.id ? (
            <div className='flex items-center gap-1'>
              <button
                type='button'
                className='rounded bg-red-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-red-600'
                onClick={(e) => {
                  e.stopPropagation()
                  deleteUser.mutate(user.id)
                }}
              >
                Confirm
              </button>
              <button
                type='button'
                className='rounded border px-2 py-0.5 text-[11px] hover:bg-slate-50'
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingDelete(null)
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type='button'
              className='rounded-lg p-1.5 text-slate-400 opacity-0 transition-[opacity,colors] group-hover:opacity-100 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30'
              onClick={(e) => {
                e.stopPropagation()
                setPendingDelete(user.id)
              }}
              disabled={user.id === authUser?.id}
              aria-label={user.id === authUser?.id ? 'Cannot delete yourself' : 'Delete user'}
            >
              <Trash2 className='h-3.5 w-3.5' />
            </button>
          )}
        </div>
      )
    }
  ]

  return (
    <>
      {/* Page header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-3'>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900'>Users</h1>
            {data && (
              <span className='inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500'>
                {formatNumber(total)}
              </span>
            )}
          </div>
          <Button size='sm' onClick={() => setShowCreate(true)}>
            <Plus className='mr-1.5 h-3.5 w-3.5' /> Add User
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className='p-8'>
        <DataTable
          columns={columns}
          rows={users}
          rowKey={(u) => u.id}
          total={total}
          page={page}
          limit={limit}
          isLoading={isLoading}
          sort={sort}
          onSortChange={(s) => {
            setSort(s)
            setPage(1)
          }}
          onPageChange={setPage}
          onRowClick={(user) => navigate(`/users/${user.id}`)}
          searchValue={search}
          onSearchChange={(v) => {
            setSearch(v)
            setPage(1)
          }}
          searchPlaceholder='Search users…'
          filterDefs={[
            {
              key: 'status',
              placeholder: 'All statuses',
              options: [
                { label: 'Active', value: 'active' },
                { label: 'Inactive', value: 'inactive' },
                { label: 'Suspended', value: 'suspended' }
              ]
            }
          ]}
          filterValues={{ status: statusFilter }}
          onFilterChange={(key, val) => {
            if (key === 'status') {
              setStatusFilter(val)
              setPage(1)
            }
          }}
          emptyMessage='No users found.'
        />
      </div>

      {/* Create modal */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add User</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreateSubmit}>
            <div className='space-y-4 px-6 pb-6'>
              <div className='grid grid-cols-2 gap-3'>
                <div className='space-y-1.5'>
                  <Label htmlFor='first_name'>First Name</Label>
                  <Input id='first_name' name='first_name' placeholder='Jane' />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='last_name'>Last Name</Label>
                  <Input id='last_name' name='last_name' placeholder='Smith' />
                </div>
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='email'>
                  Email <span className='text-red-500'>*</span>
                </Label>
                <Input
                  id='email'
                  name='email'
                  type='email'
                  required
                  placeholder='jane@example.com'
                />
              </div>
              <div className='space-y-1.5'>
                <Label htmlFor='create-role'>Role</Label>
                <Select name='role' defaultValue='__none__'>
                  <SelectTrigger id='create-role'>
                    <SelectValue placeholder='Select a role' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='__none__'>No role</SelectItem>
                    {roles.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type='submit' disabled={createUser.isPending}>
                {createUser.isPending ? 'Creating…' : 'Add User'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
