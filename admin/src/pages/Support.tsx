import { createNivaro } from '@nivaro/sdk'
import {
  defaultItemUrl,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider,
  SupportView
} from '@nivaro/shared'
import { LifeBuoy } from 'lucide-react'
import { useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'

// Support — requests people raise for the administrators (#999). The page is
// the shared SupportView: My requests for everyone, the Desk and the request
// types for administrators. ?ticket=<id> (every support notification links
// here) opens that ticket.
const client = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

export function SupportPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const ticket = Number(params.get('ticket')) || null

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-2.5 border-b border-slate-200 px-6 py-4 dark:border-border'>
        <LifeBuoy className='h-5 w-5 text-muted-foreground' />
        <div>
          <h1 className='text-lg font-semibold'>Support</h1>
          <p className='text-[11px] text-muted-foreground'>
            Requests for the administrators — changes to records and general help.
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <NivaroProvider client={client}>
          <NavigationContext.Provider
            value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
          >
            <ItemEditAuthContext.Provider
              value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
            >
              <SupportView
                initialTicketId={ticket}
                onTicketChange={(id) => {
                  const next = new URLSearchParams(params)
                  if (id) next.set('ticket', String(id))
                  else next.delete('ticket')
                  setParams(next, { replace: true })
                }}
              />
            </ItemEditAuthContext.Provider>
          </NavigationContext.Provider>
        </NivaroProvider>
      </div>
    </div>
  )
}
