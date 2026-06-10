import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Copy, Eye, EyeOff, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { DelegationCard } from '@/components/delegation-card'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { UserActivityPanel } from '@/components/user-activity-panel'
import { api, type Role, type User } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatRelative } from '@/lib/utils'

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

export function UserEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { user: currentUser } = useAuth()
  const [showToken, setShowToken] = useState(false)

  const { data: user, isLoading } = useQuery<User>({
    queryKey: ['user', id],
    queryFn: () => api.get<{ data: User }>(`/users/${id}`).then((r) => r.data.data),
    enabled: !!id
  })

  const { data: roles } = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })

  const updateUser = useMutation({
    mutationFn: (body: Partial<User>) => api.patch(`/users/${id}`, body).then((r) => r.data.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', id] })
      queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('User saved')
      navigate('/users')
    },
    onError: () => toast.error('Failed to save user')
  })

  const generateToken = useMutation({
    mutationFn: () =>
      api.post<{ data: { token: string } }>(`/users/${id}/token`).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', id] })
      setShowToken(true)
      toast.success('Token generated')
    },
    onError: () => toast.error('Failed to generate token')
  })

  const revokeToken = useMutation({
    mutationFn: () => api.delete(`/users/${id}/token`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', id] })
      setShowToken(false)
      toast.success('Token revoked')
    },
    onError: () => toast.error('Failed to revoke token')
  })

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const role = fd.get('role') as string
    updateUser.mutate({
      first_name: (fd.get('first_name') as string) || null,
      last_name: (fd.get('last_name') as string) || null,
      role: role === '__none__' ? null : role || null,
      status: fd.get('status') as User['status']
    })
  }

  const displayName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
    : '…'
  const roleName = roles?.find((r) => r.id === user?.role)?.name

  return (
    <>
      {/* Sticky header */}
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2 text-[13px]'>
            <Link
              to='/users'
              className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700'
            >
              <ArrowLeft className='h-3.5 w-3.5' />
              Users
            </Link>
            <span className='text-slate-300'>/</span>
            {isLoading ? (
              <Skeleton className='h-4 w-32' />
            ) : (
              <span className='font-medium text-slate-800'>{displayName}</span>
            )}
          </div>
          <div className='flex items-center gap-2'>
            {id && <RevisionsPanel collection='cms_users' item={id} />}
            {currentUser?.is_admin && id && <UserActivityPanel userId={id} />}
            <Button variant='outline' size='sm' asChild>
              <Link to='/users'>Cancel</Link>
            </Button>
            <Button
              size='sm'
              type='submit'
              form='user-edit-form'
              disabled={isLoading || updateUser.isPending}
            >
              {updateUser.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>

      <div className='p-8'>
        {isLoading || !user ? (
          <div className='space-y-6'>
            <Skeleton className='h-48 w-full rounded-xl' />
            <Skeleton className='h-40 w-full rounded-xl' />
          </div>
        ) : (
          <div className='space-y-6'>
            <form id='user-edit-form' key={user.id} onSubmit={handleSubmit} className='space-y-6'>
              {/* Identity */}
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <h2 className='mb-5 text-[11px] font-medium text-slate-500'>Profile</h2>

                <div className='mb-6 flex items-center gap-4'>
                  <Avatar className='h-12 w-12'>
                    <AvatarFallback className='bg-nvr-navy text-[14px] font-bold text-nvr-cyan'>
                      {initials(user)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className='text-[15px] font-semibold text-slate-900'>{displayName}</p>
                    <div className='mt-0.5 flex items-center gap-2'>
                      <Badge
                        variant={STATUS_VARIANTS[user.status] ?? 'secondary'}
                        className='h-4 px-1.5 text-[10px]'
                      >
                        {user.status}
                      </Badge>
                      {roleName && <span className='text-[12px] text-slate-400'>{roleName}</span>}
                    </div>
                  </div>
                </div>

                <div className='grid gap-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='first_name'>First Name</Label>
                    <Input
                      id='first_name'
                      name='first_name'
                      defaultValue={user.first_name ?? ''}
                      placeholder='First name'
                    />
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='last_name'>Last Name</Label>
                    <Input
                      id='last_name'
                      name='last_name'
                      defaultValue={user.last_name ?? ''}
                      placeholder='Last name'
                    />
                  </div>
                </div>

                <div className='mt-4 space-y-1.5'>
                  <Label>Email</Label>
                  <div className='flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-500'>
                    {user.email}
                  </div>
                  <p className='text-[11px] text-slate-400'>
                    Email is set via Microsoft OIDC and cannot be changed here.
                  </p>
                </div>
              </div>

              {/* Access */}
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <h2 className='mb-5 text-[11px] font-medium text-slate-500'>Access</h2>

                <div className='grid gap-4 sm:grid-cols-2'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='edit-role'>Role</Label>
                    <Select name='role' defaultValue={user.role ?? '__none__'}>
                      <SelectTrigger id='edit-role'>
                        <SelectValue placeholder='No role' />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='__none__'>No role</SelectItem>
                        {roles?.map((r) => (
                          <SelectItem key={r.id} value={r.id}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='edit-status'>Status</Label>
                    <Select name='status' defaultValue={user.status}>
                      <SelectTrigger id='edit-status'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='active'>Active</SelectItem>
                        <SelectItem value='inactive'>Inactive</SelectItem>
                        <SelectItem value='suspended'>Suspended</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              {/* Metadata */}
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <h2 className='mb-5 text-[11px] font-medium text-slate-500'>Details</h2>
                <dl className='space-y-3'>
                  <div className='flex items-center justify-between'>
                    <dt className='text-[12px] text-slate-500'>User ID</dt>
                    <dd className='font-mono text-[11px] text-slate-400'>{user.id}</dd>
                  </div>
                  <div className='flex items-center justify-between border-t border-slate-100 pt-3'>
                    <dt className='text-[12px] text-slate-500'>Created</dt>
                    <dd className='text-[12px] text-slate-600'>{formatDate(user.created_at)}</dd>
                  </div>
                  <div className='flex items-center justify-between border-t border-slate-100 pt-3'>
                    <dt className='text-[12px] text-slate-500'>Last Access</dt>
                    <dd className='text-[12px] text-slate-600'>
                      {user.last_access ? formatRelative(user.last_access) : 'Never'}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Static API token */}
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <h2 className='mb-1 text-[11px] font-medium text-slate-500'>API Token</h2>
                <p className='mb-4 text-[12px] text-slate-400'>
                  Static token for use with{' '}
                  <code className='rounded bg-slate-100 px-1 font-mono text-[11px]'>
                    Authorization: Bearer &lt;token&gt;
                  </code>{' '}
                  or the Nivaro SDK.
                </p>

                {user.static_token ? (
                  <div className='space-y-3'>
                    <div className='flex items-center gap-2'>
                      <div className='flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-700 break-all'>
                        {showToken ? user.static_token : '•'.repeat(20)}
                      </div>
                      <button
                        type='button'
                        onClick={() => setShowToken((v) => !v)}
                        className='shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                        aria-label={showToken ? 'Hide token' : 'Reveal token'}
                      >
                        {showToken ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                      </button>
                      {showToken && (
                        <button
                          type='button'
                          onClick={() => {
                            navigator.clipboard.writeText(user.static_token!)
                            toast.success('Copied to clipboard')
                          }}
                          className='shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800'
                          aria-label='Copy token'
                        >
                          <Copy className='h-4 w-4' />
                        </button>
                      )}
                    </div>
                    <div className='flex gap-2'>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => generateToken.mutate()}
                        disabled={generateToken.isPending}
                        className='gap-1.5 text-[12px]'
                      >
                        <RefreshCw className='h-3.5 w-3.5' />
                        Regenerate
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => revokeToken.mutate()}
                        disabled={revokeToken.isPending}
                        className='gap-1.5 text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
                      >
                        <Trash2 className='h-3.5 w-3.5' />
                        Revoke
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    onClick={() => generateToken.mutate()}
                    disabled={generateToken.isPending}
                    className='gap-1.5 text-[12px]'
                  >
                    <RefreshCw className='h-3.5 w-3.5' />
                    {generateToken.isPending ? 'Generating…' : 'Generate Token'}
                  </Button>
                )}
              </div>
            </form>

            {/* Delegation (own save, outside the profile form) */}
            <DelegationCard user={user} mode='admin' />
          </div>
        )}
      </div>
    </>
  )
}
