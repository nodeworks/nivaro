/**
 * Layout ops — the layout editor's save model. The editor applies small ops
 * to a LayoutBundle optimistically; the API applies the same ops to the
 * stored layout and writes the difference.
 *
 * TWIN FILE: api/src/services/layout-ops-apply.ts and
 * packages/shared/src/lib/layout-ops.ts must stay byte-identical (the API
 * cannot import packages/shared; an API test compares the two files). Golden
 * cases both suites run: packages/shared/src/lib/layout-ops.fixtures.json.
 *
 * Ordering: after every op `sort` is renumbered 0..n-1 per container —
 * placements per group_key (null = the Ungrouped zone), groups per
 * parent_key. The top level (parent_key null) is the record page's vertical
 * order: top-level groups, the Ungrouped zone (pseudo group `__ungrouped__`,
 * stored as the `__ungrouped_pos__` row) and the slot cards (CANVAS_SLOT_KEYS
 * placements with group_key null), which therefore take no part in the
 * Ungrouped zone's own order.
 */

export type PlacementKey = { field: string; group_key: string | null }

export interface PlacementPatch {
  label_override?: string | null
  is_visible?: boolean
  default_expanded?: boolean
  col_span?: number | null
  overrides?: unknown
  show_row_revisions?: boolean
  allow_revision_restore?: boolean | null
  lock_conditions?: string | null
  input_bindings?: unknown
  widget_id?: number | null
  show_approval_chain?: boolean
}

export interface PlacementRow {
  id?: number
  field: string
  group_key: string | null
  sort: number
  label_override: string | null
  is_visible: boolean
  default_expanded: boolean
  col_span: number | null
  overrides: unknown
  show_row_revisions: boolean
  allow_revision_restore: boolean | null
  lock_conditions: string | null
  input_bindings: unknown
  widget_id: number | null
  show_approval_chain: boolean
}

/** Group JSON settings (summary_fields, swap_config, …) travel as their stored JSON text. */
export interface GroupPatch {
  label?: string
  type?: string
  icon?: string | null
  is_collapsed?: boolean
  tab_mode?: string | null
  hide_when_empty?: boolean
  visibility_mode?: string | null
  summary_fields?: string | null
  summary_hide_empty?: boolean
  swap_config?: string | null
  skip_if_filled?: string | null
  content?: string | null
  content_tone?: string | null
  visible_when?: string | null
  hidden_for_roles?: string | null
  locked_for_roles?: string | null
  read_width?: string | null
}

export interface GroupRow {
  id?: number
  key: string
  parent_key: string | null
  sort: number
  label: string
  type: string
  icon: string | null
  is_collapsed: boolean
  tab_mode: string | null
  hide_when_empty: boolean
  visibility_mode: string | null
  summary_fields: string | null
  summary_hide_empty: boolean
  swap_config: string | null
  skip_if_filled: string | null
  content: string | null
  content_tone: string | null
  visible_when: string | null
  hidden_for_roles: string | null
  locked_for_roles: string | null
  read_width: string | null
}

/** The layout settings PATCH /collection-layouts/:id accepts. */
export type LayoutPatch = Partial<{
  name: string
  slug: string | null
  create_label: string | null
  create_hidden: boolean
  sort: number
  is_active: boolean
  disable_comments: boolean
  disable_tasks: boolean
  tab_mode: string
  validate_before_next: boolean
  summary_enabled: boolean
  summary_hide_empty: boolean
  ai_enabled: boolean
  accordion_mode: boolean
  disable_revisions: boolean
  disable_clone: boolean
  disable_delete: boolean
  row_order_field: string | null
  pdf_theme: string | null
  pdf_template_id: number | null
  pdf_cover_enabled: boolean
  pdf_cover_title_field: string | null
  pdf_cover_subtitle: string | null
  pdf_show_logo: boolean
  pdf_page_size: string
  pdf_orientation: string
  pdf_button_label: string | null
  conditions: { role_ids?: string[] } | null
  allow_schedule: boolean
  allow_disable_pickers: boolean
  layout_type: string
  addendum_layout_id: number | null
  workflow_template_id: string | null
  single_active_addendum: boolean
  addendum_default_view: boolean
  record_conditions: Array<{ field: string; op: string; value?: unknown }> | null
  default_values: Record<string, unknown> | null
  display_mode: string | null
  parent_layout_id: number | null
  hide_integrity_banner: boolean
  hide_sla_banner: boolean
  changes_tray: boolean
  dossier_enabled: boolean
  dossier_label: string | null
  quick_picker: string[] | null
  sheet_width: number | null
  header_fields: string[] | null
  hide_empty: boolean
}>

