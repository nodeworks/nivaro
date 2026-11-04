/**
 * `options.admin_only_edit` storage for the field settings editor. Options are
 * one JSON object per field — except choice interfaces, whose options are a
 * bare choices ARRAY with no room for a flag. The editor disables the toggle
 * there instead of pretending it saved.
 */
export function adminOnlyEditSupported(optionsJson: string | null): boolean {
  if (!optionsJson) return true
  try {
    return !Array.isArray(JSON.parse(optionsJson))
  } catch {
    return false
  }
}

/** Options JSON with the flag set or cleared; array options come back untouched. */
export function withAdminOnlyEdit(optionsJson: string | null, on: boolean): string | null {
  if (!adminOnlyEditSupported(optionsJson)) return optionsJson
  const parsed = (optionsJson ? JSON.parse(optionsJson) : {}) as Record<string, unknown>
  if (on) parsed.admin_only_edit = true
  else delete parsed.admin_only_edit
  return Object.keys(parsed).length ? JSON.stringify(parsed) : null
}
