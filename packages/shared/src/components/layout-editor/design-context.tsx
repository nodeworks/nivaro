import { type CSSProperties, createContext, type ReactNode, useContext } from 'react'
import { isCanvasSlot } from '../../lib/layout-ops'
import type { ActiveLayoutData } from '../item-edit/types'
import type { RefusedWrite } from './design-canvas'
import type { EditorNote } from './editor-notes'

export type DesignTarget =
  | { kind: 'field'; field: string; group_key: string | null }
  | { kind: 'group'; key: string }
  | { kind: 'slot'; field: string; group_key: string | null }
  | { kind: 'header'; field: string }

export interface SelectOptions {
  /** Shift / ⌘ / Ctrl-click: add the target to the selection, or take it out. */
  additive?: boolean
}

export interface LayoutDesign {
  selected: DesignTarget | null
  onSelect(t: DesignTarget, opts?: SelectOptions): void
  /** Everything selected (several fields after Shift-click); absent = just `selected`. */
  selection?: DesignTarget[]
  showHidden: boolean
  /** Parent layout name when the node comes from an inherited layout, else null. */
  inheritedFrom(t: DesignTarget): string | null
  dnd: DesignDnd
  /** "Preview as role": what that role's field permissions do to the node
   *  (hidden: faint with a tag, still selectable; read-only: a lock tag). */
  roleMark?(t: DesignTarget): RoleMark | null
  /** Preview modes' tags on a node (role differences, what-if changes, state
   *  requirements). `highlight` rings the node so differences stand out. */
  marks?(t: DesignTarget): DesignMark[]
  /** "Who sees this field" overlay: a tint and a clickable chip on the node. */
  overlay?(t: DesignTarget): DesignOverlay | null
  /** How often a field is filled across the collection's records (#2588); null = unknown or off. */
  fillRate?(field: string): number | null
  /** #2608: the editor note pinned to the node, shown as a marker on the canvas. */
  note?(t: DesignTarget): EditorNote | null
  /** Expand all / Collapse all (#2627): every section folds open or shut;
   *  open also lays every step and tab out one under another. */
  fold?: FoldSignal | null
  /** Find / outline / breadcrumb (#2620): open the step, tab or section holding this. */
  reveal?: RevealSignal | null
}

/** A press of Expand all or Collapse all; `seq` changes on every press. */
export interface FoldSignal {
  open: boolean
  seq: number
}

/** A request to bring `target` into view; `seq` changes on every request. */
export interface RevealSignal {
  target: DesignTarget
  seq: number
}

/** The group a reveal opens: the target group itself, or the group a placement sits in. */
export function revealGroupKey(t: DesignTarget): string | null {
  if (t.kind === 'group') return t.key
  if (t.kind === 'header') return null
  return t.group_key
}

export interface DesignMark {
  text: string
  tone: 'violet' | 'emerald' | 'amber' | 'slate'
  /** Instant tooltip (data-tip) with the detail. */
  tip?: string
  highlight?: boolean
  /** A small icon before the text (a pinned section's pin, #2628). */
  icon?: 'pin'
}

export interface DesignOverlay {
  /** Classes tinting the node (background + ring), light and dark. */
  className: string
  /** Rendered in the node's badge row; clicks reach it (data-design-pass). */
  chip: ReactNode
}

export interface RoleMark {
  kind: 'hidden' | 'readonly'
  /** The role's name, for the tag ("Hidden for Finance"). */
  role: string
}

/**
 * Drag and drop state for design nodes. Plain functions, no hooks: inside a
 * LayoutDndProvider every DesignNode registers through the provider's store
 * (useDesignDndNode) and these only answer questions; outside one (tests,
 * hosts without drag and drop) DesignNode takes its props and state from
 * here. `disabled` (inherited nodes, the folded copy of a header tile) asks
 * for no drag props. Passing NO_DND (dnd/node.ts) turns dragging off even
 * inside a provider.
 */
export interface DesignDnd {
  draggableProps(t: DesignTarget, opts?: { disabled?: boolean }): object
  isDragging(t: DesignTarget): boolean
  dropSlot(t: DesignTarget): 'before' | 'after' | null
  /** Where the insertion line sits inside the node (absolute; no layout shift). */
  dropIndicator?(t: DesignTarget): CSSProperties | null
}

/**
 * The `design` prop of every renderer the layout editor uses as its canvas
 * (ItemEditForm, RecordReadView, RecordDrilldownSheet).
 */
export interface LayoutDesignProp {
  /** The draft layout — rendered instead of the server's resolved layout. */
  layout: ActiveLayoutData
  /** Preview record (its values, steps and rules); null/absent = no values. */
  record?: Record<string, unknown> | null
  context: LayoutDesign
  /** Preview the record as if it were in this pipeline state (state key). */
  stateKey?: string | null
  /** Something on the canvas tried to write and was refused (tests, dev tooling). */
  onRefusedWrite?: (w: RefusedWrite) => void
}

export const LayoutDesignContext = createContext<LayoutDesign | null>(null)

export function useLayoutDesign(): LayoutDesign | null {
  return useContext(LayoutDesignContext)
}

export function targetKey(t: DesignTarget): string {
  switch (t.kind) {
    case 'field':
    case 'slot':
      return `${t.kind}:${t.field}:${t.group_key ?? ''}`
    case 'group':
      return `group:${t.key}`
    case 'header':
      return `header:${t.field}`
  }
}

/** Fields and in-section panels can be selected together; sections, header
 *  tiles and page cards (pipeline, comments, …) are selected one at a time. */
export function isMultiSelectable(t: DesignTarget): boolean {
  if (t.kind === 'field') return true
  return t.kind === 'slot' && !isCanvasSlot(t)
}

/**
 * The selection after a click on `t`. A plain click selects `t` alone. An
 * additive click adds `t`, or takes it out when it is already selected, as
 * long as everything involved can be selected together; otherwise it acts
 * as a plain click. The last entry is the one the inspector would show alone.
 */
export function nextSelection(
  current: DesignTarget[],
  t: DesignTarget,
  opts?: SelectOptions
): DesignTarget[] {
  if (!opts?.additive || !isMultiSelectable(t) || !current.every(isMultiSelectable)) return [t]
  const key = targetKey(t)
  if (current.some((c) => targetKey(c) === key)) return current.filter((c) => targetKey(c) !== key)
  return [...current, t]
}

/** Is `t` part of the design's selection (several, or the one selected)? */
export function isSelectedIn(design: LayoutDesign, t: DesignTarget): boolean {
  const key = targetKey(t)
  if (design.selection) return design.selection.some((s) => targetKey(s) === key)
  return design.selected != null && targetKey(design.selected) === key
}
