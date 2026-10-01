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

export {
  type CanvasLayer,
  type CanvasLayerArgs,
  canvasLayers,
  type NodeBadge,
  nodeBadges
} from './canvasLayers'
export { type EventAction, eventActions } from './eventActions'
export { type HotColumn, hotColumns } from './hotColumns'
export { type InspectorAction, inspectorActions } from './inspectorActions'
export { type InspectorPanel, inspectorPanels } from './inspectorPanels'
export { type PagePanel, pagePanels } from './pagePanels'
export { byOrder, register } from './registry'
export { type StripTile, stripTiles } from './stripTiles'
export { type ToolbarItem, toolbarItems } from './toolbarItems'