export type LayoutRow = Record<string, unknown> & { id: number; collection: string }

export type LayoutOp =
  | { op: 'place'; field: string; group_key: string | null; index: number; patch?: PlacementPatch }
  | { op: 'move'; from: PlacementKey; to_group_key: string | null; index: number }
  | { op: 'update_placement'; at: PlacementKey; patch: PlacementPatch }
  | { op: 'remove'; at: PlacementKey }
  | {
      op: 'group_create'
      key: string
      label: string
      group_type: string
      parent_key: string | null
      index: number
      patch?: GroupPatch
    }
  | { op: 'group_update'; key: string; patch: GroupPatch }
  | { op: 'group_move'; key: string; parent_key: string | null; index: number }
  | { op: 'group_remove'; key: string; placements: 'ungroup' | 'delete' }
  | { op: 'layout_update'; patch: LayoutPatch }

export interface LayoutBundle {
  layout: LayoutRow
  groups: GroupRow[]
  placements: PlacementRow[]
  rev: string
}

export const PLACEMENT_PATCH_KEYS = [
  'label_override',
  'is_visible',
  'default_expanded',
  'col_span',
  'overrides',
  'show_row_revisions',
  'allow_revision_restore',
  'lock_conditions',
  'input_bindings',
  'widget_id',
  'show_approval_chain'
] as const

export const GROUP_PATCH_KEYS = [
  'label',
  'type',
  'icon',
  'is_collapsed',
  'tab_mode',
  'hide_when_empty',
  'visibility_mode',
  'summary_fields',
  'summary_hide_empty',
  'swap_config',
  'skip_if_filled',
  'content',
  'content_tone',
  'visible_when',
  'hidden_for_roles',
  'locked_for_roles',
  'read_width'
] as const

export const LAYOUT_PATCH_KEYS = [
  'name',
  'slug',
  'create_label',
  'create_hidden',
  'sort',
  'is_active',
  'disable_comments',
  'disable_tasks',
  'tab_mode',
  'validate_before_next',
  'summary_enabled',
  'summary_hide_empty',
  'ai_enabled',
  'accordion_mode',
  'disable_revisions',
  'disable_clone',
  'disable_delete',
  'row_order_field',
  'pdf_theme',
  'pdf_template_id',
  'pdf_cover_enabled',
  'pdf_cover_title_field',
  'pdf_cover_subtitle',
  'pdf_show_logo',
  'pdf_page_size',
  'pdf_orientation',
  'pdf_button_label',
  'conditions',
  'allow_schedule',
  'allow_disable_pickers',
  'layout_type',
  'addendum_layout_id',
  'workflow_template_id',
  'single_active_addendum',
  'addendum_default_view',
  'record_conditions',
  'default_values',
  'display_mode',
  'parent_layout_id',
  'hide_integrity_banner',
  'hide_sla_banner',
  'changes_tray',
  'dossier_enabled',
  'dossier_label',
  'quick_picker',
  'sheet_width',
  'header_fields',
  'hide_empty'
] as const

export const GROUP_TYPES = ['section', 'tab', 'metadata', 'container', 'content'] as const
export const UNGROUPED_KEY = '__ungrouped__'
export const HEADER_GROUP_KEY = '__header__'

/** Slot cards: placed with group_key null, ordered among the top-level groups. */
export const CANVAS_SLOT_KEYS = [
  '__pipeline__',
  '__tasks__',
  '__comments__',
  '__addendums__',
  '__referenced_by__',
  '__related_records__'
] as const

// Tie order when stored sorts collide — the record page's (ItemEditForm
// sectionOrder): groups, Ungrouped, pipeline, tasks, comments, addendums,
// referenced-by, related records.
const CANVAS_TIE: Record<string, number> = {
  [UNGROUPED_KEY]: 1,
  __pipeline__: 2,
  __tasks__: 3,
  __comments__: 4,
  __addendums__: 7,
  __referenced_by__: 8,
  __related_records__: 9
}

export class LayoutOpError extends Error {
  op_index: number
  constructor(message: string, opIndex: number) {
    super(message)
    this.name = 'LayoutOpError'
    this.op_index = opIndex
  }
}

