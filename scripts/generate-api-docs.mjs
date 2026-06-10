#!/usr/bin/env node
/**
 * Generate www/openapi.json from a running Nivaro instance.
 *
 * Fetches the OpenAPI 3.1 document from GET /api/dev-tools/openapi.json
 * (admin only) and pretty-writes it to www/openapi.json so the static
 * API reference page (www/api-reference.html) can render it.
 *
 * Usage:
 *   node scripts/generate-api-docs.mjs [--url http://localhost:3055] [--token <admin static token>]
 *   pnpm docs:api -- --url https://cms.example.com --token abc123
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Generate www/openapi.json from the Nivaro schema registry.

Usage:
  node scripts/generate-api-docs.mjs [options]

Options:
  (none)           Default: read the schema directly from the database via
                   the repo's .env config (no running server or token needed)
  --url <url>      Fetch from a running instance instead (remote mode)
  --token <token>  Admin static token for remote mode (default: $NIVARO_TOKEN)
  --help, -h       Show this help

Default mode runs api/src/scripts/generate-openapi.ts with tsx, building the
spec straight from nivaro_collections/nivaro_fields. Remote mode calls
GET <url>/api/dev-tools/openapi.json (admin-only) instead.`;

function parseArgs(argv) {
  const opts = { url: '', token: process.env.NIVARO_TOKEN ?? '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--url') {
      opts.url = argv[++i] ?? '';
    } else if (arg === '--token') {
      opts.token = argv[++i] ?? '';
    } else {
      console.error(`Unknown argument: ${arg}\n`);
      console.error(HELP);
      process.exit(1);
    }
  }
  return opts;
}

const { url, token } = parseArgs(process.argv.slice(2));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Default mode: build the spec straight from the database — always reflects
// the actual schema registry, no running server or token required.
if (!url) {
  // Run from api/ so npx resolves the workspace-local tsx binary
  const result = spawnSync(
    'npx',
    ['tsx', resolve(repoRoot, 'api/src/scripts/generate-openapi.ts')],
    { stdio: 'inherit', cwd: resolve(repoRoot, 'api') },
  );
  process.exit(result.status ?? 1);
}

if (!token) {
  console.error('✗ Remote mode needs a token. Pass --token <admin static token> or set NIVARO_TOKEN.');
  console.error('  The /api/dev-tools/openapi.json endpoint is admin-only.');
  process.exit(1);
}

const base = url.replace(/\/+$/, '');
const endpoint = `${base}/api/dev-tools/openapi.json`;

let res;
try {
  res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
} catch (err) {
  console.error(`✗ Could not connect to ${endpoint}`);
  console.error(`  ${err.cause?.message ?? err.message}`);
  console.error('  Is the Nivaro API running? Try: pnpm dev');
  process.exit(1);
}

if (res.status === 401 || res.status === 403) {
  console.error(`✗ Authentication failed (HTTP ${res.status}) at ${endpoint}`);
  console.error('  The token must belong to a user with admin access.');
  process.exit(1);
}
if (!res.ok) {
  console.error(`✗ Request failed (HTTP ${res.status} ${res.statusText}) at ${endpoint}`);
  process.exit(1);
}

let spec;
try {
  spec = await res.json();
} catch {
  console.error('✗ Response was not valid JSON.');
  process.exit(1);
}
if (!spec || typeof spec !== 'object' || !spec.openapi) {
  console.error('✗ Response does not look like an OpenAPI document (missing "openapi" field).');
  process.exit(1);
}

const outPath = resolve(dirname(fileURLToPath(import.meta.url)), '../www/openapi.json');
writeFileSync(outPath, `${JSON.stringify(spec, null, 2)}\n`);

const pathCount = Object.keys(spec.paths ?? {}).length;
const schemaCount = Object.keys(spec.components?.schemas ?? {}).length;
console.log(`✓ Wrote ${outPath}`);
console.log(`  ${spec.info?.title ?? 'API'} — ${pathCount} paths, ${schemaCount} schemas`);
