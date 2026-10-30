import { useQueryClient } from '@tanstack/react-query'
import { MapPinned } from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import { useNavigation } from '../../context'
import { attentionAnnouncement, attentionCount } from './announce'
import { useCcQuery } from './api'
import { DEFAULT_PREFS, useCcPrefs, useKioskInfo } from './board-prefs'
import { CustomizeSheet } from './Customize'
import { countFailures } from './freshness'
import { Header } from './Header'
import {
  arrangeBoard,
  boardSizeFor,
  effectiveLayout,
  type ResolvedPanel,
  resolvePanels
} from './layout'
import { PeekPanel } from './PeekPanel'
import { BoardBanner } from './panels/Banner'
import { CC_PANELS, type PanelDef } from './panels/registry'
import { useFullscreen, usePeekFocus, useRegionCycle, useWindowWidth } from './shell-hooks'
import { FOCUS_REGION_EVENT, REGION_PICKER_ATTR, regionForIndex, shortcutFor } from './shortcuts'
import { CcContext, type CcState, EMPTY_FILTERS } from './state'
import { BUTTON, boardMode, ccVars, FOCUS, MUTED, useAppIsDark } from './theme'
import type { CcFilters, CcPublicConfig, Snapshot } from './types'
import {
  type BoardUrlAdapter,
  EMPTY_URL_STATE,
  parseBoardUrl,
  windowUrlAdapter,
  writeBoardUrl
} from './url-state'

/**
 * Command Center — one live board answering "what is happening in the business right now":
 * where the work physically is (map), what's moving (flow, throughput, feed), what needs
 * someone (attention), who's on (people) and a one-line system status that hands off to the
 * Traffic Map (the machine's own board). Every number clicks through to its real surface.
 *
 * Structure: this shell owns the board state (state.tsx), the lenses in the URL (url-state.ts),
 * the person's prefs (board-prefs.ts), keyboard shortcuts, TV / full screen and the layout
 * (layout.ts arrangeBoard places the panel registry for the screen size); each panel is its own
 * module reading useCc() + useCcQuery(). The contract with the API is types.ts.
 *
 * Layout — "what needs someone right now" leads at every size:
 *   ≥1800px  three columns: Needs attention + Workload | map (+ live feed under it) | rail
 *   ≥1280px  map (+ feed) | rail opening with Needs attention, beside the map's top edge
 *   <1280px  one column: attention first, then the map (on a phone behind "Show map"), the rest
 *
 * Hosts: NivaroProvider + NavigationContext required. A wallboard link (`kiosk`) shows the
 * board read-only, always dark and in TV mode, with no prefs, no URL writes and no navigation.
 */
