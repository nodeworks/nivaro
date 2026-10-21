/**
 * #2608 — notes admins pin to a section or field in the layout editor live in
 * the layout (a section's `editor_note` column, a placement's
 * `overrides.editor_note`) and are only for the editor: every route that
 * serves a layout to a record page drops them first.
 */

const NOTE_KEY = 'editor_note'
/**
 * #2692 placement AI fill (`overrides.ai_generate`): the admin's prompt template stays with
 * admins. A record page gets `{ enabled, has_prompt, tokens }` instead — whether the button
 * shows and which draft values to send along; the server reads the prompt from the stored
 * layout. Mirrors AI_FILL_KEY / TOKEN_RE in ai-design/field-fill.ts and the client reader in
 * packages/shared/src/lib/ai-fill.ts.
 */
const AI_FILL_KEY = 'ai_generate'
const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

function withoutPrompt(ai: Record<string, unknown>): Record<string, unknown> {
  const { prompt, ...rest } = ai
  const text = typeof prompt === 'string' ? prompt.trim() : ''
  const tokens: string[] = []
  for (const m of text.matchAll(TOKEN_RE)) if (!tokens.includes(m[1])) tokens.push(m[1])
  return { ...rest, has_prompt: text.length > 0, tokens }
}

function cleanOverrides(overrides: unknown, stripAiPrompt: boolean): unknown {
  if (overrides == null || overrides === '') return overrides
  let obj: unknown = overrides
  const wasString = typeof overrides === 'string'
  if (wasString) {
    // Only a stored JSON string that mentions a key needs parsing.
    const str = overrides as string
    if (!str.includes(NOTE_KEY) && !(stripAiPrompt && str.includes(AI_FILL_KEY))) return overrides
    try {
      obj = JSON.parse(str)
    } catch {
      return overrides
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return overrides
  let rest = obj as Record<string, unknown>
  let changed = false
  if (NOTE_KEY in rest) {
    const { [NOTE_KEY]: _note, ...others } = rest
    rest = others
    changed = true
  }
  const ai = rest[AI_FILL_KEY]
  if (stripAiPrompt && ai && typeof ai === 'object' && !Array.isArray(ai) && 'prompt' in ai) {
    rest = { ...rest, [AI_FILL_KEY]: withoutPrompt(ai as Record<string, unknown>) }
    changed = true
  }
  if (!changed) return overrides
  return wasString ? JSON.stringify(rest) : rest
}

/**
 * Groups and assignments as a record page may see them: no editor notes, and (for
 * non-admins, `stripAiPrompt`) no AI fill prompt templates.
 */
export function stripEditorNotes<
  G extends Record<string, unknown>,
  A extends Record<string, unknown>
>(
  groups: G[],
  assignments: A[],
  opts: { stripAiPrompt?: boolean } = {}
): { groups: G[]; assignments: A[] } {
  const stripAiPrompt = opts.stripAiPrompt === true
  return {
    groups: groups.map((g) => {
      if (!(NOTE_KEY in g)) return g
      const { [NOTE_KEY]: _note, ...rest } = g
      return rest as G
    }),
    assignments: assignments.map((a) =>
      a.overrides == null
        ? a
        : ({ ...a, overrides: cleanOverrides(a.overrides, stripAiPrompt) } as A)
    )
  }
}
