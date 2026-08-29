import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { createContext, useCallback, useContext, useState } from 'react'

// ─── Grid flush registry ───────────────────────────────────────────────────

export type GridFlushContextValue = {
  register: (key: string, fn: () => Promise<void>) => void
  unregister: (key: string) => void
}

export const GridFlushContext = createContext<GridFlushContextValue | null>(null)

export function useGridFlush(): GridFlushContextValue | null {
  return useContext(GridFlushContext)
}

// ─── Nivaro client context ─────────────────────────────────────────────────

type NivaroFormContextValue = {
  client: NivaroClient
}

const NivaroFormContext = createContext<NivaroFormContextValue | null>(null)

export function NivaroProvider({
  client,
  children
}: {
  client: NivaroClient
  children: React.ReactNode
}) {
  // Components consume TanStack Query throughout. Hosts that already run a
  // QueryClientProvider (the admin) keep theirs; standalone consumers get one
  // for free instead of "No QueryClient set" at first render.
  const ambientQueryClient = useContext(QueryClientContext)
  const [ownQueryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } }
      })
  )

  const inner = (
    <NivaroFormContext.Provider value={{ client }}>{children}</NivaroFormContext.Provider>
  )
  if (ambientQueryClient) return inner
  return <QueryClientProvider client={ownQueryClient}>{inner}</QueryClientProvider>
}

export function useNivaroClient(): NivaroClient {
  const ctx = useContext(NivaroFormContext)
  if (!ctx) throw new Error('useNivaroClient must be used within <NivaroProvider>')
  return ctx.client
}

export function useOptionalNivaroClient(): NivaroClient | null {
  const ctx = useContext(NivaroFormContext)
  return ctx?.client ?? null
}

/**
 * Base URL + auth for the few raw `fetch` calls (widgets, PDF blobs) that
 * can't go through `client.request`. Derives everything from the ambient
 * Nivaro client so external hosts (different origin, token auth) work the
 * same as the same-origin admin; falls back to relative '/api' + cookies
 * when no provider is mounted.
 */
export function useApiFetchConfig(): {
  apiBase: string
  authHeaders: Record<string, string>
  credentials: RequestCredentials
} {
  const client = useOptionalNivaroClient()
  const token = client?.getToken()
  return {
    apiBase: client ? `${client.url}/api` : '/api',
    authHeaders: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: token ? 'omit' : 'include'
  }
}

// ─── Auth context (injected by consumers; defaults to non-admin) ───────────

export type ItemEditAuthContextValue = {
  isAdmin: boolean
  userId: string
}

export const ItemEditAuthContext = createContext<ItemEditAuthContextValue>({
  isAdmin: false,
  userId: ''
})

export function useItemEditAuth(): ItemEditAuthContextValue {
  return useContext(ItemEditAuthContext)
}

// ─── Navigation context (injected by consumers; no-op default) ────────────

/** A record the UI wants to link to / open the edit page for. */
export type ItemLinkTarget = {
  collection: string
  itemId: string
  /** Grouped-layout slug to pin (queue item_layout etc.); null/absent = default. */
  layoutSlug?: string | null
}

export type NavigationContextValue = {
  /** `options.state` rides along for hosts whose router supports it (e.g. react-router's
   *  useNavigate) — hosts that ignore the second argument still navigate correctly. */
  navigate: (path: string, options?: { state?: unknown }) => void
  /** Map item links onto the host app's own routes. Components fall back to
   *  the admin shape (/collections/:collection/:id?layout=…) when absent —
   *  external embeds supply one function and every open path follows. */
  itemUrl?: (target: ItemLinkTarget) => string
  /** Full interception of item-opening: return true = handled (components
   *  skip navigation entirely — open your own modal/drawer instead). Checked
   *  before itemUrl/navigate. */
  openItem?: (target: ItemLinkTarget) => boolean | undefined
  /** Route for a user's profile page (UserChip "View profile"). Absent = the
   *  admin shape `/users/:id`; return null = host has no such page, the
   *  action is hidden instead of navigating into the host's 404 fallback. */
  userUrl?: (userId: string) => string | null
}

export const NavigationContext = createContext<NavigationContextValue>({
  navigate: (path) => {
    window.location.href = path
  }
})

export function useNavigation(): NavigationContextValue {
  return useContext(NavigationContext)
}

/** The admin's route shape — the default when the host supplies no itemUrl. */
export function defaultItemUrl(t: ItemLinkTarget): string {
  const base = `/collections/${t.collection}/${t.itemId}`
  return t.layoutSlug ? `${base}?layout=${encodeURIComponent(t.layoutSlug)}` : base
}

/** Resolved item-link helpers honoring the host's itemUrl/openItem overrides. */
export function useItemNavigation(): {
  urlFor: (target: ItemLinkTarget) => string
  open: (target: ItemLinkTarget) => void
} {
  const ctx = useNavigation()
  const urlFor = (t: ItemLinkTarget) => (ctx.itemUrl ?? defaultItemUrl)(t)
  const open = (t: ItemLinkTarget) => {
    if (ctx.openItem?.(t) === true) return
    ctx.navigate(urlFor(t))
  }
  return { urlFor, open }
}

// ─── Parent draft context (parent form values for cascade filters) ─────────

export type ParentDraftContextValue = {
  draft: Record<string, unknown>
  collection: string
  /** Fields the USER changed this session — cascade clear_on_unavailable only
   *  auto-clears when one of its parents is here; a record loaded with a
   *  stale saved value keeps it (the picker flags it amber instead). */
  dirtyFields?: ReadonlySet<string>
  /** Effective display label per parent field (layout overrides applied) —
   *  child components naming a parent field ("select Zone first") must use
   *  these, never titleCase over the raw column name. */
  fieldLabels?: Record<string, string>
  /** Effective option_filter per field (layout overrides applied). Cascading
   *  pickers inherit an UNSET parent's option filter through the cascade
   *  relation, so an unfiltered child can't offer records the parent's own
   *  picker would refuse. */
  fieldOptionFilters?: Record<string, Record<string, unknown>>
}

