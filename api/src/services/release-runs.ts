/**
 * Release runs: the admin's Release button drives scripts/release-chain.mjs
 * as a detached child whose log and record live on disk under .release-runs/,
 * so a run survives the dev API restarting. Every read derives the run's
 * state from "is the pid alive" plus the log's last marker — never from
 * memory. Local development only (see routes/release-runs.ts).
 */

export const STAGES = [
  'preflight',
  'release',
  'publish',
  'artifacts',
  'frontends',
  'deployments',
  'verify'
] as const
export type Stage = (typeof STAGES)[number]
export type Outcome = 'done' | 'failed' | 'cancelled' | 'lost'

export interface RunRecord {
  id: string
  mode: 'plan' | 'go'
  args: string[]
  pid: number
  started_at: string
  started_by: string
  finished_at?: string
  outcome?: Outcome
  failed_stage?: Stage
}

export interface StageEvent {
  stage: Stage
  status: 'start' | 'ok' | 'fail' | 'skip' | 'progress'
  detail?: string
  at: string
}

export interface RunSummary extends RunRecord {
  state: 'running' | Outcome
  version?: string
}

const BUMPS = new Set(['patch', 'minor', 'major'])
const isStage = (s: unknown): s is Stage =>
  typeof s === 'string' && (STAGES as readonly string[]).includes(s)

export function parseEvents(log: string): {
  events: StageEvent[]
  plan: Record<string, unknown> | null
} {
  const events: StageEvent[] = []
  let plan: Record<string, unknown> | null = null
  for (const line of log.split('\n')) {
    if (line.startsWith('@@event ')) {
      try {
        const e = JSON.parse(line.slice(8)) as StageEvent
        if (isStage(e.stage) && typeof e.status === 'string') events.push(e)
      } catch {
        /* a half-written line at the log's end */
      }
    } else if (line.startsWith('@@plan ')) {
      try {
        plan = JSON.parse(line.slice(7)) as Record<string, unknown>
      } catch {
        /* same */
      }
    }
  }
  return { events, plan }
}

export function markerOutcome(
  log: string
): { outcome: Outcome; failed_stage?: Stage; version?: string } | null {
  const done = log.match(/^### DONE — nivaro (\S+)/m)
  if (done) return { outcome: 'done', version: done[1] }
  const failed = log.match(/^### FAILED (?:at (\w+)|before starting)/m)
  if (failed)
    return { outcome: 'failed', ...(isStage(failed[1]) ? { failed_stage: failed[1] } : {}) }
  return null
}

export function deriveState(rec: RunRecord, alive: boolean, log: string): RunSummary {
  if (rec.outcome === 'cancelled') return { ...rec, state: 'cancelled' }
  if (alive) return { ...rec, state: 'running' }
  const m = markerOutcome(log)
  if (!m) return { ...rec, state: 'lost', outcome: 'lost' }
  return {
    ...rec,
    state: m.outcome,
    outcome: m.outcome,
    ...(m.failed_stage ? { failed_stage: m.failed_stage } : {}),
    ...(m.version ? { version: m.version } : {})
  }
}

export function validateStartBody(
  body: unknown
): { ok: true; args: string[] } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  const bump = b.bump ?? 'patch'
  if (!BUMPS.has(bump as string)) return { ok: false, error: 'bump must be patch, minor or major' }
  if (b.from !== undefined && !isStage(b.from))
    return { ok: false, error: `from must be one of ${STAGES.join(', ')}` }
  for (const k of ['with_sdk', 'with_react', 'no_react']) {
    if (b[k] !== undefined && typeof b[k] !== 'boolean')
      return { ok: false, error: `${k} must be a boolean` }
  }
  const args = ['--go', '--events', '--bump', bump as string]
  if (b.from) args.push('--from', b.from as string)
  if (b.with_sdk) args.push('--with-sdk')
  if (b.with_react) args.push('--with-react')
  if (b.no_react) args.push('--no-react')
  return { ok: true, args }
}

export function readLogChunk(log: string, after: number): { chunk: string; next_offset: number } {
  const start = after > log.length || after < 0 ? 0 : after
  return { chunk: log.slice(start), next_offset: log.length }
}
