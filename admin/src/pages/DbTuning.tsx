import { createNivaro } from '@nivaro/sdk'
import { DbTuningView, NivaroProvider } from '@nivaro/shared'
import { toast } from 'sonner'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

/** Database tuning (#996) — the propose-only tuning loop: proposals with proofs, Apply, watch, rollback. */
export default function DbTuning() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-lg font-semibold text-slate-900 dark:text-foreground'>
          Database tuning
        </h1>
        <p className='mt-1 max-w-[72ch] text-[12px] text-slate-500 dark:text-muted-foreground'>
          The platform watches its own query workload, proposes indexes, procedure rewrites, stored
          rollups and query caches, and proves each one before it is listed. Nothing changes until
          you click Apply; an applied change is watched for a week and rolled back if it regresses.
        </p>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <DbTuningView
            onNotice={(m, tone) => (tone === 'success' ? toast.success(m) : toast.error(m))}
          />
        </NivaroProvider>
      </div>
    </div>
  )
}
