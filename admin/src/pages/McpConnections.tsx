import { createNivaro } from '@nivaro/sdk'
import { type McpAdminTab, McpConnectionsAdminView, NivaroProvider } from '@nivaro/shared'
import { useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'

// MCP connections (#2466 / #2469 / #2497): every AI assistant connected to this instance
// across people — 14 days of tool calls, the idle review, per-connection limits, disconnect.
// ?tab=all|idle.
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

export function McpConnectionsPage() {
  const [params, setParams] = useSearchParams()
  const tab: McpAdminTab = params.get('tab') === 'idle' ? 'idle' : 'all'
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar description='Every person’s connected assistants: tool calls over the last 14 days, idle ones to review, and how fast each may call. Disconnect any from here.' />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <McpConnectionsAdminView
            tab={tab}
            onTabChange={(t) => {
              const next = new URLSearchParams(params)
              if (t === 'all') next.delete('tab')
              else next.set('tab', t)
              setParams(next, { replace: true })
            }}
          />
        </NivaroProvider>
      </div>
    </div>
  )
}
