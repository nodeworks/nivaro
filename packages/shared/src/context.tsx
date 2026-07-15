import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query'
import type React from 'react'
import { createContext, useContext, useState } from 'react'

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
}

export const ParentDraftContext = createContext<ParentDraftContextValue | null>(null)

export function useParentDraft(): ParentDraftContextValue | null {
  return useContext(ParentDraftContext)
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
