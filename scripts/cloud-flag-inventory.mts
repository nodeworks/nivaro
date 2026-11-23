// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * Cloud-flag inventory skeleton (Hub phase 5, Task 2).
 *
 *   cd api && node --import tsx ../scripts/cloud-flag-inventory.mts > /tmp/cloud-flag-skeleton.json
 *
 * (tsx lives in api/node_modules, so run it from api/.) Never redirect straight over the checked-in
 * inventory: the classification would be lost. Diff the skeleton against it instead.
 *
 * Prints every cloud-flag site under api/src with `meaning: null`, its batch and an id: the RAW
 * reads of CLOUD_META_DB_URL left in the code. The checked-in inventory began as this skeleton
 * classified by hand (meaning, rule, why, phase6); the guard test
 * (api/src/test/unit/cloud-flag-guard.test.ts) keeps the two in step.
 *
 * Since Hub phase 5 the ratchet is closed: every batch is converted to isMultiTenant() /
 * isNivaroCloud(), so this prints NO sites (0 is the expected answer, guard check (e)). The
 * inventory's entries are the converted sites: check (c) counts each converted file's predicate
 * calls against their weights, so the inventory is never regenerated from this output — that
 * would drop them all and blind check (c). A site this prints is a new raw read: replace it with
 * the predicate, or add that one entry, classified, by hand. (Hub phase 6 final review: the
 * "0 sites vs 313 in the fixture" seen here is this, not a scanner fault; proven by a probe file
 * with a raw read, which this script printed and checks (a), (c) and (e) refused.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { batchFor, scanTree } from '../api/src/test/unit/cloud-flag-scan.ts'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../api/src')
const sites = scanTree(SRC).map((s) => ({
  id: `${s.file}:${s.line}`,
  ...s,
  meaning: null,
  rule: null,
  why: '',
  batch: batchFor(s.file)
}))
// two sites on one line get @2, @3 (`#n` is kept for split entries)
const seen = new Map<string, number>()
for (const s of sites) {
  const n = (seen.get(s.id) ?? 0) + 1
  seen.set(s.id, n)
  if (n > 1) s.id = `${s.id}@${n}`
}
const inventory = (
  JSON.parse(readFileSync(join(SRC, 'test/fixtures/cloud-flag-inventory.json'), 'utf8')) as {
    sites: unknown[]
  }
).sites.length
console.error(
  sites.length === 0
    ? `0 raw cloud-flag sites: the ratchet is closed. The inventory's ${inventory} entries are the converted sites guard check (c) counts — never replace it with this output.`
    : `${sites.length} raw cloud-flag site(s): convert each to the predicate, or add it to the inventory classified by hand (never replace the inventory's ${inventory} entries).`
)
console.log(JSON.stringify({ sites }, null, 2))
