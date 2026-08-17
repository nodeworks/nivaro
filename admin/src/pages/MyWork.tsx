import { MyWorkView, NavigationContext, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { Inbox } from 'lucide-react'
import { useNavigate } from 'react-router'

// My Work — the personal actionable inbox (records waiting on you by SLA
// urgency, open tasks, unread notifications). The view itself is the shared
// MyWorkView; this page is only the admin host shell.
const client = createNivaro(window.location.origin)

export function MyWorkPage() {
  const navigate = useNavigate()

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-2.5 border-b border-slate-200 px-6 py-4 dark:border-border'>
        <Inbox className='h-5 w-5 text-muted-foreground' />
        <div>
          <h1 className='text-lg font-semibold'>My Work</h1>
          <p className='text-[11px] text-muted-foreground'>
            Everything waiting on you — approvals, tasks, and mentions in one place.
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <NivaroProvider client={client}>
          <NavigationContext.Provider
            value={{
              navigate: (path) => navigate(path),
              itemUrl: (t) => `/collections/${t.collection}/${t.itemId}`
            }}
          >
            <MyWorkView />
          </NavigationContext.Provider>
        </NivaroProvider>
      </div>
    </div>
  )
}
