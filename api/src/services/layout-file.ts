import { CORE_SCHEMA, dump, load } from 'js-yaml'
import {
  applyLayoutOps,
  GROUP_PATCH_KEYS,
  GROUP_TYPES,
  type GroupRow,
  isCanvasSlot,
  LAYOUT_PATCH_KEYS,
  type LayoutBundle,
  newGroup,
  newPlacement,
  PLACEMENT_PATCH_KEYS,
  type PlacementRow,
  UNGROUPED_KEY
} from './layout-ops-apply.js'

/**
 * Layout as a file (#3189): one layout — its settings, sections, steps, tabs,
 * slots and every field placement with its settings — as a YAML document a
 * team can keep and review in git, and the same document read back.
 *
 * Export walks the record page top to bottom (`form`), so a diff in review
 * reads like the form changed. Only settings that differ from a new
 * section's / placement's own defaults are written; JSON-text settings
 * (show-when rules, role lists, summaries) are written as YAML structures.
 *
 * Import never writes: `fileToTarget` turns a document into the layout it
 * describes (groups and placements in order, a layout settings patch) for
 * the editor, which plans the ops from its draft to that target, previews
 * them and applies them as one undo step — saved, like any edit, through
 * POST /collection-layouts/:id/ops with its base_rev.
 *
 * YAML: js-yaml (already an API dependency), CORE_SCHEMA both ways — no
 * custom tags, no dates; aliases are copied with a node budget, so an alias
 * bomb cannot expand. Not imported: is_active and sort (how forms are
 * chosen on this instance), and a name or slug another form here already has.
 */

export const LAYOUT_FILE_VERSION = 1
/** Largest file accepted (characters). */
export const LAYOUT_FILE_MAX = 1_000_000
const NODE_BUDGET = 200_000
const MAX_DEPTH = 40

/** Layout settings a file never carries: how forms are picked on this instance. */
const LAYOUT_SKIP = new Set(['is_active', 'sort'])
/** Group settings stored as JSON text: written to the file as structures. */
const GROUP_JSON_KEYS = new Set([
  'summary_fields',
  'swap_config',
  'skip_if_filled',
  'visible_when',
  'hidden_for_roles',
  'locked_for_roles',
  'editor_note',
  'i18n'
])
const GROUP_SETTING_KEYS = (GROUP_PATCH_KEYS as readonly string[]).filter(
  (k) => k !== 'label' && k !== 'type'
)
const PLACEMENT_KEYS = PLACEMENT_PATCH_KEYS as readonly string[]
const GROUP_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,99}$/
const SENTINEL_RE = /^__.*__$/

type Obj = Record<string, unknown>

export interface LayoutFileRefs {
  /** Layouts of this collection: id → name (parent, addendum). */
  layouts: Map<number, string>
  /** Widgets: id → name. */
  widgets: Map<number, string>
}

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

