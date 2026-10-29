#!/usr/bin/env node
/**
 * MCP tool contract tests in CI (#3215): runs every enabled saved test on an instance
 * (POST /api/mcp-console/tests/run) and exits 1 when one fails or errors.
 *
 *   NIVARO_URL=https://staging.example.com NIVARO_TOKEN=nvk_… node scripts/mcp-contract-tests.mjs
 *   pnpm mcp:contract-tests -- --ids 3,7 --json
 *
 * The token must belong to an administrator and must not be limited to named collections
 * (the console routes are administrator routes). Tests run as that administrator, and every
 * write a tool would make is held — a run never stores anything.
 */

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const value = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

const url = (value('url') ?? process.env.NIVARO_URL ?? '').replace(/\/+$/, '')
const token = process.env.NIVARO_TOKEN ?? ''
if (!url || !token) {
  console.error('Set NIVARO_URL and NIVARO_TOKEN (an administrator API key).')
  process.exit(2)
}
const ids = (value('ids') ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0)

const res = await fetch(`${url}/api/mcp-console/tests/run`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(ids.length ? { ids } : {}),
  signal: AbortSignal.timeout(15 * 60_000)
}).catch((err) => {
  console.error(`Could not reach ${url}: ${err.message}`)
  process.exit(2)
})
const body = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`${res.status}: ${body.error ?? 'the run was refused'}`)
  process.exit(2)
}

const { summary, results } = body.data
if (flag('json')) {
  console.log(JSON.stringify(body.data, null, 2))
} else {
  for (const r of results) {
    const mark = r.status === 'pass' ? 'PASS' : r.status === 'fail' ? 'FAIL' : 'ERR '
    console.log(`${mark}  ${r.tool.padEnd(28)} ${r.name}  (${r.ms} ms)`)
    for (const p of r.outcome.problems ?? []) console.log(`        - ${p}`)
    if (r.outcome.message) console.log(`        - ${r.outcome.message}`)
  }
  console.log(
    `\n${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored`
  )
}
process.exit(summary.failed + summary.errored > 0 ? 1 : 0)
