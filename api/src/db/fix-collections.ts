/**
 * Reconciles nivaro_collections.collection against actual MSSQL table names.
 *
 * Sometimes collection names in nivaro_collections don't match the real table
 * name (e.g. "workflow" vs "workflows"). This script finds every mismatch,
 * picks the best candidate from INFORMATION_SCHEMA.TABLES, and updates:
 *   - nivaro_collections.collection
 *   - nivaro_fields.collection
 *   - nivaro_relations.many_collection / one_collection
 *   - nivaro_policies.collection
 *
 * Run: pnpm fix:collections
 * Dry-run (no writes): pnpm fix:collections --dry-run
 */

import '../config.js'
import { db } from './index.js'

const DRY_RUN = process.argv.includes('--dry-run')

// ─── Load actual table names from the database ────────────────────────────────

async function getRealTableNames(): Promise<Set<string>> {
  const rows = await db.raw<{ TABLE_NAME: string }[]>(
    `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'`
  )
  return new Set(rows.map((r: { TABLE_NAME: string }) => r.TABLE_NAME))
}

// ─── Candidate matching ───────────────────────────────────────────────────────

function candidates(name: string): string[] {
  const base = name.toLowerCase()
  return [
    // Exact casing variations
    name,
    name.toLowerCase(),
    name.toUpperCase(),
    // Plural / singular
    base.endsWith('s') ? base.slice(0, -1) : base + 's', // workflow ↔ workflows
    base.endsWith('ies') ? base.slice(0, -3) + 'y' : base, // activities → activity
    base.endsWith('y') ? base.slice(0, -1) + 'ies' : base, // activity → activities
    base.endsWith('es') ? base.slice(0, -2) : base, // statuses → status
    base.endsWith('status') ? base + 'es' : base // status → statuses
  ]
}

