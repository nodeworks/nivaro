import { createNivaro } from '@nivaro/sdk'
import { NivaroProvider, OpsTasksView } from '@nivaro/shared'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/** Operational tasks (#827) — repairs, backfills and migrations registered by
 *  core or an extension, run from here: dry run by default, one at a time. */
export default function OpsTasks() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Repairs, backfills and migrations an extension owns. A dry run reports what a real run would do and writes nothing; one run at a time per task; every run is recorded under Runs & schedules.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <OpsTasksView onNotice={(m) => toast.error(m)} />
        </NivaroProvider>
      </div>
    </div>
  )
}
