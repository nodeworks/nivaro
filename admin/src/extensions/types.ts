import type React from 'react'

// ─── Slot interfaces ──────────────────────────────────────────────────────────

export interface ExternalApiDetailSlot {
  filter?: (ctx: { api: ExternalApiForSlot }) => boolean
  component: React.ComponentType<{ api: ExternalApiForSlot }>
}

export interface ItemDetailSidebarSlot {
  filter?: (ctx: { collection: string; item: Record<string, unknown> }) => boolean
  label: string
  component: React.ComponentType<{ collection: string; item: Record<string, unknown> }>
}

export interface NavSidebarSlot {
  section: 'main' | 'automation' | 'system' | 'monitoring' | 'extensions'
  label: string
  icon: React.ComponentType<{ className?: string }>
  href: string
}

export interface SettingsTabSlot {
  id: string
  label: string
  component: React.ComponentType
}

export interface CollectionToolbarSlot {
  filter?: (ctx: { collection: string }) => boolean
  component: React.ComponentType<{ collection: string; selectedIds: (string | number)[] }>
}

export interface ListRowActionSlot {
  filter?: (ctx: { collection: string }) => boolean
  label: string
  onClick: (ctx: { collection: string; item: Record<string, unknown> }) => void
}

/** A React component rendered at the app root (inside Router + auth). Extensions use this for overlays, global queries, subscriptions. */
export interface AppComponentSlot {
  component: React.ComponentType
}

/** Called on every non-2xx axios response. Return true to signal "handled" (stops further processing). */
export interface ResponseInterceptorSlot {
  handler: (status: number, data: unknown, headers: Record<string, string>) => boolean | void
}

export interface PluginSlots {
  'external-api-detail': ExternalApiDetailSlot
  'item-detail-sidebar': ItemDetailSidebarSlot
  'nav-sidebar': NavSidebarSlot
  'settings-tab': SettingsTabSlot
  'collection-toolbar': CollectionToolbarSlot
  'list-row-action': ListRowActionSlot
  'app-component': AppComponentSlot
  'response-interceptor': ResponseInterceptorSlot
}

export interface ExtensionPlugin {
  id: string
  name?: string
  version?: string
  slots?: {
    [K in keyof PluginSlots]?: PluginSlots[K]
  }
}

// Minimal ExternalApi shape for slot context (plugins only get what they need)
export interface ExternalApiForSlot {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: string
  integration_type: string | null
  integration_config: Record<string, unknown> | null
  enabled: boolean
}

// Extension manifest as returned by GET /api/extensions/manifest
export interface ExtensionManifest {
  id: string
  name: string
  version: string | null
  bundleUrl: string
  slots: string[]
  cloud: boolean
}

// Global window type augmentation
declare global {
  interface Window {
    __NIVARO__: {
      React: typeof import('react')
      useState: typeof import('react').useState
      useEffect: typeof import('react').useEffect
      useCallback: typeof import('react').useCallback
      useMemo: typeof import('react').useMemo
      useRef: typeof import('react').useRef
      registerPlugin: (plugin: ExtensionPlugin) => void
      registerCloudPlugin: (plugin: ExtensionPlugin) => void
      useQuery: typeof import('@tanstack/react-query').useQuery
      useMutation: typeof import('@tanstack/react-query').useMutation
      useNavigate: typeof import('react-router').useNavigate
      toast: typeof import('sonner').toast
    }
  }
}
