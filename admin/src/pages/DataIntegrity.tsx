import { ConformanceView, NavigationContext, NivaroProvider } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useNavigate } from 'react-router'

// Config conformance — which records would fail their own form today. The
// view itself is shared (@nivaro/shared ConformanceView) so headless
// frontends can mount the same surface; this page is just the admin host.
const client = createNivaro(window.location.origin)

export default function DataIntegrity() {
  const navigate = useNavigate()
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
          Data Integrity
        </h1>
        <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
          Records that no longer satisfy their own field configuration — required fields left
          empty, validation rules violated, cascade values that are no longer an available option.
        </p>
      </header>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{
            navigate: (path) => navigate(path),
            itemUrl: (t) => `/collections/${t.collection}/${t.itemId}`
          }}
        >
          <ConformanceView />
        </NavigationContext.Provider>
      </NivaroProvider>
    </div>
  )
}
