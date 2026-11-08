#!/usr/bin/env node
/**
 * One-time: put the "People to offload" card on every administrator's dashboard (saved
 * layouts and admin role defaults). Thin launcher for api/src/scripts/seed-offload-widget.ts,
 * which connects with the repo's .env.
 *
 *   node scripts/seed-offload-widget.mjs            dry run (default) — writes nothing
 *   node scripts/seed-offload-widget.mjs --execute  apply
 *
 * Run once per environment. Idempotent; a card an admin later removes is never re-added
 * (preferences.dashboard_seeds marker).
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/seed-offload-widget.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
