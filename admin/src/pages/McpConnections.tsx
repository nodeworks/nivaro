import { createNivaro } from '@nivaro/sdk'
import { type McpAdminTab, McpConnectionsAdminView, NivaroProvider } from '@nivaro/shared'
import { Plug } from 'lucide-react'
import { useSearchParams } from 'react-router'

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
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <Plug className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div>
          <h1 className='text-base font-semibold'>MCP Connections</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            AI assistants people connected to Nivaro — what they did, which are idle, and how fast
            each may call.
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
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
