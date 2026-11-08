/**
 * Army 11 N12 (2026-11-08): whether a list row's ⋯ menu offers Delete.
 *
 * Twin of the server rule (api services/delete-in-flight.ts) — change both:
 * a person who is not an administrator deletes a pipeline record only while
 * it has never left its first step (at the initial state, not finished, no
 * move ever recorded). On top of the server rule, the row menu offers Delete
 * only where the collection's Delete built-in is open to the person (the
 * same switch as the bulk bar's Delete: EFP keeps it admin-only on workflows
 * and inventory requests, so the row menu matches the record page, whose
 * Delete is for administrators).
 */

export interface DeleteOfferRun {
  instance?: {
    completed_at?: unknown
    current_state_obj?: { is_initial?: unknown; label?: string | null } | null
  } | null
  history?: Array<{ from_state?: unknown }> | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'

/**
 * `run`: the record's `/pipelines/instance` answer — `null` = no run,
 * `undefined` = not read yet (nothing is offered until it is, for a
 * non-admin on a pipeline collection). `builtinOpen`: the Delete built-in is
 * available to the person (`undefined` = not known yet → not offered).
 */
export function rowDeleteOffered(input: {
  isAdmin: boolean
  roleMayDelete: boolean
  builtinOpen: boolean | undefined
  hasPipeline: boolean
  run: DeleteOfferRun | null | undefined
}): boolean {
  if (input.isAdmin) return true
  if (!input.roleMayDelete || input.builtinOpen !== true) return false
  if (!input.hasPipeline) return true
  if (input.run === undefined) return false
  const inst = input.run?.instance
  if (!inst) return true
  if (inst.completed_at != null) return false
  if (!truthy(inst.current_state_obj?.is_initial)) return false
  return !(input.run?.history ?? []).some((h) => h?.from_state != null)
}
