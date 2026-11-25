import { randomUUID } from 'node:crypto'

/**
 * Hub gap sqlite (review 4, N2/N3): a SQLite app's database copy and its release checksum run
 * as start-then-poll jobs, like the file pull — the work can take minutes (a checkpoint waits up
 * to 5 min for a reader, a copy streams and checks up to 8 GiB), longer than one HTTP call may
 * stay open. The link route answers 202 {job} at once; the Hub reads the job's state until it
 * ends (services/hub/move/ops.ts followDatabaseJob), within its own limit, which is longer than
 * the target's own (SQLITE_PULL_DEADLINE_MS): the target always ends a copy first and says why.
 *
 * Jobs live in this process only, keyed by the app (`scope`: a tenant id on a shared deployment,
 * `self` on a dedicated app) and kept an hour after they end. One running job per app and kind:
 * a second start with the same `key` (the same move asking again after a lost answer) gets the
 * running job; any other start is refused (DATABASE_COPY_RUNNING).
 */

export type DatabaseJobKind = 'pull' | 'sum'

export interface DatabaseJob {
  id: string
  kind: DatabaseJobKind
  state: 'running' | 'done' | 'failed'
  result: unknown
  code: string | null
  message: string | null
  started_at: string
  finished_at: string | null
}

interface Held extends DatabaseJob {
  scope: string
  key: string
  endedMs: number | null
  /** Runs once the job's end has been read (a dedicated pull restarts only then). */
  afterRead: (() => void) | null
}

/** Ended jobs are kept this long for a late read. */
const KEEP_MS = 60 * 60_000

/** Jobs of every app of this process, by `<scope>|<id>`. */
const jobs = new Map<string, Held>()

export class DatabaseJobError extends Error {
  readonly code = 'DATABASE_COPY_RUNNING'
  readonly statusCode = 409
  constructor() {
    super('A copy of this database is already being made here; wait for it to end.')
    this.name = 'DatabaseJobError'
  }
}

function prune(now: number): void {
  for (const [k, j] of jobs) if (j.endedMs !== null && now - j.endedMs > KEEP_MS) jobs.delete(k)
}

function view(j: Held): DatabaseJob {
  return {
    id: j.id,
    kind: j.kind,
    state: j.state,
    result: j.result,
    code: j.code,
    message: j.message,
    started_at: j.started_at,
    finished_at: j.finished_at
  }
}

/** A refusal's code and message as a job keeps them (never a stack, never a path). */
function failureOf(err: unknown): { code: string; message: string } {
  const e = err as { code?: unknown; message?: unknown; name?: unknown } | null
  const known =
    e?.name === 'DatabaseTransferError' ||
    e?.name === 'SqliteTransferError' ||
    e?.name === 'SqliteTenantError' ||
    e?.name === 'DatabaseJobError'
  if (known && typeof e?.code === 'string')
    return { code: e.code, message: String(e.message ?? '').slice(0, 300) }
  return { code: 'DATABASE_COPY_FAILED', message: 'The database copy failed here.' }
}

/**
 * Start `run` as this app's `kind` job, or answer the one already running for the same `key`.
 * `opts.afterRead` runs (once) after the first read of the job's successful end.
 */
export function startDatabaseJob(
  scope: string,
  kind: DatabaseJobKind,
  key: string,
  run: () => Promise<unknown>,
  opts: { afterRead?: () => void } = {}
): DatabaseJob {
  const now = Date.now()
  prune(now)
  for (const j of jobs.values()) {
    if (j.scope !== scope || j.kind !== kind || j.state !== 'running') continue
    if (j.key === key) return view(j)
    throw new DatabaseJobError()
  }
  const j: Held = {
    id: randomUUID(),
    kind,
    state: 'running',
    result: null,
    code: null,
    message: null,
    started_at: new Date(now).toISOString(),
    finished_at: null,
    scope,
    key,
    endedMs: null,
    afterRead: opts.afterRead ?? null
  }
  jobs.set(`${scope}|${j.id}`, j)
  void (async () => {
    try {
      j.result = await run()
      j.state = 'done'
    } catch (err) {
      const f = failureOf(err)
      j.state = 'failed'
      j.code = f.code
      j.message = f.message
      j.afterRead = null
    } finally {
      j.endedMs = Date.now()
      j.finished_at = new Date(j.endedMs).toISOString()
    }
  })()
  return view(j)
}

/** This app's job `id` now, or null (unknown here: another process, or long ended). */
export function readDatabaseJob(scope: string, id: string): DatabaseJob | null {
  prune(Date.now())
  const j = jobs.get(`${scope}|${id}`)
  if (!j) return null
  const out = view(j)
  if (j.state === 'done' && j.afterRead) {
    const fn = j.afterRead
    j.afterRead = null
    fn()
  }
  return out
}

/** Forget an app's jobs (it left this process). */
export function forgetDatabaseJobs(scope: string): void {
  for (const [k, j] of jobs) if (j.scope === scope) jobs.delete(k)
}

/** A job id as the routes accept it. */
export const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
