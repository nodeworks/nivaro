#!/usr/bin/env node
/**
 * Announce fix — dry run (realtime): which stored procedures write registered collections
 * without announcing, and what the SQL checks "announce" fix would change in each. READ-ONLY —
 * a thin launcher for api/src/scripts/announce-fix-dry-run.ts, which connects with the repo's .env.
 *
 *   node scripts/announce-fix-dry-run.mjs              summary + per-procedure plan
 *   node scripts/announce-fix-dry-run.mjs --diff       … with the unified diff of each change
 *   node scripts/announce-fix-dry-run.mjs --name usp_x one procedure
 *   node scripts/announce-fix-dry-run.mjs --json       machine-readable
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/announce-fix-dry-run.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
