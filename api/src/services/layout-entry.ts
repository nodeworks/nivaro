/**
 * Entry config (migration 491, nivaro_collection_layouts.entry_config): the JSON text column
 * carrying placement presets, keyboard-first flags, tab order, beginner / expert mode,
 * glossary tooltips and the form identity badge (#2702 #2707 #2708 #2710 #2711 #2728).
 *
 * TWIN of packages/shared/src/lib/entry-config.ts (the API cannot import packages/shared);
 * an API test runs the same cases through both.
 */
import { hasColumn } from '../lib/column-probe.js'

export const ENTRY_THRESHOLD_DEFAULT = 3
export const ENTRY_THRESHOLD_MAX = 50
export const ENTRY_BADGE_TAG_MAX = 16
export const ENTRY_PRESETS_MAX = 20
export const ENTRY_TAB_ORDER_MAX = 200

/** Badge colours (a closed list, so every one has a light and a dark pair in the UI). */
export const BADGE_COLORS = [
  'slate',
  'blue',
  'cyan',
  'emerald',
  'amber',
  'orange',
  'rose',
  'violet'
] as const
export type BadgeColor = (typeof BADGE_COLORS)[number]

/** The parts of a field's placement a preset can carry. */
export const PRESET_PARTS = ['width', 'required', 'help', 'placeholder', 'input', 'lock'] as const
export type PresetPart = (typeof PRESET_PARTS)[number]

export interface EntryPreset {
  id: string
  name: string
  /** Which parts the preset sets; a part not listed is left alone on apply. */
  parts: PresetPart[]
  col_span?: number | null
  /** Placement `overrides` keys (required, note, placeholder, interface, options). */
  overrides?: Record<string, unknown>
  lock_conditions?: string | null
}

export interface EntryBadge {
  tag: string
  color: BadgeColor
}

export type EntryConfig = {
  /** Focus the first empty required field when the form opens. */
  focus_first?: boolean
  /** Enter moves to the next field instead of submitting. */
  enter_next?: boolean
  /** Field keys in the order Tab visits them; fields not listed follow in page order. */
  tab_order?: string[]
  /** Guided steps for a person's first records, tabs after that. */
  adaptive?: boolean
  /** How many of their own records a person makes before the form shows tabs. */
  adaptive_threshold?: number
  badge?: EntryBadge | null
  /** Glossary terms in help text get a dotted underline (default on). */
  glossary?: boolean
  presets?: EntryPreset[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

function sanitizePreset(raw: unknown): EntryPreset | null {
  if (!isObj(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const id = typeof raw.id === 'string' ? raw.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : ''
  if (!name || !id) return null
  const parts = (Array.isArray(raw.parts) ? raw.parts : []).filter((p): p is PresetPart =>
    (PRESET_PARTS as readonly unknown[]).includes(p)
  )
  const out: EntryPreset = { id, name, parts: [...new Set(parts)] }
  if (raw.col_span === null || typeof raw.col_span === 'number') {
    out.col_span =
      raw.col_span === null ? null : Math.min(12, Math.max(1, Math.round(raw.col_span)))
  }
  if (isObj(raw.overrides)) out.overrides = raw.overrides
  if (raw.lock_conditions === null || typeof raw.lock_conditions === 'string')
    out.lock_conditions = raw.lock_conditions
  return out
}

/** A stored or patched value → the clean config, or null when nothing is set. */
export function sanitizeEntryConfig(raw: unknown): EntryConfig | null {
  let v = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!isObj(v)) return null
  const out: EntryConfig = {}
  if (v.focus_first === true) out.focus_first = true
  if (v.enter_next === true) out.enter_next = true
  if (v.adaptive === true) out.adaptive = true
  if (v.glossary === false) out.glossary = false
  if (typeof v.adaptive_threshold === 'number' && Number.isFinite(v.adaptive_threshold)) {
    const n = Math.min(ENTRY_THRESHOLD_MAX, Math.max(1, Math.round(v.adaptive_threshold)))
    if (n !== ENTRY_THRESHOLD_DEFAULT) out.adaptive_threshold = n
  }
  if (Array.isArray(v.tab_order)) {
    const keys = [
      ...new Set(v.tab_order.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)))
    ].slice(0, ENTRY_TAB_ORDER_MAX)
    if (keys.length) out.tab_order = keys
  }
  if (isObj(v.badge)) {
    const tag =
      typeof v.badge.tag === 'string'
        ? v.badge.tag.replace(/\s+/g, ' ').trim().slice(0, ENTRY_BADGE_TAG_MAX)
        : ''
    const color = (BADGE_COLORS as readonly unknown[]).includes(v.badge.color)
      ? (v.badge.color as BadgeColor)
      : 'slate'
    if (tag) out.badge = { tag, color }
  }
  if (Array.isArray(v.presets)) {
    const seen = new Set<string>()
    const presets: EntryPreset[] = []
    for (const p of v.presets) {
      const clean = sanitizePreset(p)
      if (clean && !seen.has(clean.id)) {
        seen.add(clean.id)
        presets.push(clean)
      }
      if (presets.length >= ENTRY_PRESETS_MAX) break
    }
    if (presets.length) out.presets = presets
  }
  return Object.keys(out).length ? out : null
}

/** A patch value → the column text (null clears it), or an error for a value that is no object. */
export function normalizeEntryConfig(v: unknown): { value: string | null } | { error: string } {
  if (v == null || v === '') return { value: null }
  if (typeof v !== 'object' || Array.isArray(v))
    return { error: 'entry_config must be an object or null' }
  const clean = sanitizeEntryConfig(v)
  return { value: clean ? JSON.stringify(clean) : null }
}

/** A layout row's entry_config as the parsed object (null = none). */
export function parseEntryConfig(raw: unknown): EntryConfig | null {
  return sanitizeEntryConfig(raw)
}

// The column arrives with migration 491; until it ran, the setting cannot be stored.
let columnReady: boolean | null = null
let checkedAt = 0
export async function entryConfigColumnReady(): Promise<boolean> {
  if (columnReady || (columnReady === false && Date.now() - checkedAt < 60_000)) return columnReady
  checkedAt = Date.now()
  try {
    columnReady = await hasColumn('nivaro_collection_layouts', 'entry_config')
  } catch {
    columnReady = false
  }
  return columnReady
}
