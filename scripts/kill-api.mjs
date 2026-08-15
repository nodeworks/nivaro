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
 *
 * Also stops the dev Redis container (`pnpm dev:redis`), matched by the HOST
 * PORT from REDIS_URL — not by image name. This machine also runs the legacy
 * Directus cache, a redis container on a different port, and stopping that
 * would take the old EFP down with it.
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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

/** Redis host port from .env, so we stop OUR container and not another one. */
const redisPort = (() => {
  try {
    const env = readFileSync(resolve(repoRoot, '.env'), 'utf8')
    const m = env.match(/^REDIS_URL=.*?:(\d{2,5})\s*$/m)
    return m?.[1] ?? '6379'
  } catch {
    return '6379'
  }
})()

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

// The dev Redis runs as a container, so it survives any process kill above.
const redisIds = sh(
  `docker ps --filter "publish=${redisPort}" --filter "ancestor=redis:7-alpine" --format "{{.ID}}"`
)
  .split('\n')
  .filter((id) => /^[0-9a-f]{6,}$/i.test(id))

for (const id of redisIds) {
  sh(`docker stop ${id}`)
  console.log(`stopped redis container ${id} (port ${redisPort})`)
}

// `pnpm dev:redis` is a foreground `docker run`, so stopping the container
// without it leaves the runner to put a fresh one straight back. Matched on the
// exact port mapping, so another project's redis runner is untouched.
const redisRunners = sh(`pgrep -f "docker run .*-p ${redisPort}:6379"`)
  .split('\n')
  .filter((pid) => /^\d+$/.test(pid))
for (const pid of redisRunners) {
  try {
    process.kill(Number(pid), 'SIGKILL')
    console.log(`killed redis runner ${pid}`)
  } catch {
    /* already gone */
  }
}

// Report what is actually true afterwards rather than assuming the kill worked.
await new Promise((r) => setTimeout(r, 500))
const left = sh(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).split('\n').filter(Boolean)
if (left.length > 0) {
  console.error(`\n✗ still listening on ${port}: ${left.join(', ')}`)
  process.exit(1)
}
const redisLeft = sh(
  `docker ps --filter "publish=${redisPort}" --filter "ancestor=redis:7-alpine" --format "{{.ID}}"`
)
  .split('\n')
  .filter(Boolean)
console.log(
  `\n✓ port ${port} is free${redisLeft.length === 0 ? `, redis (${redisPort}) stopped` : ''}`
)
if (redisLeft.length > 0) console.error(`✗ redis still running: ${redisLeft.join(', ')}`)
