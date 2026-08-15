#!/usr/bin/env node
/**
 * Stop every local Nivaro API process.
 *
 *   pnpm kill:api            # default port 3055
 *   pnpm kill:api -- 3060    # another port
 *
 * Kills two overlapping sets, because either alone leaves something behind:
 *
 *  - whatever LISTENS on the API port — the process actually serving requests,
 *    whether it was started by `pnpm dev`, `tsx watch`, or by hand;
 *  - stray `tsx … src/index.ts` processes under this repo that hold no port.
 *    A `tsx watch` parent respawns its child, so killing only the listener
 *    brings the old code straight back — which is exactly how five API
 *    processes once ended up bound to one port, with requests landing on a
 *    stale one and instrumentation appearing to do nothing.
 *
 * Only touches processes whose command line points at THIS checkout, so a
 * second clone (or an unrelated node app on the port) is left alone.
 */
import { execSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rawPort = process.argv[2] ?? process.env.API_PORT ?? '3055'
// Both the port and every pid below are interpolated into shell commands, so
// they are checked to be plain numbers first — an argument like "3055; rm -rf"
// would otherwise run as a command.
if (!/^\d{1,5}$/.test(String(rawPort))) {
  console.error(`Not a port: ${rawPort}`)
  process.exit(1)
}
const port = String(rawPort)

const sh = (cmd) => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    // Both lsof and pgrep exit non-zero when they simply match nothing.
    return ''
  }
}

/** PIDs listening on the API port. */
const listeners = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`)
  .split('\n')
  .filter(Boolean)

/** API processes belonging to this checkout, port or no port. */
const strays = sh(`pgrep -f "tsx.*src/index.ts"`)
  .split('\n')
  .filter(Boolean)
  .filter((pid) => /^\d+$/.test(pid))
  .filter((pid) => sh(`ps -o command= -p ${pid}`).includes(repoRoot))

const pids = [...new Set([...listeners, ...strays])]
  .filter((p) => /^\d+$/.test(p))
  .filter((p) => p !== String(process.pid))

if (pids.length === 0) {
  console.log(`No Nivaro API process found on port ${port}.`)
  process.exit(0)
}

for (const pid of pids) {
  const cmd = sh(`ps -o command= -p ${pid}`).slice(0, 90)
  // SIGKILL, not SIGTERM: a tsx watch parent treats a terminated child as a
  // reason to start a new one.
  try {
    process.kill(Number(pid), 'SIGKILL')
    console.log(`killed ${pid}  ${cmd}`)
  } catch (err) {
    console.log(`could not kill ${pid} (${String(err)})`)
  }
}

// Report what is actually true afterwards rather than assuming the kill worked.
await new Promise((r) => setTimeout(r, 500))
const left = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split('\n').filter(Boolean)
if (left.length > 0) {
  console.error(`\n✗ still listening on ${port}: ${left.join(', ')}`)
  process.exit(1)
}
console.log(`\n✓ port ${port} is free`)
