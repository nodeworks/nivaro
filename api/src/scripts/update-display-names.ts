/**
 * Updates nivaro_collections.display_name to a human-friendly version of the
 * collection technical name (underscores → spaces, Title Case each word).
 *
 *   npx tsx api/src/scripts/update-display-names.ts           # dry-run
 *   npx tsx api/src/scripts/update-display-names.ts --apply   # write to DB
 *   npx tsx api/src/scripts/update-display-names.ts --force --apply  # overwrite existing
 */
import { db } from '../db/index.js'

const apply = process.argv.includes('--apply')
const force = process.argv.includes('--force')

function toDisplayName(collection: string): string {
  return collection
    .replace(/^nivaro_/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const rows = (await db('nivaro_collections').select('collection', 'display_name')) as {
  collection: string
  display_name: string | null
}[]

const updates = rows
  .map((r) => ({
    collection: r.collection,
    old: r.display_name,
    next: toDisplayName(r.collection)
  }))
  .filter((r) => (force ? r.old !== r.next : !r.old?.trim()))

if (updates.length === 0) {
  console.log('Nothing to update. Use --force to overwrite existing display names.')
  await db.destroy()
  process.exit(0)
}

const pad = Math.max(...updates.map((r) => r.collection.length))
console.log(`\n${apply ? 'Applying' : 'Dry-run'} — ${updates.length} collection(s):\n`)

for (const { collection, old, next } of updates) {
  console.log(`  ${collection.padEnd(pad)}  ${old ? `"${old}"` : '(empty)'} → "${next}"`)
}

if (apply) {
  for (const { collection, next } of updates) {
    await db('nivaro_collections').where({ collection }).update({ display_name: next })
  }
  console.log('\nDone.')
} else {
  console.log('\nRun with --apply to commit these changes.')
}

await db.destroy()
