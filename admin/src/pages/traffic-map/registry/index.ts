/**
 * Traffic Map feature registrations. Each feature lives in its own module (e.g.
 * `../features/<name>.tsx`) and pushes into the registries beside this file with
 * `register(list, entry)` — importing from the specific files (`../registry/registry`,
 * `../registry/inspectorPanels`, …), never from this index, so no import cycle forms.
 *
 * Add ONE side-effect import per feature in the block below — e.g. `import '../features/<name>'`
 * — so parallel branches merge cleanly. TrafficMap.tsx imports this file, so every registration
 * runs before the page renders.
 */

// ── feature registrations (one line each) ──
import '../features/deep-measurement'
import '../features/b1-request-lenses'
import '../features/ops-health'
import '../features/screens'
import '../features/caller-cost'
import '../features/inflight'
import '../features/breaker'
import '../features/change-markers'
import '../features/nodes'
import '../features/snapshots'
import '../features/compare'
import '../features/digest'
import '../features/replay'
import '../features/topology'
import '../features/links'
import '../features/partner-owes'
import '../features/explain-spike'
import '../features/hook-cost'
import '../features/client-experience'
import '../features/slow-tail'
import '../features/node-alert'
import '../features/caller-controls'
import '../features/pause-node'
import '../features/error-groups'
import '../features/probe'
import '../features/runbooks'
import '../features/pins'
import '../features/correlations'
import '../features/presence'
import '../features/nl-filter'
import '../features/capture'
import '../features/view-links'
import '../features/people-lenses'
import '../features/stale-tabs'
import '../features/platform'

export {
  type CanvasLayer,
  type CanvasLayerArgs,
  canvasLayers,
  type EdgeStyle,
  edgeStyles,
  type NodeBadge,
  type NodeProvider,
  nodeBadges,
  nodeProviders,
  requestCanvasRepaint,
  type SideBadge,
  sideBadges
} from './canvasLayers'
export { type EventAction, eventActions } from './eventActions'
export { type HotColumn, hotColumns } from './hotColumns'
export { type InspectorAction, inspectorActions } from './inspectorActions'
export { type InspectorPanel, inspectorPanels } from './inspectorPanels'
export { type PagePanel, pagePanels } from './pagePanels'
export { byOrder, register } from './registry'
export { type StripTile, stripTiles } from './stripTiles'
export { type ToolbarItem, toolbarItems } from './toolbarItems'
export { type ViewParam, viewParams } from './viewParams'
