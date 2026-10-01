#!/usr/bin/env node
// Run a throwaway API + admin (and optionally a frontend) against another
// database, beside the normal dev stack — e.g. to click through a rehearsal
// database the nightly job just rebuilt.
//
//   pnpm dev:db <database> [--api-port 3155] [--admin-port 3156]
//                          [--frontend <dir>[:port]]   (default port 3157)
//
// What it does NOT touch: the dev API/admin on 3055/3056 (it refuses a port
// that is already taken), the database's migration ledger (the API boots with
// SKIP_BOOT_MIGRATIONS=1), and the clock (CRON_TICKS=off — nothing scheduled
// runs). Redis is the dev Redis on a separate db index with prefixed pub/sub
// channels, so sessions, locks and socket events stay apart from the dev API.
//
// The pages are served on 127.0.0.1, not localhost: cookies ignore the port, so
// a localhost session here would overwrite the dev admin's session cookie.
//
// Sign in with an access token (login page → "Sign in with an access token"):
// Microsoft sign-in redirects to the registered callback, not to these ports.
// Writes land in <database>. On the rehearsal database they are wiped by the
// next nightly rebuild.
//
// Ctrl-C stops everything this script started.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REFUSED = new Set(['efp']) // live production databases — never a target

function usage(msg) {
  if (msg) console.error(`dev:db: ${msg}\n`)
  console.error(
    'usage: pnpm dev:db <database> [--api-port N] [--admin-port N] [--frontend <dir>[:port]]'
  )
  process.exit(2)
}

const args = process.argv.slice(2)
let database = null
let apiPort = 3155
let adminPort = 3156
let frontend = null
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  const next = () => args[++i] ?? usage(`${a} needs a value`)
  if (a === '--api-port') apiPort = Number(next())
  else if (a === '--admin-port') adminPort = Number(next())
  else if (a === '--frontend') {
    const [dir, port] = next().split(':')
    frontend = { dir: resolve(process.cwd(), dir), port: Number(port || 3157) }
  } else if (a === '-h' || a === '--help') usage()
  else if (a.startsWith('-')) usage(`unknown option ${a}`)
  else if (!database) database = a
  else usage(`unexpected argument ${a}`)
}
if (!database) usage('name the database')
if (!/^[A-Za-z0-9_]+$/.test(database)) usage(`'${database}' is not a database name`)
if (REFUSED.has(database.toLowerCase())) usage(`'${database}' is production — refused`)
for (const p of [apiPort, adminPort, frontend?.port].filter((x) => x !== undefined)) {
  if (!Number.isInteger(p) || p < 1024 || p > 65535) usage(`bad port ${p}`)
}
if (frontend && !existsSync(resolve(frontend.dir, 'package.json')))
  usage(`no package.json in ${frontend.dir}`)

function envFile(name, fallback) {
  try {
    const line = readFileSync(resolve(ROOT, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}=`))
    return line ? line.slice(name.length + 1).trim() : fallback
  } catch {
    return fallback
  }
}

function listening(port, host = '127.0.0.1') {
  return new Promise((done) => {
    const s = createConnection({ port, host })
    s.once('connect', () => {
      s.destroy()
      done(true)
    })
    s.once('error', () => done(false))
  })
}

// The dev Redis, on a db index the dev API does not use.
const redisBase = new URL(envFile('REDIS_URL', 'redis://localhost:6379'))
redisBase.pathname = '/7'
const redisUrl = redisBase.toString()

const apiUrl = `http://127.0.0.1:${apiPort}`
const adminUrl = `http://127.0.0.1:${adminPort}`
const frontendUrl = frontend ? `http://127.0.0.1:${frontend.port}` : null

const children = []
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM') // the whole group: pnpm → vite, npx → tsx → node
    } catch {}
  }
  setTimeout(() => process.exit(code), 1500).unref()
}
// Children run in their own process groups, so they would outlive a crash here.
process.on('exit', () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {}
  }
})
process.on('uncaughtException', (err) => {
  console.error('dev:db:', err)
  stop(1)
})
process.on('unhandledRejection', (err) => {
  console.error('dev:db:', err)
  stop(1)
})
process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

