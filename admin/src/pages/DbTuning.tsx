import { createNivaro } from '@nivaro/sdk'
import { DbTuningView, NivaroProvider } from '@nivaro/shared'
import { toast } from 'sonner'
import { HubToolbar } from '@/components/hub-page'

const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

/** Database tuning (#996) — the propose-only tuning loop: proposals with proofs, Apply, watch, rollback. */
export default function DbTuning() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Indexes, rewrites, rollups and caches proposed from this instance’s workload and proven first. Nothing changes until you Apply; applied changes are watched for a week and rolled back on regression.' />
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