export function isCanvasSlot(p: { field: string; group_key: string | null }): boolean {
  return p.group_key === null && (CANVAS_SLOT_KEYS as readonly string[]).includes(p.field)
}

export function newPlacement(field: string, groupKey: string | null): PlacementRow {
  return {
    field,
    group_key: groupKey,
    sort: 0,
    label_override: null,
    is_visible: true,
    default_expanded: true,
    col_span: null,
    overrides: null,
    show_row_revisions: false,
    allow_revision_restore: true,
    lock_conditions: null,
    input_bindings: null,
    widget_id: null,
    show_approval_chain: false
  }
}

export function newGroup(
  key: string,
  label: string,
  type: string,
  parentKey: string | null
): GroupRow {
  return {
    key,
    label,
    type,
    parent_key: parentKey,
    sort: 0,
    icon: null,
    is_collapsed: false,
    tab_mode: null,
    hide_when_empty: false,
    visibility_mode: 'always',
    summary_fields: null,
    summary_hide_empty: false,
    swap_config: null,
    skip_if_filled: null,
    content: null,
    content_tone: null,
    visible_when: null,
    hidden_for_roles: null,
    locked_for_roles: null,
    read_width: null
  }
}

/** The Ungrouped zone's place on the canvas, as a pseudo group. */
export function ungroupedGroup(sort: number): GroupRow {
  return { ...newGroup(UNGROUPED_KEY, 'Ungrouped', 'ungrouped', null), sort }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Stable array order: groups by (parent, sort, key), placements by (group, sort, field). */
export function sortBundleRows<B extends { groups: GroupRow[]; placements: PlacementRow[] }>(
  bundle: B
): B {
  return {
    ...bundle,
    groups: [...bundle.groups].sort(
      (a, b) => cmp(a.parent_key ?? '', b.parent_key ?? '') || a.sort - b.sort || cmp(a.key, b.key)
    ),
    placements: [...bundle.placements].sort(
      (a, b) =>
        cmp(a.group_key ?? '', b.group_key ?? '') || a.sort - b.sort || cmp(a.field, b.field)
    )
  }
}

interface Draft {
  layout: LayoutRow
  groups: GroupRow[]
  placements: PlacementRow[]
}

type Member = GroupRow | PlacementRow

// Placements of one zone (canvas slots excluded), in their current order.
function zoneMembers(d: Draft, groupKey: string | null): PlacementRow[] {
  return d.placements
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.group_key === groupKey && !isCanvasSlot(p))
    .sort((a, b) => a.p.sort - b.p.sort || a.i - b.i)
    .map(({ p }) => p)
}

// Groups under one parent — plus, at the top level, the slot cards.
function groupMembers(d: Draft, parentKey: string | null): Member[] {
  const rows: Array<{ m: Member; tie: number; i: number }> = []
  d.groups.forEach((g, i) => {
    if (g.parent_key === parentKey) rows.push({ m: g, tie: CANVAS_TIE[g.key] ?? 0, i })
  })
  if (parentKey === null)
    d.placements.forEach((p, i) => {
      if (isCanvasSlot(p))
        rows.push({ m: p, tie: CANVAS_TIE[p.field] ?? 0, i: d.groups.length + i })
    })
  return rows.sort((a, b) => a.m.sort - b.m.sort || a.tie - b.tie || a.i - b.i).map((r) => r.m)
}

function setOrder(members: Member[]): void {
  members.forEach((m, i) => {
    m.sort = i
  })
}

function renumberAll(d: Draft): void {
  const zones = new Set<string | null>()
  for (const p of d.placements) if (!isCanvasSlot(p)) zones.add(p.group_key)
  for (const z of zones) setOrder(zoneMembers(d, z))
  const parents = new Set<string | null>([null])
  for (const g of d.groups) parents.add(g.parent_key)
  for (const parent of parents) setOrder(groupMembers(d, parent))
}

/**
 * Apply ops in order to a copy of the bundle. Throws LayoutOpError naming the
 * failing op's index; the input bundle is never mutated.
 */
export function applyLayoutOps(bundle: LayoutBundle, ops: LayoutOp[]): LayoutBundle {
  const d: Draft = {
    layout: { ...bundle.layout },
    groups: bundle.groups.map((g) => ({ ...g })),
    placements: bundle.placements.map((p) => ({ ...p }))
  }
  if (!Array.isArray(ops)) throw new LayoutOpError('ops must be an array', 0)
  ops.forEach((op, i) => {
    applyOne(d, op, i)
    renumberAll(d)
  })
  return sortBundleRows({ ...d, rev: bundle.rev })
}

