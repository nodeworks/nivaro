import {
  type GroupRow,
  HEADER_GROUP_KEY,
  isCanvasSlot,
  type LayoutBundle,
  type PlacementRow,
  UNGROUPED_KEY
} from '../../../lib/layout-ops'
import { titleCase } from '../../../lib/utils'
import { type DesignTarget, targetKey } from '../design-context'
import { normalizedBundle } from '../field-zones'
import { readOverrides } from '../inspector/model'
import { slotName } from '../slot-names'

// The form as a tree (#2621 outline, #2622 breadcrumb, #2620 find): steps,
// tabs, sections and the fields in them, in the order the canvas draws them.
// Parent-layout parts the canvas shows (bundleToActiveLayout) are in it too,
// marked inherited. Pure — every caller passes the draft bundle.

export type NavKind =
  | 'header'
  | 'step'
  | 'tab'
  | 'steps-holder'
  | 'tabs-holder'
  | 'section'
  | 'text'
  | 'info'
  | 'ungrouped'
  | 'panel'
  | 'widget'
  | 'field'

export const KIND_WORDS: Record<NavKind, string> = {
  header: 'Header strip',
  step: 'Step',
  tab: 'Tab',
  'steps-holder': 'Steps holder',
  'tabs-holder': 'Tabs holder',
  section: 'Section',
  text: 'Text block',
  info: 'Record info',
  ungrouped: 'Ungrouped fields',
  panel: 'Panel',
  widget: 'Widget',
  field: 'Field'
}

export interface NavNode {
  /** targetKey of `target`; `header` for the header strip. */
  id: string
  /** What selecting the row selects; null for the header strip itself. */
  target: DesignTarget | null
  kind: NavKind
  label: string
  /** The field or group key, for find and the row's hint. */
  key: string
  /** Hidden here (the placement's own Hidden switch). */
  hidden: boolean
  /** Supplied by the parent layout: shown, never moved here. */
  inherited: boolean
  children: NavNode[]
}

/** field → its label in the collection's field config. */
export type FieldLabels = (field: string) => string | null | undefined

interface Merged {
  groups: GroupRow[]
  placements: PlacementRow[]
  inherited: Set<string>
  ungroupedSort: number | null
}

// What the canvas shows: the layout's own rows, plus the parent's groups and
// placements the layout does not have (the bundleToActiveLayout merge).
function merged(bundle: LayoutBundle, parent: LayoutBundle | null): Merged {
  const inherited = new Set<string>()
  const ungrouped = bundle.groups.find((g) => g.key === UNGROUPED_KEY)
  const groups = bundle.groups.filter((g) => g.key !== UNGROUPED_KEY)
  let placements = bundle.placements
  if (parent) {
    const keys = new Set(groups.map((g) => g.key))
    const fields = new Set(placements.map((p) => p.field))
    for (const g of parent.groups) {
      if (g.key === UNGROUPED_KEY || keys.has(g.key)) continue
      groups.push(g)
      inherited.add(targetKey({ kind: 'group', key: g.key }))
    }
    const extra = parent.placements.filter((p) => !fields.has(p.field))
    for (const p of extra) inherited.add(targetKey(placementTarget(p)))
    placements = [...placements, ...extra]
  }
  return { groups, placements, inherited, ungroupedSort: ungrouped ? ungrouped.sort : null }
}

export function placementTarget(p: { field: string; group_key: string | null }): DesignTarget {
  if (p.group_key === HEADER_GROUP_KEY) return { kind: 'header', field: p.field }
  return {
    kind: p.field.startsWith('__') ? 'slot' : 'field',
    field: p.field,
    group_key: p.group_key
  }
}

const bySort = <T extends { sort: number }>(rows: T[]) => [...rows].sort((a, b) => a.sort - b.sort)

export function groupKind(bundle: LayoutBundle, g: GroupRow, parent: GroupRow | null): NavKind {
  if (g.type === 'tab') {
    const mode = parent ? parent.tab_mode : bundle.layout.tab_mode
    return mode === 'steps' ? 'step' : 'tab'
  }
  if (g.type === 'container') return g.tab_mode === 'steps' ? 'steps-holder' : 'tabs-holder'
  if (g.type === 'content' || g.type === 'text') return 'text'
  if (g.type === 'metadata') return 'info'
  return 'section'
}

const groupLabel = (g: GroupRow) => g.label || titleCase(g.key)

export function placementLabel(p: PlacementRow, labels: FieldLabels): string {
  if (p.label_override) return p.label_override
  const ov = readOverrides(p).label
  if (typeof ov === 'string' && ov) return ov
  if (p.field.startsWith('__')) return p.widget_id != null ? 'Widget' : slotName(p.field)
  return labels(p.field) || titleCase(p.field.split('.').pop() ?? p.field)
}

function placementNode(p: PlacementRow, m: Merged, labels: FieldLabels): NavNode {
  const target = placementTarget(p)
  const slot = p.field.startsWith('__')
  return {
    id: targetKey(target),
    target,
    kind: slot ? (p.widget_id != null ? 'widget' : 'panel') : 'field',
    label: placementLabel(p, labels),
    key: p.field,
    hidden: readOverrides(p).hidden === true || p.is_visible === false,
    inherited: m.inherited.has(targetKey(target)),
    children: []
  }
}