export const ParentDraftContext = createContext<ParentDraftContextValue | null>(null)

export function useParentDraft(): ParentDraftContextValue | null {
  return useContext(ParentDraftContext)
}

// ─── Grid-level re-import trigger ─────────────────────────────────────────────
// ItemEditForm provides its reimport parse handler so a grid configured with
// `options.upload_template` can render its own upload button. Null on new
// records and outside ItemEditForm.
export type ReimportHandler = (result: unknown, template: unknown) => void

export const ReimportHandlerContext = createContext<ReimportHandler | null>(null)

export function useReimportHandler(): ReimportHandler | null {
  return useContext(ReimportHandlerContext)
}

// ─── Drill-down ────────────────────────────────────────────────────────────────
// Provided by the host app (admin) to open a record detail sheet when a
// relation field configured for drill-down is clicked. Null (default) = no
// drill affordances render; headless consumers are unaffected.

export interface DrilldownTarget {
  collection: string
  itemId: string
  layoutId?: number | null
  width?: number | string | null
  title?: string
}

export interface DrilldownContextValue {
  open: (target: DrilldownTarget) => void
}

export const DrilldownContext = createContext<DrilldownContextValue | null>(null)
export function useDrilldown(): DrilldownContextValue | null {
  return useContext(DrilldownContext)
}

/**
 * Lets a host put transient overlay state — a drill-down sheet and how deep it
 * is — into browser history, so Back closes the sheet instead of abandoning the
 * page underneath it.
 *
 * These packages own no router, so they cannot do this themselves, and driving
 * `history.pushState` directly would be worse than useless: react-router keeps
 * its own index in `history.state`, and writing behind its back desyncs that and
 * corrupts ordinary Back navigation. So the host implements this and the
 * components consume it. Hosts that supply nothing keep local component state
 * and behave exactly as before.
 *
 * Values must be plain and serialisable — they ride in the host's history entry
 * and are expected to survive a reload.
 */
export interface OverlayHistory {
  /** Current value stored under `key`, or null when the overlay is closed. */
  get: (key: string) => unknown
  /** Store `value` under `key` as ONE new history entry. */
  push: (key: string, value: unknown) => void
  /** Go back `steps` entries (default 1), undoing that many pushes. */
  back: (steps?: number) => void
}

export const OverlayHistoryContext = createContext<OverlayHistory | null>(null)

/**
 * Overlay state for `key`, held in history when the host provides an
 * OverlayHistory and in component state otherwise. The two paths share an API,
 * so a call site does not know or care which it got.
 */
export function useOverlayState<T>(key: string): {
  value: T | null
  /** Open, or replace the value — one history entry when history-backed. */
  push: (value: T) => void
  /** Undo `steps` pushes (default 1). */
  back: (steps?: number) => void
} {
  const history = useContext(OverlayHistoryContext)
  // Without a host adapter there are no history entries to pop, so the previous
  // values are kept here and unwound the same way — the two paths stay
  // behaviourally identical, only one of them is reachable by the Back button.
  const [locals, setLocals] = useState<T[]>([])

  const value = history
    ? ((history.get(key) as T | null) ?? null)
    : (locals[locals.length - 1] ?? null)

  const push = useCallback(
    (next: T) => {
      if (history) history.push(key, next)
      else setLocals((prev) => [...prev, next])
    },
    [history, key]
  )

  const back = useCallback(
    (steps = 1) => {
      if (history) history.back(steps)
      else setLocals((prev) => prev.slice(0, Math.max(0, prev.length - steps)))
    },
    [history]
  )

  return { value, push, back }
}

// Per-field drill-down config stored in the layout assignment's overrides.
export interface FieldDrilldownConfig {
  enabled?: boolean
  layout_id?: number | null
  width?: number | string | null
}

export function fieldDrilldownConfig(field: {
  interface?: string | null
  _overrides?: Record<string, unknown> | null
}): FieldDrilldownConfig | null {
  const raw = field._overrides?.drilldown
  const cfg = raw && typeof raw === 'object' ? (raw as FieldDrilldownConfig) : null
  // relation-path fields drill by default; M2O/M2M are opt-in.
  const defaultEnabled = field.interface === 'relation-path'
  const enabled = cfg?.enabled ?? defaultEnabled
  if (!enabled) return null
  return { enabled: true, layout_id: cfg?.layout_id ?? null, width: cfg?.width ?? null }
}

// Resolved relation-path metadata (ids + final collection per dotted field),
// provided by ItemEditForm so deep field renderers can build drill targets.
export const RelationPathDataContext = createContext<Record<
  string,
  { ids: string[]; target_collection: string | null }
> | null>(null)


/**
 * Lets a field picker tell the form that its stored value no longer appears in
 * its own filtered option set, so the summary can flag it too.
 *
 * The picker is the ONLY place that knows this: staleness depends on the
 * field's resolved option filter (cascade parents, $parent tokens, picker
 * filters), and a second implementation would drift from it — the same way a
 * duplicated owner resolver silently returned nobody for months. So the
 * component that already computed the answer reports it, rather than the
 * summary asking a similar-but-different question.
 */
export const StaleFieldReportContext = createContext<
  ((field: string, stale: boolean) => void) | null
>(null)
export const useStaleFieldReporter = () => useContext(StaleFieldReportContext)
