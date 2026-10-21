import {
  EDITOR_NOTE_MAX,
  HEADER_GROUP_KEY,
  type LayoutBundle,
  type LayoutOp
} from '../../lib/layout-ops'
import type { DesignTarget } from './design-context'
import { asObject, findPlacement, withOverride } from './inspector/model'

/**
 * Notes on the canvas (#2608): a short note an admin pins to a field or a
 * section ("Finance asked for this in Q3"). It lives in the layout — a
 * placement's `overrides.editor_note`, a section's `editor_note` column — so
 * it saves, undoes and versions like every other layout change, and only the
 * layout editor ever shows it (record pages get layouts without notes).
 */
export interface EditorNote {
  text: string
  /** Who wrote it (user id) and their name when they wrote it. */
  by: string | null
  by_name: string | null
  /** ISO time it was written. */
  at: string
}

export const NOTE_TEXT_MAX = 1000

const SUBTITLE_FIELD = '__subtitle__'

function placementKeyOf(t: DesignTarget): { field: string; group_key: string | null } | null {
  switch (t.kind) {
    case 'field':
    case 'slot':
      return { field: t.field, group_key: t.group_key }
    case 'header':
      return { field: t.field, group_key: t.field === SUBTITLE_FIELD ? null : HEADER_GROUP_KEY }
    default:
      return null
  }
}

export function parseNote(raw: unknown): EditorNote | null {
  const o = asObject(raw)
  const text = typeof o.text === 'string' ? o.text.trim() : ''
  if (!text) return null
  return {
    text,
    by: typeof o.by === 'string' ? o.by : null,
    by_name: typeof o.by_name === 'string' ? o.by_name : null,
    at: typeof o.at === 'string' ? o.at : ''
  }
}

/** The note pinned to a field, panel or section on this layout, or null. */
export function noteOf(bundle: LayoutBundle, t: DesignTarget): EditorNote | null {
  if (t.kind === 'group') {
    const g = bundle.groups.find((x) => x.key === t.key)
    return g ? parseNote(g.editor_note) : null
  }
  const at = placementKeyOf(t)
  const row = at ? findPlacement(bundle, at.field, at.group_key) : null
  return row ? parseNote(asObject(row.overrides).editor_note) : null
}

/** Every note on the layout, keyed like design targets ("group:<key>", "<field>|<group>"). */
export function notesOf(bundle: LayoutBundle): Map<string, EditorNote> {
  const out = new Map<string, EditorNote>()
  for (const g of bundle.groups) {
    const n = parseNote(g.editor_note)
    if (n) out.set(`group:${g.key}`, n)
  }
  for (const p of bundle.placements) {
    const n = parseNote(asObject(p.overrides).editor_note)
    if (n) out.set(`${p.field}|${p.group_key ?? ''}`, n)
  }
  return out
}

/** Lookup key of a target in notesOf's map. */
export function noteKey(t: DesignTarget): string | null {
  if (t.kind === 'group') return `group:${t.key}`
  const at = placementKeyOf(t)
  return at ? `${at.field}|${at.group_key ?? ''}` : null
}

/**
 * The op that pins (note) or removes (null) a note. Empty when the target is
 * not on this layout (an inherited part: override it first).
 */
export function noteOps(
  bundle: LayoutBundle,
  t: DesignTarget,
  note: EditorNote | null
): LayoutOp[] {
  const value: EditorNote | null = note
    ? { ...note, text: note.text.trim().slice(0, NOTE_TEXT_MAX) }
    : null
  if (value && !value.text) return noteOps(bundle, t, null)
  if (t.kind === 'group') {
    if (!bundle.groups.some((g) => g.key === t.key)) return []
    const json = value ? JSON.stringify(value) : null
    if (json && json.length > EDITOR_NOTE_MAX) return []
    return [{ op: 'group_update', key: t.key, patch: { editor_note: json } }]
  }
  const at = placementKeyOf(t)
  const row = at ? findPlacement(bundle, at.field, at.group_key) : null
  if (!row || !at) return []
  return [
    {
      op: 'update_placement',
      at,
      patch: { overrides: withOverride(row, 'editor_note', value ?? undefined) }
    }
  ]
}

/** "Rob Lee · 20 Oct 2026" — who wrote a note and when. */
export function noteByline(n: EditorNote): string {
  const d = n.at ? new Date(n.at) : null
  const when =
    d && !Number.isNaN(d.getTime())
      ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
      : null
  return [n.by_name || 'An admin', when].filter(Boolean).join(' · ')
}
