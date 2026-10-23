#!/usr/bin/env tsx
/**
 * Prints the release gate's token map (base URL → admin token from the
 * Environments registry) as one JSON line on stdout, for a release chain
 * started from a terminal — the Release card hands the chain the same map in
 * its environment. The chain reads stdout and keeps it in RELEASE_GATE_TOKENS;
 * nothing else should run this, and its output must never be logged.
 *
 * Run from api/ (the database settings come from the repo .env):
 *   ./node_modules/.bin/tsx ../scripts/release-gate-tokens.mts
 */
import { db } from '../api/src/db/index.js'
import { readGateTokens } from '../api/src/services/release-gate-tokens.js'

try {
  process.stdout.write(`${JSON.stringify(await readGateTokens())}\n`)
} finally {
  await db.destroy()
}
