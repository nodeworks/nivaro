import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Eye, EyeOff, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { DelegationCard } from '@/components/delegation-card'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { UserActivityPanel } from '@/components/user-activity-panel'
import { api, type Role, type User } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { formatDate, formatRelative } from '@/lib/utils'

function TwoFactorCard() {
  const queryClient = useQueryClient()
  const [setup, setSetup] = useState<{ uri: string; qr: string; secret: string } | null>(null)
  const [verifyCode, setVerifyCode] = useState('')
  const [disabling, setDisabling] = useState(false)
  const [disableCode, setDisableCode] = useState('')

  const { data: status, isLoading } = useQuery<{ enabled: boolean }>({
    queryKey: ['totp-status'],
    queryFn: () =>
      api.get<{ data: { enabled: boolean } }>('/two-factor/status').then((r) => r.data.data)
  })

  const startSetup = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { uri: string; qr: string; secret: string } }>('/two-factor/setup')
        .then((r) => r.data.data),
    onSuccess: (data) => {
      setSetup(data)
      setVerifyCode('')
    },
    onError: () => toast.error('Failed to start two-factor setup')
  })

  const verify = useMutation({
    mutationFn: (token: string) => api.post('/two-factor/verify', { token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['totp-status'] })
      setSetup(null)
      setVerifyCode('')
      toast.success('Two-factor authentication enabled')
    },
    onError: () => toast.error('Invalid verification code')
  })

  const disable = useMutation({
    mutationFn: (token: string) => api.post('/two-factor/disable', { token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['totp-status'] })
      setDisabling(false)
      setDisableCode('')
      toast.success('Two-factor authentication disabled')
    },
    onError: () => toast.error('Invalid verification code')
  })

  const enabled = status?.enabled ?? false

  return (
    <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
      <div className='mb-1 flex items-center justify-between'>
        <h2 className='text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
          Two-Factor Authentication
        </h2>
        {!isLoading &&
          (enabled ? (
            <Badge variant='success' className='h-4 px-1.5 text-[10px]'>
              Enabled
            </Badge>
          ) : (
            <Badge variant='outline' className='h-4 px-1.5 text-[10px] text-slate-400'>
              Disabled
            </Badge>
          ))}
      </div>
      <p className='mb-4 text-[12px] text-slate-400'>
        Protect your account with a time-based one-time password (TOTP) from an authenticator app.
      </p>

      {isLoading ? (
        <Skeleton className='h-9 w-40 rounded-md' />
      ) : enabled ? (
        disabling ? (
          <div className='space-y-3'>
            <div className='space-y-1.5'>
              <Label htmlFor='totp-disable-code'>Enter your current 6-digit code to disable</Label>
              <Input
                id='totp-disable-code'
                inputMode='numeric'
                autoComplete='one-time-code'
                maxLength={6}
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ''))}
                placeholder='123456'
                className='w-40 font-mono tracking-widest'
              />
            </div>
            <div className='flex gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
                disabled={disableCode.length !== 6 || disable.isPending}
                onClick={() => disable.mutate(disableCode)}
              >
                {disable.isPending ? 'Disabling…' : 'Confirm Disable'}
              </Button>
              <Button
                type='button'
                variant='outline'
                size='sm'
                className='text-[12px]'
                onClick={() => {
                  setDisabling(false)
                  setDisableCode('')
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='gap-1.5 text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
            onClick={() => setDisabling(true)}
          >
            <Trash2 className='h-3.5 w-3.5' />
            Disable Two-Factor
          </Button>
        )
      ) : setup ? (
        <div className='space-y-4'>
          <div className='flex flex-col items-start gap-4 sm:flex-row'>
            <img
              src={setup.qr}
              alt='TOTP QR code'
              className='h-40 w-40 shrink-0 rounded-lg border border-slate-200 dark:border-slate-700'
            />
            <div className='space-y-3'>
              <p className='text-[12px] text-slate-500'>
                Scan the QR code with your authenticator app (Google Authenticator, 1Password,
                Authy…), or enter the secret manually:
              </p>
              <code className='block break-all rounded bg-slate-100 px-2 py-1 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300'>
                {setup.secret}
              </code>
              <div className='space-y-1.5'>
                <Label htmlFor='totp-verify-code'>Enter the 6-digit code to confirm</Label>
                <Input
                  id='totp-verify-code'
                  inputMode='numeric'
                  autoComplete='one-time-code'
                  maxLength={6}
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                  placeholder='123456'
                  className='w-40 font-mono tracking-widest'
                />
              </div>
              <div className='flex gap-2'>
                <Button
                  type='button'
                  size='sm'
                  className='text-[12px]'
                  disabled={verifyCode.length !== 6 || verify.isPending}
                  onClick={() => verify.mutate(verifyCode)}
                >
                  {verify.isPending ? 'Verifying…' : 'Verify & Enable'}
                </Button>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='text-[12px]'
                  onClick={() => {
                    setSetup(null)
                    setVerifyCode('')
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='gap-1.5 text-[12px]'
          onClick={() => startSetup.mutate()}
          disabled={startSetup.isPending}
        >
          <ShieldCheck className='h-3.5 w-3.5' />
          {startSetup.isPending ? 'Preparing…' : 'Set up Two-Factor'}
        </Button>
      )}
    </div>
  )
}