export function CommandCenterView({
  /** Fallback map collections when the instance has no Command Center config yet. */
  geoCollections = ['locations'],
  recordUrl,
  isAdmin = false,
  kiosk = null,
  urlAdapter
}: {
  geoCollections?: string[]
  /** Host route for a record — defaults to the admin shape. */
  recordUrl?: (collection: string, id: string) => string
  isAdmin?: boolean
  /** Wallboard link token (read-only board). */
  kiosk?: string | null
  /** How the board reads/replaces the query string; default history.replaceState. */
  urlAdapter?: BoardUrlAdapter
}) {
  const { navigate: hostNavigate } = useNavigation()
  const qc = useQueryClient()
  const appDark = useAppIsDark()
  const adapter = kiosk ? null : (urlAdapter ?? windowUrlAdapter)
  // Read once: the URL seeds the lenses; after that the board writes it.
  const [initial] = useState(() => (adapter ? parseBoardUrl(adapter.read()) : EMPTY_URL_STATE))
  const [region, setRegion] = useState<string | null>(initial.region)
  const [at, setAt] = useState<number | null>(initial.at)
  const [mapCollection, setMapCollection] = useState<string | null>(initial.map)
  const [filters, setFilters] = useState<CcFilters>(EMPTY_FILTERS)
  const [peek, setPeek] = useState<CcState['peek']>(initial.peek)
  const [tv, setTv] = useState(initial.tv || !!kiosk)
  const [mapFocus, setMapFocus] = useState<CcState['mapFocus']>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const fs = useFullscreen()

  const prefsQ = useCcPrefs(!kiosk)
  const prefs = kiosk ? null : (prefsQ.data ?? null)
  const kioskInfo = useKioskInfo(kiosk)

  // A wallboard link opens on the board its maker chose.
  const kioskApplied = useRef(false)
  useEffect(() => {
    const info = kioskInfo.data
    if (!info || kioskApplied.current) return
    kioskApplied.current = true
    if (info.region) setRegion(info.region)
    if (info.map_collection) setMapCollection(info.map_collection)
  }, [kioskInfo.data])

  // Lenses → URL (replace, never push).
  useEffect(() => {
    if (!adapter) return
    adapter.replace(writeBoardUrl(adapter.read(), { region, at, map: mapCollection, peek, tv }))
  }, [adapter, region, at, mapCollection, peek, tv])

  const recordHref = useMemo(
    () => recordUrl ?? ((c: string, id: string) => `/collections/${c}/${id}`),
    [recordUrl]
  )
  // A wallboard has no app behind it: links stay on the board.
  const navigate = useCallback(
    (path: string) => {
      if (!kiosk) hostNavigate(path)
    },
    [kiosk, hostNavigate]
  )
  const refresh = useCallback(
    () => void qc.invalidateQueries({ queryKey: ['command-center'] }),
    [qc]
  )
  const mode = boardMode({ appDark, theme: prefs?.theme, tv, kiosk: !!kiosk })

  const value: CcState = useMemo(
    () => ({
      isAdmin,
      kiosk,
      config: null,
      snapshot: null,
      snapshotError: false,
      updatedAt: null,
      snapshotLoading: true,
      snapshotFailures: 0,
      refresh,
      prefs,
      mode,
      region,
      setRegion,
      at,
      setAt,
      mapCollection,
      setMapCollection,
      filters,
      setFilters,
      peek,
      // A wallboard opens no record (the server refuses /peek for a link as well).
      setPeek: kiosk ? NO_PEEK : setPeek,
      focusMap: (p) => setMapFocus({ ...p, nonce: Date.now() }),
      mapFocus,
      tv,
      setTv: (on) => setTv(kiosk ? true : on),
      fullscreen: fs.on,
      toggleFullscreen: fs.toggle,
      openCustomize: () => setCustomizeOpen(true),
      navigate,
      recordUrl: recordHref
    }),
    [
      isAdmin,
      kiosk,
      refresh,
      prefs,
      mode,
      region,
      at,
      mapCollection,
      filters,
      peek,
      mapFocus,
      tv,
      fs.on,
      fs.toggle,
      navigate,
      recordHref
    ]
  )

  if (kiosk && kioskInfo.isError) return <KioskGone />

  return (
    <CcContext.Provider value={value}>
      <Board
        fallbackCollections={geoCollections}
        exitFullscreen={fs.exit}
        customizeOpen={customizeOpen}
        setCustomizeOpen={setCustomizeOpen}
        kioskLabel={kioskInfo.data?.label ?? null}
        kioskRegionPinned={!!kioskInfo.data?.region}
      />
    </CcContext.Provider>
  )
}

/** Panels a wallboard never shows: the server refuses their reads for a link. */
const KIOSK_HIDDEN = new Set(['feed', 'workload'])
const NO_PEEK = () => undefined

function KioskGone() {
  return (
    <main
      className='flex min-h-screen flex-col items-center justify-center gap-2 bg-[var(--cc-bg)] p-6 text-center'
      style={ccVars('dark')}
    >
      <h1 className='text-[18px] font-semibold text-[var(--cc-strong)]'>
        This wallboard link no longer works
      </h1>
      <p className={`max-w-md text-[14px] ${MUTED}`}>
        It may have expired or been turned off. Ask an administrator for a new link.
      </p>
    </main>
  )
}

const TV_ZOOM = 1.25

