import { db } from '../db/index.js'
import { selectInChunks } from './db-batch.js'

/**
 * Every active at-risk rule each record matches ("On hold", "Sent back"), in rule order,
 * batched: one read of the rules' referenced fields per collection, chunked. Used where
 * a list must say a record is parked without opening it — the worklist's cached priority
 * sort (first match = the list's own rule) and My Work rows (army 11: approvers could not
 * see a held record). Records matching no rule are absent from the map.
 */
export async function atRiskFlags(
  rows: Array<{ collection: string; item_id: string }>
): Promise<Map<string, Array<{ name: string; color: string }>>> {
  const out = new Map<string, Array<{ name: string; color: string }>>()
  if (rows.length === 0) return out
  const { parseActiveRules, referencedFields, matchingRules } = await import('../routes/at-risk.js')
  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(String(r.item_id))
    byCollection.set(r.collection, set)
  }
  for (const [collection, ids] of byCollection) {
    const rules = parseActiveRules(
      (await db('nivaro_at_risk_rules')
        .where({ collection, is_active: true })
        .orderBy('id')) as never
    )
    if (rules.length === 0) continue
    const fields = new Set<string>(['id'])
    for (const rule of rules) for (const f of referencedFields(rule.conditions)) fields.add(f)
    const records = await selectInChunks(
      [...ids],
      500,
      (chunk) =>
        db(collection)
          .whereIn('id', chunk)
          .select([...fields]) as Promise<Record<string, unknown>[]>
    ).catch(() => [] as Record<string, unknown>[])
    for (const rec of records) {
      const hits = matchingRules(rec, rules)
      if (hits.length > 0)
        out.set(
          `${collection}:${String(rec.id)}`,
          hits.map((h) => ({ name: h.name, color: h.color }))
        )
    }
  }
  return out
}

/** The first matching rule's name per record (the rule a list row shows). */
export async function atRiskRuleNames(
  rows: Array<{ collection: string; item_id: string }>
): Promise<Map<string, string>> {
  const flags = await atRiskFlags(rows)
  const out = new Map<string, string>()
  for (const [k, list] of flags) if (list[0]) out.set(k, list[0].name)
  return out
}