function initials(user: User): string {
  if (user.first_name && user.last_name)
    return `${user.first_name[0]}${user.last_name[0]}`.toUpperCase()
  if (user.first_name) return user.first_name.slice(0, 2).toUpperCase()
  return user.email.slice(0, 2).toUpperCase()
}

export function ProfilePage() {
  const { user: currentUser, refetch: refetchMe } = useAuth()
  const queryClient = useQueryClient()
  const [showToken, setShowToken] = useState(false)
  const id = currentUser?.id

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
    mutationFn: (body: { first_name: string | null; last_name: string | null }) =>
      api.patch(`/users/${id}`, body).then((r) => r.data.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user', id] })
      refetchMe()
      toast.success('Profile saved')
    },
    onError: () => toast.error('Failed to save profile')
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
    updateUser.mutate({
      first_name: (fd.get('first_name') as string) || null,
      last_name: (fd.get('last_name') as string) || null
    })
  }

  const displayName = user
    ? [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email
    : '…'
  const roleName = roles?.find((r) => r.id === user?.role)?.name

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-5 dark:border-slate-800 dark:bg-slate-950'>
        <div className='flex items-center justify-between'>
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
            My Profile
          </h1>
          <div className='flex items-center gap-2'>
            {id && <RevisionsPanel collection='cms_users' item={id} />}
            {id && <UserActivityPanel userId={id} />}
            <Button
              size='sm'
              type='submit'
              form='profile-form'
              disabled={isLoading || updateUser.isPending}
            >
              {updateUser.isPending ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </div>

      <div className='p-8'>
        {isLoading || !user ? (
          <div className='mx-auto max-w-2xl space-y-6'>
            <Skeleton className='h-48 w-full rounded-xl' />
            <Skeleton className='h-32 w-full rounded-xl' />
          </div>
        ) : (
          <div className='mx-auto max-w-2xl space-y-6'>
            <form id='profile-form' key={user.id} onSubmit={handleSubmit} className='space-y-6'>
              {/* Identity */}
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
                <h2 className='mb-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                  Profile
                </h2>

                <div className='mb-6 flex items-center gap-4'>
                  <Avatar className='h-12 w-12'>
                    <AvatarFallback className='bg-nvr-navy text-[14px] font-bold text-nvr-cyan'>
                      {initials(user)}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <p className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
                      {displayName}
                    </p>
                    <div className='mt-0.5 flex items-center gap-2'>
                      <Badge variant='success' className='h-4 px-1.5 text-[10px]'>
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
                  <div className='flex h-9 items-center rounded-md border border-slate-200 bg-slate-50 px-3 text-[13px] text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400'>
                    {user.email}
                  </div>
                  <p className='text-[11px] text-slate-400'>
                    Email is managed via Microsoft OIDC and cannot be changed here.
                  </p>
                </div>
              </div>

              {/* Details */}
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
                <h2 className='mb-5 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                  Details
                </h2>
                <dl className='space-y-3'>
                  <div className='flex items-center justify-between'>
                    <dt className='text-[12px] text-slate-500'>User ID</dt>
                    <dd className='font-mono text-[11px] text-slate-400'>{user.id}</dd>
                  </div>
                  <div className='flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800'>
                    <dt className='text-[12px] text-slate-500'>Member since</dt>
                    <dd className='text-[12px] text-slate-600 dark:text-slate-300'>
                      {formatDate(user.created_at)}
                    </dd>
                  </div>
                  <div className='flex items-center justify-between border-t border-slate-100 pt-3 dark:border-slate-800'>
                    <dt className='text-[12px] text-slate-500'>Last access</dt>
                    <dd className='text-[12px] text-slate-600 dark:text-slate-300'>
                      {user.last_access ? formatRelative(user.last_access) : 'Never'}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* API Token */}
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900'>
                <h2 className='mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                  API Token
                </h2>
                <p className='mb-4 text-[12px] text-slate-400'>
                  Static token for{' '}
                  <code className='rounded bg-slate-100 px-1 font-mono text-[11px] dark:bg-slate-800'>
                    Authorization: Bearer &lt;token&gt;
                  </code>{' '}
                  or the Nivaro SDK.
                </p>

                {user.static_token ? (
                  <div className='space-y-3'>
                    <div className='flex items-center gap-2'>
                      <div className='flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[12px] text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300'>
                        {showToken ? user.static_token : '•'.repeat(24)}
                      </div>
                      <button
                        type='button'
                        onClick={() => setShowToken((v) => !v)}
                        className='shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:hover:bg-slate-800'
                        aria-label={showToken ? 'Hide token' : 'Reveal token'}
                      >
                        {showToken ? <EyeOff className='h-4 w-4' /> : <Eye className='h-4 w-4' />}
                      </button>
                      {showToken && (
                        <button
                          type='button'
                          onClick={() => {
                            navigator.clipboard.writeText(user.static_token!)
                            toast.success('Copied')
                          }}
                          className='shrink-0 rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:hover:bg-slate-800'
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

            {/* Two-Factor Authentication (own save, outside the profile form) */}
            <TwoFactorCard />

            {/* Delegation (own save, outside the profile form) */}
            <DelegationCard user={user} mode='self' />
          </div>
        )}
      </div>
    </>
  )
}
