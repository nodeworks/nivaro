import { createContext, type ReactNode, useContext } from 'react'
import type { LayoutBundle, LayoutOp } from '../../lib/layout-ops'

/**
 * What the editor hands the AI review slot (#2587): the draft, so a reviewed
 * change set lands through it as ONE undo step instead of a server-side write
 * the open draft would only learn about as "someone else saved".
 */
export interface LayoutReviewContext {
  bundle: LayoutBundle
  apply(ops: LayoutOp[], opts: { label: string }): void
  /** Why these ops would not apply to the draft as it is now (the ops twin), or null. */
  check(ops: LayoutOp[]): string | null
}

/**
 * What the layout editor needs from the app that hosts it. The editor lives in
 * @nivaro/shared and may not import admin code: anything admin-only (AI review,
 * explain, routing, the admin gate) comes in through this contract.
 */
export interface LayoutEditorHost {
  isAdmin: boolean
  navigate(to: string): void
  /** Admin-only AI review panel for a layout. Omitted by hosts that do not offer it. */
  aiReviewSlot?: (layoutId: number, ctx?: LayoutReviewContext) => ReactNode
  /** Admin-only "explain this" control for a layout part. */
  explainSlot?: (subject: object) => ReactNode
  /** Shown above the editor when this instance's layouts are overwritten elsewhere. */
  warning: string | null
  recordLink(collection: string, id: string): string
  /** Where a layout of any collection opens in this host (find a field across forms). */
  layoutLink?(collection: string, layoutId: number): string
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
