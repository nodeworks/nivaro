#!/usr/bin/env node
/**
 * Turn "Move lines to a new record" on or off for one collection (browser_config.line_split).
 * Thin launcher for api/src/scripts/line-split-config.ts, which connects with the repo's .env.
 *
 *   node scripts/line-split-config.mjs --collection <c> --relation <lines>.<link> [--skip a,b]
 *        [--link-field f] [--no-copy-links]     dry run (default) — writes nothing
 *   … --execute                                 write
 *   node scripts/line-split-config.mjs --collection <c> --off --execute
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/line-split-config.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
