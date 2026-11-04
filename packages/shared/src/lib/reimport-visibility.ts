// Who sees a template's Re-import menu item. A template may name the pipeline
// states where non-admins get it (the record has moved past the point where a
// file may replace its lines); administrators always do. Empty / absent list =
// any state. Kept apart from the form so the rule is unit-tested.

export function reimportAllowed(
  template: { reimport?: { enabled?: boolean; states?: string[] | null } | null },
  stateKey: string | null | undefined,
  isAdmin: boolean
): boolean {
  const r = template.reimport
  if (r?.enabled !== true) return false
  if (isAdmin) return true
  const states = r.states
  if (!states?.length) return true
  return !!stateKey && states.includes(stateKey)
}
