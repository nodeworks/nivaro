import { useContext, useMemo, useState } from 'react'
import { useNavigation } from '../../context'
import { useCcQuery } from './api'
import { Header } from './Header'
import { PeekPanel } from './PeekPanel'
import { CC_PANELS } from './panels/registry'
import { CcContext, type CcState, EMPTY_FILTERS } from './state'
import { ccVars, useAppIsDark } from './theme'
import type { CcFilters, CcPublicConfig, Snapshot } from './types'

/**
 * Command Center — one live board answering "what is happening in the business right now":
 * where the work physically is (map), what's moving (flow, throughput, feed), what needs
 * someone (attention), who's on (people) and a one-line system status that hands off to the
 * Traffic Map (the machine's own board). Every number clicks through to its real surface.
 *
 * Structure: this shell owns the board state (state.tsx) and lays out the panel registry
 * (panels/registry.ts); each panel is its own module reading useCc() + useCcQuery(). The
 * contract with the API is types.ts.
 *
 * Hosts: NivaroProvider + NavigationContext required.
 */
export function CommandCenterView({
  /** Fallback map collections when the instance has no Command Center config yet. */
  geoCollections = ['locations'],
  recordUrl,
  isAdmin = false,
  kiosk = null
}: {
  geoCollections?: string[]
  /** Host route for a record — defaults to the admin shape. */
  recordUrl?: (collection: string, id: string) => string
  isAdmin?: boolean
  /** Wallboard link token (read-only board). */
  kiosk?: string | null
}) {
  const { navigate } = useNavigation()
  const appDark = useAppIsDark()
  const [region, setRegion] = useState<string | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [mapCollection, setMapCollection] = useState<string | null>(null)
  const [filters, setFilters] = useState<CcFilters>(EMPTY_FILTERS)
  const [peek, setPeek] = useState<{ collection: string; id: string } | null>(null)
  const [tv, setTv] = useState(false)
  const [mapFocus, setMapFocus] = useState<CcState['mapFocus']>(null)

  const recordHref = useMemo(
    () => recordUrl ?? ((c: string, id: string) => `/collections/${c}/${id}`),
    [recordUrl]
  )

  const value: CcState = useMemo(
    () => ({
      isAdmin,
      kiosk,
      config: null,
      snapshot: null,
      snapshotError: false,
      updatedAt: null,
      region,
      setRegion,
      at,
      setAt,
      mapCollection,
      setMapCollection,
      filters,
      setFilters,
      peek,
      setPeek: (p) => {
        // Until the peek panel exists, opening a record navigates to it.
        if (p) navigate(recordHref(p.collection, p.id))
        setPeek(null)
      },
      focusMap: (p) => setMapFocus({ ...p, nonce: Date.now() }),
      mapFocus,
      tv,
      setTv,
      navigate,
      recordUrl: recordHref
    }),
    [isAdmin, kiosk, region, at, mapCollection, filters, peek, mapFocus, tv, navigate, recordHref]
  )

  return (
    <CcContext.Provider value={value}>
      <Board fallbackCollections={geoCollections} appDark={appDark} />
    </CcContext.Provider>
  )
}

function Board({
  fallbackCollections,
  appDark
}: {
  fallbackCollections: string[]
  appDark: boolean
}) {
  // The outer provider holds the lenses (useCcQuery reads them); this one adds the data.
  const outer = useContext(CcContext)
  if (!outer) throw new Error('Command Center board outside its provider')
  const snapQ = useCcQuery<Snapshot | null>('/snapshot', undefined, { refetchInterval: 20_000 })
  const configQ = useCcQuery<CcPublicConfig>('/config', undefined, {
    staleTime: 5 * 60_000,
    lenses: false,
    retry: false
  })
  const config: CcPublicConfig = configQ.data ?? {
    geo_collections: fallbackCollections.map((k) => ({ key: k, label: '' })),
    regions: [],
    region_label: null,
    stuck_days: 7
  }
  const state: CcState = {
    ...outer,
    config,
    snapshot: snapQ.data ?? null,
    snapshotError: snapQ.isError,
    updatedAt: snapQ.dataUpdatedAt || null
  }
  const mode = appDark || outer.tv ? 'dark' : 'light'
  const visible = CC_PANELS.filter((p) => !p.adminOnly || state.isAdmin || !!state.snapshot?.health)
  const area = (a: 'main' | 'rail' | 'bottom') =>
    visible.filter((p) => p.area === a).map((p) => <p.component key={p.key} />)

  return (
    <CcContext.Provider value={state}>
      <div
        className='flex h-full min-h-0 flex-1 flex-col gap-3 bg-[var(--cc-bg)] p-4 text-[var(--cc-text)]'
        style={ccVars(mode)}
        data-cc-mode={mode}
      >
        <Header />
        <div className='grid min-h-0 flex-1 gap-3 xl:grid-cols-[1fr_360px]'>
          <div className='flex min-h-0 flex-col gap-3'>{area('main')}</div>
          <div className='flex min-h-0 flex-col gap-3 overflow-y-auto'>{area('rail')}</div>
        </div>
        {area('bottom')}
        <PeekPanel />
      </div>
    </CcContext.Provider>
  )
}
