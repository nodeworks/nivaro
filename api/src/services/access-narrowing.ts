import { db } from '../db/index.js'
import type { User } from '../types.js'
import { describeNarrowing, type NarrowingFacts } from './access-words.js'
import { getAllowedFields } from './permissions.js'
import { compileAccessGates } from './record-access.js'
import { isAdminRole } from './user-scopes.js'

/**
 * #1889 — what shaped a tool's answer for THIS person.
 *
 * Built from the same gates the read path applies (record-access.ts
 * compileAccessGates: role row filter + routed User Scopes) plus the role's
 * field list. Reports only the person's OWN limits (their filter values,
 * that a row rule applies, that fields are trimmed) — never how many rows or
 * which fields were left out, which would itself leak what they cannot see.
 *
 * Cached per (user, collection) for 60 s: a chat answer asks once per tool
 * call and several tool calls usually hit the same collection.
 */

const TTL = 60_000
const cache = new Map<string, { at: number; facts: NarrowingFacts | null }>()

export function bustNarrowingCache(): void {
  cache.clear()
}

async function labelValues(
  target: string,
  displayField: string,
  values: Array<string | number>
): Promise<string[]> {
  const ids = values.slice(0, 8).map(String)
  if (ids.length === 0) return []
  try {
    const rows = (await db(target)
      .whereIn('id', ids as never)
      .select('id', db.raw('?? as label', [displayField]))) as Array<{
      id: unknown
      label: unknown
    }>
    const byId = new Map(rows.map((r) => [String(r.id), String(r.label ?? r.id)]))
    return ids.map((id) => byId.get(id) ?? id)
  } catch {
    return ids
  }
}

/** The facts (null = nothing narrowed the answer for this person). */
export async function narrowingFacts(
  user: User,
  collection: string
): Promise<NarrowingFacts | null> {
  const key = `${String(user.id).toUpperCase()}|${collection}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.facts
  let facts: NarrowingFacts | null = null
  if (!(await isAdminRole(user.role))) {
    const gates = await compileAccessGates(user, collection)
    if (gates.permitted) {
      const scopes = await Promise.all(
        gates.scopes.map(async (g) => ({
          label: g.label,
          values: await labelValues(g.target, g.displayField, g.values)
        }))
      )
      const fields = await getAllowedFields(user, 'read', collection).catch(() => null)
      const f: NarrowingFacts = {
        rowFilter: !!gates.rowFilter,
        scopes,
        fieldsLimited: Array.isArray(fields) && !fields.includes('*'),
        strict: gates.strict?.label ?? null
      }
      if (f.rowFilter || f.scopes.length > 0 || f.fieldsLimited || f.strict) facts = f
    }
  }
  cache.set(key, { at: Date.now(), facts })
  return facts
}

/** The sentence a tool result carries (null = nothing narrowed it). */
export async function narrowingNote(user: User, collection: string): Promise<string | null> {
  try {
    const f = await narrowingFacts(user, collection)
    return f ? describeNarrowing(f) : null
  } catch {
    return null
  }
}

/** Tools whose answer reads one collection the way the items service does. */
const NARROWABLE_TOOLS = new Set(['query_items', 'aggregate', 'semantic_search'])

/**
 * Attach `access_note` to a chat tool's result when access shaped it. A
 * result that is an array (aggregate with group_by) is wrapped as
 * `{rows, access_note}` only when there is a note — otherwise left exactly
 * as it was.
 */
export async function withAccessNote(
  user: User,
  tool: string,
  input: Record<string, unknown>,
  out: { result: unknown; summary: string }
): Promise<{ result: unknown; summary: string }> {
  if (!NARROWABLE_TOOLS.has(tool)) return out
  const collection = typeof input.collection === 'string' ? input.collection : ''
  if (!collection) return out
  const note = await narrowingNote(user, collection)
  if (!note) return out
  const result =
    out.result && typeof out.result === 'object' && !Array.isArray(out.result)
      ? { ...(out.result as Record<string, unknown>), access_note: note }
      : { rows: out.result, access_note: note }
  return { result, summary: `${out.summary} · ${note}` }
}

/** The distinct notes a set of tool results carried, in order. */
export function collectAccessNotes(results: unknown[]): string[] {
  const out: string[] = []
  for (const r of results) {
    const note =
      r && typeof r === 'object' && !Array.isArray(r)
        ? (r as { access_note?: unknown }).access_note
        : null
    if (typeof note === 'string' && note && !out.includes(note)) out.push(note)
  }
  return out
}
