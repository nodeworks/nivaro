/**
 * #2608 — notes admins pin to a section or field in the layout editor live in
 * the layout (a section's `editor_note` column, a placement's
 * `overrides.editor_note`) and are only for the editor: every route that
 * serves a layout to a record page drops them first.
 */

const NOTE_KEY = 'editor_note'

function withoutNote(overrides: unknown): unknown {
  if (overrides == null || overrides === '') return overrides
  let obj: unknown = overrides
  const wasString = typeof overrides === 'string'
  if (wasString) {
    // Only a stored JSON string that mentions the key needs parsing.
    if (!(overrides as string).includes(NOTE_KEY)) return overrides
    try {
      obj = JSON.parse(overrides as string)
    } catch {
      return overrides
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !(NOTE_KEY in obj)) return overrides
  const { [NOTE_KEY]: _note, ...rest } = obj as Record<string, unknown>
  return wasString ? JSON.stringify(rest) : rest
}

/** Groups and assignments as a record page may see them: no editor notes. */
export function stripEditorNotes<
  G extends Record<string, unknown>,
  A extends Record<string, unknown>
>(groups: G[], assignments: A[]): { groups: G[]; assignments: A[] } {
  return {
    groups: groups.map((g) => {
      if (!(NOTE_KEY in g)) return g
      const { [NOTE_KEY]: _note, ...rest } = g
      return rest as G
    }),
    assignments: assignments.map((a) =>
      a.overrides == null ? a : ({ ...a, overrides: withoutNote(a.overrides) } as A)
    )
  }
}
