import { BellRing } from 'lucide-react'
import { NotificationSourcesCard } from '../NotificationSourcesCard'

/**
 * "My Subscriptions" as a full page: the profile's subscription sections
 * (same rows, same trigger/paused/criteria treatment) with create, edit,
 * pause, delivery + channel changes and removal — one component for the
 * admin console page and any headless host. Needs NivaroProvider (+ an
 * optional NavigationContext for the "Manage →" links).
 */
export function NotificationSubscriptionsView({ title = 'My Subscriptions' }: { title?: string }) {
  return (
    <div className='flex min-h-0 flex-1 flex-col' data-notification-subscriptions-view>
      <header className='flex shrink-0 items-center gap-2.5 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <BellRing className='h-5 w-5 text-nvr-cyan' />
        <div>
          <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>{title}</h1>
          <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
            What you are told about and how it reaches you — workflow states, records, queues.
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
        <div className='rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
          <NotificationSourcesCard only='subscriptions' bare />
        </div>
      </div>
    </div>
  )
}
