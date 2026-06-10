/**
 * Generate www/openapi.json directly from the schema registry in the database.
 * No running server needed — reads nivaro_collections/nivaro_fields via knex.
 *
 *   npx tsx api/src/scripts/generate-openapi.ts [outFile]
 *
 * Invoked by `pnpm docs:api` (scripts/generate-api-docs.mjs) by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from '../db/index.js'
import { generateOpenApi, loadSchema } from '../routes/dev-tools.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const outFile = resolve(process.argv[2] ?? resolve(repoRoot, 'www/openapi.json'))

async function main() {
  const { collections, fieldsByCollection, projectName } = await loadSchema()
  const spec = generateOpenApi(collections, fieldsByCollection, projectName)
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, `${JSON.stringify(spec, null, 2)}\n`)
  console.log(
    `Wrote ${outFile} — ${collections.length} collections, ${Object.keys((spec as { paths?: object }).paths ?? {}).length} paths`
  )
}

main()
  .then(() => closeDb())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('OpenAPI generation failed:', err instanceof Error ? err.message : err)
    await closeDb().catch(() => {})
    process.exit(1)
  })
