import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  ProfileView,
  usePersonProfile
} from '@nivaro/shared'
import { ArrowLeft } from 'lucide-react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { RevisionsPanel } from '@/components/revisions-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/lib/auth'
import { useGoBack } from '@/lib/nav'

// /users/:id runs on the SAME shared people page every headless host renders
// (ProfileView → PersonProfile): the admin sees the Access / Activity /
// Admin tools tabs, a non-admin the slim colleague view. The page itself only
// adds the admin chrome — breadcrumb, back, revision history.
const client = createNivaro(window.location.origin)

const TABS = new Set(['overview', 'access', 'activity', 'tools'])

function Crumb({ id }: { id: string }) {
  const { data } = usePersonProfile(id)
  if (!data) return <Skeleton className='h-4 w-32' />
  return (
    <span className='font-medium text-slate-800 dark:text-slate-100' data-user-crumb>
      {data.name}
    </span>
  )
}

export function UserEditPage() {
  const { id = '' } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const goBack = useGoBack('/users')
  const { user } = useAuth()
  const tabParam = searchParams.get('tab') ?? ''
  const initialTab = TABS.has(tabParam) ? (tabParam as 'overview') : undefined

  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider
        value={{
          navigate: (path) => navigate(path),
          itemUrl: defaultItemUrl,
          userUrl: (uid) => `/users/${uid}`
        }}
      >
        <ItemEditAuthContext.Provider
          value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
        >
          <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
            <div className='flex items-center justify-between gap-4'>
              <div className='flex min-w-0 items-center gap-2 text-[13px]'>
                <Link
                  to='/users'
                  onClick={(e) => {
                    e.preventDefault()
                    goBack()
                  }}
                  className='flex items-center gap-1 text-slate-400 transition-colors hover:text-slate-700 dark:hover:text-slate-200'
                >
                  <ArrowLeft className='h-3.5 w-3.5' />
                  Users
                </Link>
                <span className='text-slate-300'>/</span>
                <Crumb id={id} />
              </div>
              <RevisionsPanel collection='cms_users' item={id} />
            </div>
          </div>
          <div className='p-8'>
            <ProfileView key={id} userId={id} initialTab={initialTab} />
          </div>
        </ItemEditAuthContext.Provider>
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}
