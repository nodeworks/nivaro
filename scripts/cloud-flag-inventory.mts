// biome-ignore-all lint/suspicious/noConsole: command-line tool, the console is its output
/**
 * Cloud-flag inventory skeleton (Hub phase 5, Task 2).
 *
 *   cd api && node --import tsx ../scripts/cloud-flag-inventory.mts > /tmp/cloud-flag-skeleton.json
 *
 * (tsx lives in api/node_modules, so run it from api/.) Never redirect straight over the checked-in
 * inventory: the classification would be lost. Diff the skeleton against it instead.
 *
 * Prints every cloud-flag site under api/src with `meaning: null`, its batch and an id. The checked-in
 * inventory is this skeleton classified by hand (meaning, rule, why, phase6); the guard test
 * (api/src/test/unit/cloud-flag-guard.test.ts) keeps the two in step.
 */
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
console.log(JSON.stringify({ sites }, null, 2))
