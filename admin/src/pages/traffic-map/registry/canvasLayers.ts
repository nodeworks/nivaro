import type { MapLayout, MapTokens } from '../layout'
import type { MapData } from '../MapCanvas'
import type { TrafficModel } from '../model'
import type { Filters, Selection } from '../types'
import { byOrder, type Registered } from './registry'

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

/**
 * Edge styles (#1112): recolour a base edge — e.g. a partner edge by why its calls fail. The
 * first provider that returns a style wins; `tone` names a MapTokens colour so light/dark follow
 * the theme, `dash` dashes the stroke. Called once per edge per paint: keep it cheap.
 */
export interface EdgeStyle extends Registered {
  /** `in` = caller/source → lane, `out` = lane → down node. */
  style(
    edge: { dir: 'in' | 'out'; from: string; to: string; rps: number },
    model: TrafficModel
  ): { tone: keyof MapTokens; dash?: number[]; label?: string } | null
}

export const edgeStyles: EdgeStyle[] = []

/** First style any provider gives the edge; null when none. */
export function edgeStyleFor(
  edge: { dir: 'in' | 'out'; from: string; to: string; rps: number },
  model: TrafficModel
): { tone: keyof MapTokens; dash?: number[]; label?: string } | null {
  for (const s of edgeStyles) {
    try {
      const v = s.style(edge, model)
      if (v) return v
    } catch {
      /* a broken style provider leaves the edge plain */
    }
  }
  return null
}

/**
 * A pill on a side-column node — a caller/source (`kind: 'caller'`) or a downstream node
 * (`kind: 'down'`): pool pressure on SQL Server (#1109), a run failing on a cron job…
 */
export interface SideBadge extends Registered {
  badge(
    kind: 'caller' | 'down',
    nodeId: string,
    model: TrafficModel
  ): { text: string; tone: 'warn' | 'error' | 'info' } | null
}

export const sideBadges: SideBadge[] = []

export function sideBadgeFor(
  kind: 'caller' | 'down',
  nodeId: string,
  model: TrafficModel
): { text: string; tone: 'warn' | 'error' | 'info' } | null {
  // order ascending (default 100), registration order within — a blocked database outranks pool
  for (const b of byOrder(sideBadges)) {
    try {
      const v = b.badge(kind, nodeId, model)
      if (v) return v
    } catch {
      /* a broken badge provider draws nothing */
    }
  }
  return null
}

let repaint: () => void = () => {}
/** The map canvas registers its repaint here; features call requestCanvasRepaint() after
 *  changing state a layer draws (an overlay toggle) so the next frame paints it. */
export function setCanvasRepaint(fn: () => void): void {
  repaint = fn
}
export function requestCanvasRepaint(): void {
  repaint()
}

/**
 * Extra side-column nodes the map draws even without a lane edge: a source that only calls
 * partners (a cron job's pushes), a down node a tap reports (Redis commands).
 */
export interface NodeProvider extends Registered {
  sources?(model: TrafficModel, win: number, filters: Filters): Array<{ id: string; rps: number }>
  downs?(model: TrafficModel, win: number): string[]
}

export const nodeProviders: NodeProvider[] = []
