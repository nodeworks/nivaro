import { NivaroProvider, TeamsView } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { Users2 } from 'lucide-react'
import { useAuth } from '@/lib/auth'

// Teams live in @nivaro/shared (TeamsView) so headless frontends and the
// Owner Matrix "Manage teams" slide-over host the same surface — this page is
// the thin admin host (CollectionBrowserV2Page pattern).
const client = createNivaro(window.location.origin)

export function UserGroupsPage() {
  const { user } = useAuth()
  const isAdmin = Boolean(user?.is_admin)

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-3'>
          <Users2 className='h-4 w-4 text-slate-400' />
          <div>
            <h1 className='text-[16px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              Teams
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Named user sets — assign a whole team as a pipeline owner, or mention one in comments
              as @its-slug. Roster and scope edits apply everywhere the team is used.
            </p>
          </div>
        </div>
      </header>
      <NivaroProvider client={client}>
        <TeamsView canManage={isAdmin} />
      </NivaroProvider>
    </div>
  )
}
