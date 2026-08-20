import { BroadcastView, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { Megaphone } from 'lucide-react'

// Broadcasts — the shared compose/history surface (banner, in-app message,
// email, SMS, zone/role targeting). Shared so efp-new can mount the same
// view; this page is just the admin host.
const client = createNivaro(window.location.origin)

export default function Announcements() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Megaphone className='h-5 w-5 text-muted-foreground' />
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Broadcasts
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Message a chosen audience over any mix of channels — a persistent banner, an in-app
              message, email, or text. Zone and role targeting narrow both delivery and who sees a
              banner.
            </p>
          </div>
        </div>
      </header>
      <NivaroProvider client={client}>
        <BroadcastView />
      </NivaroProvider>
    </div>
  )
}