function parseJsonText(v: unknown): unknown {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!t) return v
  // Only an object or a list: a text setting that reads "true" or "12" stays text.
  if (!/^[[{]/.test(t)) return v
  try {
    return JSON.parse(t)
  } catch {
    return v
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// ── Export ───────────────────────────────────────────────────────────────────

function placementEntry(p: PlacementRow, key: 'field' | 'slot' = 'field'): Obj {
  const base = newPlacement(p.field, p.group_key) as unknown as Obj
  const out: Obj = { [key]: p.field }
  for (const k of PLACEMENT_KEYS) {
    const v = (p as unknown as Obj)[k]
    if (!same(v, base[k])) out[k] = v
  }
  return out
}

function groupSettings(g: GroupRow): Obj {
  const base = newGroup(g.key, g.label, g.type, g.parent_key) as unknown as Obj
  const out: Obj = {}
  for (const k of GROUP_SETTING_KEYS) {
    const v = (g as unknown as Obj)[k]
    if (v === undefined || same(v, base[k])) continue
    out[k] = GROUP_JSON_KEYS.has(k) ? parseJsonText(v) : v
  }
  return out
}

/** The layout as a file document (plain data; `layoutToYaml` writes it). */
export function layoutToFile(raw: LayoutBundle, refs: LayoutFileRefs, now: Date = new Date()): Obj {
  // Renumbered: equal stored sorts take the record page's tie order.
  const bundle = applyLayoutOps(raw, [])
  const layout = bundle.layout
  const settings: Obj = {}
  for (const k of LAYOUT_PATCH_KEYS as readonly string[]) {
    if (LAYOUT_SKIP.has(k) || !(k in layout)) continue
    settings[k] = parseJsonText(layout[k])
  }
  const byGroup = new Map<string | null, PlacementRow[]>()
  for (const p of bundle.placements) {
    if (isCanvasSlot(p)) continue
    byGroup.set(p.group_key, [...(byGroup.get(p.group_key) ?? []), p])
  }
  const fieldsOf = (key: string | null) =>
    (byGroup.get(key) ?? []).sort((a, b) => a.sort - b.sort).map((p) => placementEntry(p))
  const keys = new Set(bundle.groups.map((g) => g.key))
  const groupEntry = (g: GroupRow): Obj => {
    const out: Obj = { key: g.key, type: g.type, label: g.label, ...groupSettings(g) }
    const children = bundle.groups
      .filter((c) => c.parent_key === g.key)
      .sort((a, b) => a.sort - b.sort)
    if (g.type === 'container') out.tabs = children.map(groupEntry)
    else if (g.type !== 'content') out.fields = fieldsOf(g.key)
    return out
  }
  const top: Array<{ sort: number; entry: Obj }> = []
  for (const g of bundle.groups) {
    if (g.parent_key !== null && keys.has(g.parent_key)) continue
    top.push({
      sort: g.sort,
      entry: g.key === UNGROUPED_KEY ? { ungrouped: true, fields: fieldsOf(null) } : groupEntry(g)
    })
  }
  for (const p of bundle.placements)
    if (isCanvasSlot(p)) top.push({ sort: p.sort, entry: placementEntry(p, 'slot') })
  top.sort((a, b) => a.sort - b.sort)

  // Placements in zones without a group row: the header, a table's extra forms, leftovers.
  const zones: Obj = {}
  for (const [key, list] of byGroup) {
    if (key === null || keys.has(key)) continue
    if (list.length) zones[key] = fieldsOf(key)
  }

  const references: Obj = {}
  const layoutRef = (id: unknown) => {
    const n = Number(id)
    return Number.isInteger(n) && n > 0 ? { id: n, name: refs.layouts.get(n) ?? null } : null
  }
  if (layout.parent_layout_id != null) references.parent_layout = layoutRef(layout.parent_layout_id)
  if (layout.addendum_layout_id != null)
    references.addendum_layout = layoutRef(layout.addendum_layout_id)
  const widgetIds = [
    ...new Set(bundle.placements.map((p) => p.widget_id).filter((w): w is number => w != null))
  ]
  if (widgetIds.length)
    references.widgets = widgetIds.map((id) => ({ id, name: refs.widgets.get(id) ?? null }))

  return {
    nivaro_layout_file: LAYOUT_FILE_VERSION,
    collection: layout.collection,
    exported_from: {
      layout_id: Number(layout.id),
      name: layout.name ?? null,
      rev: bundle.rev,
      at: now.toISOString()
    },
    layout: settings,
    form: top.map((t) => t.entry),
    ...(Object.keys(zones).length ? { zones } : {}),
    ...(Object.keys(references).length ? { references } : {})
  }
}

const HEADER = [
  '# Nivaro layout file. Keep it in git and review changes like code.',
  '# Import it in the layout editor (Outputs → Import a layout file): you see what',
  '# would change before anything does, and Save applies it like any edit.'
].join('\n')

export function layoutToYaml(doc: Obj): string {
  return `${HEADER}\n${dump(doc, { schema: CORE_SCHEMA, lineWidth: 100, noRefs: true, sortKeys: false })}`
}

/** A file name for the download: <collection>-<slug or name>.layout.yaml. */
export function layoutFileName(layout: Obj): string {
  const part = (v: unknown) =>
    String(v ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
  const name = part(layout.slug) || part(layout.name) || `layout-${String(layout.id)}`
  return `${part(layout.collection) || 'layout'}-${name}.layout.yaml`
}

// ── Import ───────────────────────────────────────────────────────────────────

export class LayoutFileError extends Error {
  statusCode = 400
  problems: string[]
  constructor(problems: string[]) {
    super(problems.length === 1 ? problems[0] : `${problems.length} problems in the file`)
    this.problems = problems
  }
}

/** Plain data out of whatever js-yaml built: aliases copied within a node budget. */
function plain(v: unknown, budget: { n: number }, depth = 0): unknown {
  if (--budget.n < 0)
    throw new LayoutFileError(['The file is too large or repeats itself too often'])
  if (depth > MAX_DEPTH) throw new LayoutFileError(['The file nests too deeply'])
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.map((x) => plain(x, budget, depth + 1))
  if (isObj(v)) {
    const out: Obj = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      out[k] = plain(x, budget, depth + 1)
    }
    return out
  }
  return null
}

/** Read a layout file (YAML, or JSON, which is YAML too). Throws LayoutFileError. */
export function parseLayoutYaml(text: string): Obj {
  if (typeof text !== 'string' || !text.trim()) throw new LayoutFileError(['The file is empty'])
  if (text.length > LAYOUT_FILE_MAX)
    throw new LayoutFileError([`The file is larger than ${LAYOUT_FILE_MAX / 1_000_000} MB`])
  let raw: unknown
  try {
    // A key written twice is refused (not last-one-wins): review would miss it.
    raw = load(text, { schema: CORE_SCHEMA })
  } catch (err) {
    const msg = (err as { reason?: string; mark?: { line?: number } }) ?? {}
    const line = typeof msg.mark?.line === 'number' ? ` (line ${msg.mark.line + 1})` : ''
    throw new LayoutFileError([`This is not readable YAML${line}: ${msg.reason ?? 'parse error'}`])
  }
  const doc = plain(raw, { n: NODE_BUDGET })
  if (!isObj(doc) || doc.nivaro_layout_file == null)
    throw new LayoutFileError(['This is not a Nivaro layout file (no nivaro_layout_file line)'])
  if (Number(doc.nivaro_layout_file) > LAYOUT_FILE_VERSION)
    throw new LayoutFileError([
      `This file was written by a newer Nivaro (version ${String(doc.nivaro_layout_file)})`
    ])
  return doc
}

/** The layout a file describes, ready for the editor to plan its ops against. */
export interface LayoutFileTarget {
  layout: Obj
  groups: GroupRow[]
  placements: PlacementRow[]
}

export interface LayoutFileImport {
  target: LayoutFileTarget
  warnings: string[]
  source: { layout_id: number | null; name: string | null; at: string | null }
}

export interface ImportContext {
  /** The layout being imported into. */
  current: LayoutBundle
  /** Other layouts of the collection (name, slug), for clashes and references. */
  layouts: Array<{ id: number; name: string | null; slug: string | null }>
  /** Fields of the collection. */
  fields: Set<string>
  widgets: Map<number, string>
}

/**
 * A parsed file → the target layout and what the import could not keep.
 * Problems that make the file unusable (another collection, another kind of
 * layout, broken structure) throw LayoutFileError naming each one.
 */
export function fileToTarget(doc: Obj, ctx: ImportContext): LayoutFileImport {
  const problems: string[] = []
  const warnings: string[] = []
  const cur = ctx.current.layout
  if (doc.collection !== cur.collection)
    problems.push(
      `This file is a layout of ${String(doc.collection ?? 'no collection')}; this one belongs to ${String(cur.collection)}`
    )
  const fileLayout = isObj(doc.layout) ? doc.layout : {}
  const typeOf = (v: unknown) => String(v ?? 'grouped') || 'grouped'
  if ('layout_type' in fileLayout && typeOf(fileLayout.layout_type) !== typeOf(cur.layout_type))
    problems.push(
      `This file is a ${typeOf(fileLayout.layout_type)} layout; this one is ${typeOf(cur.layout_type)}`
    )
  if (!Array.isArray(doc.form)) problems.push('The file has no form list')
  if (problems.length) throw new LayoutFileError(problems)

  // Layout settings: only keys the file states; unknown keys refused.
  const layout: Obj = {}
  for (const [k, v] of Object.entries(fileLayout)) {
    if (LAYOUT_SKIP.has(k)) continue
    if (!(LAYOUT_PATCH_KEYS as readonly string[]).includes(k)) {
      problems.push(`layout.${k} is not a layout setting`)
      continue
    }
    layout[k] = v
  }
  const others = ctx.layouts.filter((l) => l.id !== Number(cur.id))
  const lower = (v: unknown) => String(v ?? '').toLowerCase()
  if (
    typeof layout.name === 'string' &&
    layout.name !== cur.name &&
    others.some((l) => lower(l.name) === lower(layout.name))
  ) {
    warnings.push(`Kept this form’s name: another form here is already called “${layout.name}”`)
    delete layout.name
  }
  if (
    typeof layout.slug === 'string' &&
    layout.slug !== cur.slug &&
    others.some((l) => lower(l.slug) === lower(layout.slug))
  ) {
    warnings.push(`Kept this form’s slug: another form here already uses “${layout.slug}”`)
    delete layout.slug
  }
  // References to other layouts: kept when the id still names that form, else matched by name.
  const refs = isObj(doc.references) ? doc.references : {}
  for (const [k, refKey, what] of [
    ['parent_layout_id', 'parent_layout', 'parent form'],
    ['addendum_layout_id', 'addendum_layout', 'addendum form']
  ] as const) {
    if (!(k in layout) || layout[k] == null) continue
    const id = Number(layout[k])
    const ref = isObj(refs[refKey]) ? refs[refKey] : {}
    const name = typeof ref.name === 'string' ? ref.name : null
    const byId = ctx.layouts.find((l) => l.id === id)
    if (byId && (name == null || lower(byId.name) === lower(name)) && id !== Number(cur.id))
      continue
    const byName = name ? ctx.layouts.find((l) => lower(l.name) === lower(name)) : undefined
    if (byName && byName.id !== Number(cur.id)) {
      layout[k] = byName.id
      warnings.push(`The ${what} “${name}” is a different id here (${byName.id}); used that one`)
    } else {
      delete layout[k]
      warnings.push(
        `The ${what}${name ? ` “${name}”` : ''} is not on this instance; kept this form’s own`
      )
    }
  }

  // Groups and placements, in file order.
  const groups: GroupRow[] = []
  const placements: PlacementRow[] = []
  const groupKeys = new Set<string>()
  const placed = new Set<string>()
  const widgetRefs = new Map<number, string | null>()
  for (const w of Array.isArray(refs.widgets) ? refs.widgets : [])
    if (isObj(w) && Number.isInteger(Number(w.id)))
      widgetRefs.set(Number(w.id), typeof w.name === 'string' ? w.name : null)
  const unknownFields = new Set<string>()

  const readPlacement = (raw: unknown, groupKey: string | null, sort: number, where: string) => {
    if (!isObj(raw)) {
      problems.push(`${where}: each field must be a map with a field name`)
      return
    }
    const field = raw.field ?? raw.slot
    if (typeof field !== 'string' || !field.trim() || field.length > 200) {
      problems.push(`${where}: a field entry needs a field name`)
      return
    }
    const k = `${field}\u0000${groupKey ?? ''}`
    if (placed.has(k)) {
      problems.push(`${where}: ${field} is listed twice here`)
      return
    }
    placed.add(k)
    const row = { ...newPlacement(field, groupKey), sort } as PlacementRow & Obj
    for (const [key, v] of Object.entries(raw)) {
      if (key === 'field' || key === 'slot') continue
      if (!PLACEMENT_KEYS.includes(key)) {
        problems.push(`${where}: ${key} is not a field setting (on ${field})`)
        continue
      }
      row[key] = v
    }
    if (row.widget_id != null) {
      const id = Number(row.widget_id)
      const name = widgetRefs.get(id) ?? null
      const here = ctx.widgets.get(id)
      if (here == null || (name != null && lower(here) !== lower(name))) {
        const match = name
          ? [...ctx.widgets.entries()].find(([, n]) => lower(n) === lower(name))
          : undefined
        if (match) row.widget_id = match[0]
        else {
          row.widget_id = null
          warnings.push(`The widget${name ? ` “${name}”` : ` #${id}`} is not on this instance`)
        }
      }
    }
    if (!SENTINEL_RE.test(field) && !field.includes('.') && !ctx.fields.has(field))
      unknownFields.add(field)
    placements.push(row)
  }

  const readGroup = (raw: Obj, parent: string | null, sort: number, where: string) => {
    const key = raw.key
    if (typeof key !== 'string' || !GROUP_KEY_RE.test(key) || key.startsWith('__')) {
      problems.push(`${where}: a section needs a key (letters, digits, _ . : -)`)
      return
    }
    if (groupKeys.has(key)) {
      problems.push(`${where}: the key ${key} is used twice`)
      return
    }
    groupKeys.add(key)
    const type = String(raw.type ?? 'section')
    if (!(GROUP_TYPES as readonly string[]).includes(type)) {
      problems.push(`${where} (${key}): type must be one of ${GROUP_TYPES.join(', ')}`)
      return
    }
    if (parent !== null && type !== 'tab') problems.push(`${where} (${key}): only tabs go in tabs`)
    const row = {
      ...newGroup(key, typeof raw.label === 'string' ? raw.label : key, type, parent),
      sort
    } as GroupRow & Obj
    for (const [k, v] of Object.entries(raw)) {
      if (['key', 'type', 'label', 'fields', 'tabs'].includes(k)) continue
      if (!GROUP_SETTING_KEYS.includes(k)) {
        problems.push(`${where} (${key}): ${k} is not a section setting`)
        continue
      }
      row[k] = GROUP_JSON_KEYS.has(k) && v != null && typeof v !== 'string' ? JSON.stringify(v) : v
    }
    groups.push(row)
    if (type === 'container') {
      if (raw.fields != null)
        problems.push(`${where} (${key}): a tabs holder holds tabs, not fields`)
      const tabs = Array.isArray(raw.tabs) ? raw.tabs : []
      tabs.forEach((t, i) => {
        if (isObj(t)) readGroup(t, key, i, `${where} → tab ${i + 1}`)
        else problems.push(`${where} (${key}) → tab ${i + 1}: must be a map`)
      })
    } else {
      if (raw.tabs != null) problems.push(`${where} (${key}): only a tabs holder has tabs`)
      if (type === 'content' && Array.isArray(raw.fields) && raw.fields.length)
        problems.push(`${where} (${key}): a text block holds text, not fields`)
      const list = Array.isArray(raw.fields) ? raw.fields : []
      list.forEach((p, i) => {
        readPlacement(p, key, i, `${where} (${key})`)
      })
    }
  }

  let ungroupedAt: number | null = null
  ;(doc.form as unknown[]).forEach((entry, i) => {
    const where = `form item ${i + 1}`
    if (!isObj(entry)) {
      problems.push(`${where}: must be a map`)
      return
    }
    if (entry.ungrouped === true) {
      if (ungroupedAt != null) problems.push(`${where}: the Ungrouped zone is listed twice`)
      ungroupedAt = i
      const list = Array.isArray(entry.fields) ? entry.fields : []
      list.forEach((p, j) => {
        readPlacement(p, null, j, `${where} (Ungrouped)`)
      })
      return
    }
    if (typeof entry.slot === 'string') {
      if (!isCanvasSlot({ field: entry.slot, group_key: null })) {
        problems.push(`${where}: ${entry.slot} is not a card the form can show`)
        return
      }
      readPlacement(entry, null, i, where)
      return
    }
    readGroup(entry, null, i, where)
  })
  // The Ungrouped zone's place (where the record page puts it when the file names none).
  groups.push({
    ...newGroup(UNGROUPED_KEY, 'Ungrouped', 'ungrouped', null),
    sort: ungroupedAt ?? (doc.form as unknown[]).length
  })
  const zones = isObj(doc.zones) ? doc.zones : {}
  for (const [key, list] of Object.entries(zones)) {
    if (groupKeys.has(key) || !Array.isArray(list)) {
      problems.push(`zones.${key}: must be a list of fields in a zone no section uses`)
      continue
    }
    list.forEach((p, j) => {
      readPlacement(p, key, j, `zones.${key}`)
    })
  }
  if (problems.length) throw new LayoutFileError(problems)
  if (unknownFields.size)
    warnings.push(
      `Not fields of ${String(cur.collection)}: ${[...unknownFields].slice(0, 10).join(', ')}${
        unknownFields.size > 10 ? '…' : ''
      } — they stay on the form but show nothing`
    )
  const from = isObj(doc.exported_from) ? doc.exported_from : {}
  return {
    target: { layout, groups, placements },
    warnings,
    source: {
      layout_id: Number.isInteger(Number(from.layout_id)) ? Number(from.layout_id) : null,
      name: typeof from.name === 'string' ? from.name : null,
      at: typeof from.at === 'string' ? from.at : null
    }
  }
}
