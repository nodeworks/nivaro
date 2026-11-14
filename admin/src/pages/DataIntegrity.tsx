import { createNivaro } from '@nivaro/sdk'
import {
  ConformanceView,
  defaultItemUrl,
  InactiveUserLinksView,
  NavigationContext,
  NivaroProvider,
  QualityRulesView
} from '@nivaro/shared'
import type { ReactNode } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { HubToolbar } from '@/components/hub-page'

// Data Integrity hub (lib/hubs.ts DATA_INTEGRITY_HUB) — "which rows are bad", one tab per
// lens: Form conformance (would this record fail its own form today — the shared
// ConformanceView, embeddable in headless hosts), Quality rules (admin-authored
// not_null/regex/range/unique/formula checks; /data-quality redirects here), Inactive people
// (accounts that can no longer act but are still named on live work) and Orphans (links to
// records that no longer exist, pages/data-integrity/Orphans.tsx).
const client = createNivaro(window.location.origin, { timeoutMs: 90_000 })

function IntegrityProviders({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <NivaroProvider client={client}>
      <NavigationContext.Provider
        value={{ navigate: (path) => navigate(path), itemUrl: defaultItemUrl }}
      >
        {children}
      </NavigationContext.Provider>
    </NivaroProvider>
  )
}

/** First tab. Old links (`?tab=quality`, `?tab=people&person=…`, notifications) land on their tab. */
export function ConformanceTab() {
  const [params] = useSearchParams()
  const legacy = params.get('tab')
  if (legacy === 'quality' || legacy === 'people' || legacy === 'orphans') {
    const next = new URLSearchParams(params)
    next.delete('tab')
    const search = next.toString()
    return <Navigate to={`/data-integrity/${legacy}${search ? `?${search}` : ''}`} replace />
  }
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Records that no longer satisfy their own field configuration — required fields left empty, validation rules violated, cascade values no longer available.' />
      <IntegrityProviders>
        <ConformanceView />
      </IntegrityProviders>
    </div>
  )
}

export function QualityTab() {
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Admin-authored quality rules (not-null, regex, range, unique, formula) with run history per collection.' />
      <IntegrityProviders>
        <QualityRulesView />
      </IntegrityProviders>
    </div>
  )
}

export function PeopleTab() {
  const [params, setParams] = useSearchParams()
  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <HubToolbar description='Suspended, redacted and placeholder accounts that live work still names — contacts and owners on open records, owner seats, team places, open tasks.' />
      <IntegrityProviders>
        <InactiveUserLinksView
          focusUserId={params.get('person')}
          onClearFocus={() => {
            const next = new URLSearchParams(params)
            next.delete('person')
            setParams(next, { replace: true })
          }}
        />
      </IntegrityProviders>
    </div>
  )
}
