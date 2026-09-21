#!/usr/bin/env node
// Dev launcher — start only the pieces of the stack that are not already up.
//
// `pnpm dev` used to run redis + inngest + api + admin unconditionally under
// concurrently with --kill-others-on-fail: a hand-started API on 3055 made the
// new API child die on EADDRINUSE, which killed everything else, and the
// natural next move (kill the old one) threw away the session someone was
// using. This script asks each port first and ATTACHES to whatever is already
// listening — it never stops a process it did not start.
//
// It also reports orphaned watchers (vite build --watch / tsc --watch / tsup
// --watch / tsx watch whose parent shell is gone) because they rewrite dist
// from an old checkout and read as "my edit did nothing". Reported, never
// killed — stopping them is a person's call: `kill <pid>`.
//
// Usage:  node scripts/dev-preflight.mjs            check + launch the missing pieces
//         node scripts/dev-preflight.mjs --check    report only, exit 0
//         DEV_PREFLIGHT=off pnpm dev                 skip the check, launch everything

import { execFileSync, spawn } from 'node:child_process'

const CHECK_ONLY = process.argv.includes('--check')
const MODE = (process.env.DEV_PREFLIGHT ?? 'attach').toLowerCase()

const PIECES = [
  { name: 'redis', port: 6379, color: 'cyan', cmd: 'pnpm dev:redis' },
  { name: 'inngest', port: 8288, color: 'magenta', cmd: 'wait-on tcp:6379 && pnpm dev:inngest' },
  { name: 'api', port: 3055, color: 'blue', cmd: 'wait-on tcp:6379 && pnpm dev:api' },
  { name: 'admin', port: 3056, color: 'green', cmd: 'pnpm --filter @nivaro/admin dev' }
]
const WATCHER_RE = /(vite build --watch|vite build -w\b|tsc (--watch|-w)\b|tsup .*--watch|tsx watch)/

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

function processes() {
  if (process.platform === 'win32') return []
  return sh('ps', ['-axo', 'pid=,ppid=,lstart=,command='])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\S+ \S+\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/)
      return m ? { pid: +m[1], ppid: +m[2], started: m[3], cmd: m[4] } : null
    })
    .filter(Boolean)
}

function listeners(port) {
  if (process.platform === 'win32') return []
  const out = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'])
  const found = []
  let pid = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = +line.slice(1)
    else if (line.startsWith('c') && pid) found.push({ pid, name: line.slice(1) })
  }
  return found
}

const procs = processes()
const byPid = new Map(procs.map((p) => [p.pid, p]))
const ancestors = new Set()
for (let p = byPid.get(process.pid); p; p = byPid.get(p.ppid)) ancestors.add(p.pid)

const log = (s) => console.log(`[dev] ${s}`)

// Orphan watchers: parent is init, so no terminal will ever stop them.
const orphans = procs.filter(
  (p) => WATCHER_RE.test(p.cmd) && p.ppid === 1 && !ancestors.has(p.pid)
)
for (const w of orphans) {
  log(`warn: orphaned watcher pid ${w.pid} (since ${w.started}) still rebuilding: ${w.cmd.slice(0, 100)}`)
  log(`      it may overwrite dist from an old checkout — stop it yourself with: kill ${w.pid}`)
}

const toStart = []
for (const piece of PIECES) {
  const held = MODE === 'off' ? [] : listeners(piece.port)
  if (held.length) {
    const l = held[0]
    const p = byPid.get(l.pid)
    log(
      `${piece.name}: already listening on ${piece.port} (pid ${l.pid} ${l.name}${p ? `, since ${p.started}` : ''}) — attaching, not starting`
    )
  } else {
    toStart.push(piece)
  }
}

if (CHECK_ONLY) process.exit(0)

if (!toStart.length) {
  log('every piece is already up — nothing to start. Edits to api/src still reload through the running tsx watch.')
  process.exit(0)
}

log(`starting: ${toStart.map((p) => p.name).join(', ')}`)
const args = [
  'exec',
  'concurrently',
  '--kill-others-on-fail',
  '-n',
  toStart.map((p) => p.name).join(','),
  '-c',
  toStart.map((p) => p.color).join(','),
  ...toStart.map((p) => p.cmd)
]
const child = spawn('pnpm', args, { stdio: 'inherit', shell: process.platform === 'win32' })
const forward = (sig) => () => child.kill(sig)
process.on('SIGINT', forward('SIGINT'))
process.on('SIGTERM', forward('SIGTERM'))
child.on('exit', (code) => process.exit(code ?? 0))
