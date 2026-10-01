import type { MapLayout, MapTokens } from '../layout'
import type { MapData } from '../MapCanvas'
import type { TrafficModel } from '../model'
import type { Filters, Selection } from '../types'
import type { Registered } from './registry'

export interface CanvasLayerArgs {
  layout: MapLayout
  data: MapData
  /** Colours resolved from the --tm-* tokens (light/dark follow the theme). */
  tokens: MapTokens
  fonts: { sans: string; mono: string }
  model: TrafficModel
  filters: Filters
  /** The clicked selection. */
  selection: Selection | null
  /** Hover, else the selection — what the map highlights right now. */
  active: Selection | null
  /** Date.now() of this paint. */
  now: number
}

/**
 * Map canvas draw hooks, called each paint after the nodes are drawn (before particles), each in
 * its own ctx.save()/restore() and try/catch. Return `true` while something is still animating
 * so the loop keeps painting (any other return — or none — lets it rest).
 */
export interface CanvasLayer extends Registered {
  draw(ctx: CanvasRenderingContext2D, args: CanvasLayerArgs): unknown
}

export const canvasLayers: CanvasLayer[] = []

/** A small pill on an entity node (duplicate requests, N+1, retry storm…); null = none. */
export interface NodeBadge extends Registered {
  badge(
    nodeId: string,
    model: TrafficModel
  ): { text: string; tone: 'warn' | 'error' | 'info' } | null
}

export const nodeBadges: NodeBadge[] = []

/** First badge any registered provider gives the node (providers in order); null when none. */
export function badgeFor(
  nodeId: string,
  model: TrafficModel
): { text: string; tone: 'warn' | 'error' | 'info' } | null {
  for (const b of nodeBadges) {
    try {
      const v = b.badge(nodeId, model)
      if (v) return v
    } catch {
      /* a broken badge provider draws nothing */
    }
  }
  return null
}
