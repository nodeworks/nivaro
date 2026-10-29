/**
 * First-use form tours (#3192): which forms a person has already toured, kept in
 * nivaro_users.preferences.form_tours_done as a list of layout ids (newest last). The
 * record form starts a form's tour on its own only while the id is missing; the Tour
 * button replays it whenever. Ids are layout ids, never record data.
 */
export const FORM_TOURS_MAX = 300

/** The stored list with `layoutId` added (once, newest last, capped); null for a bad id. */
export function appendFormTourDone(current: unknown, layoutId: unknown): number[] | null {
  const id = Number(layoutId)
  if (!Number.isInteger(id) || id <= 0) return null
  const list = Array.isArray(current)
    ? current.filter((n): n is number => Number.isInteger(n) && n > 0 && n !== id)
    : []
  return [...list, id].slice(-FORM_TOURS_MAX)
}