function findMatch(name: string, realTables: Set<string>): string | null {
  // Case-insensitive lookup helper
  const lowerMap = new Map<string, string>()
  for (const t of realTables) lowerMap.set(t.toLowerCase(), t)

  for (const c of candidates(name)) {
    if (realTables.has(c)) return c // exact match
    const ci = lowerMap.get(c.toLowerCase())
    if (ci) return ci // case-insensitive match
  }
  return null
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Nivaro — collection name reconciliation${DRY_RUN ? ' (DRY RUN)' : ''}`)
  console.log(`Database: ${process.env.DB_DATABASE} @ ${process.env.DB_HOST}\n`)

  const realTables = await getRealTableNames()
  console.log(`Found ${realTables.size} tables in database\n`)

  const collections = await db<{ id: number; collection: string }>('nivaro_collections').select(
    'id',
    'collection'
  )

  const fixes: Array<{ id: number; from: string; to: string }> = []
  const missing: string[] = []

  for (const col of collections) {
    if (realTables.has(col.collection)) continue // exact match — nothing to do

    const match = findMatch(col.collection, realTables)
    if (match) {
      fixes.push({ id: col.id, from: col.collection, to: match })
    } else {
      missing.push(col.collection)
    }
  }

  // ── Report ──────────────────────────────────────────────────────────────────

  if (fixes.length === 0 && missing.length === 0) {
    console.log('All collection names match real table names. Nothing to do.')
    await db.destroy()
    return
  }

  if (fixes.length > 0) {
    const existingNames = new Set(collections.map((c) => c.collection))
    console.log('── Fixable mismatches ─────────────────────────────────────────')
    for (const f of fixes) {
      const collision = existingNames.has(f.to)
      console.log(
        `  ${f.from.padEnd(40)} → ${f.to}${collision ? '  (duplicate — will remove wrong-named row)' : ''}`
      )
    }
  }

  if (missing.length > 0) {
    console.log('\n── No matching table found (will be removed from registry) ───')
    for (const m of missing) {
      console.log(`  ${m}`)
    }
    console.log('\n  These collections have no corresponding table in the database.')
    console.log('  They will be deleted from nivaro_collections (and related rows in')
    console.log('  nivaro_fields, nivaro_relations, nivaro_policies).')
  }

  if (DRY_RUN) {
    console.log('\nDry run — no changes written. Remove --dry-run to apply.')
    await db.destroy()
    return
  }

  // ── Apply fixes ──────────────────────────────────────────────────────────────

  // Build the current set of collection names so we can detect rename collisions
  const existingNames = new Set(collections.map((c) => c.collection))

  for (const f of fixes) {
    const targetAlreadyExists = existingNames.has(f.to)

    if (targetAlreadyExists) {
      // The correct name already has its own nivaro_collections row.
      // Drop the wrong-named duplicate; migrate its child rows to the correct name
      // only where no conflict exists (duplicate fields/policies would violate unique keys).
      console.log(`\nDeduplicating: removing "${f.from}" (${f.to} already exists)`)

      // Fields: update only those not already present under the target name
      const existingFields = new Set(
        (
          await db<{ field: string }>('nivaro_fields').where({ collection: f.to }).select('field')
        ).map((r) => r.field)
      )
      const sourceFields = await db<{ id: number; field: string }>('nivaro_fields')
        .where({ collection: f.from })
        .select('id', 'field')
      for (const sf of sourceFields) {
        if (existingFields.has(sf.field)) {
          await db('nivaro_fields').where({ id: sf.id }).delete()
        } else {
          await db('nivaro_fields').where({ id: sf.id }).update({ collection: f.to })
        }
      }

      // Policies: update only those not already present under the target name
      const existingPolicies = new Set(
        (
          await db<{ role: string; action: string }>('nivaro_policies')
            .where({ collection: f.to })
            .select('role', 'action')
        ).map((r) => `${r.role}::${r.action}`)
      )
      const sourcePolicies = await db<{ id: number; role: string; action: string }>(
        'nivaro_policies'
      )
        .where({ collection: f.from })
        .select('id', 'role', 'action')
      for (const sp of sourcePolicies) {
        if (existingPolicies.has(`${sp.role}::${sp.action}`)) {
          await db('nivaro_policies').where({ id: sp.id }).delete()
        } else {
          await db('nivaro_policies').where({ id: sp.id }).update({ collection: f.to })
        }
      }

      // Relations: straightforward update (no unique constraint on these)
      await db('nivaro_relations')
        .where({ many_collection: f.from })
        .update({ many_collection: f.to })
      await db('nivaro_relations')
        .where({ one_collection: f.from })
        .update({ one_collection: f.to })

      // Delete the duplicate nivaro_collections row
      await db('nivaro_collections').where({ id: f.id }).delete()
    } else {
      // No collision — simple rename
      console.log(`\nRenaming: ${f.from} → ${f.to}`)

      await db('nivaro_collections').where({ id: f.id }).update({ collection: f.to })
      await db('nivaro_fields').where({ collection: f.from }).update({ collection: f.to })
      await db('nivaro_relations')
        .where({ many_collection: f.from })
        .update({ many_collection: f.to })
      await db('nivaro_relations')
        .where({ one_collection: f.from })
        .update({ one_collection: f.to })
      await db('nivaro_policies').where({ collection: f.from }).update({ collection: f.to })

      existingNames.add(f.to)
      existingNames.delete(f.from)
    }
  }

  // ── Remove genuinely missing collections ─────────────────────────────────────

  for (const name of missing) {
    console.log(`\nRemoving: ${name} (no matching table)`)

    await db('nivaro_fields').where({ collection: name }).delete()
    await db('nivaro_relations').where({ many_collection: name }).delete()
    await db('nivaro_relations').where({ one_collection: name }).delete()
    await db('nivaro_policies').where({ collection: name }).delete()
    await db('nivaro_collections').where({ collection: name }).delete()
  }

  console.log('\nDone.\n')
  await db.destroy()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
