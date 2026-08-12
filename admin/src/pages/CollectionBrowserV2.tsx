import {
  CollectionBrowserView,
  ItemEditAuthContext,
  NavigationContext,
  NivaroProvider
} from '@nivaro/shared'
import { createNivaro } from '@nivaro/sdk'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { useAuth } from '@/lib/auth'

// Admin /collections/:collection now runs on the SAME shared browser that
// powers headless frontends (CollectionBrowserView) — quick filters, column
// filters, saved views w/ collection default, drill sheets, row actions,
// per-collection browser_config. The legacy admin browser remains at
// /collections/:collection/classic for tree/hierarchy/AI-query flows the
// shared view doesn't cover yet.
const client = createNivaro(window.location.origin)

export function CollectionBrowserV2Page() {
  const { collection = '' } = useParams<{ collection: string }>()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  return (
    <div className='flex h-full min-h-0 flex-col'>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{
            navigate: (path) => navigate(path),
            itemUrl: (t) => `/collections/${t.collection}/${t.itemId}`
          }}
        >
          <ItemEditAuthContext.Provider
            value={{ isAdmin: !!user?.is_admin, userId: String(user?.id ?? '') }}
          >
            <CollectionBrowserView
              key={collection}
              collection={collection}
              initialSearch={searchParams.get('search') ?? ''}
              onOpenItem={(id) => navigate(`/collections/${collection}/${id}`)}
            />
          </ItemEditAuthContext.Provider>
        </NavigationContext.Provider>
      </NivaroProvider>
    </div>
  )
}
