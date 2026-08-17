import { createHash } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Dangling-FK detection — the drift detector's sibling, for relations.
 *
 * `nivaro_relations` CLAIMS relationships; nothing ever verified that
 * business rows honor them, and the legacy dual-write era guarantees they
 * don't everywhere: an FK value whose target row is gone renders as a blank
 * label, a drill-down that 404s, an owner filter that silently stops
 * matching. Every one of those surfaces as a support ticket phrased as
 * "record won't open", never as "this FK dangles".
 *
 * Nightly sweep over every registered M2O relation (plain FK columns —
 * junction legs are covered through their own M2O rows): LEFT JOIN the
 * target, count rows whose non-null FK matches nothing, sample the worst.
 * Drift lands as ONE deduped nivaro_issues row per relation, same shape as
 * rollup drift. Detector, not repairer — nulling an FK or resurrecting a row
 * is a judgment call about which side is wrong.
 */

interface RelationRow {
  id: number
  many_collection: string
  many_field: string
  one_collection: string
}

export interface FkIntegrityReport {
  checked_relations: number
  skipped_relations: number
  dangling_relations: number
  total_dangling_rows: number
  relations: Array<{
    many_collection: string
    many_field: string
    one_collection: string
    dangling: number
    examples: Array<{ row_id: string; fk_value: string }>
  }>
}

// No knex-level .timeout here: `{cancel: true}` throws "Query cancelling not
// supported for this dialect" on mssql (found live — it silently skipped
// every relation), and tedious's own 15s request timeout already bounds each
// statement.

export async function detectDanglingFks(): Promise<FkIntegrityReport> {
  // Plain M2O rows only: business-to-business, junction_field null (a junction
  // table's LEGS are themselves plain M2O rows, so they are covered), both
  // sides real tables. nivaro_relations is a CLAIM, not truth — the
  // orphan-junction-tables incident proved rows can name tables that were
  // never created, so existence is checked against information_schema first.
  const rels = (await db('nivaro_relations')
    .whereNull('junction_field')
    .whereNotNull('one_collection')
    .whereNotNull('many_field')
    .select('id', 'many_collection', 'many_field', 'one_collection')) as RelationRow[]

  const tables = new Set(
    (
      (await db.raw(
        `SELECT TABLE_NAME AS "TABLE_NAME" FROM information_schema.tables WHERE TABLE_TYPE = 'BASE TABLE'`
      )) as Array<{ TABLE_NAME: string }>
    ).map((r) => r.TABLE_NAME)
  )

  const report: FkIntegrityReport = {
    checked_relations: 0,
    skipped_relations: 0,
    dangling_relations: 0,
    total_dangling_rows: 0,
    relations: []
  }

  const ident = /^[A-Za-z_][\w]*$/
  for (const rel of rels) {
    const { many_collection: child, many_field: fk, one_collection: parent } = rel
    // nivaro_users is the ONE system parent worth checking: user-FK columns
    // (creator, internal_contact, …) were repointed there and a deleted user
    // dangles exactly like a deleted business record. Everything else
    // system-side stays out of scope.
    const parentAllowed = parent === 'nivaro_users' || !/^(nivaro|directus)_/i.test(parent)
    if (
      /^(nivaro|directus)_/i.test(child) ||
      !parentAllowed ||
      !ident.test(child) ||
      !ident.test(fk) ||
      !ident.test(parent) ||
      !tables.has(child) ||
      !tables.has(parent)
    ) {
      report.skipped_relations++
      continue
    }

    try {
      // One statement per relation: count + top examples together via a
      // windowed select would scan twice on MSSQL; two cheap indexed queries
      // read better in the plan cache. The count is the expensive half.
      const countRows = (await db.raw(
        `SELECT COUNT(*) AS c
           FROM [${child}] c
           LEFT JOIN [${parent}] p ON c.[${fk}] = p.[id]
          WHERE c.[${fk}] IS NOT NULL AND p.[id] IS NULL`
      )) as Array<{ c: number | string }>
      const dangling = Number(countRows[0]?.c ?? 0)
      report.checked_relations++
      if (dangling === 0) continue

      const examples = (await db.raw(
        `SELECT TOP 8 c.[id] AS row_id, c.[${fk}] AS fk_value
           FROM [${child}] c
           LEFT JOIN [${parent}] p ON c.[${fk}] = p.[id]
          WHERE c.[${fk}] IS NOT NULL AND p.[id] IS NULL
          ORDER BY c.[id] DESC`
      )) as Array<{
        row_id: unknown
        fk_value: unknown
      }>

      report.dangling_relations++
      report.total_dangling_rows += dangling
      report.relations.push({
        many_collection: child,
        many_field: fk,
        one_collection: parent,
        dangling,
        examples: examples.map((e) => ({
          row_id: String(e.row_id),
          fk_value: String(e.fk_value)
        }))
      })
    } catch {
      // A relation whose columns drifted (renamed fk, dropped id) — the
      // schema-impact story. Skipping keeps the sweep total.
      report.skipped_relations++
    }
  }

  await reportFindings(report)
  return report
}

async function reportFindings(report: FkIntegrityReport): Promise<void> {
  for (const r of report.relations) {
    try {
      const fingerprint = createHash('sha256')
        .update(`fk-dangling|${r.many_collection}|${r.many_field}`)
        .digest('hex')

      const existing = await db('nivaro_issues')
        .where({ fingerprint })
        .whereIn('status', ['open', 'acknowledged'])
        .first()

      const details = [
        `${r.dangling.toLocaleString()} row(s) in ${r.many_collection} hold a ${r.many_field} value with no matching ${r.one_collection} record.`,
        '',
        'Consequences: blank labels, drill-down 404s, owner filters and scopes that silently stop matching for these rows.',
        '',
        'Newest offenders (row id → dangling value):',
        ...r.examples.map((e) => `  ${e.row_id} → ${e.fk_value}`),
        '',
        'Fix is a judgment call: restore the missing parent, or null/repoint the FK. Legacy dual-writes are the usual cause.'
      ].join('\n')

      if (existing) {
        await db('nivaro_issues')
          .where({ id: existing.id })
          .update({
            details,
            occurrence_count: db.raw('occurrence_count + 1'),
            last_seen_at: new Date(),
            updated_at: new Date()
          })
      } else {
        await db('nivaro_issues').insert({
          title: `Dangling FK: ${r.many_collection}.${r.many_field} → ${r.one_collection} (${r.dangling.toLocaleString()} rows)`,
          severity: 'warning',
          status: 'open',
          source: 'server',
          details,
          fingerprint,
          occurrence_count: 1,
          last_seen_at: new Date(),
          created_at: new Date(),
          updated_at: new Date()
        })
      }
    } catch (err) {
      console.warn('fk-integrity issue write failed:', err)
    }
  }
}
