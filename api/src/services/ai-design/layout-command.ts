import type { LayoutBundle, PlacementRow } from '../layout-ops-apply.js'
import { asArray, cleanText, parseJsonLoose, titleCase } from './model.js'

/**
 * The layout editor's command palette, AI half (#2586).
 *
 * The palette parses common commands itself ("move X to Y", "make X
 * required"); only text it cannot read comes here. The model gets a summary
 * of the layout (groups, placed fields, other fields, roles) and answers with
 * INTENTS in the palette's own vocabulary — never raw layout ops. Every
 * intent is checked here against the layout (names that do not exist are
 * dropped), and the editor then turns the intents into ops with the same
 * translator the typed commands use and checks them with the ops twin before
 * showing the preview. Nothing is written here.
 *
 * MIRROR: CommandIntent matches packages/shared/src/components/layout-editor/
 * commands/intents.ts (the API cannot import packages/shared).
 */

export type CommandIntent =
  | { kind: 'move_field'; field: string; to_group: string | null; before?: string; after?: string }
  | { kind: 'move_group'; group: string; before?: string; after?: string }
  | {
      kind: 'set_field'
      field: string
      required?: boolean
      readonly?: boolean
      hidden?: boolean
      label?: string | null
      width?: 12 | 6 | 4 | 3
      help?: string | null
      role?: string
    }
  | { kind: 'add_field'; field: string; to_group: string | null }
  | { kind: 'remove_field'; field: string }
  | { kind: 'add_group'; label: string; group_type: 'section' | 'tab'; after?: string }
  | { kind: 'update_group'; group: string; label?: string; collapsed?: boolean }

export const MAX_INTENTS = 20
const MAX_OTHER_FIELDS = 200
const MAX_PLACED = 250

export interface CommandContext {
  bundle: LayoutBundle
  /** Every field of the collection: field → its own label. */
  fields: Map<string, string>
  roles: Array<{ id: string; name: string }>
}

