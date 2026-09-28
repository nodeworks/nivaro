import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider, OpsTasksView } from '@nivaro/shared'
import { toast } from 'sonner'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** Operational tasks (#827) — repairs, backfills and migrations registered by
 *  core or an extension, run from here: dry run by default, one at a time. */
export default function OpsTasks() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-lg font-semibold text-slate-900 dark:text-foreground'>
          Operational tasks
        </h1>
        <p className='mt-1 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          Repairs, backfills and migrations an extension owns. A dry run reports what a real run
          would do and writes nothing; one run at a time per task; every run is recorded under
          Background Jobs.
        </p>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <OpsTasksView onNotice={(m) => toast.error(m)} />
        </NivaroProvider>
      </div>
    </div>
  )
}