/**
 * The outline: the header strip (when it has tiles), then the page in canvas
 * order — sections, tabs and steps with their fields, tabs and steps inside
 * their holder, the Ungrouped fields and the page panels.
 */
export function buildOutline(
  bundle: LayoutBundle,
  parent: LayoutBundle | null,
  labels: FieldLabels
): NavNode[] {
  const m = merged(normalizedBundle(bundle), parent)
  const inZone = (zone: string | null) =>
    bySort(m.placements.filter((p) => p.group_key === zone && !isCanvasSlot(p))).map((p) =>
      placementNode(p, m, labels)
    )
  const groupNode = (g: GroupRow, up: GroupRow | null): NavNode => {
    const target: DesignTarget = { kind: 'group', key: g.key }
    const kids =
      g.type === 'container'
        ? bySort(m.groups.filter((t) => t.parent_key === g.key)).map((t) => groupNode(t, g))
        : inZone(g.key)
    return {
      id: targetKey(target),
      target,
      kind: groupKind(bundle, g, up),
      label: groupLabel(g),
      key: g.key,
      hidden: false,
      inherited: m.inherited.has(targetKey(target)),
      children: kids
    }
  }

  const out: NavNode[] = []
  const tiles = inZone(HEADER_GROUP_KEY)
  const subtitle = m.placements.find((p) => p.field === '__subtitle__')
  if (tiles.length > 0 || subtitle) {
    const kids = subtitle ? [placementNode(subtitle, m, labels), ...tiles] : tiles
    out.push({
      id: 'header',
      target: null,
      kind: 'header',
      label: KIND_WORDS.header,
      key: HEADER_GROUP_KEY,
      hidden: false,
      inherited: false,
      children: kids
    })
  }

  const ungroupedKids = inZone(null).filter((n) => n.key !== '__subtitle__')
  type Top = { sort: number; node: NavNode }
  const top: Top[] = [
    ...m.groups
      .filter((g) => g.parent_key === null)
      .map((g) => ({ sort: g.sort, node: groupNode(g, null) })),
    ...m.placements
      .filter((p) => isCanvasSlot(p))
      .map((p) => ({ sort: p.sort, node: placementNode(p, m, labels) }))
  ]
  const ungrouped: NavNode = {
    id: targetKey({ kind: 'group', key: UNGROUPED_KEY }),
    target: { kind: 'group', key: UNGROUPED_KEY },
    kind: 'ungrouped',
    label: 'Ungrouped',
    key: UNGROUPED_KEY,
    hidden: false,
    inherited: false,
    children: ungroupedKids
  }
  const ordered = [...top].sort((a, b) => a.sort - b.sort)
  const sorted = ordered.map((t) => t.node)
  if (ungroupedKids.length > 0) {
    const pos = m.ungroupedSort
    const at = pos === null ? -1 : ordered.findIndex((t) => t.sort > pos)
    sorted.splice(at < 0 ? sorted.length : at, 0, ungrouped)
  }
  return [...out, ...sorted]
}

/** Every node, depth first, with its ancestors (outermost first). */
export function walk(
  nodes: NavNode[],
  up: NavNode[] = []
): Array<{ node: NavNode; path: NavNode[] }> {
  const out: Array<{ node: NavNode; path: NavNode[] }> = []
  for (const n of nodes) {
    out.push({ node: n, path: up })
    out.push(...walk(n.children, [...up, n]))
  }
  return out
}

/** The ancestors of `t` (outermost first), as the outline nests it; [] when not found. */
export function pathOf(nodes: NavNode[], t: DesignTarget): NavNode[] {
  const id = targetKey(t)
  return walk(nodes).find((e) => e.node.id === id)?.path ?? []
}

export interface Crumb {
  target: DesignTarget
  label: string
  kind: NavKind
}

/**
 * The inspector's breadcrumb (#2622): the steps, tabs and sections `t` sits
 * in, outermost first (Step › Section). Header tiles and Ungrouped fields
 * have none; neither does a top-level section.
 */
export function crumbsOf(bundle: LayoutBundle, t: DesignTarget): Crumb[] {
  const start =
    t.kind === 'group'
      ? (bundle.groups.find((g) => g.key === t.key)?.parent_key ?? null)
      : t.kind === 'header'
        ? null
        : t.group_key
  const out: Crumb[] = []
  let key = start
  for (let hops = 0; key && key !== UNGROUPED_KEY && key !== HEADER_GROUP_KEY && hops < 8; hops++) {
    const g = bundle.groups.find((x) => x.key === key)
    if (!g) break
    const up = g.parent_key ? (bundle.groups.find((x) => x.key === g.parent_key) ?? null) : null
    out.unshift({
      target: { kind: 'group', key: g.key },
      label: groupLabel(g),
      kind: groupKind(bundle, g, up)
    })
    key = g.parent_key
  }
  return out
}
