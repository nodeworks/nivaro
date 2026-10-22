// Shared helpers for the chaos CI scripts (#2839 #2842 #2857 #2836).
// Plain node, no deps. Every script writes a JSON result file and can post it
// to /api/chaos/runs/record on a base URL with --record.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      out._.push(a)
      continue
    }
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else {
      out[key] = next
      i++
    }
  }
  return out
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** Write the result JSON (always) and post it when --record <base-url> is given. */
export async function finish(args, result) {
  const file = resolve(
    String(args.out && args.out !== true ? args.out : `reports/chaos/${result.script}-${stamp()}.json`)
  )
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`)
  console.log(`result: ${file}`)
  if (args.record && args.record !== true) {
    try {
      const token = process.env.CHAOS_RECORD_TOKEN ?? process.env.NIVARO_TOKEN ?? ''
      const res = await fetch(`${String(args.record).replace(/\/$/, '')}/api/chaos/runs/record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          kind: 'ci',
          fault_key: result.fault_key,
          label: result.label,
          verdict: result.verdict,
          metrics: result.metrics,
          started_at: result.started_at,
          ended_at: result.ended_at,
          meta: { script: result.script, checks: result.checks }
        })
      })
      console.log(`record: HTTP ${res.status}`)
    } catch (e) {
      console.warn(`record failed: ${e.message}`)
    }
  }
  return file
}

export function summarize(checks) {
  return checks.every((c) => c.ok) ? 'held' : 'broke'
}

export function printChecks(checks) {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
}

/**
 * Start the API from the repo as a throwaway child. Returns { child, lines, exited }.
 * env is layered over a safe base (no crons, no boot migrations, no warm).
 */
export function startApi({ port, env = {}, prefix = 'chaos-ci:', cwd = resolve(repoRoot, 'api') }) {
  const lines = []
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd,
    env: {
      ...process.env,
      CRON_TICKS: 'off',
      SKIP_BOOT_MIGRATIONS: '1',
      CACHE_WARM: 'off',
      REDIS_CHANNEL_PREFIX: prefix,
      PORT: String(port),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  const t0 = Date.now()
  const onData = (d) => {
    for (const l of String(d).split('\n')) if (l.trim()) lines.push({ at: Date.now() - t0, line: l })
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
  const exited = new Promise((r) =>
    child.on('exit', (code, signal) => r({ code, signal, at: Date.now() - t0 }))
  )
  // npx -> tsx -> node: signal the whole group we started (never anyone else's process).
  const stop = (signal = 'SIGTERM') => {
    try {
      process.kill(-child.pid, signal)
    } catch {}
  }
  return { child, lines, exited, t0, stop }
}

export async function waitFor(fn, { timeoutMs = 60_000, everyMs = 500 } = {}) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {}
    if (Date.now() > end) return null
    await sleep(everyMs)
  }
}

export async function getJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}
