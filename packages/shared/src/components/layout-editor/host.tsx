import { createContext, type ReactNode, useContext } from 'react'

/**
 * What the layout editor needs from the app that hosts it. The editor lives in
 * @nivaro/shared and may not import admin code: anything admin-only (AI review,
 * explain, routing, the admin gate) comes in through this contract.
 */
export interface LayoutEditorHost {
  isAdmin: boolean
  navigate(to: string): void
  /** Admin-only AI review panel for a layout. Omitted by hosts that do not offer it. */
  aiReviewSlot?: (layoutId: number) => ReactNode
  /** Admin-only "explain this" control for a layout part. */
  explainSlot?: (subject: object) => ReactNode
  /** Shown above the editor when this instance's layouts are overwritten elsewhere. */
  warning: string | null
  recordLink(collection: string, id: string): string
}

const DEFAULT_HOST: LayoutEditorHost = {
  isAdmin: false,
  navigate: () => {},
  warning: null,
  recordLink: (collection, id) => `/collections/${collection}/${id}`
}

export const LayoutEditorHostContext = createContext<LayoutEditorHost>(DEFAULT_HOST)

export function useLayoutEditorHost(): LayoutEditorHost {
  return useContext(LayoutEditorHostContext)
}
