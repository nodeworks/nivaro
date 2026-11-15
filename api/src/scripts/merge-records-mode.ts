/**
 * Turn "Allow merging" off (or back to the default) for named collections in one go.
 * Merging is on by default for every collection (services/record-merge/rules.ts), separately
 * from the duplicate warning; a deployment turns it off where records must never be
 * merged by people (a deployment's core workflow records, say) — an admin can still turn
 * it back on per collection in the Data Model. Run through
 * `node scripts/merge-records-mode.mjs`.
 *
 *   node scripts/merge-records-mode.mjs --off a,b,c [--like text]...      DRY RUN (default)
 *   node scripts/merge-records-mode.mjs --off a,b,c [--like text]... --execute
 *   node scripts/merge-records-mode.mjs --default a,b --execute    back to the default (on)
 *
 *   --off      collections to set `merge_records.mode = 'off'` on
 *   --like     also every registered collection whose name contains this text (repeatable)
 *   --default  collections to put back to the default (on)
 *
 * Only `browser_config.merge_records` changes; every other browser_config key is kept.
 * System tables are skipped (never merged). Idempotent. A collection name that is not registered is
 * reported and skipped. Writes go straight to nivaro_collections (no hooks, no activity
 * rows — a one-time config step, like the other scripts); running APIs pick the change up
 * when their metadata cache refreshes (about 30 s).
 */
import { db } from '../db/index.js'

const EXECUTE = process.argv.includes('--execute')
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SYSTEM = /^(nivaro_|directus_)/i

function listArg(flag: string): string[] {
  const out: string[] = []
  const argv = process.argv
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === flag && argv[i + 1])
      out.push(
        ...argv[i + 1]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
  return out
}

function parseObj(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as object) }
  if (typeof raw !== 'string' || raw === '') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function main() {
  const off = new Set(listArg('--off'))
  const back = new Set(listArg('--default'))
  const likes = listArg('--like')
  for (const n of [...off, ...back])
    if (!IDENT.test(n)) throw new Error(`Not a collection name: ${n}`)
  if (off.size === 0 && back.size === 0 && likes.length === 0) {
    console.log('Nothing to do — pass --off a,b,c, --like text or --default a,b.')
    return
  }
  console.log(
    `${EXECUTE ? 'EXECUTE' : 'DRY RUN'} — database ${String((db.client as { config?: { connection?: { database?: string } } }).config?.connection?.database ?? '?')}`
  )
  const rows = (await db('nivaro_collections').select('collection', 'browser_config')) as Array<{
    collection: string
    browser_config: unknown
  }>
  const registered = new Map(rows.map((r) => [r.collection, r]))
  for (const like of likes)
    for (const r of rows)
      if (r.collection.toLowerCase().includes(like.toLowerCase()) && !back.has(r.collection))
        off.add(r.collection)
  let changed = 0
  const plan = [
    ...[...off].map((c) => [c, 'off'] as const),
    ...[...back].map((c) => [c, 'default'] as const)
  ].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [collection, want] of plan) {
    if (SYSTEM.test(collection)) {
      console.log(`${collection}: skipped — system table (never merged)`)
      continue
    }
    const row = registered.get(collection)
    if (!row) {
      console.log(`${collection}: skipped — not a registered collection`)
      continue
    }
    const bc = parseObj(row.browser_config)
    const mr = parseObj(bc.merge_records)
    const before = mr.mode === 'off' ? 'off' : mr.mode === 'on' ? 'on' : 'default'
    if (want === 'off') mr.mode = 'off'
    else delete mr.mode
    const after = want === 'off' ? 'off' : 'default'
    if (Object.keys(mr).length) bc.merge_records = mr
    else delete bc.merge_records
    if (before === after) {
      console.log(`${collection}: already ${after}`)
      continue
    }
    changed++
    console.log(`${collection}: ${before} → ${after}${EXECUTE ? '' : ' (dry run)'}`)
    if (EXECUTE)
      await db('nivaro_collections')
        .where('collection', collection)
        .update({ browser_config: Object.keys(bc).length ? JSON.stringify(bc) : null })
  }
  console.log(
    `${changed} collection${changed === 1 ? '' : 's'} ${EXECUTE ? 'changed' : 'would change'}.`
  )
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exitCode = 1
  })
  .finally(() => db.destroy())
