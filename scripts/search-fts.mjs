#!/usr/bin/env node
/**
 * Full-text indexes for search (search item 24) — a thin launcher for
 * api/src/scripts/search-fts.ts, which connects with the repo's .env.
 *
 *   node scripts/search-fts.mjs --plan                 read-only: what would benefit
 *   node scripts/search-fts.mjs --execute --table workflows --columns name,objective
 *                                                      prints the DDL; add --yes to run it
 *   node scripts/search-fts.mjs --drop --table workflows --yes
 *
 * Production is a replication publisher: full-text DDL there is the DBA's call.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/search-fts.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
