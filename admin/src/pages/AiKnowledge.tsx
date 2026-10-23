import { createNivaro } from '@nivaro/sdk'
import { AiKnowledgeView, NivaroProvider } from '@nivaro/shared'
import { useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'
import { useAuth } from '@/lib/auth'

// AI Knowledge — what Ask AI knows beyond the data (migration 434): the
// shared glossary (everyone reads it; term links from answers land here with
// ?term=<slug>), per-collection data guides, drafted suggestions and the docs
// gaps report (admins). ?tab=glossary|guides|suggestions|gaps|conflicts|topics|index|checklists.
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '', {
  timeoutMs: 90_000
})

type Tab =
  | 'glossary'
  | 'guides'
  | 'suggestions'
  | 'gaps'
  | 'conflicts'
  | 'topics'
  | 'index'
  | 'checklists'
const TABS: Tab[] = [
  'glossary',
  'guides',
  'suggestions',
  'gaps',
  'conflicts',
  'topics',
  'index',
  'checklists'
]

export function AiKnowledgePage() {
  const { user } = useAuth()
  const isAdmin = !!user?.is_admin
  const [params, setParams] = useSearchParams()
  const raw = params.get('tab')
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : 'glossary'
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <HubToolbar
        description={
          isAdmin
            ? 'The business terms, data guides and docs Ask AI answers from, and what it could not answer.'
            : 'Business terms as this organisation defines them.'
        }
      />
      <div className='flex-1 overflow-y-auto bg-slate-50 p-4 sm:p-6 dark:bg-background'>
        <NivaroProvider client={sharedClient}>
          <AiKnowledgeView
            isAdmin={isAdmin}
            tab={tab}
            focusTerm={params.get('term')}
            onTabChange={(t) => {
              const next = new URLSearchParams(params)
              next.set('tab', t)
              next.delete('term')
              setParams(next, { replace: true })
            }}
          />
        </NivaroProvider>
      </div>
    </div>
  )
}
