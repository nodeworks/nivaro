/**
 * Request-scoped "this answer is partial" notes. A bounded read deep inside a list compile
 * (a virtual filter that reads at most N rows) cannot reach the reply, so it notes the cut on
 * the current request (the request trace's live request object) and the list route names it in
 * `meta.partial` — the list says honestly that a filter could not read everything.
 *
 * Leaf module: no database, no items service. Outside a request, a note goes nowhere.
 */
import { currentTraceRequestObject } from './request-trace.js'

const notes = new WeakMap<object, Set<string>>()

/** Note that `what` (a filter path such as `$approval_changed`) answered from a capped read. */
export function notePartialRead(
  what: string,
  req: object | null = currentTraceRequestObject()
): void {
  if (!req) return
  const set = notes.get(req) ?? new Set<string>()
  set.add(what)
  notes.set(req, set)
}

/** What this request's reads noted as partial (names only), in note order. */
export function partialReadsOf(req: object | null | undefined): string[] {
  return req ? [...(notes.get(req) ?? [])] : []
}
