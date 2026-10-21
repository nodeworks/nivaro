/**
 * What an open record form does with a config hot-push (`nvr:config-update`, #268 / #1740).
 *
 * - `ignore`: the push names another collection, so it is not about this form.
 * - `refresh`: re-read the form definition in place, quietly. A push naming no collection (a
 *   raw write's config stamp, a surface-wide notice) is about no form in particular, and the
 *   design canvas re-reads its own layout, so a Reload prompt there means nothing.
 * - `banner`: re-read AND say "This form was changed": the push names this collection (layout
 *   editor saves do) and the form is not being designed.
 */
export type ConfigUpdateReaction = 'ignore' | 'refresh' | 'banner'

export function configUpdateReaction(
  changed: string | null | undefined,
  collection: string,
  designMode: boolean
): ConfigUpdateReaction {
  if (changed && changed !== collection) return 'ignore'
  return changed === collection && !designMode ? 'banner' : 'refresh'
}
