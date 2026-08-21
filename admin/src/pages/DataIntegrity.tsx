import { ConformanceView, NavigationContext, NivaroProvider, QualityRulesView } from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useNavigate, useSearchParams } from 'react-router'
import { cn } from '@/lib/utils'

// Data Integrity — one home for "which rows are bad", two lenses:
// Form conformance (would this record fail its own form today — the shared
// ConformanceView, embeddable in headless hosts) and Quality rules (the
// admin-authored not_null/regex/range/unique/formula checks that used to
// live at /data-quality; that route now redirects here).
const client = createNivaro(window.location.origin)

export default function DataIntegrity() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'quality' ? 'quality' : 'conformance'

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <div className='flex items-center justify-between'>
          <div>
            <h1 className='text-[17px] font-semibold text-slate-900 dark:text-foreground'>
              Data Integrity
            </h1>
            <p className='mt-0.5 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              {tab === 'conformance'
                ? 'Records that no longer satisfy their own field configuration — required fields left empty, validation rules violated, cascade values no longer available.'
                : 'Admin-authored quality rules (not-null, regex, range, unique, formula) with run history per collection.'}
            </p>
          </div>
          <span className='flex rounded-md border border-slate-200 p-0.5 dark:border-border'>
            {(
              [
                { value: 'conformance', label: 'Form conformance' },
                { value: 'quality', label: 'Quality rules' }
              ] as const
            ).map((t) => (
              <button
                key={t.value}
                type='button'
                onClick={() => setParams(t.value === 'conformance' ? {} : { tab: t.value })}
                className={cn(
                  'rounded px-2.5 py-1 text-[12px] font-medium transition-colors',
                  tab === t.value
                    ? 'bg-nvr-cyan/10 text-slate-800 dark:text-foreground'
                    : 'text-slate-400 hover:text-slate-600'
                )}
              >
                {t.label}
              </button>
            ))}
          </span>
        </div>
      </header>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{
            navigate: (path) => navigate(path),
            itemUrl: (t) => `/collections/${t.collection}/${t.itemId}`
          }}
        >
          {tab === 'conformance' ? <ConformanceView /> : <QualityRulesView />}
        </NavigationContext.Provider>
      </NivaroProvider>
    </div>
  )
}