function overridesOf(p: PlacementRow): Record<string, unknown> {
  let v: unknown = p.overrides
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return {}
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const isRealField = (p: PlacementRow) =>
  !p.field.startsWith('__') && p.widget_id == null && p.group_key !== '__header__'

/** Groups that hold fields or tabs (not the Ungrouped pseudo group). */
function realGroups(bundle: LayoutBundle) {
  return bundle.groups.filter((g) => !g.key.startsWith('__'))
}

export function placementLabel(p: PlacementRow, fields: Map<string, string>): string {
  const ov = overridesOf(p)
  const own = typeof ov.label === 'string' && ov.label.trim() ? ov.label.trim() : null
  return own || p.label_override || fields.get(p.field) || titleCase(p.field)
}

export const COMMAND_SYSTEM = `You turn an admin's instruction about a data-entry form layout into structured edits.
You get the layout as JSON and the instruction. Answer with ONE JSON object and nothing else:
{"intents":[ ... ],"explanation":"<one short sentence>"} or {"error":"<why this cannot be done>"}.
Each intent is one of:
{"kind":"move_field","field":"<field key>","to_group":"<group key or null for ungrouped>","before":"<field key, optional>","after":"<field key, optional>"}
{"kind":"move_group","group":"<group key>","before":"<group key, optional>","after":"<group key, optional>"}
{"kind":"set_field","field":"<field key>","required":true|false,"readonly":true|false,"hidden":true|false,"label":"<text or null>","width":12|6|4|3,"help":"<text or null>","role":"<role name, only when the instruction names one>"} (include only the settings that change)
{"kind":"add_field","field":"<field key not on the layout yet>","to_group":"<group key or null>"}
{"kind":"remove_field","field":"<field key>"}
{"kind":"add_group","label":"<name>","group_type":"section"|"tab","after":"<group key, optional>"}
{"kind":"update_group","group":"<group key>","label":"<new name, optional>","collapsed":true|false}
Rules: use only field keys, group keys and role names from the input. Width 12 = full row, 6 = half, 4 = third, 3 = quarter. Tabs are the form's steps. At most ${MAX_INTENTS} intents. When the instruction is unclear or asks for something these intents cannot do, answer with "error".`

export function buildCommandPrompt(ctx: CommandContext, text: string): string {
  const { bundle, fields } = ctx
  const placed = bundle.placements.filter(isRealField)
  const placedSet = new Set(placed.map((p) => p.field))
  return JSON.stringify({
    instruction: text,
    collection: bundle.layout.collection,
    layout: bundle.layout.name,
    groups: realGroups(bundle).map((g) => ({
      key: g.key,
      label: g.label,
      type: g.type,
      parent: g.parent_key,
      collapsed: g.is_collapsed || undefined
    })),
    fields_on_layout: placed.slice(0, MAX_PLACED).map((p) => {
      const ov = overridesOf(p)
      return {
        field: p.field,
        label: placementLabel(p, fields),
        group: p.group_key,
        required: ov.required === true || undefined,
        hidden: ov.hidden === true || p.is_visible === false || undefined,
        width: p.col_span ?? undefined
      }
    }),
    other_fields: [...fields]
      .filter(([f]) => !placedSet.has(f) && !f.startsWith('__'))
      .slice(0, MAX_OTHER_FIELDS)
      .map(([field, label]) => ({ field, label })),
    roles: ctx.roles.map((r) => r.name)
  })
}

const WIDTHS = new Set([12, 6, 4, 3])

/**
 * The model's answer checked against the layout. Unknown kinds, names that
 * are not on the layout and empty settings are dropped (counted in `dropped`).
 */
export function parseCommandAnswer(
  text: string,
  ctx: CommandContext
): { intents: CommandIntent[]; explanation: string | null; dropped: number; error: string | null } {
  const parsed = parseJsonLoose(text)
  if (!parsed)
    return { intents: [], explanation: null, dropped: 0, error: 'The AI answer was not readable' }
  const refusal = cleanText(parsed.error, 300)
  if (refusal && !Array.isArray(parsed.intents))
    return { intents: [], explanation: null, dropped: 0, error: refusal }

  const placed = new Set(ctx.bundle.placements.filter(isRealField).map((p) => p.field))
  const groups = new Set(realGroups(ctx.bundle).map((g) => g.key))
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const optField = (v: unknown) => {
    const s = str(v)
    return s && placed.has(s) ? s : undefined
  }
  const optGroup = (v: unknown) => {
    const s = str(v)
    return s && groups.has(s) ? s : undefined
  }
  const target = (v: unknown): string | null | false =>
    v == null || v === '' ? null : typeof v === 'string' && groups.has(v) ? v : false
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)
  const role = (v: unknown) => {
    const s = str(v)?.toLowerCase()
    return s ? ctx.roles.find((r) => r.name.toLowerCase() === s || r.id === s)?.id : undefined
  }

  const intents: CommandIntent[] = []
  let dropped = 0
  for (const raw of asArray(parsed.intents).slice(0, MAX_INTENTS)) {
    const o = (raw ?? {}) as Record<string, unknown>
    const next = ((): CommandIntent | null => {
      switch (o.kind) {
        case 'move_field': {
          const field = optField(o.field)
          const to = target(o.to_group)
          if (!field || to === false) return null
          return {
            kind: 'move_field',
            field,
            to_group: to,
            ...(optField(o.before) ? { before: optField(o.before) } : {}),
            ...(optField(o.after) ? { after: optField(o.after) } : {})
          }
        }
        case 'move_group': {
          const group = optGroup(o.group)
          const before = optGroup(o.before)
          const after = optGroup(o.after)
          if (!group || (!before && !after)) return null
          return { kind: 'move_group', group, ...(before ? { before } : { after }) }
        }
        case 'set_field': {
          const field = optField(o.field)
          if (!field) return null
          const out: Extract<CommandIntent, { kind: 'set_field' }> = { kind: 'set_field', field }
          for (const k of ['required', 'readonly', 'hidden'] as const) {
            const b = bool(o[k])
            if (b !== undefined) out[k] = b
          }
          if (o.label === null) out.label = null
          else if (cleanText(o.label, 80)) out.label = cleanText(o.label, 80)
          if (o.help === null) out.help = null
          else if (cleanText(o.help, 300)) out.help = cleanText(o.help, 300)
          const w = Number(o.width)
          if (WIDTHS.has(w)) out.width = w as 12 | 6 | 4 | 3
          const r = role(o.role)
          if (r && out.required !== undefined) out.role = r
          return Object.keys(out).length > 2 ? out : null
        }
        case 'add_field': {
          const field = str(o.field)
          const to = target(o.to_group)
          if (!field || !ctx.fields.has(field) || placed.has(field) || to === false) return null
          return { kind: 'add_field', field, to_group: to }
        }
        case 'remove_field': {
          const field = optField(o.field)
          return field ? { kind: 'remove_field', field } : null
        }
        case 'add_group': {
          const label = cleanText(o.label, 60)
          if (!label || (o.group_type !== 'section' && o.group_type !== 'tab')) return null
          const after = optGroup(o.after)
          return { kind: 'add_group', label, group_type: o.group_type, ...(after ? { after } : {}) }
        }
        case 'update_group': {
          const group = optGroup(o.group)
          if (!group) return null
          const label = cleanText(o.label, 60)
          const collapsed = bool(o.collapsed)
          if (!label && collapsed === undefined) return null
          return {
            kind: 'update_group',
            group,
            ...(label ? { label } : {}),
            ...(collapsed !== undefined ? { collapsed } : {})
          }
        }
        default:
          return null
      }
    })()
    if (next) intents.push(next)
    else dropped++
  }
  return {
    intents,
    explanation: cleanText(parsed.explanation, 300),
    dropped,
    error: intents.length === 0 ? (refusal ?? 'The AI found nothing it could do here') : null
  }
}
