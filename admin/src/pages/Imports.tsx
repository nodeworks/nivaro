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
import { useNavigate, useParams } from 'react-router'
import { io } from 'socket.io-client'
import { useAuth } from '@/lib/auth'

const API_URL = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3055'

/**
 * Import console host.
 *
 * The page itself is the shared `ImportConsole` (staged imports, collection
 * imports and the definition registry), so the admin and headless frontends
 * run the same surface. Only the socket adapter and routing are admin-side.
 *
 * `import:progress` is the STAGED worker's event. The collection importer emits
 * per-job `import:progress:<id>` events instead and the console polls for those
 * — the two must not be crossed.
 */
function createImportRealtime(staticToken: string | null): ImportRealtimeAdapter {
  return {
    subscribe(onProgress) {
      const socket = io(API_URL, { transports: ['websocket', 'polling'], withCredentials: true })
      socket.on('connect', () => {
        if (staticToken) socket.emit('auth', { token: staticToken })
      })
      socket.on('import:progress', (payload: ImportProgressEvent) => onProgress(payload))
      return () => {
        socket.disconnect()
      }
    }
  }
}

export function ImportsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()

  const client = useMemo(() => createNivaro(window.location.origin), [])
  const realtime = useMemo(
    () => createImportRealtime(user?.static_token ?? null),
    [user?.static_token]
  )
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
