#!/usr/bin/env node
/**
 * Turn "Allow merging" off (or back to the default) for named collections. Thin launcher
 * for api/src/scripts/merge-records-mode.ts, which connects with the repo's .env.
 *
 *   node scripts/merge-records-mode.mjs --off a,b,c [--like text]   dry run (default)
 *   node scripts/merge-records-mode.mjs --off a,b,c --execute       apply
 *   node scripts/merge-records-mode.mjs --default a,b --execute     back to the default (on)
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/merge-records-mode.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
