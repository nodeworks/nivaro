import type { Registered } from './registry'

/**
 * #1166 whole-view links: page state a feature owns (a lens toggle, the workspace, the node
 * scope, the canvas zoom) that a link should carry. `get` returns the URL value, or null when the
 * state is at its default (a default view gives a clean URL); `set(null)` restores the default.
 * `subscribe` tells the page to rewrite the URL when the value changes.
 */
export interface ViewParam extends Registered {
  /** URL parameter name (short, unique). */
  param: string
  get(): string | null
  set(value: string | null): void
  subscribe?(fn: () => void): () => void
}

export const viewParams: ViewParam[] = []