function Board({
  fallbackCollections,
  exitFullscreen,
  customizeOpen,
  setCustomizeOpen,
  kioskLabel,
  kioskRegionPinned
}: {
  fallbackCollections: string[]
  exitFullscreen: () => void
  customizeOpen: boolean
  setCustomizeOpen: (v: boolean) => void
  kioskLabel: string | null
  kioskRegionPinned: boolean
}) {
  // The outer provider holds the lenses (useCcQuery reads them); this one adds the data.
  const outer = useContext(CcContext)
  if (!outer) throw new Error('Command Center board outside its provider')
  const snapQ = useCcQuery<Snapshot | null>('/snapshot', undefined, {
    refetchInterval: 20_000,
    retry: 1
  })
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

  // Consecutive failed polls: errors since the error count that stood when data last arrived.
  const failureMark = useRef({ dataAt: 0, errors: 0 })
  if (snapQ.dataUpdatedAt !== failureMark.current.dataAt) {
    failureMark.current = { dataAt: snapQ.dataUpdatedAt, errors: snapQ.errorUpdateCount }
  }
  const failures = countFailures(snapQ.errorUpdateCount, failureMark.current.errors)

  const state: CcState = {
    ...outer,
    config,
    snapshot: snapQ.data ?? null,
    snapshotError: snapQ.isError,
    updatedAt: snapQ.dataUpdatedAt || null,
    snapshotLoading: snapQ.isPending,
    snapshotFailures: failures
  }
  const { tv, kiosk, peek, fullscreen, region, setRegion } = state
  const [helpOpen, setHelpOpen] = useState(false)
  const [showMap, setShowMap] = useState(false)

  // ── Layout ────────────────────────────────────────────────────────────────────────────────
  const width = useWindowWidth()
  const zoom = tv ? TV_ZOOM : 1
  const size = boardSizeFor(width / zoom)
  const canSee = useCallback(
    (p: PanelDef) =>
      !(state.kiosk && KIOSK_HIDDEN.has(p.key)) &&
      (!p.adminOnly || state.isAdmin || !!state.snapshot?.health),
    [state.isAdmin, state.kiosk, state.snapshot?.health]
  )
  const panels = useMemo(() => CC_PANELS.filter(canSee), [canSee])
  const layout = effectiveLayout(state.prefs?.layout, state.prefs?.role_default)
  const ordered = useMemo(() => {
    const byKey = new Map(panels.map((p) => [p.key, p]))
    return resolvePanels(
      panels.map((p) => p.key),
      layout
    )
      .filter((r: ResolvedPanel) => r.visible)
      .map((r) => byKey.get(r.key))
      .filter((p): p is PanelDef => !!p)
  }, [panels, layout])
  const arr = arrangeBoard(ordered, size)

  // ── Peek: Esc closes, focus moves in and comes back ─────────────────────────────────────
  usePeekFocus(!!peek)

  // ── TV: cycle regions while nobody is using the board ───────────────────────────────────
  useRegionCycle({
    // A wallboard stays on the board its link opens on (the server pins it too).
    enabled: tv && !kiosk && !kioskRegionPinned,
    regionIds: config.regions.map((r) => r.id),
    current: region,
    setRegion,
    intervalMs: (state.prefs?.tv_cycle_seconds ?? DEFAULT_PREFS.tv_cycle_seconds ?? 30) * 1000
  })

  // ── Keyboard ────────────────────────────────────────────────────────────────────────────
  const keys = useRef({ state, helpOpen, customizeOpen })
  keys.current = { state, helpOpen, customizeOpen }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = shortcutFor(e)
      if (!a) return
      const { state: s, helpOpen: help, customizeOpen: sheet } = keys.current
      // The Customise sheet and the shortcuts popover handle their own keys.
      if (sheet || help) return
      const t = e.target as Element | null
      if (t?.closest?.('[role="dialog"]:not([data-cc-peek]), [role="menu"], [role="listbox"]'))
        return
      switch (a.kind) {
        case 'escape':
          if (s.peek) {
            e.preventDefault()
            s.setPeek(null)
          } else if (s.fullscreen) {
            exitFullscreen()
          } else if (s.tv && !s.kiosk) {
            s.setTv(false)
          }
          return
        case 'fullscreen':
          e.preventDefault()
          s.toggleFullscreen()
          return
        case 'tv':
          e.preventDefault()
          s.setTv(!s.tv)
          return
        case 'refresh':
          e.preventDefault()
          s.refresh()
          return
        case 'focus-region': {
          if (s.kiosk) return
          e.preventDefault()
          window.dispatchEvent(new CustomEvent(FOCUS_REGION_EVENT))
          const el = document.querySelector<HTMLElement>(`[${REGION_PICKER_ATTR}]`)
          if (el && !el.contains(document.activeElement)) el.focus()
          return
        }
        case 'region': {
          if (s.kiosk) return
          const id = regionForIndex(s.config?.regions ?? [], a.index)
          if (id === undefined) return
          e.preventDefault()
          s.setRegion(id)
          return
        }
        case 'help':
          e.preventDefault()
          setHelpOpen(true)
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [exitFullscreen])

  // ── Live region: changes in what needs attention, said once, politely ───────────────────
  // A passive observer of the attention panel's own query (same key, never fetches itself).
  const attentionQ = useCcQuery<unknown>('/attention', undefined, { enabled: false })
  const count = attentionCount(attentionQ.data)
  const prevCount = useRef<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (count === null) return
    const said = attentionAnnouncement(prevCount.current, count)
    prevCount.current = count
    if (said) setAnnouncement(said)
  }, [count])

  // ── Render ──────────────────────────────────────────────────────────────────────────────
  const render = (list: PanelDef[]) =>
    list.map((p) => (
      <div key={p.key} className='min-w-0' data-cc-slot={p.key}>
        <p.component />
      </div>
    ))
  const mapBlock = (fill: boolean) =>
    arr.main.map((p) =>
      size === 'phone' && !showMap ? (
        <button
          key={p.key}
          type='button'
          aria-expanded={false}
          onClick={() => setShowMap(true)}
          className={`${BUTTON} flex w-full items-center justify-center gap-2 py-2.5 text-[12.5px] ${FOCUS}`}
        >
          <MapPinned className='h-4 w-4' aria-hidden />
          Show map
        </button>
      ) : (
        <div
          key={p.key}
          data-cc-slot={p.key}
          className={fill ? 'flex min-h-[420px] min-w-0 flex-1 flex-col [&>*]:flex-1' : 'min-w-0'}
        >
          <p.component />
          {size === 'phone' && (
            <button
              type='button'
              aria-expanded
              onClick={() => setShowMap(false)}
              className={`${BUTTON} mt-2 w-full ${FOCUS}`}
            >
              Hide map
            </button>
          )}
        </div>
      )
    )

  let body: ReactNode
  if (arr.columns === 'three') {
    body = (
      <div className='grid min-h-0 flex-1 grid-cols-[340px_minmax(0,1fr)_360px] gap-3'>
        <section
          aria-label='Needs someone now'
          className='flex min-h-0 flex-col gap-3 overflow-y-auto'
        >
          {render(arr.lead)}
        </section>
        <div className='flex min-h-0 min-w-0 flex-col gap-3'>
          {mapBlock(true)}
          {render(arr.under)}
        </div>
        <aside
          aria-label='More on the board'
          className='flex min-h-0 flex-col gap-3 overflow-y-auto'
        >
          {render(arr.rail)}
        </aside>
      </div>
    )
  } else if (arr.columns === 'two') {
    body = (
      <div className='grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-3'>
        <div className='flex min-h-0 min-w-0 flex-col gap-3'>
          {mapBlock(true)}
          {render(arr.under)}
        </div>
        <aside
          aria-label='More on the board'
          className='flex min-h-0 flex-col gap-3 overflow-y-auto'
        >
          {render(arr.rail)}
        </aside>
      </div>
    )
  } else {
    body = (
      <div className='flex flex-col gap-3'>
        {arr.lead.length > 0 && (
          <section aria-label='Needs someone now' className='flex flex-col gap-3'>
            {render(arr.lead)}
          </section>
        )}
        {mapBlock(false)}
        <aside
          aria-label='More on the board'
          className={`grid gap-3 ${size === 'medium' ? 'grid-cols-2' : 'grid-cols-1'}`}
        >
          {render(arr.rail)}
        </aside>
        {render(arr.under)}
      </div>
    )
  }

  const fixedHeight = arr.columns !== 'one'
  const layer = fullscreen && !kiosk
  const board = (
    <CcContext.Provider value={state}>
      <div
        className={`relative flex min-w-0 flex-col gap-3 bg-[var(--cc-bg)] p-3 text-[var(--cc-text)] sm:p-4 ${
          fixedHeight ? 'h-full min-h-0 flex-1' : 'min-h-full flex-1'
        } ${layer ? 'fixed inset-0 z-[45] overflow-auto' : ''} ${kiosk ? 'min-h-screen' : ''}`}
        style={{ ...ccVars(state.mode), ...(tv ? { zoom: TV_ZOOM } : {}) }}
        data-cc-mode={state.mode}
        data-cc-tv={tv ? '1' : undefined}
        data-cc-size={size}
      >
        <Header helpOpen={helpOpen} onHelpOpenChange={setHelpOpen} kioskLabel={kioskLabel} />
        <BoardBanner />
        {/* The admin app already has a <main>; a wallboard page has nothing else. */}
        {kiosk ? (
          <main className='flex min-h-0 flex-1 flex-col'>{body}</main>
        ) : (
          <section aria-label='Command Center board' className='flex min-h-0 flex-1 flex-col'>
            {body}
          </section>
        )}
        <PeekPanel />
        <div className='sr-only' aria-live='polite' aria-atomic='true'>
          {announcement}
        </div>
        {!kiosk && <CustomizeSheet open={customizeOpen} onOpenChange={setCustomizeOpen} />}
      </div>
    </CcContext.Provider>
  )
  return layer && typeof document !== 'undefined' ? createPortal(board, document.body) : board
}
