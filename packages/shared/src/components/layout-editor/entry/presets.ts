/**
 * Placement presets (#2702): a named bundle of one field's placement settings
 * (width, required, help text, placeholder, input + format, lock rule) that
 * applies to other fields as one undoable op batch. Pure; the popover is
 * PlacementPresets.tsx and the bundles live in the layout's entry_config.
 */
import {
  ENTRY_PRESETS_MAX,
  type EntryConfig,
  type EntryPreset,
  PRESET_PARTS,
  type PresetPart,
  sanitizeEntryConfig
} from '../../../lib/entry-config'
import type { LayoutOp, PlacementPatch, PlacementRow } from '../../../lib/layout-ops'
import { readOverrides, withKey } from '../inspector/model'

export const PART_LABEL: Record<PresetPart, string> = {
  width: 'Width',
  required: 'Required',
  help: 'Help text',
  placeholder: 'Placeholder',
  input: 'Input and format',
  lock: 'Lock rule'
}

/** The `overrides` keys each part owns. */
const PART_KEYS: Record<PresetPart, string[]> = {
  width: [],
  required: ['required'],
  help: ['note'],
  placeholder: ['placeholder'],
  input: ['interface', 'options'],
  lock: []
}

/** Parts the field has something set for: what "Save as preset" offers ticked. */
export function partsSet(row: PlacementRow): PresetPart[] {
  const ov = readOverrides(row)
  return PRESET_PARTS.filter((p) => {
    if (p === 'width') return row.col_span != null
    if (p === 'lock') return !!row.lock_conditions
    return PART_KEYS[p].some((k) => ov[k] !== undefined)
  })
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** The preset a field's current settings make, limited to `parts`. */
export function capturePreset(name: string, row: PlacementRow, parts: PresetPart[]): EntryPreset {
  const ov = readOverrides(row)
  const overrides: Record<string, unknown> = {}
  for (const p of parts) for (const k of PART_KEYS[p]) if (ov[k] !== undefined) overrides[k] = ov[k]
  const out: EntryPreset = { id: newId(), name: name.trim(), parts: [...parts] }
  if (parts.includes('width')) out.col_span = row.col_span ?? null
  if (Object.keys(overrides).length) out.overrides = overrides
  if (parts.includes('lock')) out.lock_conditions = row.lock_conditions ?? null
  return out
}

/** What applying the preset changes on one placement; null when nothing would. */
export function presetPatch(preset: EntryPreset, row: PlacementRow): PlacementPatch | null {
  const patch: PlacementPatch = {}
  let ov: Record<string, unknown> | null = readOverrides(row)
  let overridesChanged = false
  for (const part of preset.parts) {
    if (part === 'width') {
      const next = preset.col_span ?? null
      if ((row.col_span ?? null) !== next) patch.col_span = next
    } else if (part === 'lock') {
      const next = preset.lock_conditions ?? null
      if ((row.lock_conditions ?? null) !== next) patch.lock_conditions = next
    } else {
      for (const k of PART_KEYS[part]) {
        const want = preset.overrides?.[k]
        const have = ov?.[k]
        if (JSON.stringify(want) === JSON.stringify(have)) continue
        ov = withKey(ov ?? {}, k, want)
        overridesChanged = true
      }
    }
  }
  if (overridesChanged) patch.overrides = ov
  return Object.keys(patch).length ? patch : null
}

/** One op per placement the preset changes, in order; the editor applies them as one step. */
export function presetOps(
  preset: EntryPreset,
  rows: PlacementRow[]
): { ops: LayoutOp[]; changed: number } {
  const ops: LayoutOp[] = []
  for (const row of rows) {
    const patch = presetPatch(preset, row)
    if (patch)
      ops.push({
        op: 'update_placement',
        at: { field: row.field, group_key: row.group_key },
        patch
      })
  }
  return { ops, changed: ops.length }
}

/** The config with `presets` replaced (empty = none) and kept clean. */
export function withPresets(config: EntryConfig, presets: EntryPreset[]): EntryConfig | null {
  return sanitizeEntryConfig({ ...config, presets: presets.slice(0, ENTRY_PRESETS_MAX) })
}

export const presetSummary = (p: EntryPreset): string =>
  p.parts.length ? p.parts.map((x) => PART_LABEL[x]).join(', ') : 'Nothing set'
