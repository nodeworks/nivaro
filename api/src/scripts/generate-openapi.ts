/**
 * Generate www/openapi.json for the PUBLIC docs site.
 *
 * Default source is the generic sample content model in
 * openapi-sample-schema.ts — the community docs must never publish a real
 * instance's registry (before 2026-09-03 they shipped a customer schema).
 * Pass `--db` (or NIVARO_OPENAPI_SOURCE=db) to build from the connected
 * database instead, for instance-specific references.
 *
 *   npx tsx api/src/scripts/generate-openapi.ts [outFile] [--db]
 *
 * Invoked by `pnpm docs:api` (scripts/generate-api-docs.mjs) by default.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeDb } from '../db/index.js'
import { generateOpenApi } from '../routes/dev-tools.js'
import { sampleSchema } from './openapi-sample-schema.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const useDb = args.includes('--db') || process.env.NIVARO_OPENAPI_SOURCE === 'db'
const outArg = args.find((a) => !a.startsWith('--'))
const outFile = resolve(outArg ?? resolve(repoRoot, 'www/openapi.json'))

async function main() {
  const { collections, fieldsByCollection, projectName } = useDb
    ? await (await import('../routes/dev-tools.js')).loadSchema()
    : sampleSchema()
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
