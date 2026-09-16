/**
 * Extension-registered Data Integrity checks.
 *
 * The conformance sweep compiles its rules from field config (required,
 * validation, cascades, display templates, row rules). Some things a record
 * can be wrong about live outside that config — a year with money recorded
 * against it and no plan row, a linked document nobody attached — and only
 * the extension that owns the domain can judge them. It registers a check
 * here; the sweep, the per-record live check, the form banner and the Fix
 * button treat its findings exactly like the built-in rules.
 *
 * A check answers for a BATCH of ids (the sweep hands it chunks of up to 500
 * — set-based SQL, never a query per record) and may offer ONE fix, which
 * the proposal picker shows as a single high-confidence action. The fix runs
 * as the acting user: an extension writes through the items API with the
 * caller's headers so RBAC, revisions and hooks apply.
 */
import type { FastifyRequest } from 'fastify'
import type { User } from '../types.js'

export interface IntegrityFinding {
  item_id: string
  message: string
}

export interface IntegrityFixArgs {
  id: string
  message: string | null
  user: User
  req?: FastifyRequest
}

export interface IntegrityCheck {
  /** Rule key on the findings ('forecast-missing'); kebab-case, unique. */
  id: string
  collection: string
  /** Human rule label for the Data Integrity facets. */
  label: string
  /** The field the finding anchors to on the form (a grid alias or column). */
  field: string
  run(ids: string[]): Promise<IntegrityFinding[]>
  /** Optional one-click fix; `fix_label` is the proposal's button text. */
  fix_label?: string
  fix?(args: IntegrityFixArgs): Promise<{ fixed: boolean; detail?: string }>
}

const registry = new Map<string, IntegrityCheck>()

export function registerIntegrityCheck(check: IntegrityCheck): void {
  if (!/^[a-z][a-z0-9-]*$/.test(check.id)) throw new Error(`integrity check id must be kebab-case: ${check.id}`)
  registry.set(check.id, check)
}

export function integrityChecksFor(collection: string): IntegrityCheck[] {
  return [...registry.values()].filter((c) => c.collection === collection)
}

export function integrityCheckById(id: string): IntegrityCheck | null {
  return registry.get(id) ?? null
}

/** Collections with at least one registered check → count (for the picker). */
export function integrityCheckCounts(): Map<string, number> {
  const out = new Map<string, number>()
  for (const c of registry.values()) out.set(c.collection, (out.get(c.collection) ?? 0) + 1)
  return out
}
