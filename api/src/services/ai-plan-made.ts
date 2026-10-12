import { db } from '../db/index.js'
import type { PlanMadeRecord, PlanStepMade } from './ai-plan-runner.js'
import { selectInChunks } from './db-batch.js'

/**
 * What an Ask AI plan step WROTE, captured around the write (#2002, #1954).
 * The before-values are read raw, the same way a Data Integrity fix records
 * its undo writes (integrity-proposals.ts applyProposal): the person may be
 * allowed to write a field they cannot read. They stay inside the plan's
 * payload and are only ever shown through the change report, which checks
 * each viewer's access per record and per field.
 */

/** Records kept per step — a plan step acts on at most 200 records. */
export const MADE_CAP = 500

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Current raw values of `fields` on `ids`, keyed by id. */
export async function readRaw(
  collection: string,
  ids: string[],
  fields: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const cols = fields.filter((f) => IDENT.test(f) && f !== 'id')
  if (!IDENT.test(collection) || ids.length === 0) return new Map()
  const rows = await selectInChunks(
    ids,
    1000,
    (chunk) =>
      db(collection)
        .whereIn('id', chunk)
        .select(['id', ...cols]) as Promise<Array<Record<string, unknown>>>
  )
  return new Map(rows.map((r) => [String(r.id), r]))
}

/** The newest revision id per record (absent = the collection keeps none). */
export async function latestRevisionIds(
  collection: string,
  ids: string[]
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await selectInChunks(
    ids,
    1000,
    (chunk) =>
      db('nivaro_revisions')
        .where({ collection })
        .whereIn('item', chunk)
        .groupBy('item')
        .select('item')
        .max({ rev: 'id' }) as Promise<Array<{ item: unknown; rev: unknown }>>
  ).catch(() => [] as Array<{ item: unknown; rev: unknown }>)
  const out = new Map<string, number>()
  for (const r of rows) if (r.rev != null) out.set(String(r.item), Number(r.rev))
  return out
}

/** Build a step's made-record set from before-values and what it wrote. */
export async function captureMade(
  collection: string,
  writes: Array<{ id: string; before: Record<string, unknown>; after: Record<string, unknown> }>,
  opts: { created?: boolean } = {}
): Promise<PlanStepMade> {
  const kept = writes.slice(0, MADE_CAP)
  const revs = await latestRevisionIds(
    collection,
    kept.map((w) => w.id)
  )
  const records: PlanMadeRecord[] = kept.map((w) => ({
    id: w.id,
    before: w.before,
    after: w.after,
    rev: revs.get(w.id) ?? null,
    ...(opts.created ? { created: true } : {})
  }))
  return { collection, records }
}