function run(label, cmd, argv, cwd, env, { respawn } = {}) {
  const child = spawn(cmd, argv, {
    cwd,
    env: { ...process.env, ...env },
    detached: true, // own process group, so stop() reaches the grandchildren
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(child)
  const tag = `[${label}]`.padEnd(9)
  for (const stream of [child.stdout, child.stderr]) {
    let buf = ''
    stream.on('data', (d) => {
      buf += d
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const l of lines) process.stdout.write(`${tag}${l}\n`)
    })
  }
  child.on('exit', (code) => {
    if (stopping) return
    const at = children.indexOf(child)
    if (at >= 0) children.splice(at, 1)
    // A clean exit the launcher did not ask for = a restart request (the
    // admin's "Restart the API" button, or an extension file changing).
    if (code === 0 && respawn) {
      console.log(`${tag}restarting`)
      respawn()
      return
    }
    console.error(`${tag}exited (${code}) — stopping the rest`)
    stop(1)
  })
  return child
}

async function waitFor(url, seconds, { json = true } = {}) {
  for (let i = 0; i < seconds; i++) {
    try {
      const r = await fetch(url)
      if (r.ok) return json ? await r.json() : true
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  return null
}

const ports = [
  ['API', apiPort],
  ['admin', adminPort],
  ...(frontend ? [['frontend', frontend.port]] : [])
]
for (const [what, port] of ports) {
  if ((await listening(port)) || (await listening(port, 'localhost')))
    usage(`port ${port} (${what}) is already in use — pick another with the flags`)
}
if (!(await listening(Number(redisBase.port || 6379), redisBase.hostname)))
  usage(`no Redis at ${redisBase.host} — start it with pnpm dev:redis`)

console.log(`dev:db → ${database}  (API ${apiPort}, admin ${adminPort}${frontend ? `, frontend ${frontend.port}` : ''})`)

function startApi() {
  run(
    'api',
    'npx',
    ['tsx', 'src/index.ts'],
    resolve(ROOT, 'api'),
    {
      PORT: String(apiPort),
      DB_DATABASE: database,
      REDIS_URL: redisUrl,
      REDIS_CHANNEL_PREFIX: 'devdb:',
      CRON_TICKS: 'off',
      SKIP_BOOT_MIGRATIONS: '1',
      // No watcher runs this API, and api/src/index.ts is shared with the dev
      // API: a restart request makes it exit, and startApi() runs it again.
      DEV_RESTART: 'exit',
      PUBLIC_URL: apiUrl,
      ADMIN_URL: adminUrl,
      APP_URLS: [adminUrl, frontendUrl].filter(Boolean).join(',')
    },
    { respawn: startApi }
  )
}
startApi()

const version = await waitFor(`${apiUrl}/api/version`, 120)
if (!version) {
  console.error('dev:db: the API did not answer /api/version within 2 minutes')
  stop(1)
} else {
  const ready = await fetch(`${apiUrl}/api/ready`)
    .then((r) => r.json())
    .catch(() => null)
  const pending = ready?.checks?.find?.((c) => c.id === 'migrations' && !c.ok)
  if (pending) console.log(`dev:db: ${pending.summary} (not run — this script never migrates)`)

  const viteEnv = (dir) => ({
    NIVARO_API_TARGET: apiUrl,
    VITE_CACHE_DIR: resolve(dir, 'node_modules/.vite-dev-db')
  })
  run(
    'admin',
    'pnpm',
    ['exec', 'vite', '--host', '127.0.0.1', '--port', String(adminPort), '--strictPort'],
    resolve(ROOT, 'admin'),
    viteEnv(resolve(ROOT, 'admin'))
  )
  if (frontend) {
    run(
      'portal',
      'pnpm',
      ['exec', 'vite', '--host', '127.0.0.1', '--port', String(frontend.port), '--strictPort'],
      frontend.dir,
      viteEnv(frontend.dir)
    )
  }

  await waitFor(adminUrl, 60, { json: false })
  console.log('')
  console.log(`  database  ${database}  (API ${version.version})`)
  console.log(`  API       ${apiUrl}`)
  console.log(`  admin     ${adminUrl}`)
  if (frontendUrl) console.log(`  frontend  ${frontendUrl}`)
  console.log('  sign in   login page → "Sign in with an access token"')
  console.log('  scheduled jobs off · migrations not run · Ctrl-C stops all')
  console.log('')
}
