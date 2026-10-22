import { createNivaro } from '@nivaro/sdk'
import {
  ImportConsole,
  type ImportProgressEvent,
  type ImportRealtimeAdapter,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { FileUp } from 'lucide-react'
import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'
import { adminRealtime, joinWatchRoom } from '@/lib/socket'

/**
 * Import console host.
 *
 * The page itself is the shared `ImportConsole` (staged imports, collection imports and the
 * definition registry), so the admin and headless frontends run the same surface. Only the
 * socket adapter and routing are admin-side.
 *
 * `import:progress` is the STAGED worker's event: the run starter hears it on their own user
 * room, administrators also on the tenant's `imports` watch room — both over the app's shared,
 * signed-in socket (never a socket of this page's own). The collection importer emits per-job
 * `import:progress:<id>` events instead and the console polls for those — the two must not be
 * crossed.
 */
function createImportRealtime(): ImportRealtimeAdapter {
  return {
    subscribe(onProgress) {
      const leave = joinWatchRoom('imports')
      const off = adminRealtime.on('import:progress', (payload: ImportProgressEvent) =>
        onProgress(payload)
      )
      return () => {
        off()
        leave()
      }
    }
  }
}

export function ImportsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const runParam = Number(searchParams.get('run'))
  const definitionParam = searchParams.get('definition')
  const { user } = useAuth()

  const client = useMemo(() => createNivaro(window.location.origin, { timeoutMs: 90_000 }), [])
  const realtime = useMemo(() => createImportRealtime(), [])
  const isAdmin = !!user?.is_admin

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <header className='flex shrink-0 items-center gap-2.5 border-b border-border px-6 py-4'>
        <FileUp className='h-5 w-5 text-muted-foreground' />
        <h1 className='text-lg font-semibold'>Imports</h1>
      </header>

      <div className='flex min-h-0 flex-1 flex-col overflow-y-auto p-6'>
        <NivaroProvider client={client}>
          <ItemEditAuthContext.Provider value={{ isAdmin, userId: user?.id ?? '' }}>
            <NavigationContext.Provider
              value={{ navigate: (path) => navigate(path), itemUrl: undefined }}
            >
              <ImportConsole
                realtime={realtime}
                // /imports/new was the old wizard route; it opens the wizard's
                // section rather than being looked up as a job id.
                defaultTab={id ? 'collection' : 'runs'}
                initialJobId={id && id !== 'new' ? id : null}
                initialRunId={Number.isInteger(runParam) && runParam > 0 ? runParam : null}
                initialDefinitionKey={definitionParam}
                onRunOpen={(runId) =>
                  setSearchParams(
                    (prev) => {
                      const next = new URLSearchParams(prev)
                      if (runId) next.set('run', String(runId))
                      else next.delete('run')
                      return next
                    },
                    { replace: true }
                  )
                }
                // Keep the URL in step so a job detail stays linkable, the way
                // /imports/:id was before this page became one console.
                onJobOpen={(jobId) =>
                  navigate(jobId ? `/imports/${jobId}` : '/imports', { replace: true })
                }
              />
            </NavigationContext.Provider>
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </div>
    </div>
  )
}
