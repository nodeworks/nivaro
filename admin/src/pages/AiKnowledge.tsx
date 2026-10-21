import { createNivaro } from '@nivaro/sdk'
import { AiKnowledgeView, NivaroProvider } from '@nivaro/shared'
import { BookMarked } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'

// AI Knowledge — what Ask AI knows beyond the data (migration 434): the
// shared glossary (everyone reads it; term links from answers land here with
// ?term=<slug>), per-collection data guides, drafted suggestions and the docs
// gaps report (admins). ?tab=glossary|guides|suggestions|gaps|conflicts|topics|index|checklists.
const sharedClient = createNivaro(typeof window !== 'undefined' ? window.location.origin : '')

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
      <header className='flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex h-9 w-9 items-center justify-center rounded-lg bg-nvr-cyan/15'>
          <BookMarked className='h-4.5 w-4.5 text-nvr-navy dark:text-nvr-cyan' />
        </div>
        <div>
          <h1 className='text-base font-semibold'>{isAdmin ? 'AI Knowledge' : 'Glossary'}</h1>
          <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {isAdmin
              ? 'The business terms, data guides and docs Ask AI answers from — and what it could not answer.'
              : 'Business terms as this organisation defines them.'}
          </p>
        </div>
      </header>
      <div className='flex-1 overflow-y-auto bg-slate-50 p-6 dark:bg-background'>
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
