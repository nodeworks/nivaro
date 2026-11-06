/**
 * The record form's header mid-air merge (army5 b09 BLOCKER): after a 409
 * MIDAIR_COLLISION the person picks, per field, THEIRS (the newer saved
 * value) or MINE (overwrite it). The retry then goes out against the newer
 * revision — which disarms the server's mid-air check — so what it carries
 * must already be the resolved values, never a draft read back from React
 * state after a setState (that sent MINE for a field left on THEIRS).
 *
 * Both the draft AND the baseline move: the server's value at the newer
 * revision is the new baseline for every conflicting field. A THEIRS field
 * then equals its baseline and is not sent at all; a MINE field differs from
 * it and is sent; every other edit the person made is untouched.
 */
export type HeaderConflict = { field: string; current_value: unknown }

export function resolveHeaderCollision(args: {
  draft: Record<string, unknown>
  initial: Record<string, unknown>
  conflicts: HeaderConflict[]
  /** What the 409'd save carried for each conflicting field. */
  mine: Record<string, unknown>
  takeTheirs: ReadonlySet<string>
}): {
  draft: Record<string, unknown>
  initial: Record<string, unknown>
  theirs: string[]
  kept: string[]
} {
  const draft = { ...args.draft }
  const initial = { ...args.initial }
  const theirs: string[] = []
  const kept: string[] = []
  for (const c of args.conflicts) {
    initial[c.field] = c.current_value
    if (args.takeTheirs.has(c.field)) {
      draft[c.field] = c.current_value
      theirs.push(c.field)
    } else {
      if (args.mine[c.field] !== undefined) draft[c.field] = args.mine[c.field]
      kept.push(c.field)
    }
  }
  return { draft, initial, theirs, kept }
}

// Same comparison as the form's own field diff (ItemEditForm valuesEqual):
// the server often answers "1" for a numeric column.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (
    (typeof a === 'string' && typeof b === 'number') ||
    (typeof a === 'number' && typeof b === 'string')
  )
    return String(a) === String(b)
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * A restored draft's fields someone else saved since the draft was taken
 * (army5 b09 HIGH): the draft's `base` (the value each field had when the
 * draft was made) no longer matches the record, and the draft's value is not
 * already the newer one. A field the draft has no base for is not judged.
 */
export function staleDraftConflicts(args: {
  fields: Record<string, unknown>
  base: Record<string, unknown> | null | undefined
  current: Record<string, unknown>
}): HeaderConflict[] {
  const base = args.base ?? {}
  const out: HeaderConflict[] = []
  for (const [k, v] of Object.entries(args.fields)) {
    if (!(k in base)) continue
    if (sameValue(base[k], args.current[k])) continue
    if (sameValue(v, args.current[k])) continue
    out.push({ field: k, current_value: args.current[k] })
  }
  return out
}

/**
 * The fields of a save payload that still carry a stale restored value: the
 * record moved past the draft's base for that field and the payload would
 * write something other than the record's value. The save stops on them with
 * the same Theirs / Mine dialog as a server 409 — never a silent overwrite.
 */
export function restoredDraftCollisions(args: {
  payload: Record<string, unknown>
  /** field → the value it had when the restored draft was taken */
  guard: ReadonlyMap<string, unknown>
  current: Record<string, unknown>
}): HeaderConflict[] {
  const out: HeaderConflict[] = []
  for (const [k, draftBase] of args.guard) {
    if (!(k in args.payload)) continue
    if (sameValue(draftBase, args.current[k])) continue
    if (sameValue(args.payload[k], args.current[k])) continue
    out.push({ field: k, current_value: args.current[k] })
  }
  return out
}

/**
 * The conflicts of a server 409 MIDAIR_COLLISION the person still has to
 * decide. Dropped:
 * - an echo: the record already holds exactly what this save carries — a
 *   double-clicked Save's second request met the first one (army5 b01-N1,
 *   "Theirs == Mine"); nothing would be overwritten;
 * - a field the person already decided (Keep mine / Take theirs on a restored
 *   draft's flag, or in the dialog) while the record still holds the value
 *   they decided against (REVIEW-R5 M4). A newer save of that field by
 *   someone else asks again.
 */
export function conflictsNeedingPerson(args: {
  conflicts: HeaderConflict[]
  payload: Record<string, unknown>
  /** field → the record's value the person decided against */
  decided: ReadonlyMap<string, unknown>
}): HeaderConflict[] {
  return args.conflicts.filter((c) => {
    if (c.field in args.payload && sameValue(args.payload[c.field], c.current_value)) return false
    if (args.decided.has(c.field) && sameValue(args.decided.get(c.field), c.current_value))
      return false
    return true
  })
}

/**
 * Every field the 409'd save carried already holds that value on the record
 * (an echo of the person's own earlier save): the save has nothing left to
 * write and counts as done — no retry, no dialog, no second revision.
 */
export function saveIsEcho(args: {
  conflicts: HeaderConflict[]
  payload: Record<string, unknown>
}): boolean {
  const fields = Object.keys(args.payload).filter((k) => !k.startsWith('_'))
  if (fields.length === 0) return false
  const echoed = new Set(
    args.conflicts
      .filter((c) => c.field in args.payload && sameValue(args.payload[c.field], c.current_value))
      .map((c) => c.field)
  )
  return fields.every((k) => echoed.has(k))
}

/** A 409-shaped error so a client-found collision takes the save's one
 *  mid-air path (midairCollisionOf → the Theirs / Mine dialog). */
export function clientMidairError(conflicts: HeaderConflict[], latest: number | null): Error {
  return Object.assign(new Error('Someone else changed this record since your draft'), {
    status: 409,
    response: {
      code: 'MIDAIR_COLLISION',
      message: 'Someone else changed this record since your draft was saved',
      conflicts,
      latest_revision: latest ?? 0
    }
  })
}