function applyOne(d: Draft, op: LayoutOp, i: number): void {
  const fail = (message: string): never => {
    throw new LayoutOpError(message, i)
  }
  if (!op || typeof op !== 'object') fail('Each op must be an object')

  const insertAt = <T>(list: T[], item: T, index: unknown): T[] => {
    if (typeof index !== 'number' || !Number.isFinite(index)) fail('index must be a number')
    const at = Math.max(0, Math.min(list.length, Math.floor(index as number)))
    return [...list.slice(0, at), item, ...list.slice(at)]
  }
  const checkPatch = (patch: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (patch == null) return {}
    if (typeof patch !== 'object' || Array.isArray(patch)) fail('patch must be an object')
    for (const k of Object.keys(patch as object))
      if (!keys.includes(k)) fail(`Unknown setting "${k}"`)
    return patch as Record<string, unknown>
  }
  const checkGroupPatch = (patch: unknown): Record<string, unknown> => {
    const p = checkPatch(patch, GROUP_PATCH_KEYS)
    if (p.type !== undefined && !(GROUP_TYPES as readonly unknown[]).includes(p.type))
      fail(`Group type must be one of ${GROUP_TYPES.join(', ')}`)
    if (p.read_width != null && !['full', 'half', 'third'].includes(p.read_width as string))
      fail("read_width must be 'full', 'half', 'third' or null")
    return p
  }
  const findPlacement = (at: PlacementKey | undefined): PlacementRow => {
    if (!at || typeof at.field !== 'string') fail('A placement needs a field')
    const k = at as PlacementKey
    const row = d.placements.find(
      (p) => p.field === k.field && p.group_key === (k.group_key ?? null)
    )
    if (!row) fail(`"${k.field}" is not placed in ${k.group_key ?? 'Ungrouped'}`)
    return row as PlacementRow
  }
  const findGroup = (key: unknown): GroupRow => {
    if (key === UNGROUPED_KEY) fail('The Ungrouped zone can only be moved')
    const g = d.groups.find((x) => x.key === key)
    if (!g) fail(`No group "${String(key)}"`)
    return g as GroupRow
  }
  const checkTarget = (groupKey: string | null) => {
    if (groupKey === null || groupKey === HEADER_GROUP_KEY) return
    const g = d.groups.find((x) => x.key === groupKey)
    if (!g || g.key === UNGROUPED_KEY) fail(`No group "${groupKey}"`)
    if ((g as GroupRow).type === 'container') fail('Fields go in the tabs of a container')
  }
  // A parent must be a container, and only tabs sit in one.
  const checkParent = (parentKey: string | null, childType: string) => {
    if (parentKey === null) return
    const parent = d.groups.find((x) => x.key === parentKey)
    if (parent?.type !== 'container') fail(`"${parentKey}" is not a container`)
    if (childType !== 'tab') fail('Only tabs go inside a container')
  }
  const placeInOrder = (row: PlacementRow, index: unknown) => {
    const members = isCanvasSlot(row)
      ? groupMembers(d, null).filter((m) => m !== row)
      : zoneMembers(d, row.group_key).filter((m) => m !== row)
    setOrder(insertAt<Member>(members, row, index))
  }

  switch (op.op) {
    case 'place': {
      if (typeof op.field !== 'string' || !op.field) fail('place needs a field')
      const groupKey = op.group_key ?? null
      checkTarget(groupKey)
      if (d.placements.some((p) => p.field === op.field && p.group_key === groupKey))
        fail(`"${op.field}" is already in ${groupKey ?? 'Ungrouped'}`)
      const row: PlacementRow = {
        ...newPlacement(op.field, groupKey),
        ...checkPatch(op.patch, PLACEMENT_PATCH_KEYS)
      }
      d.placements.push(row)
      placeInOrder(row, op.index)
      return
    }
    case 'move': {
      const row = findPlacement(op.from)
      const to = op.to_group_key ?? null
      if (to !== row.group_key) {
        checkTarget(to)
        if (d.placements.some((p) => p.field === row.field && p.group_key === to))
          fail(`"${row.field}" is already in ${to ?? 'Ungrouped'}`)
        row.group_key = to
      }
      placeInOrder(row, op.index)
      return
    }
    case 'update_placement': {
      const row = findPlacement(op.at)
      Object.assign(row, checkPatch(op.patch, PLACEMENT_PATCH_KEYS))
      return
    }
    case 'remove': {
      const row = findPlacement(op.at)
      d.placements = d.placements.filter((p) => p !== row)
      return
    }
    case 'group_create': {
      if (typeof op.key !== 'string' || !op.key.trim()) fail('A group needs a key')
      if (op.key.startsWith('__')) fail('Group keys starting with __ are reserved')
      if (d.groups.some((g) => g.key === op.key)) fail(`A group "${op.key}" already exists`)
      if (typeof op.label !== 'string') fail('A group needs a label')
      const patch = checkGroupPatch(op.patch)
      const type = (patch.type as string | undefined) ?? op.group_type
      if (!(GROUP_TYPES as readonly string[]).includes(type))
        fail(`Group type must be one of ${GROUP_TYPES.join(', ')}`)
      const parentKey = op.parent_key ?? null
      checkParent(parentKey, type)
      const row: GroupRow = { ...newGroup(op.key, op.label, type, parentKey), ...patch }
      const members = groupMembers(d, parentKey)
      d.groups.push(row)
      setOrder(insertAt<Member>(members, row, op.index))
      return
    }
    case 'group_update': {
      const g = findGroup(op.key)
      const patch = checkGroupPatch(op.patch)
      if (patch.type !== undefined && patch.type !== g.type) {
        if (g.parent_key !== null && patch.type !== 'tab') fail('Only tabs go inside a container')
        if (g.type === 'container' && d.groups.some((x) => x.parent_key === g.key))
          fail('Move the tabs out of this container first')
      }
      Object.assign(g, patch)
      return
    }
    case 'group_move': {
      const parentKey = op.parent_key ?? null
      let row: Member
      if (op.key === UNGROUPED_KEY || (CANVAS_SLOT_KEYS as readonly string[]).includes(op.key)) {
        if (parentKey !== null) fail('This stays at the top level of the form')
        const found =
          op.key === UNGROUPED_KEY
            ? d.groups.find((g) => g.key === UNGROUPED_KEY)
            : d.placements.find((p) => p.field === op.key && p.group_key === null)
        if (!found) fail(`"${op.key}" is not on this form`)
        row = found as Member
      } else {
        const g = findGroup(op.key)
        checkParent(parentKey, g.type)
        g.parent_key = parentKey
        row = g
      }
      setOrder(
        insertAt<Member>(
          groupMembers(d, parentKey).filter((m) => m !== row),
          row,
          op.index
        )
      )
      return
    }
    case 'group_remove': {
      const g = findGroup(op.key)
      if (op.placements !== 'ungroup' && op.placements !== 'delete')
        fail("placements must be 'ungroup' or 'delete'")
      // Child tabs take the removed group's place, in their order.
      const siblings = groupMembers(d, g.parent_key)
      const children = groupMembers(d, g.key) as GroupRow[]
      for (const c of children) c.parent_key = g.parent_key
      const at = siblings.indexOf(g)
      setOrder([...siblings.slice(0, at), ...children, ...siblings.slice(at + 1)])
      d.groups = d.groups.filter((x) => x !== g)

      const inGroup = zoneMembers(d, g.key)
      d.placements = d.placements.filter((p) => p.group_key !== g.key)
      if (op.placements === 'delete') return
      // Ungroup: appended to the Ungrouped zone (slot cards to the canvas);
      // a field already in Ungrouped keeps that placement.
      const zone = zoneMembers(d, null)
      const canvas = groupMembers(d, null)
      const moved = inGroup.filter(
        (p) => !d.placements.some((x) => x.field === p.field && x.group_key === null)
      )
      for (const p of moved) {
        p.group_key = null
        d.placements.push(p)
      }
      setOrder([...zone, ...moved.filter((p) => !isCanvasSlot(p))])
      setOrder([...canvas, ...moved.filter((p) => isCanvasSlot(p))])
      return
    }
    case 'layout_update': {
      Object.assign(d.layout, checkPatch(op.patch, LAYOUT_PATCH_KEYS))
      return
    }
    default:
      fail(`Unknown op "${String((op as { op?: unknown }).op)}"`)
  }
}
