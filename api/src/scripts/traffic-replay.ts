/**
 * `pnpm --filter @nivaro/api run traffic:replay -- --caller <k12|u<uuid>> --target <url>
 *    --token <bearer> [--hours 1] [--sample 200] [--multiplier 1] [--dry-run]` (#1159)
 *
 * Development only. Replays an evenly spaced sample of one caller's logged GET requests against
 * a THROWAWAY API at the chosen speed (2 = twice as fast), then prints status counts and
 * latency. GET only; refused unless NODE_ENV=development and the target is not a shared host.
 * The requests run as --token, not as the caller (see services/traffic-replay.ts).
 */
import { db } from '../db/index.js'
import { planReplay, replayRefusal, replayRows, sharedHosts } from '../services/traffic-replay.js'

const args = process.argv.slice(2)
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const caller = arg('caller') ?? ''
const target = arg('target') ?? ''
const token = arg('token') ?? process.env.TRAFFIC_REPLAY_TOKEN ?? ''
const hours = Math.min(24 * 14, Math.max(1, Number(arg('hours') ?? 1) || 1))
const sample = Math.min(5000, Math.max(1, Number(arg('sample') ?? 200) || 200))
const multiplier = Math.min(100, Math.max(0.1, Number(arg('multiplier') ?? 1) || 1))
const dry = args.includes('--dry-run')

function p(a: number[], q: number): number {
  if (!a.length) return 0
  const s = a.slice().sort((x, y) => x - y)
  return Math.round(s[Math.min(s.length - 1, Math.floor(s.length * q))])
}

let exitCode = 0
try {
  const refusal = replayRefusal(target, {
    nodeEnv: process.env.NODE_ENV,
    sharedHosts: await sharedHosts()
  })
  if (refusal) throw new Error(refusal)
  if (!caller) throw new Error('--caller is required (k<api key id> or u<user uuid>)')
  if (!token && !dry) throw new Error('--token is required (a token valid on the target)')
  const rows = await replayRows(caller, hours)
  const plan = planReplay(rows, { sample, multiplier, base: target })
  console.log(
    `traffic replay: ${rows.length} logged GETs by ${caller} in ${hours}h → ${plan.length} requests over ${Math.round((plan.at(-1)?.at ?? 0) / 1000)}s at ×${multiplier} to ${target}`
  )
  if (dry) {
    for (const s of plan.slice(0, 20)) console.log(`  +${s.at}ms GET ${s.url}`)
  } else {
    const statuses: Record<string, number> = {}
    const lat: number[] = []
    const started = Date.now()
    await Promise.all(
      plan.map(
        (s) =>
          new Promise<void>((resolve) => {
            setTimeout(async () => {
              const t = Date.now()
              try {
                const res = await fetch(s.url, { headers: { authorization: `Bearer ${token}` } })
                await res.arrayBuffer().catch(() => null)
                statuses[res.status] = (statuses[res.status] ?? 0) + 1
              } catch {
                statuses.network = (statuses.network ?? 0) + 1
              }
              lat.push(Date.now() - t)
              resolve()
            }, s.at)
          })
      )
    )
    console.log(
      `done in ${Math.round((Date.now() - started) / 1000)}s — statuses ${JSON.stringify(statuses)}, p50 ${p(lat, 0.5)}ms, p95 ${p(lat, 0.95)}ms`
    )
  }
} catch (err) {
  console.error(`traffic replay refused: ${(err as Error).message}`)
  exitCode = 1
} finally {
  await db.destroy().catch(() => {})
}
process.exit(exitCode)
