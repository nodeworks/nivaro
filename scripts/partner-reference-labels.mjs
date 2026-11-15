#!/usr/bin/env node
/**
 * Reference labels for partner sends ("Fusion accepted it at 10:43 AM — PO 12345").
 * Thin launcher for api/src/scripts/partner-reference-labels.ts, which connects with the
 * repo's .env. With no --set it applies the EFP development defaults below.
 *
 *   node scripts/partner-reference-labels.mjs                 EFP defaults, DRY RUN
 *   node scripts/partner-reference-labels.mjs --execute       EFP defaults, written
 *   node scripts/partner-reference-labels.mjs --set "Name=Label" [--execute]
 *
 * Config, not data: run it on development; promote:config carries it on from there.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// EFP (development) — what each partner calls the number it gives back.
const EFP_DEFAULTS = ['Fusion IIP=PO', 'MDSi=order', 'MWF=order']

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const args = argv.includes('--set')
  ? argv
  : [...EFP_DEFAULTS.flatMap((s) => ['--set', s]), ...argv]
const result = spawnSync(
  'npx',
  ['tsx', resolve(repoRoot, 'api/src/scripts/partner-reference-labels.ts'), ...args],
  { stdio: 'inherit', cwd: resolve(repoRoot, 'api') }
)
process.exit(result.status ?? 1)
