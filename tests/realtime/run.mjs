#!/usr/bin/env node
// Realtime CI runner. Suites run against the stack deploy/realtime-ci/rtci.sh started.
//
//   node tests/realtime/run.mjs --suite parity            one suite
//   node tests/realtime/run.mjs --suite parity,auth       several, in order
//   node tests/realtime/run.mjs --suite all               parity, auth, failover (not load)
//   node tests/realtime/run.mjs --suite load [--users 250 --soak-min 60 --compare]
//        --only <substr,…>   run only the cases whose name contains one of these
//        --base <url>        entry URL (default Traefik v3; --v2 = the Traefik v2.4 entry)
//        --out <dir>         results folder (default reports/realtime/<run id>/)
//
// Each suite writes <out>/<suite>.json; report.mjs turns a folder into summary.md + summary.json.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cfg, repoRoot } from './lib/config.mjs'
import { buildReport } from './report.mjs'

const argv = process.argv.slice(2)
const args = {}
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue
  const k = argv[i].slice(2)
  const v = argv[i + 1]
  if (v === undefined || v.startsWith('--')) args[k] = true
  else {
    args[k] = v
    i++
  }
}

const SUITES = ['parity', 'auth', 'failover', 'load', 'cloud']
const want = String(args.suite ?? 'parity')
const list = want === 'all' ? ['parity', 'auth', 'failover'] : want.split(',')
for (const s of list) if (!SUITES.includes(s)) throw new Error(`unknown suite ${s} (${SUITES.join(', ')})`)

if (args.v2) cfg.base = cfg.baseV2
if (typeof args.base === 'string') cfg.base = args.base
const runId = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${cfg.mode}`
const out = resolve(typeof args.out === 'string' ? args.out : resolve(repoRoot, 'reports/realtime', runId))
mkdirSync(out, { recursive: true })

console.log(`rtci: mode=${cfg.mode} base=${cfg.base} image=${cfg.image ?? '?'} → ${out}`)
let failed = 0
for (const name of list) {
  const mod = await import(`./suites/${name}.mjs`)
  const only = typeof args.only === 'string' ? args.only.split(',') : null
  const t0 = Date.now()
  let result
  try {
    result = await mod.run({ args, only })
  } catch (e) {
    result = { suite: name, verdict: 'fail', counts: { pass: 0, fail: 1, skip: 0 }, cases: [], error: e.stack }
    console.error(e)
  }
  result.mode = cfg.mode
  result.base = cfg.base
  result.image = cfg.image
  result.seconds = Math.round((Date.now() - t0) / 1000)
  writeFileSync(resolve(out, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`)
  if (result.verdict !== 'pass') failed++
  console.log(`rtci: ${name} ${result.verdict} — ${JSON.stringify(result.counts)} in ${result.seconds} s`)
}
const { md } = buildReport(out)
console.log(`\nrtci: report ${resolve(out, 'summary.md')}\n`)
console.log(md.split('\n').slice(0, 30).join('\n'))
// Sockets and timers the suites left open must not keep the runner alive.
process.exit(failed ? 1 : 0)
